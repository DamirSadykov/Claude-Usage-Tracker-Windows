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
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runChange,
  isGate,
  collectChange,
  attemptsSoFar,
  liveEffects,
  beginStep,
  finishStep,
  buildRunContext,
  nextFrontier,
  runReported,
  applyResult,
  stepBrief,
  resolveParallelLimit,
  formatStop,
  stampHandout,
  run,
  appendRunRecord,
  readRunLog,
  runRecordOf,
  reportRecordOf,
  summarizeRuns,
  formatRunHistory,
} from "./run.mjs";
import { isReadyNode } from "./todos.mjs";

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

const board = (...todos) => ({ version: 1, todos });
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
    setStatus: async ({ task: t, status }) => {
      calls.statuses.push([t.number, status]);
    },
    stepCost: async () => 0,
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
        return { approved: true, ok: true, model: "opus", sessionId: "review-2", costUsd: 0 };
      },
      runVerify: async () => {
        order.push("verify");
        return { code: 0 };
      },
    });
    const r = await go(data, "1", h.effects);
    expect(order).toEqual(["worker", "review:implemented", "verify"]);
    expect(r.steps[0].review).toMatchObject({ approved: true, model: "opus", session: "review-2" });
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

    expect(h.calls.steps).toEqual([2, 3]);
    expect(statusOf(r, 3)).toBe("review");
    expect(statusOf(r, 4)).toBe("queue");
    expect(r.stop.kind).toBe("gate");
    expect(r.stop.task.number).toBe(3);
    expect(r.stop.status).toBe("review");
    expect(r.stop.reason).toMatch(/kind manual/);
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

// ── whose context a step starts from ─────────────────────────────────────────

// t#543. The choice is the spawner's, never the graph's: `--go` makes it here,
// a driver on `--next` makes it for itself. The rule is the same either way —
// one prerequisite's context is unambiguous, two cannot be merged.
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
        version: 1,
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
      const after = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
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

// `--next` is no longer read-only (t#520): it stamps `handout_at` on every node
// of the wave it hands out, so `outcome.mjs`'s weak file evidence has a
// boundary that starts at the hand-out rather than at whatever the executor
// later claims. It is still NOT a status move — `--report` alone owns that,
// and the crash-before-report failure mode stays exactly as accepted.
describe("stampHandout — the one thing --next writes (t#520)", () => {
  it("stamps every node of the wave with the SAME timestamp, leaves the rest untouched", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-handout-"));
    const file = path.join(dir, "todos.json");
    const data = board(auto(2), auto(3), auto(4));
    try {
      const at2 = stampHandout(file, data, [data.todos[0], data.todos[1]]);
      expect(at2).toEqual(expect.any(String));
      expect(data.todos[0].handout_at).toBe(at2);
      expect(data.todos[1].handout_at).toBe(at2);
      expect(data.todos[2].handout_at).toBeUndefined();
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      expect(onDisk.todos[0].handout_at).toBe(at2);
      expect(onDisk.todos[1].handout_at).toBe(at2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is NOT a status move — status is unchanged before and after the stamp", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-handout-"));
    const file = path.join(dir, "todos.json");
    const data = board(auto(2));
    try {
      const before = data.todos[0].status;
      stampHandout(file, data, [data.todos[0]]);
      expect(data.todos[0].status).toBe(before);
      expect(data.todos[0].status).toBe("queue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-stamps on a second hand-out — a re-handed node starts a fresh window", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-handout-"));
    const file = path.join(dir, "todos.json");
    const data = board(auto(2));
    try {
      const first = stampHandout(file, data, [data.todos[0]]);
      await new Promise((r) => setTimeout(r, 5));
      const second = stampHandout(file, data, [data.todos[0]]);
      expect(second >= first).toBe(true);
      expect(data.todos[0].handout_at).toBe(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty wave stamps nothing, saves nothing, and returns null", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-handout-"));
    const file = path.join(dir, "todos.json");
    const data = board(auto(2));
    try {
      const at2 = stampHandout(file, data, []);
      expect(at2).toBeNull();
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run(['--next']) — the field wired end to end onto the real board (t#520)", () => {
  it("writes handout_at through the CLI without moving status, and re-stamps on a second call", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-run-cmdnext-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    const initial = board(changeRoot(1, [2, 3], { parallel_limit: 2 }), auto(2), auto(3));
    writeFileSync(path.join(appDir, "todos.json"), JSON.stringify(initial));
    const prevAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      await run(["1", "--next"]);
      const after1 = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
      const t2a = after1.todos.find((t) => t.number === 2);
      const t3a = after1.todos.find((t) => t.number === 3);
      expect(t2a.handout_at).toEqual(expect.any(String));
      expect(t3a.handout_at).toBe(t2a.handout_at);
      expect(t2a.status).toBe("queue");
      expect(t3a.status).toBe("queue");

      await new Promise((r) => setTimeout(r, 5));
      await run(["1", "--next"]);
      const after2 = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
      const t2b = after2.todos.find((t) => t.number === 2);
      expect(t2b.handout_at >= t2a.handout_at).toBe(true);
      expect(t2b.status).toBe("queue");
    } finally {
      process.stdout.write = origWrite;
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
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
});

describe("finishStep", () => {
  const finishCtx = (t, overrides = {}) => ({
    dry: false,
    cwd: process.cwd(),
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

// ── the outside-driven mode: `--next` (t#510) ───────────────────────────────
//
// `nextFrontier` is the read-only decision `--next` prints: it must reuse the
// exact same stop vocabulary formatStop knows, and it must never call
// beginStep — a node's status is asserted unchanged in every stop scenario.

describe("nextFrontier — the frontier `--next` hands out", () => {
  it("hands out the ready wave, sized to the change's parallel limit", () => {
    const data = board(
      changeRoot(1, [2, 3, 4], { parallel_limit: 2, budget_usd: 10 }),
      auto(2),
      auto(3),
      auto(4, { depends_on: deps(2) }),
    );
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const limit = resolveParallelLimit(ctx.root, undefined);
    const outcome = nextFrontier(ctx, { limit, groupBudget: ctx.root.budget_usd, spentKnown: false });

    expect(outcome.wave.map((t) => t.number)).toEqual([2, 3]);
    expect(outcome.stop).toBeUndefined();
    // Nothing moved — a peek is not an attempt.
    expect(outcome.wave.every((t) => t.status === "queue")).toBe(true);
    expect(ctx.data.todos.every((t) => !t.status_history)).toBe(true);
  });

  it("hands out the identical brief an executor gets, via the same stepBrief beginStep uses", () => {
    const data = board(changeRoot(1, [2, 3]), auto(2), auto(3));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const [t2, t3] = ctx.members;
    const wave = [t2, t3];

    const viaNext = stepBrief(ctx, t2, wave);
    // beginStep is the ONLY other caller of this shape — assert it produces the
    // identical object rather than a second, differently-shaped assembly.
    const begunElsewhere = { ...ctx, attempts: new Map(), stop: null };
    const begun = { brief: stepBrief(begunElsewhere, t2, wave) };

    expect(viaNext).toEqual(begun.brief);
    expect(viaNext.task).toBe(t2);
    expect(viaNext.board).toBe(ctx.data);
    expect(viaNext.alongside).toEqual([{ id: t3.id, number: 3, subject: t3.subject }]);
  });

  it("stops with the SAME gate reason as --go when a ready node is already sitting in review, and moves nothing", () => {
    const data = board(changeRoot(1, [2, 3]), auto(2, { status: "review" }), auto(3, { depends_on: deps(2) }));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: null, spentKnown: false });

    expect(outcome.wave).toBeUndefined();
    expect(outcome.stop.kind).toBe("gate");
    expect(outcome.stop.reason).toMatch(/already in review/);
    expect(outcome.stop.task.number).toBe(2);
    expect(formatStop(outcome.stop)).toMatch(/pipeline parked — gate/);
    expect(ctx.data.todos.find((t) => t.number === 2).status).toBe("review");
  });

  it("stops with the SAME retry-exhausted reason as --go, without ever calling beginStep", () => {
    const data = board(
      changeRoot(1, [2]),
      auto(2, {
        retry_limit: 1,
        status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
      }),
    );
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: null, spentKnown: false });

    expect(outcome.wave).toBeUndefined();
    expect(outcome.stop.kind).toBe("retry");
    expect(outcome.stop.reason).toMatch(/attempt 2 would be past the declared limit — 1\/<=1/);
    // --next must not start anything: the node is still `queue`, not `review`.
    expect(ctx.data.todos.find((t) => t.number === 2).status).toBe("queue");
  });

  it("stops with the SAME empty-frontier reason as --go when the graph lies", () => {
    const data = board(changeRoot(1, [2, 3]), auto(2, { depends_on: deps(3) }), auto(3, { depends_on: deps(2) }));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: null, spentKnown: false });

    expect(outcome.wave).toBeUndefined();
    expect(outcome.stop.kind).toBe("empty-frontier");
    expect(outcome.stop.reason).toMatch(/graph lies/);
    expect(outcome.stop.blocked.map((b) => b.task.number)).toEqual([2, 3]);
  });

  it("reports complete, not a stop, when every node is already done", () => {
    const data = board(changeRoot(1, [2]), auto(2, { status: "done" }));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 0 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: null, spentKnown: false });

    expect(outcome.complete).toBe(true);
    expect(outcome.stop).toBeUndefined();
  });

  it("does NOT enforce the group budget unless the caller reports what has been spent", () => {
    const data = board(changeRoot(1, [2], { budget_usd: 1 }), auto(2));
    // ctx.spent is deliberately way past the declared budget: with spentKnown
    // false this call must still hand the node out — the ceiling is unchecked,
    // not silently assumed to be zero.
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 999 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: 1, spentKnown: false });

    expect(outcome.wave.map((t) => t.number)).toEqual([2]);
  });

  it("parks on budget the SAME way --go does, once the caller supplies --spent", () => {
    const data = board(changeRoot(1, [2], { budget_usd: 1 }), auto(2));
    const ctx = buildRunContext({ data, change: "1", dry: true, spent: 1 });
    const outcome = nextFrontier(ctx, { limit: 1, groupBudget: 1, spentKnown: true });

    expect(outcome.wave).toBeUndefined();
    expect(outcome.stop.kind).toBe("budget");
    expect(outcome.stop.reason).toMatch(/group budget exhausted/);
  });
});

// ── the outside-driven mode: `--report` (t#511) ─────────────────────────────
//
// `runReported` + `applyResult` compose the way `runOne` + the wave loop do for
// `--go`: the caller's own result/review stand in for the effects call, but the
// branch into gate / retry / issue / done runs through the identical finishStep
// and applyResult every `--go` step already goes through.

function outsideEffects(reconcile) {
  return {
    setStatus: async ({ task, status }) => {
      if (task.status === status) return;
      task.status = status;
      (task.status_history ??= []).push({ status, at: new Date().toISOString() });
    },
    recordHandoff: async ({ task, text }) => {
      task.handoff = text;
      return { written: true };
    },
    runVerify: async () => ({ code: 0 }),
    reconcile,
    stepCost: async ({ result }) => (typeof result?.costUsd === "number" ? result.costUsd : null),
  };
}

const okReconcile = async () => ({ outcome: "ok", outcome_reason: "ok" });

describe("runReported / applyResult — reporting one node's outcome", () => {
  it("closes a node on a reported success whose declared verify passes", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2));
    const ctx = buildRunContext({ data, change: "1", dry: false, spent: 0, effects: outsideEffects(okReconcile) });
    const task = ctx.byId.get("id-2");

    const r = await runReported(ctx, task, [task], {
      result: { sessionId: null, ok: true, error: "", handoff: "produced the thing", costUsd: 0.5 },
      review: null,
    });
    const record = await applyResult(ctx, r, { dry: false, log: () => {} });

    expect(record.result).toBe("done");
    expect(record.outcome).toBe("ok");
    expect(record.baton).toBe("written");
    expect(task.status).toBe("done");
    expect(task.handoff).toBe("produced the thing");
    expect(ctx.spent).toBe(0.5);
    expect(ctx.stop).toBeNull();
  });

  it("parks with the SAME reason as --go when a reported success's declared verify fails and no retry is declared", async () => {
    const data = board(changeRoot(1, [2]), auto(2));
    const reconcile = async ({ verify }) => ({ outcome: verify, outcome_reason: `verify:${verify}` });
    const ctx = buildRunContext({
      data,
      change: "1",
      dry: false,
      spent: 0,
      effects: { ...outsideEffects(reconcile), runVerify: async () => ({ code: 1 }) },
    });
    const task = ctx.byId.get("id-2");

    const r = await runReported(ctx, task, [task], {
      result: { sessionId: null, ok: true, error: "", handoff: "", costUsd: null },
      review: null,
    });
    const record = await applyResult(ctx, r, { dry: false, log: () => {} });

    expect(record.result).toBe("issue");
    expect(ctx.stop.kind).toBe("retry");
    expect(ctx.stop.reason).toMatch(/NO declared retry limit/);
    expect(task.status).toBe("review");
  });

  it("takes the SAME ?issue transition as --go when a reported issue still has a retry left", async () => {
    const data = board(
      changeRoot(1, [2, 3]),
      auto(2),
      auto(3, { depends_on: deps(2), retry_limit: 2, on_issue: "id-2" }),
    );
    const ctx = buildRunContext({ data, change: "1", dry: false, spent: 0, effects: outsideEffects(okReconcile) });
    const t2 = ctx.byId.get("id-2");
    const t3 = ctx.byId.get("id-3");

    const r2 = await runReported(ctx, t2, [t2], { result: { ok: true, handoff: "", costUsd: null } });
    await applyResult(ctx, r2, { dry: false, log: () => {} });
    expect(t2.status).toBe("done");

    const r3 = await runReported(ctx, t3, [t3], {
      result: { sessionId: null, ok: false, error: "could not complete", handoff: "", costUsd: null },
      review: null,
    });
    const record = await applyResult(ctx, r3, { dry: false, log: () => {} });

    expect(record.result).toBe("issue");
    expect(record.reason).toMatch(/step failed: could not complete/);
    expect(ctx.transitions).toHaveLength(1);
    expect(ctx.transitions[0]).toMatchObject({ attempt: 1, limit: 2 });
    expect(t2.status).toBe("queue");
    expect(t3.status).toBe("queue");
    expect(ctx.stop).toBeNull();
  });

  it("parks with the SAME retry-exhausted reason as --go when a reported issue spends the last attempt", async () => {
    const data = board(changeRoot(1, [2]), auto(2, { retry_limit: 1 }));
    const ctx = buildRunContext({ data, change: "1", dry: false, spent: 0, effects: outsideEffects(okReconcile) });
    const task = ctx.byId.get("id-2");

    const r = await runReported(ctx, task, [task], {
      result: { sessionId: null, ok: false, error: "gave up", handoff: "", costUsd: null },
      review: null,
    });
    const record = await applyResult(ctx, r, { dry: false, log: () => {} });

    expect(record.result).toBe("issue");
    expect(ctx.stop.kind).toBe("retry");
    expect(ctx.stop.reason).toMatch(/retry limit exhausted — 1\/<=1/);
    expect(task.status).toBe("review");
  });

  it("refuses to start a reported attempt once the limit is already spent, same as beginStep does for --go", async () => {
    const data = board(
      changeRoot(1, [2]),
      auto(2, {
        retry_limit: 1,
        status_history: [{ status: "in_progress", at: "2026-07-28T10:00:00.000Z" }],
      }),
    );
    const ctx = buildRunContext({ data, change: "1", dry: false, spent: 0, effects: outsideEffects(okReconcile) });
    const task = ctx.byId.get("id-2");

    const r = await runReported(ctx, task, [task], { result: { ok: true, handoff: "", costUsd: null } });
    expect(r.kind).toBe("retry-exhausted");

    const record = await applyResult(ctx, r, { dry: false, log: () => {} });
    expect(record.result).toBe("retry-exhausted");
    expect(ctx.stop.kind).toBe("retry");
    expect(ctx.stop.reason).toMatch(/attempt 2 would be past the declared limit/);
    expect(task.status).toBe("review");
  });

  it("a model review issue vetoes a reported success, the same as it does for --go", async () => {
    const data = board(changeRoot(1, [2], { budget_usd: 10 }), auto(2, { retry_limit: 1 }));
    const ctx = buildRunContext({ data, change: "1", dry: false, spent: 0, effects: outsideEffects(okReconcile) });
    const task = ctx.byId.get("id-2");

    const r = await runReported(ctx, task, [task], {
      result: { sessionId: null, ok: true, error: "", handoff: "looks done", costUsd: null },
      review: { approved: false, ok: true, result: "scope regression\nVERDICT: issue" },
    });
    const record = await applyResult(ctx, r, { dry: false, log: () => {} });

    expect(record.result).toBe("issue");
    expect(record.reason).toMatch(/model review issue/);
    expect(ctx.stop.kind).toBe("retry");
    expect(task.status).toBe("review");
  });
});

// ── the equivalence claim itself ────────────────────────────────────────────
//
// The point of the whole design: a graph driven one node at a time from
// OUTSIDE this loop — a fresh `buildRunContext` for every "call", exactly as
// separate `--next` / `--report` invocations would each reload the board from
// disk — must reach the SAME end state `--go`'s own long-lived loop reaches on
// the identical graph and an equivalent executor.

describe("equivalence — a --next/--report pair walks a graph to --go's own end state", () => {
  it("closes the same graph, through the same ?issue transition, either way", async () => {
    const buildGraph = () =>
      board(
        changeRoot(1, [2, 3], { budget_usd: 10 }),
        auto(2),
        auto(3, { depends_on: deps(2), verify: "flaky", retry_limit: 2, on_issue: "id-2" }),
      );

    // Node #3's own check fails on its first attempt and passes on any later
    // one — decided from board state (attemptsSoFar), never from a hidden
    // counter, so the two drivers cannot desync by calling in a different order.
    const reconcile = async ({ task }) =>
      task.number === 3 && attemptsSoFar(task) <= 1
        ? { outcome: "issue", outcome_reason: "verify:issue" }
        : { outcome: "ok", outcome_reason: "ok" };

    // -- scenario A: --go, one long-lived ctx for the whole run.
    const dataA = buildGraph();
    const resultA = await runChange({
      data: dataA,
      change: "1",
      dry: false,
      effects: {
        executeStep: async ({ task }) => ({ sessionId: `s-${task.number}`, ok: true, handoff: `done #${task.number}` }),
        reviewStep: async () => ({ approved: true, ok: true, costUsd: 0 }),
        ...outsideEffects(reconcile),
      },
    });
    expect(resultA.complete).toBe(true);

    // -- scenario B: --next / --report, a FRESH ctx built from the board every
    // "call" — no ctx.attempts carries over, so the retry accounting can only
    // be honest if it comes from status_history, exactly as separate processes
    // would have to derive it from the real board on disk.
    let boardB = buildGraph();
    let stopB = null;
    for (let guard = 0; !stopB && guard < 10; guard++) {
      const peekCtx = buildRunContext({ data: boardB, change: "1", dry: true, spent: 0 });
      const limit = resolveParallelLimit(peekCtx.root, undefined);
      const groupBudget = typeof peekCtx.root.budget_usd === "number" ? peekCtx.root.budget_usd : null;
      const outcome = nextFrontier(peekCtx, { limit, groupBudget, spentKnown: false });
      if (outcome.complete) break;
      if (outcome.stop) {
        stopB = outcome.stop;
        break;
      }
      for (const ready of outcome.wave) {
        const workCtx = buildRunContext({
          data: boardB,
          change: "1",
          dry: false,
          spent: 0,
          effects: outsideEffects(reconcile),
        });
        const task = workCtx.byId.get(ready.id);
        const result = { sessionId: null, ok: true, error: "", handoff: `done #${task.number}`, costUsd: null };
        const review = { approved: true, ok: true, costUsd: 0 };
        const r = await runReported(workCtx, task, [task], { result, review });
        await applyResult(workCtx, r, { dry: false, log: () => {} });
        boardB = workCtx.data;
        if (workCtx.stop) {
          stopB = workCtx.stop;
          break;
        }
      }
    }

    expect(stopB).toBeNull();
    const statusesA = Object.fromEntries(resultA.board.todos.map((t) => [t.number, t.status]));
    const statusesB = Object.fromEntries(boardB.todos.map((t) => [t.number, t.status]));
    expect(statusesB).toEqual(statusesA);
    expect(statusesB).toEqual({ 1: "queue", 2: "done", 3: "done" });

    const handoffsA = Object.fromEntries(resultA.board.todos.map((t) => [t.number, t.handoff || null]));
    const handoffsB = Object.fromEntries(boardB.todos.map((t) => [t.number, t.handoff || null]));
    expect(handoffsB).toEqual(handoffsA);

    // #3 took the ?issue transition exactly once on both paths: two attempts
    // logged, not one and not three.
    const attemptsA = attemptsSoFar(resultA.board.todos.find((t) => t.number === 3));
    const attemptsB = attemptsSoFar(boardB.todos.find((t) => t.number === 3));
    expect(attemptsB).toBe(attemptsA);
    expect(attemptsB).toBe(2);
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
      steps: [{ task: { number: 2 }, attempt: 1, result: "done", verify: "ok", cost_usd: 0.0413, session: "s-2" }],
      spend: { usd: 0.0413, unmeasured_steps: 0, group_budget: 1 },
      complete: true,
    }, { inherit: true });

    expect(rec.steps[0]).toMatchObject({ task: 2, cost_usd: 0.0413, session: "s-2", verify: "ok" });
    expect(rec.inherit).toBe(true);
  });

  it("records a driven-mode step under the same change", () => {
    const rec = reportRecordOf({
      change: { number: 4, subject: "c" },
      step: { task: { number: 11 }, attempt: 1, result: "done", cost_usd: null, session: null },
      refused: [],
      next: { ready: [], stop: null, complete: true },
    });
    expect(rec.kind).toBe("report");
    expect(rec.change.number).toBe(4);
    expect(rec.steps[0].task).toBe(11);
    expect(rec.complete).toBe(true);
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
    expect(all.spend_usd).toBe(0.65);
    expect(all.unmeasured_steps).toBe(1);
    expect(all.reported_steps).toBe(1);

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
