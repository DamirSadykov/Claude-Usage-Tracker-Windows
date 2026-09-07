// Unit tests for the runner core (`cli.mjs todos run <change>`, t#305).
//
// Everything the run does to the outside world sits behind an injected seam
// (executeStep / runVerify / reconcile / setStatus / stepCost), so these tests
// exercise the real semantics without starting a model or a shell. Each
// invariant of the DSL gets its own test, named after it.

import { describe, it, expect } from "vitest";
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
import { runChange, isGate, collectChange, attemptsSoFar, liveEffects } from "./run.mjs";

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
  const calls = { steps: [], statuses: [], verifies: [], reconciles: [], batons: [], alongside: [] };
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
