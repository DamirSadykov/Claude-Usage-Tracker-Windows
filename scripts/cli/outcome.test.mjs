// Unit tests for the outcome reconciliation (`cli.mjs todos outcome`, t#304).
//
// Two layers are worth testing separately:
//   parseTouchedFiles   what counts as a file the step really TOUCHED — writes
//                       only, failed tool calls dropped, reads never producing;
//   buildOutcomeReport  promised -> produced -> consumed and the predicate
//                       ok | issue, including the two states that are NOT a
//                       verdict: an unclaimed output (§15) and a declared
//                       verify that was never run (§7, §15).
// The `--write` path is exercised end-to-end through the CLI, because what it
// promises is a property of the FILE: exactly three fields, nothing else moved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTouchedFiles,
  foldBlocks,
  buildOutcomeReport,
  pathMatches,
  isPathLike,
} from "./outcome.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────────
// One transcript line: a tool_use with a file_path at `ts`.
const toolLine = (name, file, ts, id = null) =>
  JSON.stringify({
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name, input: { file_path: file } }] },
  });

const errorResult = (id) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "denied" }] },
  });

// A board of tasks; rows are [number, extra].
const board = (...rows) => ({
  version: 1,
  todos: rows.map(([number, extra = {}]) => ({
    id: `id-${number}`,
    number,
    subject: `task ${number}`,
    status: "in_progress",
    ...extra,
  })),
});

const at = (task, session, from, to) => ({ task, session, from, to, source: "take" });

const touchesOf = (...entries) => {
  const m = new Map();
  for (const [session, list] of entries) m.set(session, list);
  return m;
};

const wrote = (file, ts, tool = "Edit") => ({ path: file, ts, tool, mutates: true });
const read = (file, ts) => ({ path: file, ts, tool: "Read", mutates: false });

describe("parseTouchedFiles", () => {
  it("takes writes as touches and never counts a Read as producing", () => {
    const raw = [
      toolLine("Read", "D:\\p\\src\\a.rs", "2026-07-28T10:00:00.000Z"),
      toolLine("Write", "D:\\p\\scripts\\cli\\outcome.mjs", "2026-07-28T10:01:00.000Z"),
      toolLine("Edit", "D:/p/scripts/cli/todos.mjs", "2026-07-28T10:02:00.000Z"),
    ].join("\n");
    const { touches, last_ts } = parseTouchedFiles(raw);
    expect(touches.map((t) => [t.path, t.mutates])).toEqual([
      ["D:/p/src/a.rs", false],
      ["D:/p/scripts/cli/outcome.mjs", true],
      ["D:/p/scripts/cli/todos.mjs", true],
    ]);
    expect(last_ts).toBe("2026-07-28T10:02:00.000Z");
  });

  it("drops a write whose tool_result came back as an error", () => {
    const raw = [
      toolLine("Write", "D:\\p\\denied.mjs", "2026-07-28T10:00:00.000Z", "u1"),
      errorResult("u1"),
      toolLine("Write", "D:\\p\\ok.mjs", "2026-07-28T10:01:00.000Z", "u2"),
    ].join("\n");
    expect(parseTouchedFiles(raw).touches.map((t) => t.path)).toEqual(["D:/p/ok.mjs"]);
  });

  it("survives malformed lines and tool_use without a file path", () => {
    const raw = [
      "{ not json",
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls file_path" } }] } }),
      toolLine("Edit", "D:\\p\\a.mjs", "2026-07-28T10:00:00.000Z"),
    ].join("\n");
    expect(parseTouchedFiles(raw).touches.map((t) => t.path)).toEqual(["D:/p/a.mjs"]);
  });
});

describe("foldBlocks", () => {
  it("closes a block with the next start, or with its own task's end", () => {
    const events = [
      { ts: "T1", session: "s1", task: "a", event: "start", source: "take" },
      { ts: "T2", session: "s1", task: "b", event: "start", source: "take" },
      { ts: "T3", session: "s1", task: "b", event: "end", source: "set-status" },
    ];
    const blocks = foldBlocks(events, new Map([["s1", "T9"]]));
    expect(blocks.map((b) => [b.task, b.from, b.to])).toEqual([
      ["a", "T1", "T2"],
      ["b", "T2", "T3"],
    ]);
  });

  it("keeps a block open when ANOTHER task is closed (t#326)", () => {
    const events = [
      { ts: "T1", session: "s1", task: "a", event: "start", source: "take" },
      { ts: "T2", session: "s1", task: "b", event: "start", source: "take" },
      { ts: "T3", session: "s1", task: "a", event: "end", source: "set-status" },
      { ts: "T8", session: "s1", task: "b", event: "end", source: "set-status" },
    ];
    const blocks = foldBlocks(events, new Map([["s1", "T9"]]));
    expect(blocks.map((b) => [b.task, b.from, b.to])).toEqual([
      ["a", "T1", "T2"],
      ["b", "T2", "T8"],
    ]);
  });

  it("closes the last open block with the session's last transcript ts", () => {
    const events = [{ ts: "T1", session: "s1", task: "a", event: "start", source: "take" }];
    expect(foldBlocks(events, new Map([["s1", "T5"]]))[0].to).toBe("T5");
    expect(foldBlocks(events, new Map())[0].to).toBe("T1");
  });
});

describe("path matching", () => {
  it("matches a repo-relative declaration against an absolute Windows path", () => {
    expect(pathMatches("scripts/cli/outcome.mjs", "D:/p/scripts/cli/outcome.mjs")).toBe(true);
    expect(pathMatches("scripts/cli/outcome.mjs", "D:/p/scripts/cli/outcome.test.mjs")).toBe(false);
  });

  it("tells a path-shaped declaration from a prose one", () => {
    expect(isPathLike("scripts/cli/outcome.mjs")).toBe(true);
    expect(isPathLike("поле outcome на задаче")).toBe(false);
  });
});

describe("buildOutcomeReport", () => {
  // The node under reconciliation is #1; #2 depends on it, so #2's blocks are
  // where a promised output can be CONSUMED.
  const data = () =>
    board(
      [1, { produces: ["scripts/cli/outcome.mjs"] }],
      [2, { depends_on: ["id-1"] }],
    );

  it("promised output produced and taken by a dependent -> ok, consumed", () => {
    const d = data();
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2"), at("id-2", "s2", "T3", "T4")],
      touches: touchesOf(
        ["s1", [wrote("D:/p/scripts/cli/outcome.mjs", "T1")]],
        ["s2", [read("D:/p/scripts/cli/outcome.mjs", "T3")]],
      ),
    });
    expect(report.produces[0]).toMatchObject({ produced: true, consumed: true });
    expect(report.produces[0].consumed_by).toEqual([{ id: "id-2", number: 2 }]);
    expect(report.missing).toEqual([]);
    expect(report.unconsumed).toEqual([]);
    expect(report.outcome).toBe("ok");
    expect(report.outcome_reason).toBe("ok");
  });

  it("promised output produced but taken by nobody -> still ok, reported unclaimed", () => {
    const d = data();
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2"), at("id-2", "s2", "T3", "T4")],
      touches: touchesOf(
        ["s1", [wrote("D:/p/scripts/cli/outcome.mjs", "T1")]],
        ["s2", [read("D:/p/src/unrelated.rs", "T3")]],
      ),
    });
    expect(report.produces[0]).toMatchObject({ produced: true, consumed: false });
    expect(report.unconsumed).toEqual(["scripts/cli/outcome.mjs"]);
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("ok");
  });

  it("promised output never produced -> issue with missing:<path>", () => {
    const d = data();
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/scripts/cli/todos.mjs", "T1")]]),
    });
    expect(report.missing).toEqual(["scripts/cli/outcome.mjs"]);
    expect(report.side_effects).toEqual(["D:/p/scripts/cli/todos.mjs"]);
    expect(report.outcome).toBe("issue");
    expect(report.outcome_reason).toBe("missing:scripts/cli/outcome.mjs");
  });

  it("a write outside the block window is not this step's output", () => {
    const d = data();
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T2", "T3")],
      touches: touchesOf(["s1", [wrote("D:/p/scripts/cli/outcome.mjs", "T1")]]),
    });
    expect(report.outcome_reason).toBe("missing:scripts/cli/outcome.mjs");
  });

  it("verify declared but not run -> outcome NOT finalized", () => {
    const d = board([1, { produces: ["scripts/cli/outcome.mjs"], verify: "npx vitest run" }]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/scripts/cli/outcome.mjs", "T1")]]),
    });
    expect(report.produces[0].produced).toBe(true);
    expect(report.outcome).toBeNull();
    expect(report.finalized).toBe(false);
    expect(report.outcome_reason).toBe("verify-declared-not-run");
    expect(report.verify).toEqual({ declared: "npx vitest run", ran: false, result: null });
  });

  it("--verify issue overrides a produces reconciliation that passed", () => {
    const d = board([1, { produces: ["scripts/cli/outcome.mjs"], verify: "npx vitest run" }]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/scripts/cli/outcome.mjs", "T1")]]),
      verify: "issue",
    });
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("issue");
    expect(report.outcome_reason).toBe("verify:issue");
  });

  it("nothing declared -> no false ok, the outcome stays undecided", () => {
    const d = board([1]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/scripts/cli/whatever.mjs", "T1")]]),
    });
    expect(report.outcome).toBeNull();
    expect(report.finalized).toBe(false);
    expect(report.outcome_reason).toBe("nothing-declared");
  });

  it("a prose declaration is unchecked, not missing", () => {
    const d = board([1, { produces: ["поле outcome на задаче"], verify: "npm test" }]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [],
      touches: touchesOf(),
      verify: "ok",
    });
    expect(report.unchecked).toEqual(["поле outcome на задаче"]);
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("ok");
  });
});

describe("outcome --write (end to end)", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;

  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-outcome-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos }, null, 2));
  };

  // No journal and no transcripts under this APPDATA → no blocks, so a declared
  // output is honestly "not produced": enough to drive --write to a verdict.
  const todo = (number, extra = {}) => ({
    id: `id-${number}`,
    number,
    subject: `task ${number}`,
    description: "",
    status: "in_progress",
    plan: "",
    created_by: "claude",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...extra,
  });

  const run = (...args) =>
    execFileSync(process.execPath, [cli, "todos", "outcome", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  const refuse = (...args) => {
    try {
      execFileSync(process.execPath, [cli, "todos", "outcome", ...args], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
      return null;
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const read = (number) =>
    JSON.parse(readFileSync(file, "utf8")).todos.find((t) => t.number === number);

  beforeEach(() => seed([todo(1, { produces: ["scripts/cli/outcome.mjs"] })]));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes exactly outcome, outcome_reason and outcome_at and moves nothing else", () => {
    const before = read(1);
    run("1", "--write");
    const after = read(1);
    expect(after.outcome).toBe("issue");
    expect(after.outcome_reason).toBe("missing:scripts/cli/outcome.mjs");
    expect(typeof after.outcome_at).toBe("string");
    expect(Object.keys(after).filter((k) => !k.startsWith("outcome"))).toEqual(
      Object.keys(before),
    );
    for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k]);
  });

  it("without --write it only prints; --json carries the same reconciliation", () => {
    const out = run("#1");
    expect(out).toContain("NOT produced");
    expect(out).toContain("outcome: issue");
    expect(read(1)).not.toHaveProperty("outcome");
    const json = JSON.parse(run("1", "--json"));
    expect(json.outcome).toBe("issue");
    expect(json.missing).toEqual(["scripts/cli/outcome.mjs"]);
    expect(json.written).toBe(false);
  });

  it("refuses to write an outcome that is not finalized", () => {
    seed([todo(1, { verify: "npm test" })]);
    const err = refuse("1", "--write");
    expect(err).toContain("not finalized");
    expect(read(1)).not.toHaveProperty("outcome");
  });

  it("accepts id | N | #N and rejects a bad --verify value", () => {
    const byId = run("id-1");
    expect(byId).toContain("#1");
    expect(run("t#1")).toContain("#1");
    expect(refuse("1", "--verify", "maybe")).toContain('--verify takes "ok" or "issue"');
  });
});
