// Unit tests for the runner core (`cli.mjs todos run <change>`, t#305).
//
// Everything the run does to the outside world sits behind an injected seam
// (executeStep / runVerify / reconcile / setStatus / stepCost), so these tests
// exercise the real semantics without starting a model or a shell. Each
// invariant of the DSL gets its own test, named after it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runChange,
  isGate,
  collectChange,
  attemptsSoFar,
  liveEffects,
  beginStep,
  finishStep,
  shouldEscalate,
  buildRunContext,
  applyResult,
  stepBrief,
  buildWave,
  resolveParallelLimit,
  formatStop,
  formatRunReport,
  run,
  appendRunRecord,
  readRunLog,
  runRecordOf,
  summarizeRuns,
  formatRunHistory,
} from "./run.mjs";
import { isReadyNode, loadBoard } from "../board/todos.mjs";
import { buildStepPrompt } from "./run-step.mjs";
import { snapshotTree } from "./red-gate.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────────
const task = (number, extra = {}) => ({
  id: `id-${number}`,
  number,
  subject: `task ${number}`,
  status: "queue",
  ...extra,
});

// An auto node the runner may close itself: kind auto + a declared check.
const auto = (number, extra = {}) => task(number, { kind: "auto", verify: "npm test", ...extra });

const changeRoot = (number, children, extra = {}) =>
  task(number, { change: true, depends_on: children.map((n) => `id-${n}`), ...extra });

const board = (...todos) => ({ version: 2, todos });
const deps = (...ns) => ns.map((n) => `id-${n}`);

const tick = () => new Promise((r) => setTimeout(r, 0));

// A recording seam. Overrides replace single effects; `maxParallel` observes how
// many steps were actually in flight at once.
function harness(overrides = {}) {
  const calls = { steps: [], reviews: [], statuses: [], verifies: [], reconciles: [], batons: [], alongside: [] };
  let live = 0;
  const state = { maxParallel: 0 };
  const effects = {
    executeStep: async ({ task: t, alongside }) => {
      live += 1;
      state.maxParallel = Math.max(state.maxParallel, live);
      calls.steps.push(t.number);
      calls.alongside.push([t.number, (alongside || []).map((p) => p.number)]);
      await tick();
      await tick();
      live -= 1;
      return { sessionId: `s-${t.number}`, ok: true };
    },
    reviewStep: async ({ task: t }) => {
      calls.reviews.push(t.number);
      return { approved: true, ok: true, costUsd: 0 };
    },
    recordHandoff: async ({ task: t, text }) => {
      calls.batons.push([t.number, text]);
      return { written: true };
    },
    runVerify: async ({ cmd }) => {
      calls.verifies.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    },
    reconcile: async ({ task: t, verify }) => {
      calls.reconciles.push([t.number, verify]);
      return { outcome: verify, outcome_reason: `verify:${verify}` };
    },
    recordIssue: async () => ({ written: true }),
    recordAttempt: async () => ({ written: true, snapshot: null }),
    setStatus: async ({ task: t, status }) => {
      calls.statuses.push([t.number, status]);
    },
    stepCost: async () => 0,
    // No real git in these tests unless a test opts in: without these stubs a
    // `dry:false` run falls through to liveEffects (buildRunContext merges it
    // under the harness), which would snapshot the ACTUAL repo working tree.
    stepBase: async () => ({ ok: false, error: "harness: no step base in tests" }),
    priorChanges: async () => ({ ok: true, changes: null }),
    ownChanges: async () => ({ ok: true, skip: true }),
    ...overrides,
  };
  return { effects, calls, state };
}

const go = (data, change, effects, opts = {}) =>
  runChange({ data, change, effects, dry: false, ...opts });

const statusOf = (report, number) =>
  report.board.todos.find((t) => t.number === number).status;

// ── the loop ─────────────────────────────────────────────────────────────────

describe("runChange — the frontier", () => {
  it("passes outside changes from the executor-scoped diff to review", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { step_base: "base" }));
    let reviewed;
    let executorEdits;
    const h = harness({
      executeStep: async () => ({ sessionId: "s-2", ok: true, editedPaths: ["a.txt"] }),
      ownChanges: async ({ editedPaths }) => {
        executorEdits = editedPaths;
        return {
          ok: true,
          own: [{ status: "M", path: "a.txt" }],
          outside: [{ status: "M", path: "b.txt" }],
          damaged: [],
        };
      },
      reviewStep: async (args) => {
        reviewed = args;
        return { approved: true, ok: true, costUsd: 0 };
      },
    });

    const report = await go(data, "1", h.effects);
    expect(executorEdits).toEqual(["a.txt"]);
    expect(reviewed.ownChanges).toEqual([{ status: "M", path: "a.txt" }]);
    expect(reviewed.outsideChanges).toEqual([{ status: "M", path: "b.txt" }]);
    expect(report.steps[0].outside_changes).toBe(1);
  });

  it("runs a linear three-step change all the way through", async () => {
    const data = board(
      changeRoot(1, [2, 3, 4], { budget_usd: 10 }),
      auto(2),
      auto(3, { depends_on: deps(2) }),
      auto(4, { depends_on: deps(3) }),
    );
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 3, 4]);
    expect(r.waves).toEqual([[2], [3], [4]]);
    expect(r.steps.map((s) => s.result)).toEqual(["done", "done", "done"]);
    expect(r.stop).toBeNull();
    expect(r.complete).toBe(true);
    // §14 п.7 — the runner closes no group and creates no task.
    expect(statusOf(r, 1)).toBe("queue");
    expect(h.calls.statuses.some(([n]) => n === 1)).toBe(false);
    expect(r.board.todos).toHaveLength(4);
    // The caller's board is never mutated — the engine works on a clone.
    expect(data.todos.map((t) => t.status)).toEqual(["queue", "queue", "queue", "queue"]);
  });

  it("keeps a parallel wave inside the change's declared parallel_limit", async () => {
    const data = board(changeRoot(1, [2, 3, 4, 5], { parallel_limit: 2 }), auto(2), auto(3), auto(4), auto(5));
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(r.max_parallel).toBe(2);
    expect(h.state.maxParallel).toBe(2);
    expect(r.waves).toEqual([[2, 3], [4, 5]]);
    expect(r.complete).toBe(true);
    // Each step of a wave is told who else is editing files right now — a
    // conflict between two of them costs both.
    expect(h.calls.alongside).toEqual([
      [2, [3]],
      [3, [2]],
      [4, [5]],
      [5, [4]],
    ]);
  });

  it("falls back to one step at a time when no parallel limit is declared", async () => {
    const data = board(changeRoot(1, [2, 3]), auto(2), auto(3));
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(r.change.parallel_limit).toBe(1);
    expect(r.change.parallel_declared).toBeNull();
    expect(h.state.maxParallel).toBe(1);
  });

  it("names the nodes it cannot reach when the frontier is empty and the change is open", async () => {
    // Two nodes waiting on each other: the frontier is empty from the start,
    // which is only possible when the graph lies about its edges.
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2, { depends_on: deps(3) }),
      auto(3, { depends_on: deps(2) }),
    );
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([]);
    expect(r.stop.kind).toBe("empty-frontier");
    expect(r.stop.reason).toMatch(/graph lies/);
    expect(r.stop.blocked.map((b) => [b.task.number, b.blocked_by.map((d) => d.number)])).toEqual([
      [2, [3]],
      [3, [2]],
    ]);
    expect(r.complete).toBe(false);
  });
});

describe("buildWave — declared output conflicts", () => {
  it("keeps ready steps with a shared produced path in separate waves", () => {
    const wave = buildWave([
      auto(2, { produces: ["src/shared.mjs"] }),
      auto(3, { produces: ["src/shared.mjs"] }),
    ], 2);

    expect(wave.map((t) => t.number)).toEqual([2]);
  });

  it("groups ready steps whose produced paths do not overlap", () => {
    const wave = buildWave([
      auto(2, { produces: ["src/first.mjs"] }),
      auto(3, { produces: ["src/second.mjs"] }),
    ], 2);

    expect(wave.map((t) => t.number)).toEqual([2, 3]);
  });

  it("compares produced paths independently of slash direction", () => {
    const wave = buildWave([
      auto(2, { produces: ["src\\shared.mjs"] }),
      auto(3, { produces: ["src/shared.mjs"] }),
    ], 2);

    expect(wave.map((t) => t.number)).toEqual([2]);
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

// §13: the baton is the ONE thing that crosses the seam, and the step has no
// shell to write it with. If the run does not put it on the board, nothing does.
describe("runChange — the baton", () => {
  it("puts the handoff the step wrote onto the board", async () => {
    const data = board(changeRoot(1, [2, 3]), auto(2), auto(3, { depends_on: deps(2) }));
    const batons = [];
    const h = harness({
      executeStep: async ({ task: t }) => ({
        sessionId: `s-${t.number}`,
        ok: true,
        handoff: `BATON-${t.number}`,
      }),
      recordHandoff: async ({ task: t, text }) => {
        batons.push([t.number, text]);
        return { written: true };
      },
    });
    const r = await go(data, "1", h.effects);

    expect(batons).toEqual([
      [2, "BATON-2"],
      [3, "BATON-3"],
    ]);
    expect(r.steps.map((s) => s.baton)).toEqual(["written", "written"]);
  });

  it("reports a step that wrote no HANDOFF instead of passing nothing on quietly", async () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const calls = [];
    const h = harness({
      executeStep: async ({ task: t }) => ({ sessionId: `s-${t.number}`, ok: true }),
      recordHandoff: async (a) => {
        calls.push(a);
        return { written: true };
      },
    });
    const r = await go(data, "1", h.effects);

    expect(calls).toEqual([]);
    expect(r.steps[0].baton).toBe("missing");
    expect(r.steps[0].result).toBe("done");
  });

  it("writes the baton of a step whose check then fails — what it did is still what it did", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 1 }));
    const batons = [];
    const h = harness({
      executeStep: async ({ task: t }) => ({ sessionId: `s-${t.number}`, ok: true, handoff: "half done" }),
      runVerify: async () => ({ code: 1, stdout: "", stderr: "" }),
      recordHandoff: async ({ text }) => {
        batons.push(text);
        return { written: true };
      },
    });
    const r = await go(data, "1", h.effects);

    expect(batons).toEqual(["half done"]);
    expect(r.stop.kind).toBe("retry");
  });

  it("a board that refuses the baton stops nothing and is said out loud", async () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const h = harness({
      executeStep: async ({ task: t }) => ({ sessionId: `s-${t.number}`, ok: true, handoff: "текст" }),
      recordHandoff: async () => ({ written: false, error: "board locked" }),
    });
    const r = await go(data, "1", h.effects);

    expect(r.steps[0].baton).toBe("refused");
    expect(r.steps[0].result).toBe("done");
    expect(r.complete).toBe(true);
  });
});

describe("runChange — lifecycle review", () => {
  it("reviews every successful worker result before deterministic verification", async () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const order = [];
    const h = harness({
      executeStep: async () => {
        order.push("worker");
        return { sessionId: "s-2", ok: true, result: "implemented" };
      },
      reviewStep: async ({ workerResult }) => {
        order.push(`review:${workerResult}`);
        return { approved: true, ok: true, model: "claude-opus-5-5", sessionId: "review-2", costUsd: 0 };
      },
      runVerify: async () => {
        order.push("verify");
        return { code: 0 };
      },
    });
    const r = await go(data, "1", h.effects);
    expect(order).toEqual(["worker", "review:implemented", "verify"]);
    expect(r.steps[0].review).toMatchObject({ approved: true, model: "claude-opus-5-5", session: "review-2" });
  });

  // A reviewer reads the board as the step left it — in the agent-driven mode
  // (t#356) that reviewer is a subagent handed the board's current state, so the
  // baton must already be on it. Pin the order so a later split cannot lose it
  // silently the way the beginStep/finishStep split first did.
  it("writes the baton before the reviewer runs", async () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const order = [];
    const h = harness({
      executeStep: async ({ task: t }) => {
        order.push("worker");
        return { sessionId: `s-${t.number}`, ok: true, handoff: "BATON-2" };
      },
      recordHandoff: async ({ text }) => {
        order.push(`baton:${text}`);
        return { written: true };
      },
      reviewStep: async () => {
        order.push("review");
        return { approved: true, ok: true, costUsd: 0 };
      },
    });
    const r = await go(data, "1", h.effects);

    expect(order).toEqual(["worker", "baton:BATON-2", "review"]);
    expect(r.steps[0].baton).toBe("written");
  });

  it("parks an unapproved review without running verify", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 1 }));
    const h = harness({
      reviewStep: async () => ({ approved: false, ok: true, result: "scope regression\nVERDICT: issue" }),
    });
    const r = await go(data, "1", h.effects);
    expect(h.calls.verifies).toEqual([]);
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.reason).toContain("model review issue");
    expect(statusOf(r, 2)).toBe("review");
  });
});

describe("runChange — gates", () => {
  it("does the gate's work, parks it in review and leaves its dependents untouched", async () => {
    const data = board(
      changeRoot(1, [2, 3, 4]),
      auto(2),
      task(3, { depends_on: deps(2) }), // kind manual — the gate
      auto(4, { depends_on: deps(3) }),
    );
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2]);
    expect(h.calls.reviews).toEqual([2]);
    expect(statusOf(r, 3)).toBe("review");
    expect(statusOf(r, 4)).toBe("queue");
    expect(r.stop.kind).toBe("gate");
    expect(r.stop.task.number).toBe(3);
    expect(r.stop.status).toBe("review");
    expect(r.stop.reason).toMatch(/kind manual/);
  });

  it("a manual node with produces still goes to the executor and the reviewer", async () => {
    const data = board(changeRoot(1, [2]), task(2, { produces: ["docs/a.md"] }));
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2]);
    expect(h.calls.reviews).toEqual([2]);
    expect(statusOf(r, 2)).toBe("review");
    expect(r.stop.kind).toBe("gate");
  });

  it("treats an auto node WITHOUT a declared verify as a gate, not as auto", async () => {
    const data = board(changeRoot(1, [2]), task(2, { kind: "auto" }));
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(isGate(data.todos[1])).toBe(true);
    expect(h.calls.steps).toEqual([2]); // the work IS done
    expect(h.calls.verifies).toEqual([]); // there is no check to run
    expect(h.calls.reconciles).toEqual([]); // and no outcome to claim
    expect(statusOf(r, 2)).toBe("review");
    expect(r.stop.kind).toBe("gate");
    expect(r.stop.reason).toMatch(/auto WITHOUT a declared verify/);
  });

  it("parks on a node already sitting in review instead of redoing its work", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { status: "review" }));
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([]);
    expect(r.stop.kind).toBe("gate");
    expect(r.stop.reason).toMatch(/already in review/);
  });
});

// ── the loop construct ───────────────────────────────────────────────────────

describe("runChange — issue, transition and the retry limit", () => {
  const failing = (numbers) => ({
    runVerify: async ({ cmd }) => ({ code: cmd === "flaky" ? 1 : 0, stdout: "", stderr: "" }),
    reconcile: async ({ task: t, verify }) => ({
      outcome: numbers.includes(t.number) ? verify : "ok",
      outcome_reason: `verify:${verify}`,
    }),
  });

  it("takes the declared ?issue transition and counts the attempt", async () => {
    // #3 checks #2's work; its check fails once, control goes back to #2.
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2),
      auto(3, { depends_on: deps(2), verify: "flaky", retry_limit: 2, on_issue: "id-2" }),
    );
    let round = 0;
    const h = harness({
      runVerify: async () => ({ code: 0 }),
      reconcile: async ({ task: t }) => {
        if (t.number !== 3) return { outcome: "ok", outcome_reason: "ok" };
        round += 1;
        return round === 1
          ? { outcome: "issue", outcome_reason: "verify:issue" }
          : { outcome: "ok", outcome_reason: "ok" };
      },
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 3, 2, 3]);
    expect(r.transitions).toHaveLength(1);
    expect(r.transitions[0]).toMatchObject({ attempt: 1, limit: 2 });
    expect(r.transitions[0].from.number).toBe(3);
    expect(r.transitions[0].to.number).toBe(2);
    const attempts = r.steps.filter((s) => s.task.number === 3).map((s) => s.attempt);
    expect(attempts).toEqual([1, 2]);
    expect(r.complete).toBe(true);
    expect(statusOf(r, 3)).toBe("done");
  });

  it("parks with M/<=M once the declared retry limit is spent", async () => {
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2),
      auto(3, { depends_on: deps(2), retry_limit: 2, on_issue: "id-2" }),
    );
    const h = harness({ ...failing([3]), runVerify: async () => ({ code: 1 }) });
    const r = await go(data, "1", h.effects);

    const attempts = r.steps.filter((s) => s.task.number === 3).map((s) => s.attempt);
    expect(attempts).toEqual([1, 2]);
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.task.number).toBe(3);
    expect(r.stop.reason).toMatch(/2\/<=2/);
    expect(statusOf(r, 3)).toBe("review");
  });

  it("parks an issue over its node budget before it can retry", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 3, budget_usd: 1 }));
    const h = harness({
      reconcile: async () => ({ outcome: "issue", outcome_reason: "verify:issue" }),
      stepCost: async () => 2,
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2]);
    expect(r.stop.kind).toBe("budget");
    expect(statusOf(r, 2)).toBe("review");
  });

  it("continues retrying issues within its node budget", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 3, budget_usd: 10 }));
    const h = harness({
      reconcile: async () => ({ outcome: "issue", outcome_reason: "verify:issue" }),
      stepCost: async () => 2,
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 2, 2]);
    expect(r.stop.kind).toBe("retry");
  });

  it("does not reopen an on-issue target when the issuing node is over budget", async () => {
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2),
      auto(3, { depends_on: deps(2), retry_limit: 3, budget_usd: 1, on_issue: "id-2" }),
    );
    const h = harness({
      reconcile: async ({ task: t }) => t.number === 3
        ? { outcome: "issue", outcome_reason: "verify:issue" }
        : { outcome: "ok", outcome_reason: "verify:ok" },
      stepCost: async () => 2,
    });
    const r = await go(data, "1", h.effects);

    expect(r.stop.kind).toBe("budget");
    expect(statusOf(r, 2)).toBe("done");
    expect(r.transitions).toEqual([]);
  });

  it("prints and records a retry decision card with the final verify tail and limit plus two", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 1, budget_usd: 5 }));
    const comments = [];
    const h = harness({
      runVerify: async () => ({ code: 1, stderr: Array.from({ length: 25 }, (_, i) => `verify line ${i + 1}`).join("\n") }),
      reconcile: async () => ({ outcome: "issue", outcome_reason: "verify:issue" }),
      recordIssue: async ({ comment }) => { comments.push(comment); return { written: true }; },
      stepCost: async () => 1.25,
    });
    const r = await go(data, "1", h.effects);

    expect(r.card).toContain("Decision card — retry");
    expect(r.card).toContain("verify line 6");
    expect(r.card).not.toContain("verify line 5");
    expect(r.card).toContain("todos set retry t#2 3");
    expect(r.card).toContain("todos run c#1 --go");
    expect(comments.at(-1).body).toContain("Decision card — retry");
  });

  it("labels the run header with c# for a change", async () => {
    const r = await runChange({ data: board(changeRoot(1, [2]), auto(2)), change: "1", dry: true });
    expect(formatRunReport(r)).toMatch(/^change c#1 /);
  });

  it("never starts attempt M+1", async () => {
    // The counter is derived from status_history: this node has already spent
    // its single declared attempt, so no work may start at all.
    const data = board(
      changeRoot(1, [2]),
      auto(2, {
        retry_limit: 1,
        on_issue: "id-2",
        status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
      }),
    );
    const h = harness();
    const r = await go(data, "1", h.effects);

    expect(attemptsSoFar(data.todos[1])).toBe(1);
    expect(h.calls.steps).toEqual([]);
    expect(h.calls.statuses).toEqual([[2, "review"]]);
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.reason).toMatch(/attempt 2 would be past the declared limit/);
  });

  it("does not take the transition when no retry limit is declared", async () => {
    // on_issue without retry_limit cannot be written through the CLI, but a
    // hand-edited board can carry it — the missing limit FORBIDS the transition.
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2),
      auto(3, { depends_on: deps(2), on_issue: "id-2" }),
    );
    const h = harness({ ...failing([3]), runVerify: async () => ({ code: 1 }) });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 3]); // #2 is never re-run
    expect(r.transitions).toEqual([]);
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.reason).toMatch(/NO declared retry limit/);
    expect(statusOf(r, 2)).toBe("done");
    expect(statusOf(r, 3)).toBe("review");
  });
});

describe("runChange — self-retry when a retry limit is declared but no on_issue is", () => {
  it("requeues the node itself and runs it a second time, carrying the reviewer's findings forward", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 2 }));
    const seen = [];
    const h = harness({
      executeStep: async (b) => {
        seen.push(b);
        return { sessionId: `s-2-${seen.length}`, ok: true, result: "implemented" };
      },
      reviewStep: async () => ({
        approved: seen.length === 1 ? false : true,
        ok: true,
        model: "opus",
        result: "scope regression: touched files outside the promise\nVERDICT: issue",
      }),
    });
    const r = await go(data, "1", h.effects);

    expect(seen).toHaveLength(2);
    expect(seen[0].attempt).toBe(1);
    expect(seen[0].limit).toBe(2);
    expect(seen[1].attempt).toBe(2);
    expect(seen[1].limit).toBe(2);
    expect(r.complete).toBe(true);
    expect(statusOf(r, 2)).toBe("done");
    expect(r.transitions).toHaveLength(1);
    expect(r.transitions[0].from.number).toBe(2);
    expect(r.transitions[0].to.number).toBe(2);
    expect(r.transitions[0].self).toBe(true);

    const comment = (seen[1].task.comments || []).find(
      (c) => c.author === "review" && c.body.startsWith("ISSUE attempt 1/2"),
    );
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("review opus");
    expect(comment.body).toContain("scope regression: touched files outside the promise");

    const prompt = buildStepPrompt({
      task: seen[1].task,
      board: seen[1].board,
      alongside: seen[1].alongside,
      attempt: seen[1].attempt,
      limit: seen[1].limit,
    });
    expect(prompt).toContain("PREVIOUS ATTEMPT");
    expect(prompt).toContain("scope regression: touched files outside the promise");
  }, 20000);

  it("adds an ISSUE comment with the verify output tail when the declared check fails", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 1 }));
    const h = harness({
      runVerify: async () => ({
        code: 1,
        stdout: "running tests\n...\nFAIL something\n",
        stderr: "assertion failed at line 12\n",
      }),
    });
    const r = await go(data, "1", h.effects);

    const t2 = r.board.todos.find((t) => t.number === 2);
    const comment = (t2.comments || []).find(
      (c) => c.author === "review" && c.body.startsWith("ISSUE attempt 1/1"),
    );
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("verify");
    expect(comment.body).toContain("assertion failed at line 12");
    expect(r.stop.kind).toBe("retry");
    expect(statusOf(r, 2)).toBe("review");
  });

  it("adds an ISSUE comment with the executor error when the step itself fails", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 1 }));
    const h = harness({
      executeStep: async () => ({ sessionId: "s-2", ok: false, error: "codex exited 3: sandbox denied write" }),
    });
    const r = await go(data, "1", h.effects);

    const t2 = r.board.todos.find((t) => t.number === 2);
    const comment = (t2.comments || []).find((c) => c.author === "review" && c.body.startsWith("ISSUE attempt 1/1"));
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("executor");
    expect(comment.body).toContain("sandbox denied write");
  });

  it("adds an ISSUE comment with the reconcile reason when verify passes but the outcome is issue", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 1 }));
    const h = harness({
      reconcile: async () => ({ outcome: "issue", outcome_reason: "promised src/a.ts was never written" }),
    });
    const r = await go(data, "1", h.effects);

    const t2 = r.board.todos.find((t) => t.number === 2);
    const comment = (t2.comments || []).find((c) => c.author === "review" && c.body.startsWith("ISSUE attempt 1/1"));
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("reconcile");
    expect(comment.body).toContain("promised src/a.ts was never written");
  });

  it("never starts a third attempt when the retry limit is 2 and every attempt gets an issue", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 2 }));
    const h = harness({
      reviewStep: async () => ({ approved: false, ok: true, result: "still wrong\nVERDICT: issue" }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 2]);
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.reason).toMatch(/retry limit exhausted/);
    expect(statusOf(r, 2)).toBe("review");
  });
});

const redAuto = (number, extra = {}) =>
  auto(number, { red: "npm run test:red", red_tests: ["test/regression.spec.js"], ...extra });

describe("runChange — the red gate never shares a wave", () => {
  it("keeps a red-declared step solo even when the parallel limit allows more", async () => {
    const data = board(
      changeRoot(1, [2, 3, 4], { parallel_limit: 3, budget_usd: 10 }),
      auto(2),
      redAuto(3),
      auto(4),
    );
    const h = harness({
      stepBase: async () => ({ ok: true, sha: "base-sha" }),
      redGate: async () => ({ ok: true, field: "failed-on-base", reason: null }),
    });
    const r = await go(data, "1", h.effects);

    expect(r.waves).toEqual([[2], [3], [4]]);
    expect(r.complete).toBe(true);
  });

  it("parks a red-declared step instead of starting it when the base cannot be recorded", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), redAuto(2));
    const h = harness({
      stepBase: async () => ({ ok: false, error: "not a git repository" }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([]);
    expect(r.stop.kind).toBe("red-base");
    expect(r.stop.reason).toMatch(/not a git work tree/);
    expect(statusOf(r, 2)).toBe("queue");
  });
});

describe("runChange — the red gate's verdict", () => {
  it("a failing gate (red passes on base) produces an ISSUE comment with source `red` and is retried per retry_limit", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), redAuto(2, { retry_limit: 2 }));
    const h = harness({
      stepBase: async () => ({ ok: true, sha: "base-sha" }),
      redGate: async () => ({
        ok: false,
        field: "passed-on-base",
        reason: "the regression test passes on the base code — it does not catch the bug",
      }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2, 2]);
    expect(h.calls.verifies).toEqual([]);
    const t2 = r.board.todos.find((t) => t.number === 2);
    const comment = (t2.comments || []).find(
      (c) => c.author === "review" && c.body.startsWith("ISSUE attempt 1/2"),
    );
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("red");
    expect(comment.body).toContain("does not catch the bug");
    expect(r.stop.kind).toBe("retry");
    expect(r.stop.reason).toMatch(/retry limit exhausted/);
    expect(statusOf(r, 2)).toBe("review");
  });

  it("a passing gate (red fails on base) proceeds to the declared verify and records the field", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), redAuto(2));
    const h = harness({
      stepBase: async () => ({ ok: true, sha: "base-sha" }),
      redGate: async () => ({ ok: true, field: "failed-on-base", reason: null }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.verifies).toEqual(["npm test"]);
    expect(r.steps[0].result).toBe("done");
    expect(r.steps[0].red).toBe("failed-on-base");
    expect(statusOf(r, 2)).toBe("done");
  });
});

describe("runChange — flow gate", () => {
  it("retries a flow issue and sends its reason to the task comment", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 2, step_base: "base", flow: { file: "src/Notifier.cs", method: "Send" } }));
    const h = harness({ flowGate: async () => ({ status: "issue", reason: "missing guard", coverage: [], unchecked: [], duration_ms: 7 }) });
    const r = await go(data, "1", h.effects);
    expect(h.calls.verifies).toEqual([]);
    expect(r.stop.kind).toBe("retry");
    expect(r.board.todos.find((t) => t.number === 2).comments[0].body).toContain("flow\nmissing guard");
  });

  it("parks flow cannot without retrying or running verify", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 2, step_base: "base", flow: { file: "src/Notifier.cs", method: "Send" } }));
    const h = harness({ flowGate: async () => ({ status: "cannot", reason: "executable missing", coverage: [], unchecked: [], duration_ms: 4 }) });
    const r = await go(data, "1", h.effects);
    expect(h.calls.steps).toEqual([2]);
    expect(h.calls.verifies).toEqual([]);
    expect(r.stop).toMatchObject({ kind: "flow-cannot", reason: "executable missing" });
    expect(statusOf(r, 2)).toBe("review");
  });

  it("records flow measurements and prints unchecked produces", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { step_base: "base", flow: { file: "src/Notifier.cs", method: "Send" } }));
    const h = harness({ flowGate: async () => ({ status: "pass", reason: null, coverage: ["other method"], unchecked: [{ file: "docs/note.md" }], duration_ms: 9 }) });
    const r = await go(data, "1", h.effects, { log: () => {} });
    expect(r.steps[0].flow).toMatchObject({ status: "pass", duration_ms: 9, unchecked: [{ file: "docs/note.md" }] });
    expect(runRecordOf(r).steps[0].flow.status).toBe("pass");
    expect(formatRunReport(r)).toContain("не проверено: docs/note.md");
  });

  it("skips flow for an absent or n/a declaration and reaches verify", async () => {
    for (const flow of [undefined, "n/a no C# method body"]) {
      const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { step_base: "base", flow }));
      const h = harness({ flowGate: async () => { throw new Error("must not run"); } });
      const r = await go(data, "1", h.effects);
      expect(h.calls.verifies).toEqual(["npm test"]);
      expect(r.steps[0].flow ?? null).toBeNull();
    }
  });
});

describe("runChange — neighbour damage ends a step as issue before review", () => {
  it("parks scope damage after the one high-route retry instead of queuing another attempt", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, {
      produces: ["src/own.js"],
      _runner_high_route_attempt: 1,
    }));
    data.todos[1].step_base = "base-sha";
    const h = harness({
      recordIssue: async () => ({ written: true }),
      ownChanges: async () => ({
        ok: true,
        own: [{ status: "D", path: "src/prior.js" }],
        damaged: [{ path: "src/prior.js", state: "deleted" }],
      }),
    });
    const r = await go(data, "1", h.effects);

    expect(r.steps[0].result).toBe("issue");
    expect(r.stop).toMatchObject({ kind: "convergence" });
    expect(statusOf(r, 2)).toBe("review");
  });

  it("a step that reverts or deletes an earlier step's uncommitted work never reaches review", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { produces: ["src/own.js"] }));
    data.todos[1].step_base = "base-sha";
    const h = harness({
      ownChanges: async () => ({
        ok: true,
        own: [
          { status: "M", path: "src/sum.mjs" },
          { status: "D", path: "test/sum.regression.test.mjs" },
        ],
        damaged: [
          { path: "src/sum.mjs", state: "reverted" },
          { path: "test/sum.regression.test.mjs", state: "deleted" },
        ],
      }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.reviews).toEqual([]);
    expect(r.steps[0].result).toBe("issue");
    expect(r.steps[0].reason).toMatch(/reverted or deleted/);
    expect(r.steps[0].own_changes).toBe(2);
    expect(r.steps[0].neighbour_damage).toBe(2);
    const t2 = r.board.todos.find((t) => t.number === 2);
    const comment = (t2.comments || []).find((c) => c.author === "review" && c.body.includes("\nscope\n"));
    expect(comment).toBeTruthy();
    expect(comment.body).toContain("src/sum.mjs");
    expect(comment.body).toContain("test/sum.regression.test.mjs");
  });

  it("a step that only adds its own file causes no issue", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { produces: ["src/own.js"] }));
    data.todos[1].step_base = "base-sha";
    const h = harness({
      ownChanges: async () => ({ ok: true, own: [{ status: "A", path: "src/own.js" }], damaged: [] }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.reviews).toEqual([2]);
    expect(r.steps[0].result).toBe("done");
    expect(r.steps[0].own_changes).toBe(1);
    expect(r.steps[0].neighbour_damage).toBe(0);
  });

  it("a step that modifies a prior file that IS in its own produces causes no issue", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { produces: ["src/sum.mjs"] }));
    data.todos[1].step_base = "base-sha";
    const h = harness({
      ownChanges: async () => ({ ok: true, own: [{ status: "M", path: "src/sum.mjs" }], damaged: [] }),
    });
    const r = await go(data, "1", h.effects);

    expect(h.calls.reviews).toEqual([2]);
    expect(r.steps[0].result).toBe("done");
  });
});

// ── whose context a step starts from ─────────────────────────────────────────

// t#543. The choice is the spawner's, never the graph's: `--go` makes it here.
// One prerequisite's context is unambiguous; two cannot be merged.
describe("runChange — --inherit", () => {
  it("starts every step cold unless inheriting was asked for", async () => {
    const data = board(changeRoot(1, [2, 3], { budget_usd: 10 }), auto(2), auto(3, { depends_on: deps(2) }));
    const seen = [];
    const h = harness({
      executeStep: async ({ task: t, inherit }) => {
        seen.push([t.number, inherit]);
        return { sessionId: `s-${t.number}`, ok: true };
      },
    });
    await go(data, "1", h.effects);

    expect(seen).toEqual([
      [2, ""],
      [3, ""],
    ]);
  });

  it("forks a step from its single prerequisite's session", async () => {
    const data = board(changeRoot(1, [2, 3], { budget_usd: 10 }), auto(2), auto(3, { depends_on: deps(2) }));
    const seen = [];
    const h = harness({
      executeStep: async ({ task: t, inherit }) => {
        seen.push([t.number, inherit]);
        return { sessionId: `s-${t.number}`, ok: true };
      },
    });
    await go(data, "1", h.effects, { inherit: true });

    expect(seen).toEqual([
      [2, ""],
      [3, "s-2"],
    ]);
  });

  it("starts a convergence node cold — two contexts cannot be merged", async () => {
    const data = board(
      changeRoot(1, [2, 3, 4, 5], { budget_usd: 10, parallel_limit: 2 }),
      auto(2),
      auto(3, { depends_on: deps(2) }),
      auto(4, { depends_on: deps(2) }),
      auto(5, { depends_on: deps(3, 4) }),
    );
    const seen = new Map();
    const h = harness({
      executeStep: async ({ task: t, inherit }) => {
        seen.set(t.number, inherit);
        return { sessionId: `s-${t.number}`, ok: true };
      },
    });
    await go(data, "1", h.effects, { inherit: true });

    expect(seen.get(3)).toBe("s-2");
    expect(seen.get(4)).toBe("s-2");
    expect(seen.get(5)).toBe("");
  });

  it("keeps a step cold when the prerequisite did not run in THIS run", async () => {
    const data = board(
      changeRoot(1, [2, 3], { budget_usd: 10 }),
      auto(2, { status: "done" }),
      auto(3, { depends_on: deps(2) }),
    );
    const seen = [];
    const h = harness({
      executeStep: async ({ task: t, inherit }) => {
        seen.push([t.number, inherit]);
        return { sessionId: `s-${t.number}`, ok: true };
      },
    });
    await go(data, "1", h.effects, { inherit: true });

    expect(seen).toEqual([[3, ""]]);
  });
});

// ── a board that says no ─────────────────────────────────────────────────────

// The live failure of c#19 (t#528): a lost transition left a prerequisite open,
// the done-gate refused to close the node that depended on it, and the throw
// took the whole report with it — the run printed no spend at all, so what the
// steps had already cost was unrecoverable. The refusal now travels as data.
describe("runChange — a refused transition", () => {
  it("keeps the report and the spend when the board refuses to close a node", async () => {
    const data = board(changeRoot(1, [2, 3], { budget_usd: 10 }), auto(2), auto(3, { depends_on: deps(2) }));
    const h = harness({
      setStatus: async ({ task: t, status }) => {
        if (t.number === 3 && status === "done")
          throw new Error("set status #3 done refused: #3 depends on unfinished task(s): #2 [in_progress]");
      },
      stepCost: async () => 0.5,
    });
    const r = await go(data, "1", h.effects);

    expect(r.steps.map((s) => s.task.number)).toEqual([2, 3]);
    expect(r.spend.usd).toBe(1);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].task.number).toBe(3);
    expect(r.refused[0].status).toBe("done");
    expect(r.refused[0].error).toMatch(/depends on unfinished/);
    expect(r.stop.kind).toBe("outcome");
    expect(r.stop.reason).toMatch(/board refused to close the node/);
    expect(statusOf(r, 2)).toBe("done");
    expect(statusOf(r, 3)).toBe("review");
  });
});

// ── the budget ───────────────────────────────────────────────────────────────

describe("runChange — budget", () => {
  it("stops on the step boundary and rolls nothing back", async () => {
    const data = board(changeRoot(1, [2, 3], { budget_usd: 1 }), auto(2), auto(3, { depends_on: deps(2) }));
    const h = harness({ stepCost: async () => 1 });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2]); // #3 was never started, not killed
    expect(r.stop.kind).toBe("budget");
    expect(r.stop.not_started.number).toBe(3);
    expect(r.spend).toMatchObject({ usd: 1, group_budget: 1 });
    // Nothing is rolled back and no status is rewritten after the fact.
    expect(statusOf(r, 2)).toBe("done");
    expect(statusOf(r, 3)).toBe("queue");
    expect(h.calls.statuses).toEqual([
      [2, "in_progress"],
      [2, "done"],
    ]);
  });

  it("stops on a node's own declared ceiling too", async () => {
    const data = board(
      changeRoot(1, [2, 3], { budget_usd: 100 }),
      auto(2, { budget_usd: 0.5 }),
      auto(3, { depends_on: deps(2) }),
    );
    const h = harness({ stepCost: async () => 0.75 });
    const r = await go(data, "1", h.effects);

    expect(h.calls.steps).toEqual([2]);
    expect(r.stop.kind).toBe("budget");
    expect(r.stop.task.number).toBe(2);
    expect(statusOf(r, 2)).toBe("done");
  });
});

// ── dry run ──────────────────────────────────────────────────────────────────

describe("runChange — dry run", () => {
  it("touches neither the board nor the model, and prices the plan by declared budgets", async () => {
    const boom = () => {
      throw new Error("the dry run reached the seam");
    };
    const h = harness({
      executeStep: boom,
      runVerify: boom,
      reconcile: boom,
      setStatus: boom,
      stepCost: undefined,
    });
    delete h.effects.stepCost;

    const data = board(
      changeRoot(1, [2, 3, 4], { budget_usd: 10, parallel_limit: 2 }),
      auto(2, { budget_usd: 2 }),
      auto(3, { budget_usd: 3 }),
      task(4, { depends_on: deps(2, 3) }), // the gate the plan stops at
    );
    const r = await runChange({ data, change: "1", effects: h.effects, dry: true });

    expect(h.calls.steps).toEqual([]);
    expect(h.calls.statuses).toEqual([]);
    expect(r.dry).toBe(true);
    expect(r.waves).toEqual([[2, 3], [4]]);
    expect(r.steps.map((s) => s.task.number)).toEqual([2, 3, 4]);
    expect(r.steps.map((s) => s.gate)).toEqual([false, false, true]);
    expect(r.spend.usd).toBe(5); // 2 + 3 by the DECLARED budgets; the gate declares none
    expect(r.stop.kind).toBe("gate");
    expect(r.stop.task.number).toBe(4);
    // The caller's board is untouched: statuses on the original object stand.
    expect(data.todos.map((t) => t.status)).toEqual(["queue", "queue", "queue", "queue"]);
  });
});

// ── the group ────────────────────────────────────────────────────────────────

describe("collectChange", () => {
  it("takes the dependency closure of the root and never the root itself", () => {
    const data = board(
      changeRoot(1, [2]),
      auto(2, { depends_on: deps(3, 4) }),
      auto(3),
      auto(4, { depends_on: deps(3) }),
      auto(9), // another board area, not reachable from the root
    );
    const { root, members } = collectChange(data, "#1");
    expect(root.number).toBe(1);
    expect(members.map((t) => t.number)).toEqual([2, 3, 4]);
  });

  // Every test above injects its own stepCost, so the LIVE seam is the one place
  // a rename can pass unnoticed: reading the wrong field would report every step
  // as unmeasured and quietly disable the budget ceiling, which is the only
  // thing that stops an autonomous run. Pin it to what run-step.mjs returns.
  it("liveEffects reads the step's cost under the name the executor returns", async () => {
    const { stepCost } = liveEffects({ cwd: process.cwd() });
    expect(await stepCost({ result: { costUsd: 1.25 } })).toBe(1.25);
    // Unknown stays unknown — a missing measurement is never a zero.
    expect(await stepCost({ result: { costUsd: null } })).toBeNull();
    expect(await stepCost({ result: {} })).toBeNull();
  });
});

// The other live-only seam (t#312): `setStatus` really spawns the CLI, and the
// CLI really writes the binding journal — the injected seam of every test above
// hides both. Run it the way the runner is actually started, from inside a
// Claude Code session, and pin that the parent's session id stays out.
describe("liveEffects — the board seam", () => {
  it("moves the board without opening a block on the session that launched the runner", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-live-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "todos.json"),
      JSON.stringify({
        version: 2,
        todos: [{ id: "id-2", number: 2, subject: "task 2", status: "queue" }],
      }),
    );
    const prevAppData = process.env.APPDATA;
    const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.APPDATA = dir;
    process.env.CLAUDE_CODE_SESSION_ID = "parent-session";
    try {
      const { setStatus } = liveEffects({ cwd: process.cwd() });
      await setStatus({ task: { id: "id-2", number: 2 }, status: "in_progress" });
      const after = loadBoard(path.join(appDir, "todos.json"));
      expect(after.todos[0].status).toBe("in_progress");
      // No journal at all: the only binding a step gets is the one run-step.mjs
      // writes for the session that does the work.
      expect(existsSync(path.join(appDir, "task-sessions.jsonl"))).toBe(false);
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe("run change references", () => {
  it("suggests c#N when #N names an existing change but no task graph", () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-change-ref-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "todos.json"), JSON.stringify({
      version: 1,
      todos: [],
      changes: [{ id: "change-8", number: 8, title: "change eight" }],
    }));
    try {
      const result = spawnSync(process.execPath, [cli, "todos", "run", "#8"], {
        encoding: "utf8", env: { ...process.env, APPDATA: dir }, windowsHide: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("did you mean c#8?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The two halves runOne is composed from (t#356) — each callable, and testable,
// on its own so a caller outside this loop can drive one attempt in two calls.
describe("beginStep", () => {
  it("refuses at the retry limit without moving the node", async () => {
    const t = auto(2, {
      retry_limit: 1,
      on_issue: "id-2",
      status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
    });
    const statuses = [];
    const ctx = {
      attempts: new Map(),
      dry: false,
      data: board(t),
      cwd: process.cwd(),
      timeoutMs: undefined,
      effects: {
        setStatus: async ({ task, status }) => {
          statuses.push([task.number, status]);
        },
      },
    };
    const begun = await beginStep(ctx, t, [t]);

    expect(begun).toEqual({ task: t, kind: "retry-exhausted", attempt: 1, limit: 1, cost: null, session: null });
    expect(statuses).toEqual([]);
    expect(t.status).toBe("queue");
    expect(ctx.attempts.has(t.id)).toBe(false);
  });

  it("moves the node to in_progress and hands the executor its brief when attempts remain", async () => {
    const t = auto(2, { retry_limit: 2 });
    const sibling = auto(3);
    const statuses = [];
    const ctx = {
      attempts: new Map(),
      dry: false,
      data: board(t, sibling),
      cwd: "/work",
      timeoutMs: 1000,
      effects: {
        setStatus: async ({ task, status }) => {
          statuses.push([task.number, status]);
        },
      },
    };
    const begun = await beginStep(ctx, t, [t, sibling]);

    expect(begun.kind).toBe("begin");
    expect(begun.attempt).toBe(1);
    expect(begun.limit).toBe(2);
    expect(begun.brief).toMatchObject({ task: t, cwd: "/work", timeoutMs: 1000 });
    expect(begun.brief.alongside).toEqual([{ id: sibling.id, number: 3, subject: sibling.subject }]);
    expect(statuses).toEqual([[2, "in_progress"]]);
    expect(t.status).toBe("in_progress");
    expect(ctx.attempts.get(t.id)).toBe(1);
  });

  it("journals the flow declaration, including an explicit n/a when it is absent", async () => {
    const appData = mkdtempSync(path.join(os.tmpdir(), "run-flow-events-"));
    const previous = process.env.APPDATA;
    process.env.APPDATA = appData;
    try {
      const makeCtx = (t) => ({
        attempts: new Map(), dry: false, events: true, runId: "flow-test", root: task(1, { change: true }), data: board(t), cwd: process.cwd(), timeoutMs: undefined,
        effects: { setStatus: async () => {}, stepBase: async () => ({ ok: true, sha: "base" }), priorChanges: async () => ({ ok: true }) },
      });
      const flowing = auto(2, { flow: { file: "src/Notifier.cs", method: "Send" } });
      const absent = auto(3);
      await beginStep(makeCtx(flowing), flowing);
      await beginStep(makeCtx(absent), absent);
      const events = readFileSync(path.join(appData, "com.claude-usage-tracker.app", "run-events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map((event) => event.flow)).toEqual([{ file: "src/Notifier.cs", method: "Send" }, "n/a"]);
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
      rmSync(appData, { recursive: true, force: true });
    }
  });
});

describe("finishStep", () => {
  const finishCtx = (t, { cwd = process.cwd(), ...overrides } = {}) => ({
    dry: false,
    cwd,
    timeoutMs: undefined,
    attempts: new Map([[t.id, 1]]),
    effects: {
      setStatus: async () => {},
      recordHandoff: async () => ({ written: true }),
      stepCost: async () => 0,
      runVerify: async () => ({ code: 0 }),
      reconcile: async () => ({ outcome: "ok", outcome_reason: "verify:ok" }),
      ...overrides,
    },
  });

  it("produces the gate result for a manual node", async () => {
    const t = task(3);
    const ctx = finishCtx(t);
    const out = await finishStep(ctx, t, { result: { sessionId: "s-3", ok: true }, review: null });

    expect(out.kind).toBe("gate");
    expect(out.reason).toMatch(/kind manual/);
    expect(out.session).toBe("s-3");
    expect(t.status).toBe("review");
  });

  it("produces the issue result for a failed step", async () => {
    const t = auto(4);
    const ctx = finishCtx(t);
    const out = await finishStep(ctx, t, { result: { ok: false, error: "boom" }, review: null });

    expect(out.kind).toBe("issue");
    expect(out.reason).toMatch(/step failed: boom/);
    expect(t.status).toBe("queue");
  });

  it.each([
    ["executor", {}, { ok: false, error: "boom" }],
    ["red gate", { red: "npm run test:red" }, { ok: true }],
  ])("marks a %s failure from the high-route retry as escalated", async (_source, extra, result) => {
    const t = auto(41, { ...extra, _runner_high_route_attempt: 1 });
    const ctx = finishCtx(t, { redGate: async () => ({ ok: false, reason: "red failed" }) });
    const out = await finishStep(ctx, t, { result, review: null });

    expect(out).toMatchObject({ kind: "issue", routeEscalated: true });
  });

  // t#528: the board refusing the close is an outcome, not an exception. The
  // node stays undecided — the work happened, the record of it must survive.
  it("leaves the node undecided when the board refuses to close it", async () => {
    const t = auto(5);
    const ctx = finishCtx(t, {
      setStatus: async () => {
        throw new Error("set status #5 done refused: #5 depends on unfinished task(s): #4 [in_progress]");
      },
    });
    const out = await finishStep(ctx, t, {
      result: { sessionId: "s-5", ok: true },
      review: null,
      cost: 0.42,
    });

    expect(out.kind).toBe("undecided");
    expect(out.reason).toMatch(/board refused to close the node/);
    expect(out.reason).toMatch(/depends on unfinished/);
    expect(out.cost).toBe(0.42);
    expect(t.status).not.toBe("done");
  });

  it("downgrades a new blocking finding outside a retry diff and gives the reviewer its repair context", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 2 }));
    const contexts = [];
    const h = harness({
      reviewContext: async ({ task: t, neighbours }) => ({
        previousAttempt: t.attempts.at(-1),
        attemptDiff: [{ status: "M", path: "src/repaired.mjs" }],
        outsideFindings: [{ status: "M", path: "src/unrelated.mjs" }],
        neighbours: neighbours.map((n) => ({ number: n.number, subject: n.subject, produces: n.produces || [] })),
      }),
      reviewStep: async ({ task: t, retryContext }) => {
        contexts.push(retryContext);
        return {
          approved: false, ok: true,
          findings: t.attempts.length
            ? [{ level: "high", file: "src/old-code.mjs", line: 4, text: "old defect", evidence: "scenario" }]
            : [{ level: "high", file: "src/repaired.mjs", line: 4, text: "repair missing", evidence: "scenario" }],
        };
      },
    });
    const result = await go(data, "1", h.effects);

    expect(statusOf(result, 2)).toBe("done");
    expect(contexts[0]).toBeNull();
    expect(contexts[1]).toMatchObject({ attemptDiff: [{ path: "src/repaired.mjs" }], outsideFindings: [{ path: "src/unrelated.mjs" }] });
    expect(result.board.todos.find((t) => t.number === 2).attempts.at(-1).findings[0].level).toBe("medium");
  });

  it("marks only this retry's changed finding locations as in-scope", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "cut-retry-locations-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd }); execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      mkdirSync(path.join(cwd, "src"));
      writeFileSync(path.join(cwd, "src/a.mjs"), Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
      execFileSync("git", ["add", "-A"], { cwd }); execFileSync("git", ["commit", "-qm", "base"], { cwd });
      const preceding = snapshotTree(cwd).sha;
      const task = auto(63, { attempts: [{ snapshot: preceding, findings: [{ level: "high", file: "src/a.mjs", line: 10, text: "reported location" }] }] });
      const lines = readFileSync(path.join(cwd, "src/a.mjs"), "utf8").trimEnd().split("\n");
      lines[199] = "retry changed line 200";
      writeFileSync(path.join(cwd, "src/a.mjs"), `${lines.join("\n")}\n`);

      const first = await liveEffects({ cwd }).reviewContext({ task, cwd });
      expect(first.attemptDiff).toEqual([{ status: "M", path: "src/a.mjs" }]);
      expect(first.attemptPatch).toContain("-line 200");
      expect(first.attemptPatch).toContain("+retry changed line 200");
      expect(first.outsideFindings).toEqual([{ status: "M", path: "src/a.mjs" }]);

      const secondSnapshot = snapshotTree(cwd).sha;
      task.attempts = [{ snapshot: secondSnapshot, findings: [{ level: "high", file: "src/a.mjs", line: 10, text: "reported location" }] }];
      lines[9] = "retry changed reported line 10";
      writeFileSync(path.join(cwd, "src/a.mjs"), `${lines.join("\n")}\n`);
      const second = await liveEffects({ cwd }).reviewContext({ task, cwd });
      expect(second.outsideFindings).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("appends structured review findings, total cost, and the end snapshot to the task attempt journal", async () => {
    const t = auto(6);
    const entries = [];
    const ctx = finishCtx(t, {
      recordAttempt: async ({ entry }) => {
        entries.push(entry);
        return { written: true, snapshot: "end-tree-sha" };
      },
    });
    await finishStep(ctx, t, {
      result: { ok: true },
      cost: 0.4,
      review: {
        approved: true,
        ok: true,
        costUsd: 0.1,
        findings: [{ level: "high", file: "src/a.mjs", line: 7, text: "missing output", evidence: "running the command omits it" }],
      },
    });

    expect(entries).toEqual([expect.objectContaining({
      attempt: 1,
      cost_usd: 0.5,
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      snapshot: null,
    })]);
    expect(t.attempts).toEqual([expect.objectContaining({ snapshot: "end-tree-sha", findings: entries[0].findings })]);
  });

  it("rolls a worse reviewed retry back to the earlier journal checkpoint", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "cut-run-checkpoint-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd }); execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      writeFileSync(path.join(cwd, "output.txt"), "base\n");
      execFileSync("git", ["add", "-A"], { cwd }); execFileSync("git", ["commit", "-qm", "base"], { cwd });
      writeFileSync(path.join(cwd, "output.txt"), "best\n");
      const best = snapshotTree(cwd).sha;
      writeFileSync(path.join(cwd, "output.txt"), "worse\n");
      const t = auto(61, { produces: ["output.txt"], attempts: [{ attempt: 1, reviewed: true, counts: { critical: 0, high: 0 }, snapshot: best }] });
      const ctx = finishCtx(t, {
        cwd,
        recordAttempt: async () => ({ written: true, snapshot: snapshotTree(cwd).sha }),
      });
      ctx.attempts.set(t.id, 2);
      const out = await finishStep(ctx, t, {
        result: { ok: true },
        ownChanges: [{ path: "output.txt" }],
        review: { approved: false, ok: true, findings: [{ level: "high", file: "output.txt", line: 1, text: "regressed", evidence: "output is worse" }] },
      });

      expect(out.rolledBackTo).toBe(best);
      expect(readFileSync(path.join(cwd, "output.txt"), "utf8")).toBe("best\n");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("sends medium/low-only review findings to the architect while continuing to reconciliation", async () => {
    const t = auto(7);
    const comments = [];
    const ctx = finishCtx(t, { recordIssue: async ({ comment }) => { comments.push(comment); return { written: true }; } });
    const out = await finishStep(ctx, t, {
      result: { ok: true },
      review: { approved: false, ok: true, findings: [{ level: "medium", file: "src/a.mjs", line: 3, text: "rename this" }] },
    });

    expect(out.kind).toBe("done");
    expect(out.architectFindings).toHaveLength(1);
    expect(comments[0].author).toBe("architect");
  });

  it("parks a review with three blocking findings for a changed approach", async () => {
    const t = auto(8);
    const ctx = finishCtx(t);
    const out = await finishStep(ctx, t, {
      result: { ok: true },
      review: { approved: false, ok: true, findings: ["a", "b", "c"].map((text) => ({ level: "high", file: "src/a.mjs", text })) },
    });

    expect(out.kind).toBe("convergence");
    expect(out.parkReason).toMatch(/резать или менять подход/);
  });

  it("retries a first verify failure after an approved review", async () => {
    const t = auto(8, { retry_limit: 2 });
    const ctx = finishCtx(t, { runVerify: async () => ({ code: 1, stderr: "assertion failed" }) });
    const out = await finishStep(ctx, t, { result: { ok: true }, review: { approved: true, ok: true } });

    expect(out.kind).not.toBe("mechanics");
  });

  it("parks a mechanical verify failure without leaving the executor attempt spent", async () => {
    const t = auto(9, { retry_limit: 1, attempts: [{ attempt: 1, findings: [], verify_tail: "runner unavailable" }] });
    const ctx = finishCtx(t, { runVerify: async () => ({ code: 1, stderr: "runner unavailable" }) });
    const out = await finishStep(ctx, t, { result: { ok: true }, review: { approved: true, ok: true } });

    expect(out.kind).toBe("mechanics");
    expect(ctx.attempts.get(t.id)).toBe(0);
    expect(out.reason).toMatch(/механика/);
  });

  it("treats a medium/low-only rejected review followed by verify failure as mechanics", async () => {
    const t = auto(10, { retry_limit: 1, attempts: [{ attempt: 1, findings: [], verify_tail: "runner unavailable" }] });
    const ctx = finishCtx(t, { runVerify: async () => ({ code: 1, stderr: "runner unavailable" }) });
    const out = await finishStep(ctx, t, {
      result: { ok: true },
      review: { approved: false, ok: true, findings: [{ level: "low", text: "formatting" }] },
    });

    expect(out.kind).toBe("mechanics");
    expect(ctx.attempts.get(t.id)).toBe(0);
  });
});

describe("shouldEscalate", () => {
  it("does not mistake a first blocking failure for non-convergence", () => {
    const t = auto(42, {
      attempts: [{ findings: [{ level: "high", file: "src/a.mjs", text: "broken" }] }],
    });
    const base = { review: { findings: [{ level: "high", file: "src/a.mjs", text: "broken" }] } };

    expect(shouldEscalate(t, base)).toBe(false);
  });

  it("escalates only after a prior blocking count is available and did not decrease", () => {
    const t = auto(43, {
      attempts: [
        { findings: [{ level: "high", file: "src/a.mjs", text: "first" }] },
        { findings: [{ level: "high", file: "src/b.mjs", text: "second" }] },
      ],
    });
    const base = { review: { findings: [{ level: "high", file: "src/b.mjs", text: "second" }] } };

    expect(shouldEscalate(t, base)).toBe(true);
  });

  it("does not escalate repeated failures that carry no blocking findings", () => {
    const t = auto(44, { attempts: [{ findings: [] }, { findings: [] }] });
    const base = { review: { findings: [] } };

    expect(shouldEscalate(t, base)).toBe(false);
  });
});

describe("buildRunContext", () => {
  it("derives attempts from status_history and parked from review/retry-exhausted nodes", () => {
    const inReview = auto(5, { status: "review" });
    const exhausted = auto(6, {
      retry_limit: 1,
      status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
    });
    const fresh = auto(7);
    const data = board(changeRoot(1, [5, 6, 7]), inReview, exhausted, fresh);

    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });

    expect(attemptsSoFar(exhausted)).toBe(1);
    expect(ctx.parked.has("id-5")).toBe(true);
    expect(ctx.parked.has("id-6")).toBe(true);
    expect(ctx.parked.has("id-7")).toBe(false);
    expect(ctx.spent).toBe(0);
  });

  it("requires spent explicitly rather than defaulting it to zero", () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 42 });
    expect(ctx.spent).toBe(42);
  });

  it("does not change what todos ready reports for a review-status or retry-exhausted node", () => {
    const inReview = auto(5, { status: "review" });
    const exhausted = auto(6, {
      retry_limit: 1,
      status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
    });
    const byId = new Map([
      [inReview.id, inReview],
      [exhausted.id, exhausted],
    ]);
    // parked is a run-level notion (this run will not pick the node back up);
    // it must not leak into the board's own ready predicate, which `todos
    // ready` and `todos pipeline` also read.
    expect(isReadyNode(inReview, byId)).toBe(true);
    expect(isReadyNode(exhausted, byId)).toBe(true);
  });
});

// ── risk routing (t#741) ────────────────────────────────────────────────────

describe("risk routing through the run record", () => {
  it("carries the effective provider/model and the route note into the step record", async () => {
    const data = board(
      changeRoot(1, [2], { budget_usd: 10 }),
      auto(2, { risk: "high" }),
    );
    const h = harness({
      executeStep: async ({ task: t }) => ({
        sessionId: `s-${t.number}`, ok: true,
        provider: "openai", model: "gpt-5.6-terra",
        route: { applied: true, risk: "high", note: "risk high routed worker to openai/gpt-5.6-terra" },
      }),
    });
    const r = await go(data, "1", h.effects);

    expect(r.steps[0]).toMatchObject({
      provider: "openai", model: "gpt-5.6-terra",
      route: { applied: true, risk: "high" },
    });
    const rec = runRecordOf(r);
    expect(rec.steps[0]).toMatchObject({
      provider: "openai", model: "gpt-5.6-terra",
      route: { applied: true, risk: "high" },
    });
  });

  it("mentions the route in the printed step line when risk is high, whether applied or not", async () => {
    const data = board(
      changeRoot(1, [2], { budget_usd: 10 }),
      auto(2, { risk: "high" }),
    );
    const lines = [];
    const h = harness({
      executeStep: async ({ task: t }) => ({
        sessionId: `s-${t.number}`, ok: true,
        provider: "anthropic", model: "opus",
        route: { applied: false, risk: "high", note: "risk high, no route configured for worker" },
      }),
    });
    await go(data, "1", h.effects, { log: (l) => lines.push(l) });

    expect(lines.join("")).toMatch(/no route configured for worker/);
  });

  it("leaves the step record without a route when the task carries no risk", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2));
    const h = harness({
      executeStep: async ({ task: t }) => ({ sessionId: `s-${t.number}`, ok: true, provider: "anthropic", model: "sonnet" }),
    });
    const r = await go(data, "1", h.effects);

    expect(r.steps[0].route).toBeNull();
  });
});

// ── the journal ──────────────────────────────────────────────────────────────

// t#543/t#87: a run used to print its cost and forget it, which is why the
// agent-mode run of c#18 could never be priced afterwards. These pin the shape
// of what is now kept and the one number it is kept for.
describe("the runs journal", () => {
  let dir;
  const file = () => path.join(dir, "runs.jsonl");

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "runlog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one readable line per record and survives a torn one", () => {
    expect(appendRunRecord({ kind: "run", nodes: 2 }, file())).toBe(true);
    expect(appendRunRecord({ kind: "run", nodes: 3 }, file())).toBe(true);
    writeFileSync(file(), readFileSync(file(), "utf8") + "{ not json\n");
    expect(appendRunRecord({ kind: "run", nodes: 4 }, file())).toBe(true);

    const back = readRunLog(file());
    expect(back.map((r) => r.nodes)).toEqual([2, 3, 4]);
    expect(back.every((r) => typeof r.ts === "string" && r.ts)).toBe(true);
  });

  it("reads an absent journal as empty rather than throwing", () => {
    expect(readRunLog(path.join(dir, "nothing.jsonl"))).toEqual([]);
  });

  it("calls a run one pass only when it closed complete, unparked, first attempt", () => {
    const base = {
      change: { number: 7, subject: "c" },
      members: [{ number: 2 }, { number: 3 }],
      waves: [[2], [3]],
      spend: { usd: 0.2, unmeasured_steps: 0, group_budget: 3 },
      complete: true,
      stop: null,
      steps: [
        { task: { number: 2 }, attempt: 1, result: "done", cost_usd: 0.1 },
        { task: { number: 3 }, attempt: 1, result: "done", cost_usd: 0.1 },
      ],
    };
    expect(runRecordOf(base).one_pass).toBe(true);

    const retried = { ...base, steps: [base.steps[0], { ...base.steps[1], attempt: 2 }] };
    expect(runRecordOf(retried).one_pass).toBe(false);

    const parked = { ...base, complete: false, stop: { kind: "gate", task: { number: 3 }, reason: "manual" } };
    const rec = runRecordOf(parked);
    expect(rec.one_pass).toBe(false);
    expect(rec.stop).toEqual({ kind: "gate", task: 3, reason: "manual" });
  });

  it("keeps the per-step cost and session the report printed and then dropped", () => {
    const rec = runRecordOf({
      change: { number: 9, subject: "c" },
      members: [{ number: 2 }],
      steps: [{ task: { number: 2 }, attempt: 1, result: "done", verify: "ok", cost_usd: 0.0413, session: "s-2", requested_mode: "fork", start_mode: "fork", parent_session: "s-1" }],
      spend: { usd: 0.0413, unmeasured_steps: 0, group_budget: 1 },
      complete: true,
    }, { inherit: true });

    expect(rec.steps[0]).toMatchObject({ task: 2, cost_usd: 0.0413, session: "s-2", verify: "ok", requested_mode: "fork", start_mode: "fork", parent_session: "s-1" });
    expect(rec.inherit).toBe(true);
  });

  it("summarizes the share of one-pass runs and what parked the rest", () => {
    const records = [
      { kind: "run", change: { number: 1 }, one_pass: true, stop: null, steps: [{ cost_usd: 0.2 }] },
      { kind: "run", change: { number: 1 }, one_pass: false, stop: { kind: "gate" }, steps: [{ cost_usd: 0.1 }] },
      { kind: "run", change: { number: 2 }, one_pass: false, stop: { kind: "budget" }, steps: [{ cost_usd: 0.3 }] },
      { kind: "run", change: { number: 2 }, one_pass: true, stop: null, steps: [{ cost_usd: null }] },
      { kind: "report", change: { number: 2 }, stop: null, steps: [{ cost_usd: 0.05 }] },
    ];
    const all = summarizeRuns(records);
    expect(all.runs).toBe(4);
    expect(all.one_pass).toBe(2);
    expect(all.one_pass_share).toBe(0.5);
    expect(all.parked).toEqual({ gate: 1, budget: 1 });
    expect(all.spend_usd).toBe(0.6);
    expect(all.unmeasured_steps).toBe(1);

    const one = summarizeRuns(records, { change: 2 });
    expect(one.runs).toBe(2);
    expect(one.one_pass).toBe(1);
    expect(one.parked).toEqual({ budget: 1 });
  });

  it("says plainly when nothing has run yet instead of printing an empty table", () => {
    const text = formatRunHistory([], summarizeRuns([]));
    expect(text).toMatch(/no runs recorded yet/);
  });

  it("prints the verdict, the money and the share", () => {
    const records = [
      {
        ts: "2026-09-07T21:20:00.000Z",
        kind: "run",
        change: { number: 24, subject: "c" },
        nodes: 4,
        inherit: true,
        one_pass: true,
        complete: true,
        stop: null,
        steps: [{ task: 1, cost_usd: 0.26 }],
      },
    ];
    const text = formatRunHistory(records, summarizeRuns(records));
    expect(text).toMatch(/c#24/);
    expect(text).toMatch(/one pass/);
    expect(text).toMatch(/\$0\.26/);
    expect(text).toMatch(/\(inherit\)/);
    expect(text).toMatch(/1 of 1 --go run\(s\) — 100%/);
    expect(text).toMatch(/parked: never/);
  });
});
