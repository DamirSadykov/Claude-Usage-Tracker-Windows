// `cli.mjs todos outcome` — the RECONCILIATION half of the process DSL (t#304):
// promised → produced → consumed, and the machine predicate of a node's outcome
// (`ok` | `issue`, DSL §12).
//
// Same layer split as task-cost.mjs / corrections.mjs: Node owns TRANSCRIPT
// PARSING, Rust owns the join with SQLite. It has to be that way here — the
// database has no project file paths at all (`cc_files` stores transcripts), so
// "what did the step actually produce" is only knowable from the transcript.
//
// What the reconciliation reads:
//   produces (t#302)          what the step promised BEFORE the work (DSL §6)
//   task-sessions.jsonl       (task, session, [from,to]) blocks — the window
//                             inside which a session's file writes belong to
//                             THIS step (block fold mirrors task_sessions.rs)
//   the session transcripts   Write / Edit / MultiEdit / NotebookEdit tool_use
//                             entries = what was really touched
//   depends_on (reversed)     the dependent nodes; a promised output counts as
//                             CONSUMED when it shows up in their blocks
//
// Per DSL §15 («Артефакт — потреблённое») a declared output nobody took is NOT
// an artefact of an edge — but it is not an error either: it is reported as an
// unclaimed output and never moves the predicate.
//
// The declared `verify` is NEVER executed here — running an arbitrary command is
// the runner's job (t#305). This module only consumes its verdict via
// `--verify ok|issue`; a declared-but-not-run check leaves the outcome
// UNFINALIZED rather than guessing (§15, «никаких значений из воздуха»).

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTask, readTaskSessionEvents } from "./todos.mjs";

// Tools that CHANGE a file — the only evidence that something was produced.
// `Read` carries a `file_path` too and is deliberately NOT here: reading a file
// is taking, not producing (it does count on the consuming side, below).
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Cheap line prefilter — everything else is skipped without a JSON.parse.
const LINE_PREFILTER = /"file_path"|"notebook_path"|"is_error":true/;

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function appDataFile(name) {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", name);
}

// Forgiving load / atomic save — the same contract as todos.mjs::load/save, so a
// concurrent tracker write is never half-read or clobbered.
function loadTodos(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.todos)) return { version: 1, todos: [] };
    if (typeof data.version !== "number") data.version = 1;
    return data;
  } catch {
    return { version: 1, todos: [] };
  }
}

function saveTodos(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

// ── paths ────────────────────────────────────────────────────────────────────
// Declared outputs are repo-relative (`scripts/cli/outcome.mjs`), transcripts
// carry absolute Windows paths — so matching is suffix-based, on `/` separators,
// case-insensitively (this tracker is Windows-only, where the filesystem is).
export function normalizePath(p) {
  return String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "");
}

const pathKey = (p) => normalizePath(p).toLowerCase();

export function pathMatches(declared, touched) {
  const d = pathKey(declared);
  const t = pathKey(touched);
  if (!d || !t) return false;
  return t === d || t.endsWith("/" + d) || d.endsWith("/" + t);
}

// `produces` may declare things that are not files at all (DSL §6 allows
// interfaces and records). Those cannot be checked against file writes, and
// calling them "missing" would be a value out of thin air — they are reported
// as unchecked instead and never force `issue`.
export function isPathLike(item) {
  const s = normalizePath(item);
  if (!s) return false;
  return s.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

// ── transcript parsing ───────────────────────────────────────────────────────
// Every file a session touched, with the timestamp that places it inside a
// block. Evidence is buffered per tool_use id and dropped when the matching
// tool_result came back with `is_error` — a denied permission or a failed write
// did NOT produce the file (same discipline as task-cost.mjs). A tool_use whose
// result never reached the transcript (truncated tail) keeps the benefit of the
// doubt. Entries without a timestamp cannot be placed in a block and are kept
// with `ts: null`, so a windowed reader drops them rather than mis-attributing.
export function parseTouchedFiles(raw) {
  const pending = [];
  const errored = new Set();
  let lastTs = "";
  for (const line of String(raw || "").split("\n")) {
    if (!LINE_PREFILTER.test(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
    if (ts && ts > lastTs) lastTs = ts;
    const content = rec && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_result" && item.is_error && item.tool_use_id) {
        errored.add(item.tool_use_id);
        continue;
      }
      if (item.type !== "tool_use") continue;
      const input = item.input;
      if (!input || typeof input !== "object") continue;
      const file = input.file_path || input.notebook_path;
      if (typeof file !== "string" || !file.trim()) continue;
      pending.push({
        id: typeof item.id === "string" ? item.id : null,
        path: normalizePath(file),
        ts,
        tool: String(item.name || ""),
        mutates: MUTATING_TOOLS.has(String(item.name || "")),
      });
    }
  }
  const touches = pending
    .filter((t) => !(t.id && errored.has(t.id)))
    .map(({ path: p, ts, tool, mutates }) => ({ path: p, ts, tool, mutates }))
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  return { touches, last_ts: lastTs || null };
}

// ── blocks ───────────────────────────────────────────────────────────────────
// Fold the binding journal into (task, session, [from,to]) spans. Mirrors
// task_sessions.rs::blocks — a `start` opens; what CLOSES an open block is a
// `start` of any task (a session works on one task at a time) or an `end` of
// THAT task. An `end` of another task leaves it open: closing a second task
// that was left in_progress says nothing about the work going on right now, and
// a rule that lets it close the block loses everything after it (t#326 — a
// 20-minute step recorded as 67 seconds, its files reported NOT produced).
// The last open block is closed by the session's end. Rust takes that end from
// `cc_usage`; here it is the session's last transcript timestamp, the same
// instant seen from the Node side. Unknown end → a zero-length block, as in
// Rust, rather than an open-ended one.
export function foldBlocks(events, sessionEnd = new Map()) {
  const bySession = new Map();
  for (const e of events || []) {
    if (!e || !e.ts || !e.session || !e.task) continue;
    if (e.event !== "start" && e.event !== "end") continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const out = [];
  for (const [session, list] of bySession) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let open = null;
    for (const e of list) {
      if (open && (e.event === "start" || e.task === open.task)) {
        open.to = e.ts;
        out.push(open);
        open = null;
      }
      if (e.event === "start") {
        open = {
          task: e.task,
          session,
          from: e.ts,
          to: "",
          source: e.source || "",
          project: e.project || null,
        };
      }
    }
    if (open) {
      const end =
        (sessionEnd instanceof Map ? sessionEnd.get(session) : sessionEnd?.[session]) || "";
      open.to = end > open.from ? end : open.from;
      out.push(open);
    }
  }
  out.sort((a, b) => a.from.localeCompare(b.from) || a.session.localeCompare(b.session));
  return out;
}

const inWindow = (touch, block) =>
  !!touch.ts && touch.ts >= block.from && touch.ts <= block.to;

function touchesIn(blocks, touchesBySession) {
  const out = [];
  for (const b of blocks) {
    const list =
      (touchesBySession instanceof Map
        ? touchesBySession.get(b.session)
        : touchesBySession?.[b.session]) || [];
    for (const t of list) if (inWindow(t, b)) out.push({ ...t, session: b.session });
  }
  return out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

// ── the reconciliation ───────────────────────────────────────────────────────
// Pure: everything it needs is passed in, so the whole verdict is unit-testable
// without a filesystem.
//   data     the board (for depends_on and the dependents' numbers)
//   todo     the node under reconciliation
//   blocks   ALL folded blocks (this node's and its dependents')
//   touches  Map<session, touch[]> — un-windowed; windows are applied here
//   verify   "ok" | "issue" | undefined — the runner's verdict, never run here
export function buildOutcomeReport({ data, todo, blocks = [], touches = new Map(), verify }) {
  const board = (data && Array.isArray(data.todos) ? data.todos : []).filter(Boolean);
  const own = blocks.filter((b) => b.task === todo.id);
  const dependents = board.filter(
    (t) => Array.isArray(t.depends_on) && t.depends_on.includes(todo.id),
  );

  const wrote = touchesIn(own, touches).filter((t) => t.mutates);
  // Consumption counts ANY file-path-bearing tool of a dependent, `Read`
  // included: the dependent TOOK the output — that is what makes it an artefact
  // (§1), and it does not have to rewrite it to have taken it.
  const seenByDependent = new Map();
  for (const d of dependents) {
    seenByDependent.set(
      d.id,
      touchesIn(
        blocks.filter((b) => b.task === d.id),
        touches,
      ),
    );
  }

  const declared = (Array.isArray(todo.produces) ? todo.produces : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);

  const produces = declared.map((item) => {
    const checkable = isPathLike(item);
    const hit = checkable ? wrote.find((t) => pathMatches(item, t.path)) : undefined;
    const consumers = checkable
      ? dependents.filter((d) =>
          (seenByDependent.get(d.id) || []).some((t) => pathMatches(item, t.path)),
        )
      : [];
    return {
      path: item,
      checkable,
      produced: !!hit,
      produced_at: hit ? hit.ts : null,
      produced_by: hit ? hit.tool : null,
      produced_in_session: hit ? hit.session : null,
      consumed: consumers.length > 0,
      consumed_by: consumers.map((d) => ({ id: d.id, number: d.number })),
    };
  });

  const missing = produces.filter((r) => r.checkable && !r.produced).map((r) => r.path);
  const unconsumed = produces.filter((r) => r.produced && !r.consumed).map((r) => r.path);
  const unchecked = produces.filter((r) => !r.checkable).map((r) => r.path);

  // Everything written but not promised: side results (§6, the noise filter).
  const sideEffects = [];
  for (const t of wrote) {
    if (declared.some((item) => pathMatches(item, t.path))) continue;
    if (!sideEffects.some((p) => pathKey(p) === pathKey(t.path))) sideEffects.push(t.path);
  }

  const verifyDeclared =
    todo.verify && String(todo.verify).trim() ? String(todo.verify).trim() : null;
  const declaredAnything = produces.length > 0 || !!verifyDeclared;

  let outcome = null;
  let reason;
  if (verify === "issue") {
    outcome = "issue";
    reason = "verify:issue";
  } else if (missing.length) {
    // A missing promise decides on its own: a green check over a step that did
    // not produce what it promised is still an `issue` (§14 п.4, §15).
    outcome = "issue";
    reason = `missing:${missing[0]}`;
  } else if (verifyDeclared && verify !== "ok") {
    reason = "verify-declared-not-run";
  } else if (!verify && !declaredAnything) {
    // Nothing promised and nothing checked — there is no contract to be `ok`
    // against. Reporting `ok` here would be a value out of thin air (§15).
    reason = "nothing-declared";
  } else {
    outcome = "ok";
    reason = "ok";
  }

  return {
    version: 1,
    kind: "task.outcome",
    task: { id: todo.id, number: todo.number, subject: todo.subject },
    blocks: own.map((b) => ({
      session: b.session,
      from: b.from,
      to: b.to,
      source: b.source || "",
    })),
    dependents: dependents.map((d) => ({ id: d.id, number: d.number })),
    produces,
    missing,
    unconsumed,
    unchecked,
    side_effects: sideEffects,
    verify: {
      declared: verifyDeclared,
      ran: verify === "ok" || verify === "issue",
      result: verify === "ok" || verify === "issue" ? verify : null,
    },
    outcome,
    outcome_reason: reason,
    finalized: outcome !== null,
    written: false,
  };
}

// ── transcript location ──────────────────────────────────────────────────────
// Mirrors task-cost.mjs / corrections.mjs. Subagent transcripts live in
// `<session>/subagents/agent-*.jsonl` and belong to the PARENT session id, so
// their writes fall inside the parent's block and count as the step's output.
function claudeProjectsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return home ? path.join(home, ".claude", "projects") : null;
}

const encodeCwd = (cwd) => String(cwd).replace(/[:\\/.]/g, "-");

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

export function findSessionTranscripts(session, root = claudeProjectsDir()) {
  if (!session || !root || !existsSync(root)) return [];
  const here = path.join(root, encodeCwd(process.cwd()));
  const dirs = [here, ...listDirs(root).filter((d) => d !== here)];
  for (const dir of dirs) {
    const main = path.join(dir, `${session}.jsonl`);
    if (!existsSync(main)) continue;
    const files = [main];
    const sub = path.join(dir, session, "subagents");
    if (existsSync(sub)) {
      for (const f of readdirSync(sub)) {
        if (f.endsWith(".jsonl")) files.push(path.join(sub, f));
      }
    }
    return files;
  }
  return [];
}

// ── command ──────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const f = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") f.json = true;
    else if (a === "--write") f.write = true;
    else if (a === "--verify") f.verify = args[++i];
    else if (a.startsWith("--verify=")) f.verify = a.slice("--verify=".length);
    else if (a.startsWith("--")) fail(`unknown flag: ${a}`);
    else f.positional.push(a);
  }
  return f;
}

function reconcile(ref, verify) {
  const file = appDataFile("todos.json");
  const data = loadTodos(file);
  const todo = resolveTask(data, ref);
  if (!todo) fail(`no such task: ${ref}`);

  const dependents = data.todos.filter(
    (t) => t && Array.isArray(t.depends_on) && t.depends_on.includes(todo.id),
  );
  const wanted = new Set([todo.id, ...dependents.map((d) => d.id)]);

  const events = readTaskSessionEvents();
  const sessions = new Set(events.filter((e) => wanted.has(e.task)).map((e) => e.session));

  const touches = new Map();
  const sessionEnd = new Map();
  for (const s of sessions) {
    const all = [];
    let last = "";
    for (const f of findSessionTranscripts(s)) {
      let raw;
      try {
        raw = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const parsed = parseTouchedFiles(raw);
      all.push(...parsed.touches);
      if (parsed.last_ts && parsed.last_ts > last) last = parsed.last_ts;
    }
    touches.set(s, all);
    if (last) sessionEnd.set(s, last);
  }

  // Block boundaries need EVERY event of a relevant session, not only the ones
  // naming these tasks: a block is closed by the next event of the session,
  // whatever task that event belongs to.
  const blocks = foldBlocks(
    events.filter((e) => sessions.has(e.session)),
    sessionEnd,
  );
  return { file, data, todo, report: buildOutcomeReport({ data, todo, blocks, touches, verify }) };
}

function applyOutcome(file, data, todo, report) {
  const t = data.todos.find((x) => x && x.id === todo.id);
  if (!t) return false;
  t.outcome = report.outcome;
  t.outcome_reason = report.outcome_reason;
  t.outcome_at = new Date().toISOString();
  saveTodos(file, data);
  return true;
}

function printReport(r) {
  const out = [];
  out.push(`#${r.task.number} ${r.task.subject}\n`);
  out.push(
    `  blocks: ${r.blocks.length}${
      r.blocks.length ? ` (${new Set(r.blocks.map((b) => b.session)).size} session(s))` : ""
    }\n`,
  );
  if (!r.produces.length) out.push("  produces: (nothing declared)\n");
  for (const p of r.produces) {
    if (!p.checkable) {
      out.push(`  ? ${p.path} — not a path, not machine-checkable\n`);
      continue;
    }
    if (!p.produced) {
      out.push(`  ✗ ${p.path} — NOT produced\n`);
      continue;
    }
    const by = `${p.produced_by}${p.produced_at ? ` ${p.produced_at}` : ""}`;
    const taken = p.consumed
      ? `consumed by ${p.consumed_by.map((c) => `#${c.number}`).join(", ")}`
      : "not consumed — unclaimed output (not an error, §15)";
    out.push(`  ✓ ${p.path} — produced (${by}), ${taken}\n`);
  }
  if (r.side_effects.length) {
    out.push(`  side results (touched, not declared): ${r.side_effects.length}\n`);
    for (const p of r.side_effects) out.push(`      ${p}\n`);
  }
  if (r.verify.declared) {
    out.push(
      r.verify.ran
        ? `  verify: ${r.verify.declared} -> ${r.verify.result}\n`
        : `  verify: ${r.verify.declared} — declared, NOT run (the runner passes --verify ok|issue)\n`,
    );
  }
  if (r.finalized) {
    out.push(`  outcome: ${r.outcome} (${r.outcome_reason})\n`);
  } else if (r.outcome_reason === "verify-declared-not-run") {
    out.push("  outcome: undecided — verify declared but never run\n");
  } else {
    out.push("  outcome: undecided — nothing declared to reconcile against\n");
  }
  if (r.written) out.push("  written: outcome, outcome_reason, outcome_at\n");
  process.stdout.write(out.join(""));
}

function usage(code) {
  process.stdout.write(
    "usage: cli todos outcome <task> [--verify ok|issue] [--write] [--json]\n\n" +
      "  reconciles promised -> produced -> consumed (DSL §6/§12) and prints the\n" +
      "  machine predicate of the node: ok | issue.\n\n" +
      "  <task>            an id, a number, or #N\n" +
      "  --verify ok|issue the verdict of the declared check; the check itself is\n" +
      "                    NOT run here — the runner (t#305) runs it and reports\n" +
      "  --write           store outcome / outcome_reason / outcome_at on the task\n" +
      "  --json            the same reconciliation, machine-readable\n\n" +
      "  A declared verify that was not run leaves the outcome UNFINALIZED.\n" +
      "  A produced output nobody took is an unclaimed output, not an error.\n",
  );
  process.exit(code);
}

export function run(args) {
  const f = parseFlags(args);
  const ref = f.positional[0];
  if (!ref || ref === "-h" || ref === "--help" || ref === "help") usage(ref ? 0 : 1);

  let verify;
  if (f.verify !== undefined) {
    const v = String(f.verify ?? "").trim().toLowerCase();
    if (v !== "ok" && v !== "issue") fail('--verify takes "ok" or "issue"');
    verify = v;
  }

  const { file, data, todo, report } = reconcile(ref, verify);
  if (f.write && report.finalized) report.written = applyOutcome(file, data, todo, report);

  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else printReport(report);

  if (f.write && !report.finalized) {
    process.stderr.write(
      `outcome not finalized (${report.outcome_reason}) — nothing written\n`,
    );
    process.exit(1);
  }
}
