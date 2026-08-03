// `cli.mjs todos run <change>` — the RUNNER half of the process DSL (t#305):
// the SEMANTICS of an autonomous run over a change's task graph.
//
// This module owns the run loop and nothing else. It never starts a model and
// never runs a shell command itself: both live behind an injected seam, so the
// whole semantics is unit-testable without spending a cent.
//
//   executeStep({ task, board, cwd, timeoutMs }) -> { sessionId, ok, error }
//   runVerify({ cmd, cwd, timeoutMs })           -> { code, stdout, stderr }
//
// Both come from ./run-step.mjs (imported lazily, only on a real run). The board
// is moved through the CLI (`todos set status`) and the predicate of a node is
// asked from `todos outcome` (t#304) — the runner never decides an outcome on
// its own and never writes todos.json directly.
//
// The loop, step by step (the seven points of the execution semantics):
//   1. FRONTIER   nodes of the change whose every depends_on is `done` (`review`
//                 is NOT a closure). Several ready -> they go in one wave, up to
//                 the change's declared parallel limit (no declaration = 1).
//   2. SEAM       every step is its own session and its own block; what carries
//                 between steps is the `handoff` baton of the direct
//                 prerequisites, not the message history. The step writes its
//                 baton as a `## HANDOFF` section and has no shell, so the RUN
//                 puts it on the board (`recordHandoff`); a step that wrote none
//                 is reported as such instead of silently passing nothing on.
//                 The runner never drags one context through a whole run — a
//                 long session costs ~3x per message.
//   3. WORK       executeStep.
//   4. CHECK      the declared `verify` is run, its verdict is handed to
//                 `todos outcome <task> --verify ok|issue --write`. A node closes
//                 only when the check is green AND what was promised was produced
//                 AND the direct prerequisites are closed (the done-gate refuses
//                 the rest).
//   5. FAILURE    predicate `issue` -> the declared `?issue` transition, if
//                 attempts and budget are left. The attempt counter grows.
//   6. STOPS      four of them, and they all look the SAME: the node sits in
//                 `review`, the reason is spelled out, the pipeline is parked —
//                 a gate; the retry limit; the budget (softly, on a step
//                 boundary — the current step is finished, never killed
//                 mid-flight); an empty frontier while the change is still open
//                 (that means the graph lies and edges are missing).
//   7. THE GROUP  the runner never closes the change and never creates a task.
//                 Everything it executes already stands in the graph.
//
// Invariants it holds (and the tests name one by one):
//   * `auto` without a declared `verify` runs as a GATE — the authority to close
//     comes from the check, not from the flag;
//   * attempt M+1 never starts; a MISSING retry limit FORBIDS the `?issue`
//     transition rather than permitting an endless one;
//   * there is no `--force` in the runner's hands — that stays a human exception;
//   * an exhausted budget rolls nothing back and never rewrites a status after
//     the fact.
//
// `--dry-run` is the DEFAULT: the same loop with a simulator behind the seam, so
// the printed plan is produced by the real semantics, not by a second
// description of it. In dry mode the caller's effects are IGNORED outright — the
// engine physically cannot touch the board or a model.
//
// Open direction of §11 decided here: on an `?issue` transition only the TARGET
// of the transition is reopened (to `queue`), the `done` nodes between it and
// the failing node stay closed. Rationale in the module's answer to t#305: a
// wholesale rollback re-buys work the check never faulted, and the budget — not
// tidiness — is the binding constraint of an autonomous run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

import { resolveTask, isReadyNode, isDone, isChangeRoot, envWithoutSession } from "./todos.mjs";

export const DEFAULT_PARALLEL_LIMIT = 1;

const brief = (t) => (t ? { id: t.id, number: t.number, subject: t.subject } : null);
const num = (t) => (t && t.number != null ? `#${t.number}` : t ? t.id : "?");
const declaredVerify = (t) => (t && t.verify && String(t.verify).trim()) || "";

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

function loadTodos(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.todos)) return { version: 1, todos: [] };
    return data;
  } catch {
    return { version: 1, todos: [] };
  }
}

// ── the node ─────────────────────────────────────────────────────────────────

// A GATE is a node whose outcome a human confirms. Two ways to be one, and the
// second is the invariant that matters: `kind auto` without a declared check is
// a gate, because the authority to close comes from the check.
export function isGate(t) {
  if (!t) return true;
  if (t.kind !== "auto") return true;
  return !declaredVerify(t);
}

export function gateReason(t) {
  if (!t || t.kind !== "auto")
    return "kind manual — the human moves review -> done, dependents stay blocked by design";
  return "auto WITHOUT a declared verify — a node runs as a gate until a check gives it the authority to close";
}

// Attempts already spent on a node. Derived, never stored: the DSL says the
// counter comes out of `status_history`, and every entry into `in_progress` is
// one attempt at the node.
export function attemptsSoFar(t) {
  const h = Array.isArray(t?.status_history) ? t.status_history : [];
  return h.filter((e) => e && e.status === "in_progress").length;
}

const retryLimitOf = (t) => (typeof t?.retry_limit === "number" ? t.retry_limit : null);

// ── the group ────────────────────────────────────────────────────────────────
// A change is a root that depends_on all of its children, so its members are
// the transitive closure over `depends_on` — the root itself excluded, since
// the runner never executes and never closes the group.
export function collectChange(data, ref) {
  const todos = (data?.todos || []).filter(Boolean);
  const byId = new Map(todos.map((t) => [t.id, t]));
  const root = resolveTask({ todos }, ref);
  if (!root) return { root: null, members: [], byId };
  const members = [];
  const seen = new Set([root.id]);
  let wave = [root.id];
  while (wave.length) {
    const next = [];
    for (const id of wave) {
      const t = byId.get(id);
      for (const dep of Array.isArray(t?.depends_on) ? t.depends_on : []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        const d = byId.get(dep);
        if (!d) continue;
        members.push(d);
        next.push(dep);
      }
    }
    wave = next;
  }
  members.sort((a, b) => (a.number || 0) - (b.number || 0));
  return { root, members, byId };
}

// The frontier: members workable RIGHT NOW. The ready predicate is the board's
// own (`todos ready` / `pipeline` read it too), so there is exactly one
// definition of "blocked" in the codebase. Parked nodes are held out — a node
// the run already handed to a human is not work the runner picks back up.
export function frontierOf({ members, byId, parked = new Set() }) {
  return members
    .filter((t) => !parked.has(t.id) && isReadyNode(t, byId))
    .sort((a, b) => (a.number || 0) - (b.number || 0));
}

// ── the seam ─────────────────────────────────────────────────────────────────

// Dry run: the same loop, everything behind the seam simulated. A step "costs"
// what the node DECLARED as its budget — the only number that exists before the
// work, and the reason the plan can price itself at all.
export function simulationEffects() {
  return {
    executeStep: async ({ task }) => ({ sessionId: `dry:${task.id}`, ok: true }),
    runVerify: async () => ({ code: 0, stdout: "", stderr: "" }),
    reconcile: async () => ({ outcome: "ok", outcome_reason: "dry-run" }),
    setStatus: async () => {},
    recordHandoff: async () => ({ written: false }),
    stepCost: async ({ task }) =>
      typeof task.budget_usd === "number" ? task.budget_usd : null,
  };
}

function trackerCliPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
}

// Every board command the runner issues. It runs them WITHOUT the session id the
// runner itself was started under (t#312): `todos set status` binds whatever
// CLAUDE_CODE_SESSION_ID it finds, so a runner launched from inside Claude Code
// would open a block on its PARENT's session — the one session guaranteed not to
// be doing the node's work — and its later `review`/`done` moves would close the
// parent's own block early. Erased, the run writes exactly one binding per
// attempt: the one run-step.mjs writes for the session that really works the
// node. From a plain terminal nothing changes, the variable was never set there.
function cli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [trackerCliPath(), ...args],
      { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: envWithoutSession() },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// The live seam. `executeStep` / `runVerify` are the other half of t#305
// (run-step.mjs); the board and the predicate go through the CLI, so the runner
// inherits the done-gate, the binding journal and the reconciliation instead of
// reimplementing any of them.
export function liveEffects({ cwd } = {}) {
  const step = async (name, arg) => {
    let mod;
    try {
      mod = await import("./run-step.mjs");
    } catch (err) {
      throw new Error(
        `the step executor is missing: scripts/cli/run-step.mjs could not be loaded (${
          (err && err.message) || err
        }).\nthe runner drives the semantics, run-step.mjs starts the model — without it only --dry-run works`,
      );
    }
    if (typeof mod[name] !== "function")
      throw new Error(`scripts/cli/run-step.mjs exports no ${name}()`);
    return mod[name](arg);
  };
  return {
    executeStep: (a) => step("executeStep", a),
    runVerify: (a) => step("runVerify", a),
    reconcile: async ({ task, verify }) => {
      const r = await cli(
        ["todos", "outcome", String(task.number ?? task.id), "--verify", verify, "--write", "--json"],
        { cwd },
      );
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { outcome: null, outcome_reason: `outcome unreadable: ${r.stderr.trim() || r.code}` };
      }
    },
    setStatus: async ({ task, status }) => {
      const r = await cli(["todos", "set", "status", String(task.number ?? task.id), status], { cwd });
      if (r.code !== 0)
        throw new Error(`set status ${num(task)} ${status} refused: ${r.stderr.trim() || r.stdout.trim()}`);
    },
    // The other end of the seam. The step is TOLD to finish with a `## HANDOFF`
    // (run-step.mjs::buildStepPrompt, rule 4) and has no shell to write it with,
    // so the baton reaches the board only if the run puts it there. Without this
    // the one declared carrier of context between steps (§13) is written by
    // nobody and every step after the first reads "(no handoff)".
    recordHandoff: async ({ task, text }) => {
      const body = String(text ?? "").trim();
      if (!body) return { written: false };
      const r = await cli(
        ["todos", "handoff", "set", String(task.number ?? task.id), "--text", body],
        { cwd },
      );
      return {
        written: r.code === 0,
        error: r.code === 0 ? "" : r.stderr.trim() || r.stdout.trim(),
      };
    },
    // What a step really cost lives in the tracker's blocks (SQLite, Rust side),
    // but the headless run already reports its own total — `executeStep` returns
    // it as `costUsd` (from `total_cost_usd` of the JSON result). Read that name,
    // not a guessed one: a mismatch here reads as "every step unmeasured" and
    // silently disables the budget ceiling. Unknown stays unknown — a declared
    // budget is not a measurement.
    stepCost: async ({ result }) =>
      typeof result?.costUsd === "number" ? result.costUsd : null,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

function park(ctx, kind, task, reason, extra = {}) {
  if (ctx.stop) return;
  ctx.stop = {
    kind,
    task: brief(task),
    status: task ? task.status : null,
    reason,
    parked: true,
    ...extra,
  };
}

async function moveTo(ctx, task, status) {
  if (task.status === status) return;
  await ctx.effects.setStatus({ task, status, dry: ctx.dry });
  task.status = status;
}

// One attempt at one node. Everything it touches is its OWN node, so a wave of
// these can run concurrently; anything that moves another node (the `?issue`
// transition) is returned as an intent and applied in board order afterwards.
// The baton the step wrote, put on the board before anything else reads it. A
// step that left no `## HANDOFF` is reported as `missing` rather than papered
// over: the next node then knows it is starting blind, which is a fact about the
// run and not an error of it.
async function recordBaton(ctx, task, text) {
  if (!String(text ?? "").trim()) return "missing";
  try {
    const r = await ctx.effects.recordHandoff({ task, text });
    return r && r.written === false ? "refused" : "written";
  } catch {
    return "refused";
  }
}

async function runOne(ctx, task, wave = []) {
  const spent = ctx.attempts.get(task.id) ?? attemptsSoFar(task);
  const limit = retryLimitOf(task);
  // Invariant: attempt M+1 NEVER starts. Checked before any work — not after it.
  if (limit !== null && spent + 1 > limit) {
    return { task, kind: "retry-exhausted", attempt: spent, limit, cost: null, session: null };
  }
  const attempt = spent + 1;
  ctx.attempts.set(task.id, attempt);

  await moveTo(ctx, task, "in_progress");
  let result;
  try {
    result = (await ctx.effects.executeStep({
      task,
      board: ctx.data,
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
      alongside: wave.filter((t) => t !== task).map(brief),
    })) || {};
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  const baton = ctx.dry ? null : await recordBaton(ctx, task, result.handoff);
  let cost = null;
  try {
    const c = await ctx.effects.stepCost({ task, sessionId: result.sessionId, result });
    if (typeof c === "number" && Number.isFinite(c)) cost = c;
  } catch {
    cost = null;
  }
  const base = { task, attempt, limit, cost, baton, session: result.sessionId || null };

  // A gate does the WORK and stops at `review`: the human checks one slice, and
  // the dependents stay blocked by construction.
  if (isGate(task)) {
    await moveTo(ctx, task, "review");
    return { ...base, kind: "gate", reason: gateReason(task) };
  }
  if (result.ok === false) {
    return { ...base, kind: "issue", reason: `step failed: ${result.error || "no error reported"}` };
  }

  const verdictRun = await ctx.effects.runVerify({
    cmd: declaredVerify(task),
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
  });
  const verify = Number(verdictRun?.code) === 0 ? "ok" : "issue";
  const report = (await ctx.effects.reconcile({ task, verify })) || {};
  const outcome = report.outcome ?? null;
  const reason = report.outcome_reason || `verify:${verify}`;

  if (outcome === "ok") {
    await moveTo(ctx, task, "done");
    return { ...base, kind: "done", verify, reason };
  }
  if (outcome === "issue") return { ...base, kind: "issue", verify, reason };
  return { ...base, kind: "undecided", verify, reason };
}

// The `?issue` transition and every stop it can produce. All of it runs in board
// order, after the wave — a parallel step never moves another node's status.
async function applyIssue(ctx, r) {
  const task = r.task;
  const limit = r.limit;
  if (limit === null) {
    await moveTo(ctx, task, "review");
    park(
      ctx,
      "retry",
      task,
      `outcome issue (${r.reason}) and NO declared retry limit — a missing limit forbids the ?issue transition, it does not permit an endless one`,
    );
    return;
  }
  if (r.attempt >= limit) {
    await moveTo(ctx, task, "review");
    park(ctx, "retry", task, `retry limit exhausted — ${r.attempt}/<=${limit}, predicate issue (${r.reason})`);
    return;
  }
  const target = task.on_issue ? ctx.byId.get(task.on_issue) : null;
  if (!target) {
    await moveTo(ctx, task, "review");
    park(
      ctx,
      "retry",
      task,
      task.on_issue
        ? `outcome issue and the declared ?issue target ${task.on_issue} is not on the board`
        : `outcome issue (${r.reason}) and no ?issue transition declared — there is nowhere to hand control`,
    );
    return;
  }
  // Point return: the transition TARGET is reopened, the `done` nodes between it
  // and the failing node stay closed (§11's open direction, decided here).
  await moveTo(ctx, target, "queue");
  await moveTo(ctx, task, "queue");
  ctx.transitions.push({
    from: brief(task),
    to: brief(target),
    attempt: r.attempt,
    limit,
    reason: r.reason,
  });
}

function blockedDiagnosis(ctx) {
  return ctx.members
    .filter((t) => !isDone(t))
    .map((t) => ({
      task: brief(t),
      status: t.status,
      blocked_by: (Array.isArray(t.depends_on) ? t.depends_on : [])
        .map((id) => ctx.byId.get(id))
        .filter((d) => d && !isDone(d))
        .map(brief),
    }));
}

// The run loop. `data` is cloned first, so nothing the engine does is visible on
// the caller's object — the board changes only through the setStatus seam.
export async function runChange({
  data,
  change,
  effects = {},
  dry = true,
  cwd = process.cwd(),
  // Undeclared by default on purpose: the ceiling of a step and of a check
  // belongs to the executor (run-step.mjs), and a second default here would
  // silently override it. Only an explicit --timeout speaks.
  timeoutMs,
  parallelLimit,
  log = () => {},
  maxSteps,
}) {
  const board = structuredClone(data ?? { version: 1, todos: [] });
  const { root, members, byId } = collectChange(board, change);
  if (!root) throw new Error(`no such task: ${change}`);

  const limit =
    (typeof parallelLimit === "number" && parallelLimit > 0 && Math.floor(parallelLimit)) ||
    (typeof root.parallel_limit === "number" && root.parallel_limit > 0
      ? Math.floor(root.parallel_limit)
      : DEFAULT_PARALLEL_LIMIT);
  const groupBudget = typeof root.budget_usd === "number" ? root.budget_usd : null;

  // In dry mode the seam is the simulator, full stop: a caller's effects are not
  // merged in, so `--dry-run` cannot start a model or move the board even by
  // mistake. Only the cost estimator may be supplied.
  const sim = simulationEffects();
  const ctx = {
    data: board,
    root,
    members,
    byId,
    dry,
    cwd,
    timeoutMs,
    effects: dry
      ? { ...sim, stepCost: effects.stepCost ?? sim.stepCost }
      : { ...liveEffects({ cwd }), ...effects },
    attempts: new Map(),
    parked: new Set(),
    transitions: [],
    steps: [],
    waves: [],
    spent: 0,
    nodeSpent: new Map(),
    unknownCost: 0,
    stop: null,
    maxParallel: 0,
  };

  const bound = maxSteps ?? members.length * 8 + 8;

  while (!ctx.stop) {
    const ready = frontierOf(ctx);
    if (!ready.length) {
      if (members.every((t) => isDone(t))) break;
      park(
        ctx,
        "empty-frontier",
        null,
        "the frontier is empty while the change is still open — no node has all of its prerequisites closed, so the graph lies: edges are missing or a cycle is written into depends_on",
        { blocked: blockedDiagnosis(ctx) },
      );
      break;
    }
    // Budget is checked on the BOUNDARY of a step, before a new wave is
    // dispatched: whatever is running is always finished, never killed
    // mid-flight, and nothing already spent is given back.
    if (groupBudget !== null && ctx.spent >= groupBudget) {
      park(
        ctx,
        "budget",
        ready[0],
        `group budget exhausted — $${round(ctx.spent)} of $${groupBudget} spent; the step boundary is where the run stops, so #${ready[0].number} was NOT started and nothing was rolled back`,
        { spent: round(ctx.spent), budget: groupBudget, not_started: brief(ready[0]) },
      );
      break;
    }
    // A node already sitting in `review` is the human's inbox, not work to redo:
    // the runner parks on it exactly as it would on a fresh gate.
    const pending = ready.find((t) => t.status === "review");
    if (pending) {
      ctx.parked.add(pending.id);
      park(
        ctx,
        "gate",
        pending,
        "already in review from an earlier step — the runner never takes a node back out of the human's column",
      );
      break;
    }

    const wave = ready.slice(0, limit);
    ctx.waves.push(wave.map((t) => t.number));
    if (ctx.steps.length + wave.length > bound) {
      park(ctx, "empty-frontier", null, `runaway guard: more than ${bound} steps in one run — the graph or the seam is looping`);
      break;
    }
    let live_ = 0;
    const results = await Promise.all(
      wave.map(async (t) => {
        live_ += 1;
        ctx.maxParallel = Math.max(ctx.maxParallel, live_);
        try {
          return await runOne(ctx, t, wave);
        } finally {
          live_ -= 1;
        }
      }),
    );

    for (const r of results.sort((a, b) => (a.task.number || 0) - (b.task.number || 0))) {
      if (typeof r.cost === "number") {
        ctx.spent += r.cost;
        ctx.nodeSpent.set(r.task.id, (ctx.nodeSpent.get(r.task.id) || 0) + r.cost);
      } else if (r.kind !== "retry-exhausted") {
        ctx.unknownCost += 1;
      }
      const record = {
        task: brief(r.task),
        wave: ctx.waves.length,
        attempt: r.attempt,
        retry_limit: r.limit,
        session: r.session,
        cost_usd: r.cost,
        baton: r.baton ?? null,
        gate: r.kind === "gate",
        verify: r.verify ?? null,
        outcome: r.kind === "done" ? "ok" : r.kind === "issue" ? "issue" : null,
        result: r.kind,
        reason: r.reason || null,
        status: r.task.status,
      };
      ctx.steps.push(record);
      log(formatStepLine(record, dry));

      if (r.kind === "gate") {
        ctx.parked.add(r.task.id);
        park(ctx, "gate", r.task, r.reason);
        continue;
      }
      if (r.kind === "retry-exhausted") {
        ctx.parked.add(r.task.id);
        await moveTo(ctx, r.task, "review");
        park(
          ctx,
          "retry",
          r.task,
          `attempt ${r.attempt + 1} would be past the declared limit — ${r.attempt}/<=${r.limit}; attempt M+1 never starts`,
        );
        continue;
      }
      if (r.kind === "undecided") {
        ctx.parked.add(r.task.id);
        await moveTo(ctx, r.task, "review");
        park(ctx, "outcome", r.task, `the outcome could not be finalized (${r.reason}) — nothing is closed on a guess`);
        continue;
      }
      if (r.kind === "issue") {
        const before = ctx.stop;
        await applyIssue(ctx, r);
        if (ctx.stop && ctx.stop !== before) ctx.parked.add(r.task.id);
        record.status = r.task.status;
        continue;
      }
      // done — the node's own budget is a ceiling too, and reaching it stops the
      // run on this same boundary. Nothing already spent is given back.
      record.status = r.task.status;
      // The group ceiling gates the START of new work (nothing may begin unless
      // budget is LEFT); a node ceiling is about the node's own overrun, so it
      // fires only when the step actually spent past it — a step that costs
      // exactly what it declared stayed inside its budget.
      const own = ctx.nodeSpent.get(r.task.id) || 0;
      if (typeof r.task.budget_usd === "number" && own > r.task.budget_usd) {
        park(ctx, "budget", r.task, `node budget overrun — $${round(own)} spent against a declared $${r.task.budget_usd}`, {
          spent: round(own),
          budget: r.task.budget_usd,
        });
      }
    }
  }

  const complete = !ctx.stop && members.every((t) => isDone(t));
  return {
    version: 1,
    kind: "change.run",
    dry,
    change: {
      ...brief(root),
      is_change: isChangeRoot(root),
      parallel_limit: limit,
      parallel_declared: typeof root.parallel_limit === "number" ? root.parallel_limit : null,
      budget_usd: groupBudget,
      status: root.status,
    },
    members: members.map((t) => ({ ...brief(t), status: t.status, gate: isGate(t) })),
    waves: ctx.waves,
    max_parallel: ctx.maxParallel,
    steps: ctx.steps,
    transitions: ctx.transitions,
    spend: {
      usd: round(ctx.spent),
      unmeasured_steps: ctx.unknownCost,
      group_budget: groupBudget,
    },
    stop: ctx.stop,
    complete,
    board: board,
  };
}

const round = (n) => Math.round(n * 10000) / 10000;

// ── output ───────────────────────────────────────────────────────────────────

function formatStepLine(s, dry) {
  const verb = dry ? (s.gate ? "would run, then park (gate)" : "would run") : s.result;
  const cost = typeof s.cost_usd === "number" ? ` $${round(s.cost_usd)}` : "";
  const attempt = s.retry_limit !== null ? ` ${s.attempt}/<=${s.retry_limit}` : ` attempt ${s.attempt}`;
  // A step that wrote no baton leaves the next one blind, and nothing else in
  // the report says so — the node still reads `done`.
  const baton =
    dry || s.baton === "written" || s.baton == null
      ? ""
      : s.baton === "refused"
        ? " · baton REFUSED by the board"
        : " · NO baton — it wrote no ## HANDOFF";
  return `  wave ${s.wave}  #${s.task.number} ${s.task.subject} — ${verb}${attempt}${cost}${baton}\n`;
}

// All four stops print the SAME shape: the node, the reason, "pipeline parked",
// and what is expected of the human. Only the reason line differs.
export function formatStop(stop) {
  if (!stop) return "";
  const out = [`\n⏸ pipeline parked — ${stop.kind}\n`];
  if (stop.task)
    out.push(`   node:   #${stop.task.number} "${stop.task.subject}" [${stop.status}]\n`);
  out.push(`   reason: ${stop.reason}\n`);
  if (Array.isArray(stop.blocked) && stop.blocked.length) {
    out.push("   blocked nodes and what holds them:\n");
    for (const b of stop.blocked) {
      const by = b.blocked_by.length
        ? b.blocked_by.map((d) => `#${d.number}`).join(", ")
        : "nothing on the board — its prerequisites are gone";
      out.push(`     #${b.task.number} [${b.status}] ${b.task.subject} ← ${by}\n`);
    }
  }
  out.push(
    "   next:   yours. the runner does not push a node past its check — --force is a human exception, not the runner's.\n",
  );
  return out.join("");
}

export function formatRunReport(r) {
  const out = [];
  const th = r.change;
  out.push(
    `change #${th.number} "${th.subject}" — ${r.members.length} node(s), parallel limit ${th.parallel_limit}` +
      `${th.parallel_declared === null ? " (undeclared, default 1)" : ""}` +
      `${th.budget_usd === null ? ", budget UNDECLARED" : `, budget $${th.budget_usd}`}\n`,
  );
  if (!th.is_change)
    out.push("  note: this node is not marked as a change — running its dependency closure anyway\n");
  out.push(
    r.dry
      ? "plan of the run (dry — no model was started, the board was not touched):\n"
      : "run:\n",
  );
  if (!r.steps.length) out.push("  (nothing to run — the frontier was empty from the start)\n");
  for (const s of r.steps) out.push(formatStepLine(s, r.dry));
  for (const t of r.transitions)
    out.push(
      `  ?issue  #${t.from.number} → #${t.to.number} — ${t.reason} (attempt ${t.attempt}/<=${t.limit}; the target is reopened, closed nodes below it stay closed)\n`,
    );
  const spend = r.dry
    ? `  ${r.spend.usd ? `$${r.spend.usd}` : "$0"} by DECLARED budgets${
        r.spend.group_budget !== null ? ` of $${r.spend.group_budget} declared on the group` : " (no group budget declared)"
      }\n`
    : `  spent $${r.spend.usd}${
        r.spend.group_budget !== null ? ` of $${r.spend.group_budget}` : ""
      }${r.spend.unmeasured_steps ? `; ${r.spend.unmeasured_steps} step(s) unmeasured` : ""}\n`;
  out.push(spend);
  if (r.stop) out.push(formatStop(r.stop));
  else if (r.complete)
    out.push(
      `\n✓ every node of the change is closed. The change root #${th.number} stays open — the runner never closes the group.\n`,
    );
  return out.join("");
}

// ── command ──────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const f = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") f.json = true;
    else if (a === "--dry-run" || a === "--dry") f.dry = true;
    else if (a === "--go") f.go = true;
    else if (a === "--force") f.force = true;
    else if (a === "--parallel") f.parallel = args[++i];
    else if (a.startsWith("--parallel=")) f.parallel = a.slice("--parallel=".length);
    else if (a === "--timeout") f.timeout = args[++i];
    else if (a.startsWith("--timeout=")) f.timeout = a.slice("--timeout=".length);
    else if (a === "-h" || a === "--help" || a === "help") f.help = true;
    else if (a.startsWith("--")) fail(`unknown flag: ${a}`);
    else f.positional.push(a);
  }
  return f;
}

function usage(code) {
  process.stdout.write(
    "usage: cli todos run <change> [--dry-run | --go] [--parallel N] [--timeout <min>] [--json]\n\n" +
      "  Executes a change's task graph: frontier -> step -> verify -> outcome, one\n" +
      "  session per step, until the run parks. What it executes is what already\n" +
      "  stands in the graph — the runner creates no tasks and closes no change.\n\n" +
      "  <change>       an id, a number, or #N (its dependency closure is the group)\n" +
      "  --dry-run      DEFAULT: print the plan — the order of steps, what would run,\n" +
      "                 where it would hit a gate, what it would cost by the DECLARED\n" +
      "                 budgets. Touches neither the board nor a model.\n" +
      "  --go           actually run it. Requires a budget declared on the change.\n" +
      "  --parallel N   override the change's declared parallel limit for this run\n" +
      "  --timeout <min>  ceiling for a step and for a check; without it the step\n" +
      "                 executor's own defaults stand (run-step.mjs)\n" +
      "  --json         the run report, machine-readable\n\n" +
      "  Four stops, all printed the same way (node in review + reason + parked):\n" +
      "    gate            a manual node, or an `auto` one with no declared verify\n" +
      "    retry           the declared limit is spent (M/<=M), or none was declared\n" +
      "                    at all — a missing limit forbids the ?issue transition\n" +
      "    budget          soft, on a step boundary; nothing is rolled back\n" +
      "    empty-frontier  the change is open but nothing is workable — the graph lies\n\n" +
      "  Exit code: 0 when the change finished or parked at a gate, 1 otherwise.\n" +
      "  There is no --force here: overriding a failed check is a human exception.\n",
  );
  process.exit(code);
}

export async function run(args) {
  const f = parseFlags(args);
  const ref = f.positional[0];
  if (f.help) usage(0);
  if (!ref) usage(1);
  if (f.force)
    fail(
      "--force is not the runner's to use: a failed check is overridden by a human, never by an autonomous run.\n" +
        "close the node yourself with `todos set status <task> done --force` if that is really your call.",
    );
  if (f.go && f.dry) fail("--go and --dry-run ask for opposite things — pick one");

  const dry = !f.go;
  const file = appDataFile("todos.json");
  const data = loadTodos(file);
  const { root } = collectChange(data, ref);
  if (!root) fail(`no such task: ${ref}`);
  if (!dry && typeof root.budget_usd !== "number") {
    fail(
      `refusing to run #${root.number} unattended: no budget is declared on the change.\n` +
        "an autonomous run needs a ceiling it can stop itself at — declare one first:\n" +
        `  todos set budget ${root.number} <usd>`,
    );
  }

  let parallel;
  if (f.parallel !== undefined) {
    parallel = Number(f.parallel);
    if (!Number.isInteger(parallel) || parallel <= 0) fail(`--parallel takes a positive whole number`);
  }
  let timeoutMs;
  if (f.timeout !== undefined) {
    const min = Number(f.timeout);
    if (!Number.isFinite(min) || min <= 0) fail("--timeout takes a positive number of minutes");
    timeoutMs = min * 60_000;
  }

  const report = await runChange({
    data,
    change: ref,
    dry,
    parallelLimit: parallel,
    timeoutMs,
    cwd: process.cwd(),
    log: dry || f.json ? () => {} : (line) => process.stdout.write(line),
  });
  delete report.board;

  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatRunReport(report));

  if (report.stop && report.stop.kind !== "gate") process.exit(1);
}
