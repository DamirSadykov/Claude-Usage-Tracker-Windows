import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

describe("todos lint checks the recorded graph", () => {
  let dir;
  let boardFile;
  const savedAppData = process.env.APPDATA;

  // Fixture tasks are project-LESS on purpose: the board scope is "this project
  // plus project-less tasks", so a global task is in scope whatever directory
  // vitest happens to run from.
  const task = (n, extra = {}) => ({
    id: `t${n}`,
    number: n,
    subject: `узел ${n}`,
    status: "queue",
    ...extra,
  });

  const board = (...todos) =>
    writeFileSync(boardFile, JSON.stringify({ version: 1, todos }, null, 2));

  const lint = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "todos", "lint", ...args], {
          encoding: "utf8",
          env: { ...process.env, APPDATA: dir },
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-lint-"));
    // The app data directory is the tracker's to create, exactly as in real use.
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing about a graph that keeps every invariant, and exits 0", () => {
    board(
      task(1, { verify: "npm test", kind: "auto" }),
      task(2, { depends_on: ["t1"] }),
    );
    const { code, out } = lint();
    expect(code).toBe(0);
    expect(out).toMatch(/2 node\(s\) checked/);
    expect(out).toMatch(/nothing violates the process language/);
  });

  it("reads the board and never writes it", () => {
    board(task(1, { kind: "auto" }), task(2, { on_issue: "gone" }));
    const before = readFileSync(boardFile, "utf8");
    lint();
    lint("--json");
    expect(readFileSync(boardFile, "utf8")).toBe(before);
  });

  // §11/§15: a limit withdrawn AFTER the transition was declared is how a board
  // reaches this state — `set on-issue` itself refuses without one.
  it("errors on an ?issue transition left without a retry limit", () => {
    board(task(1), task(2, { on_issue: "t1" }));
    const { code, out } = lint();
    expect(code).toBe(1);
    expect(out).toMatch(/#2: on-issue without a retry limit/);
    expect(out).toMatch(/1 error\(s\), 0 warning\(s\)/);
  });

  it("errors on an ?issue arrow left hanging by a deleted task", () => {
    board(task(1, { on_issue: "t9", retry_limit: 2 }));
    const { out, code } = lint();
    expect(code).toBe(1);
    expect(out).toMatch(/#1: on-issue points at "t9", which is not a task on this board any more/);
  });

  it("errors on a dependency pointing at a task that no longer exists", () => {
    board(task(1, { depends_on: ["t9"] }));
    const { out, code } = lint();
    expect(code).toBe(1);
    expect(out).toMatch(/#1 needs "t9", which is not a task on this board any more/);
  });

  it("errors on a cycle written into depends_on and names the ring", () => {
    board(task(1, { depends_on: ["t2"] }), task(2, { depends_on: ["t1"] }));
    const { out, code } = lint();
    expect(code).toBe(1);
    expect(out).toMatch(/needs form a cycle: #1 -> #2 -> #1/);
  });

  // A gate is a legal graph — the node just cannot close itself, so this is a
  // note about what the runner will do, not a fault.
  it("only warns on auto without a verify, and calls it a gate", () => {
    board(task(1, { kind: "auto" }));
    const { code, out } = lint();
    expect(code).toBe(0);
    expect(out).toMatch(/#1: auto with no verify runs as a GATE/);
  });

  it("warns that a change with no budget cannot be run unattended, and stays quiet once it has one", () => {
    board(task(1, { change: true, depends_on: ["t2"] }), task(2));
    expect(lint().out).toMatch(/change #1 "узел 1": no budget declared on the group/);
    board(task(1, { change: true, depends_on: ["t2"], budget_usd: 5 }), task(2));
    expect(lint().out).toMatch(/nothing violates/);
  });

  // A ceiling bounds a run that is still ahead. Over a group whose members are
  // all closed there is no run to bound, and the number would be invented — the
  // one thing §15 forbids ("никаких значений из воздуха").
  it("says nothing about the budget of a change with nothing left to run", () => {
    board(task(1, { change: true, depends_on: ["t2"] }), task(2, { status: "done" }));
    expect(lint().out).toMatch(/nothing violates/);
  });

  it("warns about a node closed on a promise nobody reconciled", () => {
    board(task(1, { status: "done", produces: ["src/a.ts"] }));
    expect(lint().out).toMatch(/#1: closed with 1 promised output\(s\) and no reconciled outcome/);
    board(task(1, { status: "done", produces: ["src/a.ts"], outcome: "ok" }));
    expect(lint().out).toMatch(/nothing violates/);
  });

  // Every other rule is about the NEXT run, and a closed node has none: warning
  // about a gate that will never open or a transition that will never fire is
  // exactly the noise that makes a linter get ignored.
  it("holds the run-time rules off closed nodes", () => {
    board(task(1, { status: "done", kind: "auto", on_issue: "gone" }));
    const { code, out } = lint();
    expect(code).toBe(0);
    expect(out).toMatch(/nothing violates/);
  });

  it("with a change argument checks that subtree only", () => {
    board(
      task(1, { change: true, budget_usd: 5, depends_on: ["t2"] }),
      task(2, { kind: "auto" }),
      task(3, { kind: "auto" }),
    );
    const inside = lint("1").out;
    expect(inside).toMatch(/2 node\(s\) checked/);
    expect(inside).toMatch(/#2: auto with no verify/);
    expect(inside).not.toMatch(/#3/);
    expect(lint().out).toMatch(/#3: auto with no verify/);
    expect(lint("99").code).toBe(1);
  });

  it("hands the same findings out machine-readably", () => {
    board(task(1, { on_issue: "t2" }), task(2, { kind: "auto" }));
    const r = JSON.parse(lint("--json").out);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(2);
    expect(r.findings.map((f) => [f.rule, f.severity, f.task])).toEqual([
      ["on-issue-without-retry", "error", "#1"],
      ["auto-without-verify", "warning", "#2"],
    ]);
  });

  // The point of graph-rules.mjs: `apply` (a file on the way in) and `lint` (the
  // graph already recorded) do not each carry their own wording of a rule. If
  // one of them is ever edited in place, this test is what notices.
  it("states a rule in the same words as apply does", () => {
    writeFileSync(
      path.join(dir, "graph.yaml"),
      ["steps:", "  1:", "    title: A", "  2:", "    title: B", "    on-issue: 1"].join("\n"),
    );
    let fromApply = "";
    try {
      execFileSync(process.execPath, [cli, "todos", "apply", path.join(dir, "graph.yaml")], {
        encoding: "utf8",
        env: { ...process.env, APPDATA: dir },
        windowsHide: true,
      });
    } catch (e) {
      fromApply = (e.stdout || "") + (e.stderr || "");
    }
    board(task(1), task(2, { on_issue: "t1" }));
    const shared =
      "on-issue without a retry limit. A missing limit FORBIDS the transition, " +
      "it does not permit an endless one — declare retry on this node";
    expect(fromApply).toContain(shared);
    expect(lint().out).toContain(shared);
  });
});
