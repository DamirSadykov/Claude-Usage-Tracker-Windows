// The EXECUTOR half of the process-DSL runner (t#305): one step, start to
// finish. The scheduler half (frontier, retries, budget, parking — DSL §14)
// lives in run.mjs and drives this module one node at a time.
//
// Three things happen here and nothing else:
//   buildStepPrompt   what the step is told (DSL §14.2 — the SEAM)
//   executeStep       the headless session that does the work (§14.3)
//   runVerify         the declared check that decides ok | issue (§7, §14.4)
//
// Why a seam at all (§13): the median cost of a message triples with session
// length ($0.052 at 10-30 messages vs $0.151 at 120-400), so an autonomous run
// carried by ONE long session is several times more expensive than the same run
// as short per-step sessions. The price of the seam is that a step remembers
// nothing — which is exactly why the baton (`handoff` of the DIRECT
// prerequisites) is what crosses it, and the message history never does.
//
// The step gets no Bash. That is not caution, it is a measured constraint:
// `claude -p --allowedTools "Bash(node *)"` does NOT match node commands, so a
// step told to run the tracker CLI from inside the session silently loses the
// permission and stalls on a prompt. Every command of the run — the binding,
// the baton read, the check — is therefore issued by the HOST (this module and
// its caller), and the session is left with the file tools it needs to work.

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  formatDeclarations,
  appendTaskSessionEvent,
  envWithoutSession,
  changeRootsFor,
  formatChangeVision,
  isChangeRoot,
} from "./todos.mjs";

// A step is a whole unit of work, not a question — it gets minutes, not
// seconds. A check is bounded by what it runs (`npm test` on this repo is ~5s;
// a cargo build is minutes), so it gets half as long. Both are overridable per
// call; neither is optional, because a headless session that hangs on a
// permission prompt never exits on its own.
export const DEFAULT_STEP_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

// Reading the baton is a local CLI call; if it takes longer than this the
// tracker is wedged and the step should say so rather than wait.
const HANDOFF_TIMEOUT_MS = 20 * 1000;

// Captured per stream. `verify` output is read by a model and by a human, and
// both stop reading long before this; the cap exists so a runaway loop printing
// to stdout cannot exhaust the runner's memory.
export const MAX_CAPTURE_CHARS = 16 * 1024;

// The step's own stdout must survive intact — the session id is parsed out of
// it — so it gets a far larger, purely defensive ceiling.
const MAX_STEP_CAPTURE_CHARS = 4 * 1024 * 1024;

// Tools a step needs to do work whose result the host can check: read the
// codebase, write to it, keep its own scratch list. Bash is deliberately absent
// (see the header). Callers that know better pass their own list.
export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TodoWrite",
];

const cliEntry = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// Keep the head AND the tail: a failing check puts its verdict at the end and
// its context at the start, and dropping either half is what makes a truncated
// log useless.
export function clampOutput(text, max = MAX_CAPTURE_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return (
    s.slice(0, head) +
    `\n… [${s.length - max} chars elided] …\n` +
    s.slice(s.length - tail)
  );
}

// The same head/tail policy applied as the bytes ARRIVE, so a runaway process
// never puts more than the cap in memory in the first place. Buffering the
// whole stream and trimming afterwards defeats the point of having a cap.
function makeSink(max) {
  const headMax = Math.max(1, Math.floor(max * 0.6));
  const tailMax = Math.max(1, max - headMax);
  let head = "";
  let tail = "";
  let total = 0;
  return {
    push(chunk) {
      const s = String(chunk);
      total += s.length;
      if (head.length < headMax) {
        const room = headMax - head.length;
        head += s.slice(0, room);
        tail += s.slice(room);
      } else {
        tail += s;
      }
      if (tail.length > tailMax) tail = tail.slice(-tailMax);
    },
    value() {
      const dropped = total - head.length - tail.length;
      return dropped > 0
        ? head + `\n… [${dropped} chars elided] …\n` + tail
        : head + tail;
    },
  };
}

// ── spawning ────────────────────────────────────────────────────────────────
//
// Windows cannot exec a `.cmd`/`.bat` shim directly (Node refuses it without a
// shell since CVE-2024-27980), and `shell: true` would re-parse every argument.
// So the wrapper quotes each argv element itself and hands cmd.exe a single
// verbatim line: the arguments still cross as arguments, never as text that the
// shell may re-split. `claude` ships as `claude.exe` today, which takes the
// direct path below and never reaches the wrapper.
function winQuote(s) {
  const v = String(s);
  if (v && !/[\s"^&|<>()%!]/.test(v)) return v;
  return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

function windowsShim(file, args) {
  const cmdLine = [file, ...args].map(winQuote).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${cmdLine}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

function resolveSpawn(file, args) {
  if (process.platform !== "win32") return { file, args, opts: {} };
  if (/\.exe$/i.test(file) || file === (process.env.ComSpec || "cmd.exe"))
    return { file, args, opts: {} };
  if (/\.(cmd|bat)$/i.test(file) || !path.extname(file))
    return windowsShim(file, args);
  return { file, args, opts: {} };
}

// A headless session spawns children (its own tools, a language server); killing
// only the parent on timeout leaves them holding the cwd and the console. Kill
// the tree: `taskkill /T` on Windows, the process group elsewhere (which is why
// the child is detached there).
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      }).on("error", () => child.kill("SIGKILL"));
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

// One captured run with a hard deadline. Resolves — never rejects: a step that
// could not be started is an `issue` for the runner to route (§12), not an
// exception that unwinds the whole run.
function spawnCaptured(
  file,
  args,
  { cwd, timeoutMs, input = null, maxChars = MAX_CAPTURE_CHARS, env, spawnOpts } = {},
) {
  return new Promise((resolve) => {
    const target = resolveSpawn(file, args);
    let child;
    try {
      child = spawn(target.file, target.args, {
        cwd: cwd || process.cwd(),
        env: env || process.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...target.opts,
        ...(spawnOpts || {}),
      });
    } catch (e) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: `cannot start ${file}: ${e && e.message ? e.message : e}`,
      });
      return;
    }

    const out = makeSink(maxChars);
    const err = makeSink(maxChars);
    let timedOut = false;
    let spawnError = "";
    let settled = false;

    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: out.value(),
        stderr: err.value(),
        timedOut,
        error: timedOut
          ? `timed out after ${timeoutMs}ms — process tree killed`
          : spawnError || "",
      });
    };

    child.on("error", (e) => {
      spawnError = `cannot start ${file}: ${e && e.message ? e.message : e}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(String(input));
    } else {
      try {
        child.stdin.end();
      } catch {}
    }
  });
}

// ── the prompt ──────────────────────────────────────────────────────────────

const line = (label, body) => `${label}\n${String(body).trim()}\n`;

// The baton, read through the CLI that owns it. `todos handoff <task>` is the
// single assembler of the inherited-handoff block (todos.mjs::
// formatInheritedHandoff, shared with the in_progress anchor), and it is not
// exported — so it is reused as a process rather than reimplemented, because a
// second assembler would drift from the one the interactive path prints.
// Failure yields an empty string, never a reconstruction: a baton invented by
// the runner is a value out of thin air (§15).
function inheritedBaton(task, { cwd } = {}) {
  const ref = task && task.number != null ? `#${task.number}` : String(task?.id ?? "");
  if (!ref) return "";
  try {
    return String(
      execFileSync(process.execPath, [cliEntry(), "todos", "handoff", ref], {
        cwd: cwd || process.cwd(),
        encoding: "utf8",
        timeout: HANDOFF_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
  } catch {
    return "";
  }
}

// The change's vision, read UP the dep edges the way the interactive path
// reads it on `-> in_progress` (todos.mjs::formatChangeVision). It is
// assembled in process rather than through the CLI because both halves are
// exported — and because it is the one block that must not go missing on a
// slow board: a step without it works on a node whose frame (what must NOT be
// touched, what the change deliberately keeps) exists only in the plan.
function changeVision(task, all, changes = []) {
  if (!all.length) return "";
  try {
    const roots = changeRootsFor({ todos: all, changes }, task);
    if (!roots.length) return "";
    return formatChangeVision(task, roots).trim();
  } catch {
    return "";
  }
}

// The graph read FORWARD: nodes that unblock when this one closes. A change
// root is left out — it depends on every member and names no work of its own.
function awaitingNodes(task, all) {
  return all.filter(
    (t) =>
      t &&
      !isChangeRoot(t) &&
      t.id !== task.id &&
      Array.isArray(t.depends_on) &&
      t.depends_on.includes(task.id),
  );
}

function formatAwaiting(nodes) {
  if (!nodes.length)
    return "(nothing on the board depends on this node — it hands off to no one)\n";
  let out = "";
  for (const t of nodes) {
    const promised = (Array.isArray(t.produces) ? t.produces : []).filter(Boolean);
    out +=
      `t#${t.number} ${t.subject}` +
      (promised.length ? ` — its own promise: ${promised.join(", ")}` : "") +
      "\n";
  }
  return out;
}

// Everything a step is told, and nothing more (§14.2): the WORK (this node's own
// subject / description / plan), the VISION of the change it serves, the BATON
// it inherits, the nodes WAITING on it, whatever runs ALONGSIDE it in the same
// wave, the DECLARATIONS it must satisfy, and the boundary rules of a headless
// step.
//
// What is deliberately NOT here: the history of previous steps, the transcript
// of an earlier attempt. Context crosses the seam as the baton or not at all —
// that is the whole reason the seam exists (§13).
export function buildStepPrompt({ task, board, cwd, alongside = [] } = {}) {
  if (!task) throw new Error("buildStepPrompt: task is required");
  const all = Array.isArray(board?.todos) ? board.todos : [];
  const index = new Map(all.map((t) => [t.id, t]));

  let out =
    "You are executing ONE step of an autonomous run over a task graph.\n" +
    "Everything you need is below; there is no earlier conversation to recall.\n\n";

  out += `── WORK ──\nt#${task.number} ${task.subject || "(no subject)"}\n`;
  if (task.description && task.description.trim())
    out += "\n" + line("Description:", task.description);
  if (task.plan && task.plan.trim()) out += "\n" + line("Plan:", task.plan);

  const vision = changeVision(task, all, Array.isArray(board?.changes) ? board.changes : []);
  out +=
    "\n── VISION — the change this step serves ──\n" +
    (vision
      ? vision + "\n"
      : "(no change root above this node — there is no vision to inherit)\n");

  const baton = inheritedBaton(task, { cwd });
  out +=
    "\n── BATON — what the steps before you left ──\n" +
    (baton
      ? baton + "\n"
      : "(the baton could not be read — proceed on the declarations alone, and do not invent what upstream did)\n");

  out +=
    "\n── WHAT WAITS ON YOU — nodes that unblock when this one closes ──\n" +
    formatAwaiting(awaitingNodes(task, all));

  const peers = (Array.isArray(alongside) ? alongside : []).filter(
    (t) => t && t.id !== task.id,
  );
  if (peers.length)
    out +=
      "\n── ALONGSIDE — steps of the same wave working RIGHT NOW ──\n" +
      peers.map((t) => `t#${t.number} ${t.subject}`).join("\n") +
      "\nThey are editing files at the same time as you: stay inside your own promise.\n";

  out +=
    "\n── DECLARATIONS — the frame this node was given before it ran ──\n" +
    formatDeclarations(task, index);
  const produces = (Array.isArray(task.produces) ? task.produces : []).filter(Boolean);
  if (produces.length)
    out +=
      "You MUST produce all of: " +
      produces.join(", ") +
      " — the run reconciles what was promised against what was written.\n";
  if (task.verify && String(task.verify).trim())
    out +=
      "Your work will be checked by: " +
      String(task.verify).trim() +
      " — it is run by the harness after you stop, not by you. Exit 0 is the only pass.\n";
  if (typeof task.retry_limit === "number")
    out += `This node gets at most ${task.retry_limit} attempt(s); a failed check spends one.\n`;
  if (typeof task.budget_usd === "number")
    out += `Spend ceiling for this node: $${task.budget_usd}.\n`;

  out +=
    "\n── RULES ──\n" +
    "1. Do the work in the files. You have no shell: the harness runs every command,\n" +
    "   including the check above — do not ask for one and do not simulate it.\n" +
    "2. Do not touch the task board, the task status or the graph. The runner closes\n" +
    "   the node after the check passes; claiming it done yourself does not close it.\n" +
    "3. Stay inside this node. Work the next step is meant to do is not yours to start.\n" +
    "4. Finish with a `## HANDOFF` section: what you produced (paths), the gotcha the\n" +
    "   next step would otherwise hit, and where you stopped. That text is the baton\n" +
    "   the next step reads — it is the only thing that survives you.\n";

  return out;
}

// The `## HANDOFF` section the RULES ask for, cut out of the step's answer. It
// is the whole baton and nothing else: the prose above it is the step narrating
// itself to no one, and passing that on as a baton would hand the next step a
// transcript instead of what it is owed. A missing section yields "" — a baton
// assembled out of whatever the step happened to say last is a value out of thin
// air (§15), and the run reports the absence instead.
export function extractHandoff(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  const m = s.match(/^[ \t]*#{1,6}[ \t]*HANDOFF[ \t]*:?[ \t]*$/im);
  if (!m) return "";
  const body = s.slice(m.index + m[0].length).trim();
  return body;
}

// ── binding ─────────────────────────────────────────────────────────────────
//
// The seam's other cost: the session that does the work is NOT the session that
// launched it, so `todos take` — which binds whatever session it is running in —
// would bind the runner instead of the step. Two facts make the foreign binding
// writable without a CLI change:
//
//   * `take` already takes the session as an argument (`--session <id>`,
//     todos.mjs::currentSessionId prefers the flag over the environment); its
//     own usage text calls it "pass one explicitly if you really know it".
//   * `appendTaskSessionEvent` is exported, and is the exact primitive `take`
//     itself writes with.
//
// The in-process primitive is used here so the binding lands BEFORE the session
// starts. That ordering is the point: a block is `[start, next event]`
// (task_sessions.rs), so a binding written after the work would open a block
// with none of the work inside it, and the step would measure as $0 — which is
// precisely how the t#294 run lost t#296's spend (§10).
//
// `source` is the runner's own wire value, and it has to be in
// task_sessions.rs::EXPLICIT_SOURCES — that allowlist is what separates a stated
// binding from a guessed one, and a block outside it is downgraded to a guess.
// It is listed there since t#312; until then this wrote "take", the only value
// that counted as explicit, which left the journal unable to tell a human's
// `todos take` from a step the runner started.
//
// This is the ONLY binding an attempt at a node produces. The `in_progress` move
// the runner makes just before would write a second one, under the session the
// RUNNER was started in — run.mjs keeps that id out of the CLI children it
// spawns for exactly this reason (t#312).
export function bindSession({ session, task, event = "start" }) {
  return appendTaskSessionEvent({
    session,
    task: task && task.id,
    event,
    source: "run-step",
    project: (task && task.project) || null,
  });
}

// ── the step ────────────────────────────────────────────────────────────────

// `claude -p --output-format json` ends with one result object; older/edge
// builds may print other JSON before it, so the LAST parseable object wins.
export function parseClaudeResult(stdout) {
  const s = String(stdout ?? "").trim();
  if (!s) return null;
  try {
    const whole = JSON.parse(s);
    if (whole && typeof whole === "object") return whole;
  } catch {}
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    try {
      const rec = JSON.parse(l);
      if (rec && typeof rec === "object") return rec;
    } catch {}
  }
  return null;
}

// Run one step: bind, work, unbind. Resolves `{ sessionId, ok, error }` (plus
// the material the caller needs to route the outcome) and never rejects.
//
// The session id is CHOSEN, not discovered: the runner mints a UUID and passes
// it as `--session-id`. Three properties come from that, and no post-hoc method
// has all three — scraping stdout only tells you afterwards, and picking "the
// newest transcript in ~/.claude/projects" is a race the moment two steps run
// in parallel (§10), which is exactly the case the runner is built for.
//   * the binding can be written BEFORE the work, so the block covers it;
//   * a parallel step's id is unambiguous, with no directory to guess at;
//   * the transcript file is named by it, so the reconciliation (t#304) finds it.
// The id reported back by `--output-format json` is still checked, and if the
// binary ever disagrees (an ignored flag, a fork) the REPORTED id is trusted and
// the binding is rewritten to it — a binding pointing at a session that does not
// exist is worse than a late one.
export async function executeStep({
  task,
  board,
  cwd,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  claudeBin = process.env.CLAUDE_BIN || "claude",
  allowedTools = DEFAULT_ALLOWED_TOOLS,
  permissionMode = "acceptEdits",
  model,
  env,
  bind = true,
  alongside = [],
} = {}) {
  if (!task) return { sessionId: "", ok: false, error: "executeStep: task is required" };

  let prompt;
  try {
    prompt = buildStepPrompt({ task, board, cwd, alongside });
  } catch (e) {
    return { sessionId: "", ok: false, error: `prompt: ${e && e.message ? e.message : e}` };
  }

  const sessionId = randomUUID();
  const [file, ...prefix] = Array.isArray(claudeBin) ? claudeBin : [claudeBin];
  const args = [
    ...prefix,
    "-p",
    "--session-id",
    sessionId,
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  if (allowedTools && allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (model) args.push("--model", model);

  if (bind) bindSession({ session: sessionId, task, event: "start" });

  // The step is its own session (`--session-id` above), so it must not carry the
  // id of the session that launched the runner: whatever inside it reads
  // CLAUDE_CODE_SESSION_ID — the project's own SessionStart hook among them —
  // would write a binding under a session that is elsewhere (t#312).
  const run = await spawnCaptured(file, args, {
    cwd,
    timeoutMs,
    input: prompt,
    maxChars: MAX_STEP_CAPTURE_CHARS,
    env: envWithoutSession(env || process.env),
  });

  const parsed = parseClaudeResult(run.stdout);
  const reported =
    parsed && typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
  const actual = reported || sessionId;
  if (bind && reported && reported !== sessionId)
    bindSession({ session: reported, task, event: "start" });
  // The block closes either way. A step that timed out or crashed still spent
  // what it spent, and §15 forbids rewriting that after the fact — an unclosed
  // block would silently swallow the next step's messages instead.
  if (bind) bindSession({ session: actual, task, event: "end" });

  let error = "";
  if (run.error) error = run.error;
  else if (run.code !== 0)
    error =
      `claude exited ${run.code}` +
      (run.stderr.trim() ? `: ${clampOutput(run.stderr.trim(), 2000)}` : "");
  else if (!parsed)
    error = "claude produced no parseable JSON result — cannot confirm the step ran";
  else if (parsed.is_error)
    error = `step reported an error: ${String(parsed.result ?? parsed.subtype ?? "").slice(0, 2000)}`;

  const answer = parsed && typeof parsed.result === "string" ? parsed.result : "";
  return {
    sessionId: actual,
    ok: !error,
    error,
    timedOut: !!run.timedOut,
    code: run.code,
    result: answer,
    handoff: extractHandoff(answer),
    costUsd: parsed && typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    numTurns: parsed && typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    stderr: clampOutput(run.stderr, MAX_CAPTURE_CHARS),
    prompt,
  };
}

// ── the check ───────────────────────────────────────────────────────────────

// The declared check (§7), run by the host after the step stops. Exit 0 is `ok`
// and everything else is `issue` — that is the whole predicate, and this
// function does not interpret the output beyond capturing it.
//
// `cmd` is the author's own string and is passed to the shell as ONE argument,
// never assembled from anything else: no task subject, path, session id or
// model output is ever concatenated into a command line. A caller that wants no
// shell at all passes an argv array instead, which is spawned directly.
export async function runVerify({
  cmd,
  cwd,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  maxChars = MAX_CAPTURE_CHARS,
  env,
} = {}) {
  if (Array.isArray(cmd)) {
    const [file, ...args] = cmd.filter((x) => x != null).map(String);
    if (!file)
      return { code: null, stdout: "", stderr: "runVerify: empty command", timedOut: false, error: "runVerify: empty command" };
    return spawnCaptured(file, args, { cwd, timeoutMs, maxChars, env });
  }

  const text = String(cmd ?? "").trim();
  if (!text)
    return {
      code: null,
      stdout: "",
      stderr: "runVerify: no command declared",
      timedOut: false,
      error: "runVerify: no command declared",
    };

  // `cmd /d /s /c "<text>"` with verbatim arguments is exactly what Node's own
  // `shell: true` builds — minus `shell: true` itself, which would let anything
  // ELSE handed to spawn be re-parsed too. `/s` strips the outer quotes and
  // leaves the author's line untouched, so embedded quotes survive.
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawnCaptured(comspec, ["/d", "/s", "/c", `"${text}"`], {
      cwd,
      timeoutMs,
      maxChars,
      env,
      spawnOpts: { windowsVerbatimArguments: true },
    });
  }
  return spawnCaptured("/bin/sh", ["-c", text], { cwd, timeoutMs, maxChars, env });
}
