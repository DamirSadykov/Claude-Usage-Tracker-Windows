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
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";

import {
  resolveTask,
  isReadyNode,
  isDone,
  isChangeRoot,
  changeAsRoot,
  envWithoutSession,
  boardPath,
  loadBoard,
  loadBoardForWrite,
  saveBoard,
  readTaskSessionEvents,
} from "../board/todos.mjs";
import { findChange } from "../board/change.mjs";
import { resolveDuty } from "../agents/agents.mjs";
import { withBoardLock } from "../kernel/board-lock.mjs";
import { appDataFile } from "../kernel/appdata.mjs";
import {
  gitHead,
  gitBase,
  snapshotTree,
  diffNameStatus,
  computeNeighbourDamage,
  runRedGate,
  recoverMarkers,
} from "./red-gate.mjs";
import { bestAttempt, blockingCount, restoreCheckpoint } from "./checkpoint.mjs";
import { appendRunEvent, runEventsPath, watchRunEvents } from "./run-events.mjs";

export const DEFAULT_PARALLEL_LIMIT = 1;

const brief = (t) => (t ? { id: t.id, number: t.number, subject: t.subject } : null);

const reviewPath = (value) => String(value || "").replace(/\\/g, "/");

function retryChangedLocations(cwd, from, to) {
  let output;
  try {
    output = execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", "--unified=0", from, to], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const byPath = new Map();
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("diff --git a/") && line.includes(" b/")) {
      current = reviewPath(line.slice(line.indexOf(" b/") + 3));
      if (!byPath.has(current)) byPath.set(current, []);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      current = reviewPath(line.slice(6));
      if (!byPath.has(current)) byPath.set(current, []);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    byPath.get(current).push({
      oldStart: Number(hunk[1]), oldCount: Number(hunk[2] || 1),
      newStart: Number(hunk[3]), newCount: Number(hunk[4] || 1),
    });
  }
  return byPath;
}

function retryPatch(cwd, from, to) {
  try {
    return execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", from, to], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function touchesFinding(ranges, line) {
  if (!Number.isInteger(line) || line < 1) return false;
  return (ranges || []).some(({ oldStart, oldCount, newStart, newCount }) =>
    (oldCount > 0 && line >= oldStart && line < oldStart + oldCount) ||
    (newCount > 0 && line >= newStart && line < newStart + newCount));
}
const num = (t) => (t && t.number != null ? `#${t.number}` : t ? t.id : "?");
const declaredVerify = (t) => (t && t.verify && String(t.verify).trim()) || "";
const declaredRed = (t) => (t && t.red && String(t.red).trim()) || "";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function redGateDir() {
  return appDataFile("red-gate");
}

function recoverRedGate(cwd) {
  recoverMarkers({ appDataDir: redGateDir(), cwd });
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
  const mechanical = Array.isArray(t?.attempts) ? t.attempts.filter((a) => a?.mechanics === true).length : 0;
  return Math.max(0, h.filter((e) => e && e.status === "in_progress").length - mechanical);
}

const retryLimitOf = (t) => (typeof t?.retry_limit === "number" ? t.retry_limit : null);

// ── the group ────────────────────────────────────────────────────────────────
// A change is a root that depends_on all of its children, so its members are
// the transitive closure over `depends_on` — the root itself excluded, since
// the runner never executes and never closes the group.
export function collectChange(data, ref) {
  const todos = (data?.todos || []).filter(Boolean);
  const byId = new Map(todos.map((t) => [t.id, t]));
  const record = findChange(data ?? {}, ref);
  if (record) {
    const members = todos
      .filter((t) => t.change_id === record.id)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    return { root: changeAsRoot(record, data), members, byId };
  }
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
    reviewStep: async () => ({ approved: true, ok: true, skipped: true, costUsd: 0 }),
    runVerify: async () => ({ code: 0, stdout: "", stderr: "" }),
    reconcile: async () => ({ outcome: "ok", outcome_reason: "dry-run" }),
    setStatus: async () => {},
    recordHandoff: async () => ({ written: false }),
    recordIssue: async () => ({ written: false }),
    stepBase: async () => ({ ok: true, sha: "dry" }),
    priorChanges: async () => ({ ok: true, changes: null }),
    ownChanges: async () => ({ ok: true, skip: true }),
    redGate: async () => ({ ok: true, field: "failed-on-base", reason: null }),
    stepCost: async ({ task }) =>
      typeof task.budget_usd === "number" ? task.budget_usd : null,
  };
}

function trackerCliPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
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
        `the step executor is missing: scripts/cli/process/run-step.mjs could not be loaded (${
          (err && err.message) || err
        }).\nthe runner drives the semantics, run-step.mjs starts the model — without it only --dry-run works`,
      );
    }
    if (typeof mod[name] !== "function")
      throw new Error(`scripts/cli/process/run-step.mjs exports no ${name}()`);
    return mod[name](arg);
  };
  return {
    executeStep: (a) => step("executeStep", a),
    reviewStep: (a) => step("executeReview", a),
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
    recordIssue: async ({ task, comment }) => {
      const file = appDataFile("todos.json");
      return withBoardLock(file, () => {
        const data = loadBoardForWrite(file);
        const todo = data.todos.find((t) => t && t.id === task.id);
        if (!todo) return { written: false, error: `task ${task.id} not found on the board` };
        if (!Array.isArray(todo.comments)) todo.comments = [];
        todo.comments.push(comment);
        todo.updated_at = comment.created_at;
        saveBoard(file, data);
        return { written: true };
      });
    },
    stepBase: async ({ task, cwd }) => {
      const based = gitBase(cwd);
      if (!based.ok) return { ok: false, error: based.error };
      const file = appDataFile("todos.json");
      const write = withBoardLock(file, () => {
        const data = loadBoardForWrite(file);
        const todo = data.todos.find((t) => t && t.id === task.id);
        if (!todo) return { written: false, error: `task ${task.id} not found on the board` };
        todo.step_base = based.sha;
        todo.updated_at = new Date().toISOString();
        saveBoard(file, data);
        return { written: true };
      });
      if (!write.written) return { ok: false, error: write.error };
      return { ok: true, sha: based.sha };
    },
    recordAttempt: async ({ task, cwd, entry }) => {
      const snap = snapshotTree(cwd);
      const saved = { ...entry, snapshot: snap.ok ? snap.sha : null };
      const file = appDataFile("todos.json");
      return withBoardLock(file, () => {
        const data = loadBoardForWrite(file);
        const todo = data.todos.find((t) => t && t.id === task.id);
        if (!todo) return { written: false, error: `task ${task.id} not found on the board` };
        if (!Array.isArray(todo.attempts)) todo.attempts = [];
        todo.attempts.push(saved);
        todo.updated_at = new Date().toISOString();
        saveBoard(file, data);
        return { written: true, snapshot: saved.snapshot };
      });
    },
    priorChanges: async ({ task, cwd }) => {
      if (!task.step_base) return { ok: true, changes: null };
      const head = gitHead(cwd);
      if (!head.ok) return { ok: false, error: head.error };
      const changes = diffNameStatus(cwd, head.sha, task.step_base);
      if (!Array.isArray(changes)) return { ok: false, error: changes.error };
      return { ok: true, changes };
    },
    ownChanges: async ({ task, cwd, editedPaths }) => {
      if (!task.step_base) return { ok: true, skip: true };
      const head = gitHead(cwd);
      if (!head.ok) return { ok: false, error: head.error };
      const end = snapshotTree(cwd);
      if (!end.ok) return { ok: false, error: end.error };
      const damage = computeNeighbourDamage({
        cwd,
        head: head.sha,
        stepBase: task.step_base,
        end: end.sha,
        produces: task.produces,
        edited: editedPaths,
      });
      if (!damage.ok) return { ok: false, error: damage.error };
      return { ok: true, own: damage.own, outside: damage.outside, damaged: damage.damaged };
    },
    reviewContext: async ({ task, cwd, neighbours = [] }) => {
      const previousAttempt = priorAttempts(task).at(-1);
      const current = snapshotTree(cwd);
      let attemptDiff = null;
      let attemptPatch = null;
      let changedLocations = null;
      if (previousAttempt?.snapshot && current.ok) {
        const changed = diffNameStatus(cwd, previousAttempt.snapshot, current.sha);
        if (Array.isArray(changed)) attemptDiff = changed;
        attemptPatch = retryPatch(cwd, previousAttempt.snapshot, current.sha);
        changedLocations = retryChangedLocations(cwd, previousAttempt.snapshot, current.sha);
      }
      const outsideFindings = (attemptDiff || []).filter((change) => {
        const path = reviewPath(change?.path);
        const findings = (previousAttempt?.findings || []).filter((f) => reviewPath(f?.file) === path);
        return !findings.some((finding) => touchesFinding(changedLocations?.get(path), Number(finding?.line)));
      });
      return {
        previousAttempt: previousAttempt || null,
        attemptDiff,
        attemptPatch,
        outsideFindings,
        neighbours: neighbours.map((t) => ({ number: t.number, subject: t.subject, produces: Array.isArray(t.produces) ? t.produces : [] })),
      };
    },
    redGate: async ({ task, cwd, timeoutMs }) => {
      let mod;
      try {
        mod = await import("./run-step.mjs");
      } catch (err) {
        return {
          ok: false,
          field: null,
          reason: `the step executor is missing: scripts/cli/process/run-step.mjs could not be loaded (${
            (err && err.message) || err
          })`,
        };
      }
      return runRedGate({ task, cwd, timeoutMs, appDataDir: redGateDir(), runCmd: mod.runVerify });
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

// ── what a run leaves behind ─────────────────────────────────────────────────

// Until now a run printed its report to stdout and forgot it: no cost on the
// board, no record of where it parked, nothing to compare two runs by. That is
// why the agent-mode run of c#18 could never be priced afterwards, and why the
// question "how often is one pass over the graph enough" had no answer at all.
//
// The journal answers exactly that. One append-only line per run (and per
// reported step in the driven mode), next to the board, never inside it — the
// tracker's own writer owns todos.json, and a log that grows without bound has
// no business in a file the UI rewrites.
export function runLogPath() {
  return appDataFile("runs.jsonl");
}

function emitRunEvent(ctx, event) {
  if (ctx.dry || !ctx.events) return;
  const task = event.task == null ? null : `t#${String(event.task).replace(/^t?#/, "")}`;
  appendRunEvent({ run: ctx.runId, change: `c#${ctx.root.number}`, ...event, task }, runEventsPath(runLogPath()));
}

export function appendRunRecord(rec, file = runLogPath()) {
  if (!rec) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readRunLog(file = runLogPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

// The record of a `--go` run: what it executed, what it cost, and — the point
// of the whole journal — whether one pass was enough and, if not, which of the
// four stops ate it.
export function runRecordOf(report, { inherit = false } = {}) {
  return {
    kind: "run",
    change: report.change ? { number: report.change.number, subject: report.change.subject } : null,
    inherit: !!inherit,
    parallel_limit: report.change ? report.change.parallel_limit : null,
    nodes: (report.members || []).length,
    waves: (report.waves || []).length,
    steps: (report.steps || []).map((s) => ({
      task: s.task ? s.task.number : null,
      attempt: s.attempt ?? null,
      result: s.result,
      verify: s.verify ?? null,
      red: s.red ?? null,
      cost_usd: typeof s.cost_usd === "number" ? s.cost_usd : null,
      session: s.session || null,
      requested_mode: s.requested_mode || null,
      start_mode: s.start_mode || "unknown",
      parent_session: s.parent_session || null,
      provider: s.provider || null,
      model: s.model || null,
      route: s.route || null,
      review: s.review || null,
      reason: s.reason || null,
      own_changes: typeof s.own_changes === "number" ? s.own_changes : null,
      outside_changes: typeof s.outside_changes === "number" ? s.outside_changes : null,
      neighbour_damage: typeof s.neighbour_damage === "number" ? s.neighbour_damage : null,
    })),
    spend: report.spend || null,
    refused: (report.refused || []).length,
    transitions: (report.transitions || []).length,
    architect_findings: report.architect_findings || [],
    stop: report.stop ? { kind: report.stop.kind, task: report.stop.task ? report.stop.task.number : null, reason: report.stop.reason } : null,
    complete: !!report.complete,
    one_pass: !!report.complete && !report.stop && (report.steps || []).every((s) => (s.attempt ?? 1) === 1),
  };
}

// The same line for the driven mode, where a "run" is one reported node and the
// loop lives in the caller. Kept in the same journal on purpose: the question
// "what did this change cost end to end" must not depend on who drove it.
export function reportRecordOf(report) {
  const s = report.step || {};
  return {
    kind: "report",
    change: report.change ? { number: report.change.number, subject: report.change.subject } : null,
    steps: [
      {
        task: s.task ? s.task.number : null,
        attempt: s.attempt ?? null,
        result: s.result,
        verify: s.verify ?? null,
        red: s.red ?? null,
        cost_usd: typeof s.cost_usd === "number" ? s.cost_usd : null,
        session: s.session || null,
        requested_mode: s.requested_mode || null,
        start_mode: s.start_mode || "unknown",
        parent_session: s.parent_session || null,
        provider: s.provider || null,
        model: s.model || null,
        route: s.route || null,
        review: s.review || null,
        reason: s.reason || null,
        own_changes: typeof s.own_changes === "number" ? s.own_changes : null,
        outside_changes: typeof s.outside_changes === "number" ? s.outside_changes : null,
        neighbour_damage: typeof s.neighbour_damage === "number" ? s.neighbour_damage : null,
      },
    ],
    refused: (report.refused || []).length,
    stop: report.next && report.next.stop ? { kind: report.next.stop.kind, task: null, reason: report.next.stop.reason } : null,
    complete: !!(report.next && report.next.complete),
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
  emitRunEvent(ctx, { task: task?.number, kind: "park", park_kind: kind, reason });
}

function nodeSpend(task, current = 0) {
  const prior = (task?.attempts || []).reduce(
    (sum, attempt) => sum + (Number.isFinite(attempt?.cost_usd) ? attempt.cost_usd : 0),
    0,
  );
  return round(prior || (Number.isFinite(current) ? current : 0));
}

export function formatDecisionCard(stop, { task = null, change = null, spent = 0 } = {}) {
  if (!stop) return "";
  const out = [`\nDecision card — ${stop.kind}\n`, `reason: ${stop.reason}\n`];
  if (!task) return out.join("");
  const last = (task.attempts || []).at(-1) || {};
  const tail = String(last.verify_tail || "").trim();
  const findings = Array.isArray(last.findings) ? last.findings : [];
  const limit = retryLimitOf(task);
  out.push(`node: t#${task.number}; spent: $${round(spent)}${typeof task.budget_usd === "number" ? ` of $${task.budget_usd} budget` : " (no node budget declared)"}\n`);
  if (tail) out.push(`verify tail (last 20 lines):\n${tailLines(tail, 20)}\n`);
  if (findings.length) {
    out.push("last review findings:\n");
    for (const finding of findings)
      out.push(`  [${finding.level || "unknown"}] ${finding.file || "(file not specified)"}${finding.line ? `:${finding.line}` : ""} ${finding.text || ""}\n`);
  }
  const retry = (limit ?? 0) + 2;
  const changeRef = change?.number == null ? "c#<change>" : `c#${change.number}`;
  out.push("actions:\n");
  out.push(`  accept as is: todos set status t#${task.number} done\n`);
  out.push(`  allow more attempts: todos set retry t#${task.number} ${retry}\n`);
  out.push(`                       todos run ${changeRef} --go\n`);
  out.push("  split the work: todos apply <new plan>\n");
  out.push(`  fix by hand: edit the files, then todos set status t#${task.number} done\n`);
  return out.join("");
}

async function attachDecisionCard(ctx) {
  if (!ctx.stop) return null;
  const task = ctx.stop.task ? ctx.byId.get(ctx.stop.task.id) : null;
  const spent = task ? nodeSpend(task, ctx.nodeSpent.get(task.id) || 0) : 0;
  const card = formatDecisionCard(ctx.stop, { task, change: ctx.root, spent });
  ctx.stop.card = card;
  if ((!ctx.dry || ctx.persistDecisionCard) && task) {
    const comment = {
      id: randomUUID(), author: "review", body: card.trim(), created_at: new Date().toISOString(),
    };
    (task.comments ??= []).push(comment);
    try { await ctx.effects.recordIssue?.({ task, comment }); } catch {}
  }
  return card;
}

// A refused transition is DATA, not a crash. The board can legitimately say no
// — the done-gate refuses a node whose prerequisite is not closed — and the
// runner used to let that throw out of the wave: the whole report died with it,
// including what the steps had already spent (t#528). The caller decides what a
// refusal means for its node; nothing here rewrites the status it failed to set.
async function moveTo(ctx, task, status) {
  if (task.status === status) return { ok: true };
  try {
    await ctx.effects.setStatus({ task, status, dry: ctx.dry });
  } catch (err) {
    const error = String((err && err.message) || err);
    if (Array.isArray(ctx.refused)) ctx.refused.push({ task: brief(task), status, error });
    return { ok: false, error };
  }
  task.status = status;
  return { ok: true };
}

async function recordBaton(ctx, task, text) {
  if (!String(text ?? "").trim()) return "missing";
  try {
    const r = await ctx.effects.recordHandoff({ task, text });
    return r && r.written === false ? "refused" : "written";
  } catch {
    return "refused";
  }
}

// Which finished session, if any, this step should be forked from. The choice
// belongs to whoever spawns the step, and for `--go` that is this loop, under
// one rule: exactly ONE direct prerequisite ran in this run, so its context is
// unambiguously the one to carry. Two prerequisites cannot be merged, and
// picking either would drop the other's context without saying so — a
// convergence node starts cold and that is visible in the report.
export function inheritFrom(ctx, task) {
  if (!ctx.inherit) return "";
  const own = (Array.isArray(task.depends_on) ? task.depends_on : [])
    .map((id) => ctx.sessions.get(id))
    .filter(Boolean);
  return own.length === 1 ? own[0] : "";
}

export function stepBrief(ctx, task, wave, { attempt, limit, priorChanges } = {}) {
  return {
    task,
    board: ctx.data,
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    alongside: wave.filter((t) => t !== task).map(brief),
    inherit: inheritFrom(ctx, task),
    attempt,
    limit,
    priorChanges,
  };
}

// Everything BEFORE the executor runs. One attempt at one node — it touches
// only that node's own bookkeeping (ctx.attempts, its own status), so a wave of
// these can run concurrently without one stepping on another's state.
export async function beginStep(ctx, task, wave = []) {
  const spent = ctx.attempts.get(task.id) ?? attemptsSoFar(task);
  const limit = retryLimitOf(task);
  // Invariant: attempt M+1 NEVER starts. Checked before any work — not after it.
  if (limit !== null && spent + 1 > limit) {
    return { task, kind: "retry-exhausted", attempt: spent, limit, cost: null, session: null };
  }
  const based = await recordStepBase(ctx, task);
  if (!based.ok) {
    if (declaredRed(task)) {
      return {
        task,
        kind: "red-base-failed",
        attempt: spent,
        limit,
        cost: null,
        session: null,
        reason: `red declared but ${ctx.cwd} is not a git work tree${based.error ? `: ${based.error}` : ""}`,
      };
    }
    if (!ctx.stepBaseWarned) {
      ctx.stepBaseWarned = true;
      process.stderr.write(
        `run: step base unavailable for ${ctx.cwd}${based.error ? `: ${based.error}` : ""} — continuing without it, this run's produces/scope checks are best-effort\n`,
      );
    }
  }
  let priorChanges = null;
  if (task.step_base) {
    try {
      const pr = (await ctx.effects.priorChanges({ task, cwd: ctx.cwd })) || {};
      if (pr.ok) priorChanges = pr.changes ?? null;
    } catch {}
  }
  const attempt = spent + 1;
  ctx.attempts.set(task.id, attempt);
  if (task._runner_high_route_pending) {
    task._runner_high_route_pending = false;
    task._runner_high_route_used = true;
    task._runner_high_route_attempt = attempt;
    task.risk = "high";
  }

  await moveTo(ctx, task, "in_progress");
  emitRunEvent(ctx, { task: task.number, kind: "step_start", attempt, limit, route: task._runner_high_route_used ? "high" : null });
  return {
    task,
    kind: "begin",
    attempt,
    limit,
    brief: stepBrief(ctx, task, wave, { attempt, limit, priorChanges }),
  };
}

async function recordStepBase(ctx, task) {
  if (task.step_base) return { ok: true };
  let result;
  try {
    result = (await ctx.effects.stepBase({ task, cwd: ctx.cwd })) || {};
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  if (!result.ok) return { ok: false, error: result.error };
  task.step_base = result.sha;
  return { ok: true };
}

// The baton the step wrote, put on the board before anything else reads it. A
// step that left no `## HANDOFF` is reported as `missing` rather than papered
// over: the next node then knows it is starting blind, which is a fact about the
// run and not an error of it.
async function recordWork(ctx, task, result) {
  const baton = ctx.dry ? null : await recordBaton(ctx, task, result.handoff);
  let cost = null;
  try {
    const c = await ctx.effects.stepCost({ task, sessionId: result.sessionId, result });
    if (typeof c === "number" && Number.isFinite(c)) cost = c;
  } catch {
    cost = null;
  }
  emitRunEvent(ctx, { task: task.number, kind: "worker_done", attempt: ctx.attempts.get(task.id), limit: retryLimitOf(task), cost });
  return { baton, cost };
}

const clampChars = (s, max) => {
  const t = String(s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… [${t.length - max} chars elided] …`;
};

const tailLines = (s, n) => {
  const t = String(s ?? "").trim();
  const lines = t.split(/\r?\n/);
  return lines.length <= n ? t : lines.slice(-n).join("\n");
};

async function recordIssueComment(ctx, task, { attempt, limit, source, text }) {
  const marker = `ISSUE attempt ${attempt}/${limit === null ? "-" : limit}`;
  const comment = {
    id: randomUUID(),
    author: "review",
    body: `${marker}\n${source}\n${text}`.trim(),
    created_at: new Date().toISOString(),
  };
  (task.comments ??= []).push(comment);
  if (typeof ctx.effects.recordIssue === "function") {
    let written;
    try {
      written = await ctx.effects.recordIssue({ task, comment });
    } catch (e) {
      written = { written: false, error: e && e.message ? e.message : String(e) };
    }
    if (written && written.written === false && written.error)
      process.stderr.write(`run: ISSUE comment for #${task.number} not saved to the board — ${written.error}
`);
  }
  return comment;
}

async function recordArchitectComment(ctx, task, { attempt, findings }) {
  const comment = {
    id: randomUUID(),
    author: "architect",
    body: `ARCHITECT attempt ${attempt}\n${findings.map((f) =>
      `[${f.level}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""} ${f.text || ""}`.trim(),
    ).join("\n")}`.trim(),
    created_at: new Date().toISOString(),
  };
  (task.comments ??= []).push(comment);
  if (typeof ctx.effects.recordIssue === "function") {
    try { await ctx.effects.recordIssue({ task, comment }); } catch {}
  }
  return comment;
}

function resultBase(ctx, task, result, review, baton, cost, ownChanges, outsideChanges) {
  const attempt = ctx.attempts.get(task.id);
  const limit = retryLimitOf(task);
  if (typeof review?.costUsd === "number" && Number.isFinite(review.costUsd))
    cost = (typeof cost === "number" ? cost : 0) + review.costUsd;

  return {
    task, attempt, limit, cost, baton, session: result.sessionId || null,
    requestedMode: result.requestedMode || null,
    startMode: result.startMode || "unknown",
    parentSession: result.parentSession || null,
    provider: result.provider || null,
    model: result.model || null,
    route: result.route || null,
    ownChanges: Array.isArray(ownChanges) ? ownChanges.length : null,
    outsideChanges: Array.isArray(outsideChanges) ? outsideChanges.length : null,
    rollbackChanges: Array.isArray(ownChanges) ? ownChanges : [],
    neighbourDamage: Array.isArray(ownChanges) ? 0 : null,
    review: review ? {
      skipped: !!review.skipped,
      approved: !!review.approved,
      provider: review.provider || null,
      model: review.model || null,
      session: review.sessionId || null,
      route: review.route || null,
      findings: Array.isArray(review.findings) ? review.findings : [],
    } : null,
  };
}

function findingCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) if (Object.hasOwn(counts, finding?.level)) counts[finding.level] += 1;
  return counts;
}

const blockingFindings = (findings) => (findings || []).filter((f) => f?.level === "critical" || f?.level === "high");
const findingKey = (f) => `${f?.file || ""}\u0000${f?.text || ""}`;
const priorAttempts = (task) => Array.isArray(task?.attempts) ? task.attempts : [];

function convergenceStop(task, base) {
  const findings = blockingFindings(base.review?.findings);
  if (!findings.length) return null;
  const previous = priorAttempts(task).at(-1);
  const previousBlocking = blockingFindings(previous?.findings);
  if (findings.length >= 3)
    return "резать или менять подход: в одной попытке найдено 3+ critical/high";
  if (base.attempt >= 3) {
    const known = new Set(priorAttempts(task).flatMap((a) => blockingFindings(a.findings).map(findingKey)));
    if (findings.some((f) => !known.has(findingKey(f))))
      return "резать или менять подход: на попытке 3+ появились новые critical/high";
  }
  const budget = Number(task.budget_usd);
  const spent = priorAttempts(task).reduce((sum, a) => sum + (Number.isFinite(a?.cost_usd) ? a.cost_usd : 0), 0) + (Number.isFinite(base.cost) ? base.cost : 0);
  if (Number.isFinite(budget) && spent > budget * 0.6 && previous && findings.length >= previousBlocking.length)
    return "порог денег: потрачено больше 60% бюджета шага, а critical/high не уменьшаются";
  return null;
}

export function shouldEscalate(task, base) {
  const current = blockingFindings(base.review?.findings).length;
  const previousAttempt = priorAttempts(task).at(-2);
  const previous = blockingFindings(previousAttempt?.findings).length;
  if (task._runner_high_route_used || task._runner_high_route_pending) return false;
  return String(task.risk || "").toLowerCase() === "high" || (previousAttempt != null && current > 0 && current >= previous);
}

function hasHighRoute() {
  try { return resolveDuty("worker", undefined, { risk: "high" }).route?.applied === true; } catch { return false; }
}

async function recordAttempt(ctx, task, base) {
  const findings = base.review?.findings || [];
  const entry = {
    attempt: base.attempt,
    cost_usd: typeof base.cost === "number" && Number.isFinite(base.cost) ? base.cost : null,
    findings,
    counts: findingCounts(findings),
    reviewed: !!base.review && base.review.skipped !== true && base.review.ok !== false,
    mechanics: base.kind === "mechanics",
    verify_tail: base.verifyTail ?? null,
    snapshot: null,
  };
  let written;
  if (typeof ctx.effects.recordAttempt === "function") {
    try { written = await ctx.effects.recordAttempt({ task, cwd: ctx.cwd, entry: { ...entry } }); }
    catch (err) { written = { written: false, error: String(err?.message || err) }; }
  }
  entry.snapshot = written?.snapshot || null;
  (task.attempts ??= []).push(entry);
  return entry;
}

async function finishAttempt(ctx, task, outcome) {
  const journal = await recordAttempt(ctx, task, outcome);
  if (outcome.review && outcome.review.skipped !== true && outcome.review.ok !== false) {
    const earlier = priorAttempts(task).slice(0, -1);
    const best = bestAttempt(earlier);
    if (best && blockingCount(journal) > blockingCount(best)) {
      const restored = restoreCheckpoint({
        cwd: ctx.cwd,
        sha: best.snapshot,
        produces: task.produces,
        ownChanges: outcome.rollbackChanges,
      });
      if (!restored.ok) {
        return { ...outcome, kind: "convergence", parkReason: restored.lost ? "контрольная точка потеряна" : `контрольная точка не восстановлена: ${restored.reason}`, attempt_journal: journal };
      }
      emitRunEvent(ctx, { task: task.number, kind: "rollback", attempt: outcome.attempt, limit: outcome.limit, to: best.attempt ?? best.snapshot });
      return { ...outcome, rolledBackTo: best.snapshot, attempt_journal: journal };
    }
  }
  return { ...outcome, attempt_journal: journal };
}

// Everything AFTER the executor and the reviewer have run: the review verdict,
// its cost added onto what the worker already cost, and the branch into gate /
// issue / verify+reconcile / close. Anything that moves ANOTHER node (the
// `?issue` transition) is only RETURNED as an intent here — it is applied in
// board order afterwards, never from inside a single node's own step.
export async function finishStep(ctx, task, { result, review, baton, cost, ownChanges, outsideChanges }) {
  const base = resultBase(ctx, task, result, review, baton, cost, ownChanges, outsideChanges);
  const { attempt, limit } = base;

  const findings = Array.isArray(review?.findings) ? review.findings : [];
  if (review) emitRunEvent(ctx, { task: task.number, kind: "review", attempt, limit, counts: findingCounts(findings) });
  const blocking = blockingFindings(findings);
  const architectFindings = findings.filter((f) => f?.level === "medium" || f?.level === "low");
  const onlyArchitectural = review && review.skipped !== true && blocking.length === 0 && architectFindings.length;
  if (onlyArchitectural) {
    await recordArchitectComment(ctx, task, { attempt, findings: architectFindings });
    base.architectFindings = architectFindings;
  }
  if (review && review.skipped !== true && (blocking.length || (!onlyArchitectural && (review.ok === false || review.approved !== true)))) {
    await recordIssueComment(ctx, task, {
      attempt,
      limit,
      source: review.model ? `review ${review.model}` : "review",
      text: clampChars(review.result || review.error || "reviewer did not approve the obligations", 6000),
    });
    const stopped = convergenceStop(task, base);
    return finishAttempt(ctx, task, {
      ...base,
      kind: stopped ? "convergence" : "issue",
      parkReason: stopped,
      routeEscalated: task._runner_high_route_attempt === attempt,
      reason: `model review issue: ${review.error || review.result || "reviewer did not approve the obligations"}`,
    });
  }

  // A gate does the WORK and stops at `review`: the human checks one slice, and
  // the dependents stay blocked by construction.
  if (isGate(task)) {
    await moveTo(ctx, task, "review");
    return finishAttempt(ctx, task, { ...base, kind: "gate", reason: gateReason(task) });
  }
  if (result.ok === false) {
    const error = result.error || "no error reported";
    await recordIssueComment(ctx, task, { attempt, limit, source: "executor", text: clampChars(error, 6000) });
    return finishAttempt(ctx, task, {
      ...base,
      kind: "issue",
      routeEscalated: task._runner_high_route_attempt === attempt,
      reason: `step failed: ${error}`,
    });
  }

  if (declaredRed(task)) {
    let gate;
    try {
      gate = (await ctx.effects.redGate({ task, cwd: ctx.cwd, timeoutMs: ctx.timeoutMs })) || {};
    } catch (err) {
      gate = { ok: false, field: null, reason: `red gate crashed: ${(err && err.message) || err}` };
    }
    if (!gate.ok) {
      await recordIssueComment(ctx, task, {
        attempt,
        limit,
        source: "red",
        text: clampChars(gate.reason || "red gate issue", 6000),
      });
      return finishAttempt(ctx, task, {
        ...base,
        kind: "issue",
        routeEscalated: task._runner_high_route_attempt === attempt,
        red: gate.field ?? null,
        reason: gate.reason || "red gate issue",
      });
    }
    base.red = gate.field ?? null;
  }

  const verdictRun = await ctx.effects.runVerify({
    cmd: declaredVerify(task),
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
  });
  const verify = Number(verdictRun?.code) === 0 ? "ok" : "issue";
  emitRunEvent(ctx, { task: task.number, kind: "verify", attempt, limit, ok: verify === "ok" });
  if (verify === "issue") {
    const combined = [verdictRun?.stdout, verdictRun?.stderr].filter((s) => s && String(s).trim()).join("\n");
    const tail = tailLines(combined, 60);
    base.verifyTail = tail;
    await recordIssueComment(ctx, task, { attempt, limit, source: "verify", text: tail });
    const repeated = priorAttempts(task).at(-1)?.verify_tail === tail;
    if (repeated && tail.trim() && review && review.skipped !== true && (review.approved === true || onlyArchitectural) && blocking.length === 0) {
      ctx.attempts.set(task.id, Math.max(0, attempt - 1));
      return finishAttempt(ctx, task, { ...base, kind: "mechanics", verify, reason: "механика: verify упал с тем же выводом две попытки подряд при одобренном ревью без critical/high" });
    }
  }
  const report = (await ctx.effects.reconcile({ task, verify })) || {};
  const outcome = report.outcome ?? null;
  const reason = report.outcome_reason || `verify:${verify}`;

  if (outcome === "ok") {
    const moved = await moveTo(ctx, task, "done");
    if (!moved.ok)
      return finishAttempt(ctx, task, {
        ...base,
        kind: "undecided",
        verify,
        reason: `the work finished and reconciled, but the board refused to close the node: ${moved.error}`,
      });
    return finishAttempt(ctx, task, { ...base, kind: "done", verify, reason });
  }
  if (outcome === "issue") {
    if (verify === "ok") await recordIssueComment(ctx, task, { attempt, limit, source: "reconcile", text: clampChars(reason, 6000) });
    const stopped = convergenceStop(task, base);
    return finishAttempt(ctx, task, { ...base, kind: stopped ? "convergence" : "issue", parkReason: stopped, routeEscalated: task._runner_high_route_attempt === attempt, verify, reason });
  }
  return finishAttempt(ctx, task, { ...base, kind: "undecided", verify, reason });
}

function formatNeighbourDamage(damaged) {
  const lines = damaged.map((d) => `${d.state} ${d.path}`).join("\n");
  return (
    `this step reverted or deleted work of earlier steps of the run, outside its own produces:\n${lines}`
  );
}

async function checkNeighbourDamage(ctx, task, result, baton, cost) {
  if (result.ok === false || !task.step_base) return null;
  let damage;
  try {
    damage = (await ctx.effects.ownChanges({ task, cwd: ctx.cwd, editedPaths: result.editedPaths })) || {};
  } catch (err) {
    damage = { ok: false, error: String((err && err.message) || err) };
  }
  if (!damage.ok || damage.skip) return null;
  const ownChanges = damage.own || [];
  const outsideChanges = Array.isArray(damage.outside) ? damage.outside : [];
  if (!Array.isArray(damage.damaged) || !damage.damaged.length)
    return { ownChanges, outsideChanges, issue: null };
  const base = resultBase(ctx, task, result, null, baton, cost, ownChanges, outsideChanges);
  base.neighbourDamage = damage.damaged.length;
  await recordIssueComment(ctx, task, {
    attempt: base.attempt,
    limit: base.limit,
    source: "scope",
    text: formatNeighbourDamage(damage.damaged),
  });
  return {
    ownChanges,
    outsideChanges,
    issue: await finishAttempt(ctx, task, {
      ...base,
      kind: "issue",
      routeEscalated: task._runner_high_route_attempt === base.attempt,
      reason: `step reverted or deleted work of earlier steps outside its own produces: ${damage.damaged.map((d) => d.path).join(", ")}`,
    }),
  };
}

async function retryReviewContext(ctx, task, ownChanges) {
  if (!priorAttempts(task).length) return null;
  try {
    return (await ctx.effects.reviewContext?.({
      task,
      cwd: ctx.cwd,
      ownChanges,
      neighbours: ctx.members.filter((t) => t.id !== task.id),
    })) || null;
  } catch {
    return null;
  }
}

function downgradeUntouchedRetryFindings(review, context) {
  if (!review || !Array.isArray(review.findings) || !Array.isArray(context?.attemptDiff)) return review;
  const prior = new Set((context.previousAttempt?.findings || []).map(findingKey));
  const touched = new Set(context.attemptDiff.map((c) => String(c?.path || "").replace(/\\/g, "/")));
  const findings = review.findings.map((f) => {
    const file = String(f?.file || "").replace(/\\/g, "/");
    if ((f?.level === "critical" || f?.level === "high") && !prior.has(findingKey(f)) && file && !touched.has(file))
      return { ...f, level: "medium", evidence: `${f.evidence || ""}${f.evidence ? "; " : ""}outside this retry's diff` };
    return f;
  });
  return { ...review, findings };
}

// One attempt at one node, composed from the three phases above: beginStep does
// the bookkeeping and hands the executor its brief, recordWork puts what the
// worker produced on the board, then the reviewer runs and finishStep reads
// its verdict and branches.
async function runOne(ctx, task, wave = []) {
  const begun = await beginStep(ctx, task, wave);
  if (begun.kind === "retry-exhausted" || begun.kind === "red-base-failed") return begun;

  let result;
  try {
    result = (await ctx.effects.executeStep(begun.brief)) || {};
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  const { baton, cost } = await recordWork(ctx, task, result);
  if (result.sessionId) ctx.sessions.set(task.id, result.sessionId);

  const damage = await checkNeighbourDamage(ctx, task, result, baton, cost);
  if (damage && damage.issue) return damage.issue;
  const ownChanges = damage ? damage.ownChanges : null;
  const outsideChanges = damage ? damage.outsideChanges : null;
  const retryContext = await retryReviewContext(ctx, task, ownChanges);

  let review = null;
  if (result.ok !== false && typeof ctx.effects.reviewStep === "function") {
    try {
      review = await ctx.effects.reviewStep({
        task,
        workerResult: result.result || "",
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        ownChanges,
        outsideChanges,
        retryContext,
      });
      review = downgradeUntouchedRetryFindings(review, retryContext);
    } catch (err) {
      review = { approved: false, ok: false, error: String(err?.message || err) };
    }
  }
  return finishStep(ctx, task, { result, review, baton, cost, ownChanges, outsideChanges });
}

export async function runReported(ctx, task, wave, { result, review = null }) {
  const begun = await beginStep(ctx, task, wave);
  if (begun.kind === "retry-exhausted" || begun.kind === "red-base-failed") return begun;
  const { baton, cost } = await recordWork(ctx, task, result);
  const damage = await checkNeighbourDamage(ctx, task, result, baton, cost);
  if (damage && damage.issue) return damage.issue;
  const ownChanges = damage ? damage.ownChanges : null;
  const outsideChanges = damage ? damage.outsideChanges : null;
  return finishStep(ctx, task, {
    result,
    review,
    baton,
    cost,
    ownChanges,
    outsideChanges,
  });
}

// The `?issue` transition and every stop it can produce. All of it runs in board
// order, after the wave — a parallel step never moves another node's status.
async function applyIssue(ctx, r) {
  const task = r.task;
  const limit = r.limit;
  if (r.routeEscalated) {
    await moveTo(ctx, task, "review");
    park(ctx, "convergence", task, "резать или менять подход: high-маршрут уже был использован для следующей попытки");
    return;
  }
  if (shouldEscalate(task, r) && hasHighRoute()) {
    task._runner_high_route_pending = true;
    emitRunEvent(ctx, { task: task.number, kind: "escalate", attempt: r.attempt, limit: r.limit, route: "high" });
  }
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
  if (!task.on_issue) {
    await moveTo(ctx, task, "queue");
    ctx.transitions.push({
      from: brief(task),
      to: brief(task),
      attempt: r.attempt,
      limit,
      reason: r.reason,
      self: true,
    });
    return;
  }
  const target = ctx.byId.get(task.on_issue);
  if (!target) {
    await moveTo(ctx, task, "review");
    park(ctx, "retry", task, `outcome issue and the declared ?issue target ${task.on_issue} is not on the board`);
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

// A node this run will not pick back up: its declared retry limit is already
// spent (attemptsSoFar, board-derived — the same count beginStep refuses on),
// or it is already sitting in `review` — the human's inbox, not work to redo.
// This is NOT the ready predicate (`isReadyNode`, todos.mjs): `review` stays a
// human gate there on purpose, and `todos ready` must go on reporting exactly
// what it does today. Parked is a second, narrower question — of what's ready,
// what has this run already handed off and will not act on again — asked only
// here and by whatever drives a run from outside this loop.
function isNodeParked(t) {
  const limit = retryLimitOf(t);
  return (limit !== null && attemptsSoFar(t) >= limit) || t.status === "review";
}

// The one way to build a run's state from a board — used by `runChange` below,
// so a run driven from OUTSIDE this loop (a later task) reads the same frontier
// this loop does, and the two can never disagree about what is ready.
//
// `spent` is a required, explicit input rather than a default of 0: this loop
// knows its own running total, but nothing on the board records what a run has
// spent — a caller resuming a run from outside has no honest way to derive it,
// and defaulting it to 0 would make that caller silently believe it has spent
// nothing rather than visibly have no ceiling to check against.
export function buildRunContext({ data, change, effects = {}, dry = true, cwd = process.cwd(), timeoutMs, spent, inherit = false, events = false, persistDecisionCard = false }) {
  const board = structuredClone(data ?? { version: 1, todos: [] });
  const { root, members, byId } = collectChange(board, change);
  if (!root) throw new Error(`no such task: ${change}`);

  // In dry mode the seam is the simulator, full stop: a caller's effects are not
  // merged in, so `--dry-run` cannot start a model or move the board even by
  // mistake. Only the cost estimator may be supplied.
  const sim = simulationEffects();
  const persistedEffects = persistDecisionCard ? { recordIssue: liveEffects({ cwd }).recordIssue } : {};
  return {
    data: board,
    root,
    members,
    byId,
    dry,
    cwd,
    timeoutMs,
    effects: dry
      ? { ...sim, stepCost: effects.stepCost ?? sim.stepCost, ...persistedEffects }
      : { ...liveEffects({ cwd }), ...effects },
    attempts: new Map(),
    parked: new Set(members.filter(isNodeParked).map((t) => t.id)),
    transitions: [],
    refused: [],
    // task id -> the session that executed it in THIS run; the only source
    // `inheritFrom` reads, so a fork can never point at a session this loop did
    // not watch finish.
    sessions: new Map(),
    inherit: !!inherit,
    steps: [],
    architectFindings: [],
    waves: [],
    spent,
    nodeSpent: new Map(),
    unknownCost: 0,
    stop: null,
    maxParallel: 0,
    stepBaseWarned: false,
    runId: randomUUID(),
    events: !!events,
    persistDecisionCard: !!persistDecisionCard,
  };
}

const EMPTY_FRONTIER_REASON =
  "the frontier is empty while the change is still open — no node has all of its prerequisites closed, so the graph lies: edges are missing or a cycle is written into depends_on";

const REVIEW_GATE_REASON =
  "already in review from an earlier step — the runner never takes a node back out of the human's column";

const budgetExhaustedReason = (spent, budget, notStarted) =>
  `group budget exhausted — $${round(spent)} of $${budget} spent; the step boundary is where the run stops, so #${notStarted.number} was NOT started and nothing was rolled back`;

const retryExhaustedReason = (attempt, limit) =>
  `attempt ${attempt + 1} would be past the declared limit — ${attempt}/<=${limit}; attempt M+1 never starts`;

export function buildWave(ready, limit) {
  if (!ready.length) return [];
  if (declaredRed(ready[0])) return [ready[0]];
  const wave = [];
  const produced = new Set();
  for (const t of ready) {
    if (wave.length >= limit || declaredRed(t)) break;
    const paths = (Array.isArray(t.produces) ? t.produces : [])
      .filter(Boolean)
      .map((p) => String(p).replace(/\\/g, "/"));
    if (paths.some((p) => produced.has(p))) continue;
    wave.push(t);
    for (const p of paths) produced.add(p);
  }
  return wave;
}

export function resolveParallelLimit(root, override) {
  return (
    (typeof override === "number" && override > 0 && Math.floor(override)) ||
    (typeof root.parallel_limit === "number" && root.parallel_limit > 0
      ? Math.floor(root.parallel_limit)
      : DEFAULT_PARALLEL_LIMIT)
  );
}

export async function applyResult(ctx, r, { dry, log }) {
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
    requested_mode: r.requestedMode || null,
    start_mode: r.startMode || "unknown",
    parent_session: r.parentSession || null,
    provider: r.provider || null,
    model: r.model || null,
    route: r.route || null,
    cost_usd: r.cost,
    baton: r.baton ?? null,
    review: r.review ?? null,
    architect_findings: r.architectFindings ?? [],
    gate: r.kind === "gate",
    verify: r.verify ?? null,
    red: r.red ?? null,
    outcome: r.kind === "done" ? "ok" : r.kind === "issue" ? "issue" : null,
    result: r.kind,
    reason: r.reason || null,
    status: r.task.status,
    own_changes: typeof r.ownChanges === "number" ? r.ownChanges : null,
    outside_changes: typeof r.outsideChanges === "number" ? r.outsideChanges : null,
    neighbour_damage: typeof r.neighbourDamage === "number" ? r.neighbourDamage : null,
  };
  ctx.steps.push(record);
  if (Array.isArray(r.architectFindings) && r.architectFindings.length)
    ctx.architectFindings.push({ task: brief(r.task), attempt: r.attempt, findings: r.architectFindings });
  log(formatStepLine(record, dry));

  if (r.kind === "gate") {
    ctx.parked.add(r.task.id);
    park(ctx, "gate", r.task, r.reason);
    return record;
  }
  if (r.kind === "red-base-failed") {
    ctx.parked.add(r.task.id);
    park(ctx, "red-base", r.task, r.reason);
    return record;
  }
  if (r.kind === "retry-exhausted") {
    ctx.parked.add(r.task.id);
    await moveTo(ctx, r.task, "review");
    park(ctx, "retry", r.task, retryExhaustedReason(r.attempt, r.limit));
    return record;
  }
  if (r.kind === "undecided") {
    ctx.parked.add(r.task.id);
    await moveTo(ctx, r.task, "review");
    park(ctx, "outcome", r.task, `the outcome could not be finalized (${r.reason}) — nothing is closed on a guess`);
    return record;
  }
  if (r.kind === "mechanics") {
    ctx.parked.add(r.task.id);
    await moveTo(ctx, r.task, "review");
    park(ctx, "mechanics", r.task, r.reason);
    record.status = r.task.status;
    return record;
  }
  if (r.kind === "convergence") {
    ctx.parked.add(r.task.id);
    await moveTo(ctx, r.task, "review");
    park(ctx, "convergence", r.task, r.parkReason || r.reason);
    record.status = r.task.status;
    return record;
  }
  if (r.kind === "issue") {
    const before = ctx.stop;
    await applyIssue(ctx, r);
    if (ctx.stop && ctx.stop !== before) ctx.parked.add(r.task.id);
    record.status = r.task.status;
    return record;
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
  return record;
}

export function nextFrontier(ctx, { limit, groupBudget, spentKnown }) {
  const ready = frontierOf({ members: ctx.members, byId: ctx.byId });
  if (!ready.length) {
    if (ctx.members.every((t) => isDone(t))) return { complete: true };
    park(ctx, "empty-frontier", null, EMPTY_FRONTIER_REASON, { blocked: blockedDiagnosis(ctx) });
    return { stop: ctx.stop };
  }
  if (spentKnown && groupBudget !== null && ctx.spent >= groupBudget) {
    park(ctx, "budget", ready[0], budgetExhaustedReason(ctx.spent, groupBudget, ready[0]), {
      spent: round(ctx.spent),
      budget: groupBudget,
      not_started: brief(ready[0]),
    });
    return { stop: ctx.stop };
  }
  const pending = ready.find((t) => t.status === "review");
  if (pending) {
    ctx.parked.add(pending.id);
    park(ctx, "gate", pending, REVIEW_GATE_REASON);
    return { stop: ctx.stop };
  }
  const exhausted = ready.find((t) => {
    const lim = retryLimitOf(t);
    return lim !== null && attemptsSoFar(t) >= lim;
  });
  if (exhausted) {
    ctx.parked.add(exhausted.id);
    park(ctx, "retry", exhausted, retryExhaustedReason(attemptsSoFar(exhausted), retryLimitOf(exhausted)));
    return { stop: ctx.stop };
  }
  return { wave: buildWave(ready, limit) };
}

// The run loop. `data` is cloned first, so nothing the engine does is visible on
// the caller's object — the board changes only through the setStatus seam.
export async function runChange({
  data,
  change,
  effects = {},
  dry = true,
  inherit = false,
  cwd = process.cwd(),
  // Undeclared by default on purpose: the ceiling of a step and of a check
  // belongs to the executor (run-step.mjs), and a second default here would
  // silently override it. Only an explicit --timeout speaks.
  timeoutMs,
  parallelLimit,
  log = () => {},
  maxSteps,
}) {
  const ctx = buildRunContext({ data, change, effects, dry, cwd, timeoutMs, spent: 0, inherit, events: !dry });
  const { root, members, byId } = ctx;

  const limit = resolveParallelLimit(root, parallelLimit);
  const groupBudget = typeof root.budget_usd === "number" ? root.budget_usd : null;

  const bound = maxSteps ?? members.length * 8 + 8;
  emitRunEvent(ctx, { kind: "run_start" });

  while (!ctx.stop) {
    // The live loop asks the STRUCTURAL frontier, not the parked-filtered one:
    // a node already parked from a fresh board — status `review`, or the retry
    // limit spent — still needs the specific diagnosis below (gate reason,
    // attempt count), not a generic exclusion that would misreport it as a
    // missing edge. `ctx.parked` stays the board-derived set a run started
    // from OUTSIDE this loop would read instead (buildRunContext).
    const ready = frontierOf({ members, byId });
    if (!ready.length) {
      if (members.every((t) => isDone(t))) break;
      park(ctx, "empty-frontier", null, EMPTY_FRONTIER_REASON, { blocked: blockedDiagnosis(ctx) });
      break;
    }
    // Budget is checked on the BOUNDARY of a step, before a new wave is
    // dispatched: whatever is running is always finished, never killed
    // mid-flight, and nothing already spent is given back.
    if (groupBudget !== null && ctx.spent >= groupBudget) {
      park(ctx, "budget", ready[0], budgetExhaustedReason(ctx.spent, groupBudget, ready[0]), {
        spent: round(ctx.spent),
        budget: groupBudget,
        not_started: brief(ready[0]),
      });
      break;
    }
    // A node already sitting in `review` is the human's inbox, not work to redo:
    // the runner parks on it exactly as it would on a fresh gate.
    const pending = ready.find((t) => t.status === "review");
    if (pending) {
      ctx.parked.add(pending.id);
      park(ctx, "gate", pending, REVIEW_GATE_REASON);
      break;
    }

    const wave = buildWave(ready, limit);
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
      await applyResult(ctx, r, { dry, log });
    }
  }

  const complete = !ctx.stop && members.every((t) => isDone(t));
  const card = await attachDecisionCard(ctx);
  const report = {
    version: 1,
    kind: "change.run",
    dry,
    change: {
      ...brief(root),
      is_change: Boolean(root.record) || isChangeRoot(root),
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
    refused: ctx.refused,
    architect_findings: ctx.architectFindings,
    spend: {
      usd: round(ctx.spent),
      unmeasured_steps: ctx.unknownCost,
      group_budget: groupBudget,
    },
    stop: ctx.stop,
    card,
    complete,
    board: ctx.data,
  };
  emitRunEvent(ctx, { kind: "run_end", complete, stop: ctx.stop?.kind || null });
  return report;
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
  const route = s.route ? ` · ${s.route.note}` : "";
  return `  wave ${s.wave}  #${s.task.number} ${s.task.subject} — ${verb}${attempt}${cost}${baton}${route}\n`;
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
  if (stop.card) out.push(stop.card);
  return out.join("");
}

function formatTransitionLine(t) {
  if (t.self)
    return `  ?issue  #${t.from.number} retried in place — ${t.reason} (attempt ${t.attempt}/<=${t.limit}; no ?issue target declared, the node itself is requeued with the findings)\n`;
  return `  ?issue  #${t.from.number} → #${t.to.number} — ${t.reason} (attempt ${t.attempt}/<=${t.limit}; the target is reopened, closed nodes below it stay closed)\n`;
}

export function formatRunReport(r) {
  const out = [];
  const th = r.change;
  out.push(
    `change c#${th.number} "${th.subject}" — ${r.members.length} node(s), parallel limit ${th.parallel_limit}` +
      `${th.parallel_declared === null ? " (undeclared, default 1)" : ""}` +
      `${th.budget_usd === null ? ", budget UNDECLARED" : `, budget $${th.budget_usd}`}\n`,
  );
  if (!th.is_change)
    out.push("  note: this node is not marked as a change — running its dependency closure anyway\n");
  out.push(
    r.dry
      ? "plan of the run (dry — no model was started, the board was not touched):\n"
      : "run (rollback touches only produces and files changed by this step; snapshots are unreferenced local commits, never pushed; unrelated uncommitted work is untouched):\n",
  );
  if (!r.steps.length) out.push("  (nothing to run — the frontier was empty from the start)\n");
  for (const s of r.steps) out.push(formatStepLine(s, r.dry));
  if (Array.isArray(r.architect_findings) && r.architect_findings.length) {
    out.push("  архитектору:\n");
    for (const item of r.architect_findings)
      for (const finding of item.findings)
        out.push(`    #${item.task.number} [${finding.level}] ${finding.file || "(file not specified)"}${finding.line ? `:${finding.line}` : ""} ${finding.text || ""}\n`);
  }
  for (const t of r.transitions) out.push(formatTransitionLine(t));
  for (const f of r.refused || [])
    out.push(`  refused  #${f.task.number} → ${f.status} — ${f.error}
`);
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
      `\n✓ every node of the change is closed. The change root c#${th.number} stays open — the runner never closes the group.\n`,
    );
  return out.join("");
}

function dutySummary(name) {
  const d = resolveDuty(name);
  return { duty: name, mode: d.mode, enabled: d.enabled, provider: d.provider, model: d.model };
}

// The last session bound to each task, read from the binding journal. `--next`
// hands it out so the DRIVER can decide whether its step starts cold or forks
// that session (t#543): the runner has no say there — whoever spawns the step
// owns the choice, and can only make it if it is told the id.
function lastSessionByTask() {
  const map = new Map();
  let events = [];
  try {
    events = readTaskSessionEvents();
  } catch {
    return map;
  }
  for (const e of events) {
    if (!e || !e.task || !e.session) continue;
    map.set(String(e.task), String(e.session));
  }
  return map;
}

function prereqBatons(task, byId, sessions = new Map()) {
  return (Array.isArray(task.depends_on) ? task.depends_on : [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => ({
      task: brief(p),
      status: p.status,
      handoff: p.handoff && p.handoff.trim() ? p.handoff.trim() : null,
      session: sessions.get(String(p.id)) || null,
    }));
}

function budgetNote(groupBudget, spentKnown, spent) {
  if (groupBudget === null) return "no budget is declared on this change — there is nothing to enforce.";
  if (spentKnown)
    return `checked against the declared $${groupBudget} using the $${round(spent)} you passed via --spent — this process still cannot verify that number on its own.`;
  return (
    `NOT enforced this call — $${groupBudget} is declared on the change, but this CLI cannot see what a ` +
    "subagent spends outside it; pass --spent <usd> yourself if you are tracking the total, or the ceiling will not stop you."
  );
}

function nodeHandout(task, byId, handoutAt = null) {
  return {
    task: brief(task),
    status: task.status,
    why: task.description || "",
    produces: (Array.isArray(task.produces) ? task.produces : []).filter(Boolean),
    verify: declaredVerify(task) || null,
    retry_limit: retryLimitOf(task),
    budget_usd: typeof task.budget_usd === "number" ? task.budget_usd : null,
    kind: task.kind === "auto" ? "auto" : "manual",
    gate: isGate(task),
    handout_at: handoutAt,
    inherits: prereqBatons(task, byId, lastSessionByTask()),
  };
}

function formatNodeHandout(n) {
  const out = [`\n#${n.task.number} ${n.task.subject}  [${n.kind}]${n.gate ? " — GATE" : ""}\n`];
  out.push(`  why:      ${n.why || "(no description declared)"}\n`);
  out.push(`  produces: ${n.produces.length ? n.produces.join(", ") : "(none declared)"}\n`);
  out.push(`  verify:   ${n.verify || "(none — this node runs as a gate)"}\n`);
  out.push(`  retry:    ${n.retry_limit === null ? "(none declared)" : `<=${n.retry_limit}`}\n`);
  out.push(`  budget:   ${n.budget_usd === null ? "(none declared)" : `$${n.budget_usd}`}\n`);
  out.push(`  handed out: ${n.handout_at || "(not recorded)"} — status unchanged, still ${n.status}\n`);
  if (n.inherits.length) {
    out.push("  inherits (direct prerequisites' handoff):\n");
    for (const p of n.inherits)
      out.push(`    t#${p.task.number} "${p.task.subject}" [${p.status}] — ${p.handoff ? p.handoff : "(no handoff)"}\n`);
  } else {
    out.push("  inherits: (a root of the change — nothing upstream)\n");
  }
  const forkable = n.inherits.filter((p) => p.session);
  if (forkable.length === 1)
    out.push(
      `  context:  the prerequisite ran as session ${forkable[0].session} — YOUR call whether this step\n` +
        `            starts cold or forks it (claude -p --resume <id> --fork-session): a fork is\n` +
        `            cheaper and keeps its own id, but the step then sees that session, while the\n` +
        `            brief above tells it there is no earlier conversation.\n`,
    );
  else if (forkable.length > 1)
    out.push(
      `  context:  ${forkable.length} prerequisites ran in their own sessions (${forkable
        .map((p) => `#${p.task.number} ${p.session}`)
        .join(", ")}) — forking one of them drops the others' context silently; a cold start is the honest default here.\n`,
    );
  return out.join("");
}

function formatDutyLine(label, d) {
  return `  ${label.padEnd(8)} ${d.enabled ? `${d.provider}/${d.model}` : "off"}  [${d.mode}]\n`;
}

function formatNextReport(r) {
  const out = [];
  const th = r.change;
  out.push(
    `change c#${th.number} "${th.subject}" — parallel limit ${th.parallel_limit}` +
      `${th.budget_usd === null ? ", budget UNDECLARED" : `, budget $${th.budget_usd}`}\n`,
  );
  out.push("the models this loop must bill to (agents.mjs; read, never hardcoded):\n");
  out.push(formatDutyLine("worker", r.worker));
  out.push(formatDutyLine("review", r.review));
  out.push(`budget: ${r.budget_note}\n`);
  if (!r.ready.length) {
    out.push(
      r.complete
        ? "\nnothing to hand out — every node of the change is already closed.\n"
        : formatStop(r.stop),
    );
    return out.join("");
  }
  out.push(`\nready (${r.ready.length} of up to ${th.parallel_limit}):\n`);
  for (const n of r.ready) out.push(formatNodeHandout(n));
  return out.join("");
}

function formatReportResult(r) {
  const out = [];
  const s = r.step;
  out.push(`#${s.task.number} ${s.task.subject} — ${s.result}\n`);
  out.push(`  attempt: ${s.retry_limit !== null ? `${s.attempt}/<=${s.retry_limit}` : s.attempt}\n`);
  if (s.verify !== null) out.push(`  verify:  ${s.verify}\n`);
  if (s.outcome !== null) out.push(`  outcome: ${s.outcome}${s.reason ? ` (${s.reason})` : ""}\n`);
  else if (s.reason) out.push(`  reason:  ${s.reason}\n`);
  out.push(
    `  baton:   ${s.baton === null ? "(not reported)" : s.baton === "written" ? "written" : s.baton === "refused" ? "REFUSED by the board" : s.baton}\n`,
  );
  out.push(
    `  cost:    ${typeof s.cost_usd === "number" ? `$${round(s.cost_usd)} (this report only — not accumulated across calls)` : "unknown"}\n`,
  );
  out.push(`  status:  ${s.status}\n`);
  for (const t of r.transitions) out.push(formatTransitionLine(t));
  out.push("\nwhat the next --next will hand out:\n");
  if (r.next.complete) out.push("  nothing — every node of the change is now closed.\n");
  else if (r.next.stop) out.push(formatStop(r.next.stop));
  else out.push(`  ${r.next.ready.map((t) => `#${t.number}`).join(", ") || "(none)"}\n`);
  return out.join("");
}

// The one place `--next` writes: every node of the wave it hands out gets a
// fresh `handout_at` (t#520) — NOT a status move, `--report` still owns that —
// so `outcome.mjs`'s weak file evidence has a boundary that is not the
// executor's own word about when it started. Overwritten on a re-hand-out, so
// a node that comes back after a crashed attempt starts a clean window rather
// than measuring against the stamp of the attempt that never reported.
export function stampHandout(file, data, wave) {
  if (!wave.length) return null;
  const at = new Date().toISOString();
  const ids = new Set(wave.map((t) => t.id));
  for (const t of data.todos) if (t && ids.has(t.id)) t.handout_at = at;
  saveBoard(file, data);
  return at;
}

function attachStepBase(data, wave, cwd) {
  if (!wave.length) return { wave, stop: null };
  let warned = false;
  for (const t of wave) {
    if (t.step_base) continue;
    const head = gitBase(cwd);
    if (!head.ok) {
      if (declaredRed(t)) {
        return {
          wave: [],
          stop: {
            kind: "red-base",
            task: brief(t),
            status: t.status,
            reason: `red declared but ${cwd} is not a git work tree${head.error ? `: ${head.error}` : ""}`,
            parked: true,
          },
        };
      }
      if (!warned) {
        warned = true;
        process.stderr.write(
          `run: step base unavailable for ${cwd}${head.error ? `: ${head.error}` : ""} — continuing without it, this run's produces/scope checks are best-effort\n`,
        );
      }
      continue;
    }
    const todo = data.todos.find((x) => x && x.id === t.id);
    if (todo) todo.step_base = head.sha;
    t.step_base = head.sha;
  }
  return { wave, stop: null };
}

async function cmdNext(ref, f) {
  recoverRedGate(process.cwd());
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
  const spentKnown = f.spent !== undefined;
  let spent = 0;
  if (spentKnown) {
    spent = Number(f.spent);
    if (!Number.isFinite(spent) || spent < 0) fail("--spent takes a non-negative number of dollars");
  }

  const file = appDataFile("todos.json");
  const { root, limit, groupBudget, ctx, outcome, handoutAt } = withBoardLock(file, () => {
    const data = loadBoardForWrite(file);
    const c = buildRunContext({ data, change: ref, dry: true, cwd: process.cwd(), timeoutMs, spent, persistDecisionCard: true });
    const l = resolveParallelLimit(c.root, parallel);
    const gb = typeof c.root.budget_usd === "number" ? c.root.budget_usd : null;
    let o = nextFrontier(c, { limit: l, groupBudget: gb, spentKnown });
    if (o.wave) {
      const based = attachStepBase(data, o.wave, process.cwd());
      o = based.stop ? { stop: based.stop } : { ...o, wave: based.wave };
    }
    const at = stampHandout(file, data, o.wave || []);
    return { root: c.root, limit: l, groupBudget: gb, ctx: c, outcome: o, handoutAt: at };
  });

  if (outcome.stop) ctx.stop = outcome.stop;
  const report = {
    version: 1,
    kind: "change.next",
    change: {
      ...brief(root),
      is_change: Boolean(root.record) || isChangeRoot(root),
      parallel_limit: limit,
      budget_usd: groupBudget,
    },
    worker: dutySummary("worker"),
    review: dutySummary("review"),
    budget_note: budgetNote(groupBudget, spentKnown, spent),
    ready: (outcome.wave || []).map((t) => nodeHandout(t, ctx.byId, handoutAt)),
    handout_at: handoutAt,
    stop: outcome.stop || null,
    card: outcome.stop ? await attachDecisionCard(ctx) : null,
    complete: !!outcome.complete,
  };

  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatNextReport(report));

  if (report.stop && report.stop.kind !== "gate") process.exit(1);
}

async function cmdReport(ref, f) {
  recoverRedGate(process.cwd());
  const taskRef = f.report;
  if (f.result !== "ok" && f.result !== "issue") fail('--report needs --result "ok" or "issue"');
  let cost;
  if (f.cost !== undefined) {
    cost = Number(f.cost);
    if (!Number.isFinite(cost)) fail("--cost takes a number of dollars");
  }
  let review = null;
  if (f.review !== undefined) {
    const v = String(f.review).trim().toLowerCase();
    if (v !== "approve" && v !== "issue") fail('--review takes "approve" or "issue"');
    review = { approved: v === "approve", ok: true, skipped: false };
  }
  let timeoutMs;
  if (f.timeout !== undefined) {
    const min = Number(f.timeout);
    if (!Number.isFinite(min) || min <= 0) fail("--timeout takes a positive number of minutes");
    timeoutMs = min * 60_000;
  }

  const file = appDataFile("todos.json");
  const data = loadBoardForWrite(file);
  const ctx = buildRunContext({ data, change: ref, dry: false, cwd: process.cwd(), timeoutMs, spent: 0 });
  const task = resolveTask(ctx.data, taskRef);
  if (!task) fail(`no such task: ${taskRef}`);
  if (!ctx.members.some((t) => t.id === task.id))
    fail(`#${task.number ?? task.id} is not a member of ${ref}'s dependency closure`);
  if (!isReadyNode(task, ctx.byId))
    fail(`#${task.number} is not ready — its prerequisites are not all closed, so there is nothing to report yet`);

  const result = {
    sessionId: null,
    ok: f.result !== "issue",
    error: f.result === "issue" ? String(f.reason || "") : "",
    handoff: String(f.handoff || ""),
    costUsd: typeof cost === "number" ? cost : null,
  };

  const r = await runReported(ctx, task, [task], { result, review });
  const record = await applyResult(ctx, r, { dry: false, log: () => {} });

  const limit = resolveParallelLimit(ctx.root, undefined);
  const groupBudget = typeof ctx.root.budget_usd === "number" ? ctx.root.budget_usd : null;
  const preview = nextFrontier(ctx, { limit, groupBudget, spentKnown: false });
  const card = preview.stop ? await attachDecisionCard(ctx) : null;

  const report = {
    version: 1,
    kind: "change.report",
    change: brief(ctx.root),
    step: record,
    transitions: ctx.transitions,
    refused: ctx.refused,
    next: {
      ready: (preview.wave || []).map((t) => brief(t)),
      stop: preview.stop || null,
      complete: !!preview.complete,
    },
    card,
  };

  appendRunRecord(reportRecordOf(report));

  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatReportResult(report));
}

// ── the history ──────────────────────────────────────────────────────────────

// The one number the journal exists for: how often ONE pass over the graph was
// enough. A plan that needed no correction finishes complete, unparked, with
// every node closed on its first attempt — anything else is the graph having
// been wrong, and the breakdown names which of the four stops ate it.
export function summarizeRuns(records, { change } = {}) {
  const mine = (r) => !change || (r.change && r.change.number === change);
  const runs = records.filter((r) => r && r.kind === "run" && mine(r));
  const reported = records.filter((r) => r && r.kind === "report" && mine(r));
  const onePass = runs.filter((r) => r.one_pass).length;
  const parked = {};
  for (const r of [...runs, ...reported]) {
    if (!r.stop) continue;
    parked[r.stop.kind] = (parked[r.stop.kind] || 0) + 1;
  }
  let usd = 0;
  let unmeasured = 0;
  for (const r of [...runs, ...reported])
    for (const s of r.steps || []) {
      if (typeof s.cost_usd === "number") usd += s.cost_usd;
      else unmeasured += 1;
    }
  return {
    runs: runs.length,
    reported_steps: reported.length,
    one_pass: onePass,
    one_pass_share: runs.length ? onePass / runs.length : null,
    parked,
    spend_usd: Math.round(usd * 10000) / 10000,
    unmeasured_steps: unmeasured,
  };
}

const money = (steps = []) => {
  const known = steps.filter((s) => typeof s.cost_usd === "number");
  const sum = known.reduce((a, s) => a + s.cost_usd, 0);
  if (!known.length) return "unmeasured";
  return `$${Math.round(sum * 10000) / 10000}${known.length < steps.length ? " (partly unmeasured)" : ""}`;
};

export function formatRunHistory(records, summary, { limit = 20 } = {}) {
  const out = [];
  if (!records.length) {
    out.push("no runs recorded yet — the journal fills on `--go` and on every `--report`.\n");
    return out.join("");
  }
  out.push(`runs journal — ${records.length} record(s), newest last\n\n`);
  for (const r of records.slice(-limit)) {
    const when = String(r.ts || "").slice(0, 16).replace("T", " ");
    const ch = r.change ? `c#${r.change.number}` : "(none)";
    if (r.kind === "run") {
      const verdict = r.stop
        ? `parked: ${r.stop.kind}`
        : r.one_pass
          ? "one pass"
          : r.complete
            ? "complete, with retries"
            : "incomplete";
      out.push(
        `  ${when}  ${ch.padEnd(6)} ${String(r.nodes ?? "?").padStart(2)} node(s)  ${verdict.padEnd(24)} ${money(r.steps)}${r.inherit ? "  (inherit)" : ""}\n`,
      );
      if (r.stop && r.stop.reason) out.push(`      ${r.stop.reason}\n`);
    } else {
      const s = (r.steps || [])[0] || {};
      out.push(
        `  ${when}  ${ch.padEnd(6)} reported #${s.task ?? "?"} — ${s.result || "?"}${
          s.attempt > 1 ? ` (attempt ${s.attempt})` : ""
        }  ${money(r.steps)}\n`,
      );
    }
  }
  out.push("\n");
  out.push(
    summary.runs
      ? `one pass over the graph: ${summary.one_pass} of ${summary.runs} --go run(s) — ${Math.round((summary.one_pass_share || 0) * 100)}%\n`
      : "one pass over the graph: no --go run recorded yet\n",
  );
  const stops = Object.entries(summary.parked);
  out.push(stops.length ? `parked: ${stops.map(([k, n]) => `${k} x${n}`).join(", ")}\n` : "parked: never\n");
  out.push(
    `spend: $${summary.spend_usd} recorded${summary.unmeasured_steps ? `, ${summary.unmeasured_steps} step(s) unmeasured` : ""}\n`,
  );
  if (summary.reported_steps)
    out.push(
      `note: ${summary.reported_steps} step(s) came from the driven mode (--report), where the loop lives in the caller and one pass is not a property this journal can see.\n`,
    );
  return out.join("");
}

function cmdHistory(ref, f) {
  const records = readRunLog();
  let change = null;
  if (ref) {
    const data = loadBoard(appDataFile("todos.json"));
    const { root } = collectChange(data, ref);
    if (!root) fail(`no such change: ${ref}`);
    change = root.number;
  }
  const shown = change ? records.filter((r) => r.change && r.change.number === change) : records;
  const summary = summarizeRuns(records, { change });
  if (f.json) {
    process.stdout.write(
      JSON.stringify({ version: 1, kind: "run.history", change, summary, records: shown }, null, 2) + "\n",
    );
    return;
  }
  process.stdout.write(formatRunHistory(shown, summary));
}

// ── command ──────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const f = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") f.json = true;
    else if (a === "--dry-run" || a === "--dry") f.dry = true;
    else if (a === "--go") f.go = true;
    else if (a === "--inherit") f.inherit = true;
    else if (a === "--history") f.history = true;
    else if (a === "--from") f.from = args[++i];
    else if (a.startsWith("--from=")) f.from = a.slice("--from=".length);
    else if (a === "--force") f.force = true;
    else if (a === "--next") f.next = true;
    else if (a === "--report") f.report = args[++i];
    else if (a.startsWith("--report=")) f.report = a.slice("--report=".length);
    else if (a === "--result") f.result = args[++i];
    else if (a.startsWith("--result=")) f.result = a.slice("--result=".length);
    else if (a === "--handoff") f.handoff = args[++i];
    else if (a.startsWith("--handoff=")) f.handoff = a.slice("--handoff=".length);
    else if (a === "--reason") f.reason = args[++i];
    else if (a.startsWith("--reason=")) f.reason = a.slice("--reason=".length);
    else if (a === "--cost") f.cost = args[++i];
    else if (a.startsWith("--cost=")) f.cost = a.slice("--cost=".length);
    else if (a === "--review") f.review = args[++i];
    else if (a.startsWith("--review=")) f.review = a.slice("--review=".length);
    else if (a === "--spent") f.spent = args[++i];
    else if (a.startsWith("--spent=")) f.spent = a.slice("--spent=".length);
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
    "usage: cli todos run <change> [--dry-run | --go] [--inherit] [--parallel N] [--timeout <min>] [--json]\n" +
      "       cli todos run <change> --next [--parallel N] [--spent <usd>] [--json]\n" +
      "       cli todos run watch <change> [--from start]\n" +
      "       cli todos run <change> --report <task> --result ok|issue [--handoff <text>]\n" +
      '                     [--reason <text>] [--cost <usd>] [--review approve|issue] [--json]\n\n' +
      "  Executes a change's task graph: frontier -> step -> verify -> outcome, one\n" +
      "  session per step, until the run parks. What it executes is what already\n" +
      "  stands in the graph — the runner creates no tasks and closes no change.\n\n" +
      "  <change>       an id, a number, or #N (its dependency closure is the group)\n" +
      "  --dry-run      DEFAULT: print the plan — the order of steps, what would run,\n" +
      "                 where it would hit a gate, what it would cost by the DECLARED\n" +
      "                 budgets. Touches neither the board nor a model.\n" +
      "  --go           actually run it. Requires a budget declared on the change. Rollback touches only\n" +
      "                 produces and files changed by this step; snapshots are unreferenced local commits,\n" +
      "                 never pushed; unrelated uncommitted work is untouched.\n" +
      "  --inherit      fork each step from its prerequisite's session instead of\n" +
      "                 starting it cold — cheaper, the prefix is already warm, but\n" +
      "                 the step then SEES that session while its brief says there\n" +
      "                 is no earlier conversation. Only a node with exactly ONE\n" +
      "                 prerequisite run in this run inherits; a convergence node\n" +
      "                 starts cold, because two contexts cannot be merged and\n" +
      "                 dropping one of them silently is worse than the cost.\n" +
      "  --parallel N   override the change's declared parallel limit for this run\n" +
      "  --timeout <min>  ceiling for a step and for a check; without it the step\n" +
      "                 executor's own defaults stand (run-step.mjs)\n" +
      "  --json         the run report, machine-readable\n\n" +
      "  --history [<change>]  what past runs did, from the journal beside the board\n" +
      "                 (runs.jsonl, one line per --go run and per --report step):\n" +
      "                 what each cost, where it parked, and the share of runs that\n" +
      "                 needed exactly ONE pass over the graph — the number that says\n" +
      "                 whether plans hold up, and which stop eats them when they do not.\n\n" +
      "  watch <change>       print live events for one change and stop when its run parks or ends\n" +
      "    --from start       include existing events; otherwise starts at the current end of the journal\n\n" +
      "  --next         hand the frontier to a caller driving the loop itself — the\n" +
      "                 worker/review provider+model to bill (agents.mjs), each ready\n" +
      "                 node's declarations and inherited handoff. Moves no status —\n" +
      "                 a node still enters in_progress only on --report — but it DOES\n" +
      "                 stamp handout_at on every node it hands out (t#520): the floor\n" +
      "                 outcome.mjs's weak file evidence measures an mtime against, so\n" +
      "                 it cannot be the executor's own word about when it started.\n" +
      "  --report <task> apply one node's outcome through the same finishStep --go uses:\n" +
      "                 the declared verify, reconcile, the status move, retry/on-issue.\n" +
      "    --result ok|issue   did the work itself complete, or did it hit an issue\n" +
      "    --handoff <text>    the baton the step produced\n" +
      "    --reason <text>     why, when --result issue\n" +
      "    --cost <usd>        what it cost, if known — unmeasured stays unmeasured\n" +
      "    --review approve|issue   the review verdict, when the caller ran one\n\n" +
      "  Four stops, all printed the same way (node in review + reason + parked):\n" +
      "    gate            a manual node, or an `auto` one with no declared verify\n" +
      "    retry           the declared limit is spent (M/<=M), or none was declared\n" +
      "                    at all — a missing limit forbids the ?issue transition\n" +
      "    budget          soft, on a step boundary; nothing is rolled back\n" +
      "    empty-frontier  the change is open but nothing is workable — the graph lies\n\n" +
      "  Exit code: 0 when the change finished or parked at a gate, 1 otherwise.\n" +
      "  There is no --force here: overriding a failed check is a human exception.\n\n" +
      "  --next / --report never see what a subagent spends: the group budget is\n" +
      "  enforced only when you pass --spent yourself; without it, it is not checked.\n",
  );
  process.exit(code);
}

export async function run(args) {
  const f = parseFlags(args);
  if (f.positional[0] === "watch") {
    const change = f.positional[1];
    if (!change || f.positional.length > 2) usage(1);
    if (f.from !== undefined && f.from !== "start") fail('--from takes "start"');
    return watchRunEvents({ change, file: runEventsPath(runLogPath()), from: f.from });
  }
  const ref = f.positional[0];
  if (f.help) usage(0);
  if (f.history) return cmdHistory(ref || "", f);
  if (!ref) usage(1);
  if (f.next && f.report !== undefined) fail("--next and --report ask for opposite things — pick one");
  if (f.next) return cmdNext(ref, f);
  if (f.report !== undefined) return cmdReport(ref, f);
  if (f.force)
    fail(
      "--force is not the runner's to use: a failed check is overridden by a human, never by an autonomous run.\n" +
        "close the node yourself with `todos set status <task> done --force` if that is really your call.",
    );
  if (f.go && f.dry) fail("--go and --dry-run ask for opposite things — pick one");

  const dry = !f.go;
  if (!dry) recoverRedGate(process.cwd());
  const file = appDataFile("todos.json");
  const data = dry ? loadBoard(file) : loadBoardForWrite(file);
  const { root } = collectChange(data, ref);
  if (!root) {
    const number = String(ref).trim().match(/^#?(\d+)$/)?.[1];
    const change = number ? findChange(data, number) : null;
    fail(change ? `no graph for ${ref}; did you mean c#${change.number}?` : `no such task: ${ref}`);
  }
  if (!dry && typeof root.budget_usd !== "number") {
    fail(
      `refusing to run ${root.address ?? `#${root.number}`} unattended: no budget is declared on the change.\n` +
        "an autonomous run needs a ceiling it can stop itself at — declare one first:\n" +
        (root.record
          ? `  cli change set budget ${root.address} <usd>`
          : `  todos set budget ${root.number} <usd>`),
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
    inherit: !!f.inherit,
    parallelLimit: parallel,
    timeoutMs,
    cwd: process.cwd(),
    log: dry || f.json ? () => {} : (line) => process.stdout.write(line),
  });
  delete report.board;

  if (!dry) appendRunRecord(runRecordOf(report, { inherit: !!f.inherit }));

  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatRunReport(report));

  if (report.stop && report.stop.kind !== "gate") process.exit(1);
}
