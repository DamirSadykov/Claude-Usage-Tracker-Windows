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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTouchedFiles,
  foldBlocks,
  buildOutcomeReport,
  pathMatches,
  isPathLike,
  attemptStartOf,
  handoutStartOf,
  evidenceWindowStartOf,
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

describe("attemptStartOf", () => {
  it("is the LATEST entry into in_progress, the same field attemptsSoFar counts", () => {
    const t = {
      status_history: [
        { status: "backlog", at: "T0" },
        { status: "in_progress", at: "T1" },
        { status: "review", at: "T2" },
        { status: "in_progress", at: "T3" },
      ],
    };
    expect(attemptStartOf(t)).toBe("T3");
  });

  it("is null with no status_history and no in_progress entry", () => {
    expect(attemptStartOf({})).toBeNull();
    expect(attemptStartOf({ status_history: [{ status: "backlog", at: "T0" }] })).toBeNull();
  });
});

describe("buildOutcomeReport — weak file evidence (t#520)", () => {
  const withHistory = (attemptAt) =>
    board([
      1,
      {
        produces: ["out/words.txt"],
        status_history: [{ status: "in_progress", at: attemptAt }],
      },
    ]).todos[0];

  const neverStat = () => {
    throw new Error("weak evidence must not be consulted when the transcript already answered");
  };

  it("transcript evidence alone decides -> unchanged verdict, weak source never touched", () => {
    const todo = withHistory("2026-01-01T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/out/words.txt", "T1")]]),
      root: "D:/p",
      statFile: neverStat,
    });
    expect(report.produces[0]).toMatchObject({
      produced: true,
      evidence: "transcript",
      produced_by: "Edit",
      produced_in_session: "s1",
    });
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("ok");
  });

  it("file evidence alone, mtime after the attempt start -> produced, marked as the weaker source", () => {
    const todo = withHistory("2026-01-01T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2026-01-02T00:00:00.000Z",
    });
    expect(report.produces[0]).toMatchObject({
      produced: true,
      evidence: "file",
      produced_by: null,
      produced_in_session: null,
      produced_at: "2026-01-02T00:00:00.000Z",
    });
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("ok");
  });

  it("file present but mtime BEFORE the attempt start -> NOT produced (no rubber stamp)", () => {
    const todo = withHistory("2026-01-05T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2026-01-01T00:00:00.000Z",
    });
    expect(report.produces[0]).toMatchObject({ produced: false, evidence: null });
    expect(report.missing).toEqual(["out/words.txt"]);
    expect(report.outcome).toBe("issue");
    expect(report.outcome_reason).toBe("missing:out/words.txt");
  });

  it("both sources present -> strong wins, evidence says transcript", () => {
    const todo = withHistory("2026-01-01T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [at("id-1", "s1", "T1", "T2")],
      touches: touchesOf(["s1", [wrote("D:/p/out/words.txt", "T1")]]),
      root: "D:/p",
      statFile: neverStat,
    });
    expect(report.produces[0].evidence).toBe("transcript");
  });

  it("a stat that throws is NOT evidence and never escapes", () => {
    const todo = withHistory("2026-01-01T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => {
        throw new Error("EPERM: permission denied");
      },
    });
    expect(report.produces[0]).toMatchObject({ produced: false, evidence: null });
    expect(report.outcome).toBe("issue");
  });

  it("no status_history at all -> no attempt start -> weak evidence never applies", () => {
    const d = board([1, { produces: ["out/words.txt"] }]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2099-01-01T00:00:00.000Z",
    });
    expect(report.produces[0]).toMatchObject({ produced: false, evidence: null });
    expect(report.outcome).toBe("issue");
  });

  it("a non-path declaration stays checkable:false, weak evidence never touched", () => {
    const d = board([
      1,
      {
        produces: ["поле outcome на задаче"],
        status_history: [{ status: "in_progress", at: "2026-01-01T00:00:00.000Z" }],
        verify: "npm test",
      },
    ]);
    const report = buildOutcomeReport({
      data: d,
      todo: d.todos[0],
      blocks: [],
      touches: touchesOf(),
      verify: "ok",
      root: "D:/p",
      statFile: neverStat,
    });
    expect(report.unchecked).toEqual(["поле outcome на задаче"]);
    expect(report.produces[0].checkable).toBe(false);
    expect(report.produces[0].evidence).toBeNull();
  });
});

describe("handoutStartOf / evidenceWindowStartOf (t#520)", () => {
  it("handoutStartOf reads handout_at, trimmed, or null", () => {
    expect(handoutStartOf({ handout_at: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(handoutStartOf({ handout_at: "  " })).toBeNull();
    expect(handoutStartOf({})).toBeNull();
  });

  it("evidenceWindowStartOf prefers handout_at over the in_progress floor", () => {
    const t = {
      handout_at: "2026-01-02T00:00:00.000Z",
      status_history: [{ status: "in_progress", at: "2026-01-05T00:00:00.000Z" }],
    };
    expect(evidenceWindowStartOf(t)).toEqual({ at: "2026-01-02T00:00:00.000Z", source: "handout" });
  });

  it("evidenceWindowStartOf falls back to the in_progress floor when there is no handout_at — the --go path", () => {
    const t = { status_history: [{ status: "in_progress", at: "2026-01-05T00:00:00.000Z" }] };
    expect(evidenceWindowStartOf(t)).toEqual({ at: "2026-01-05T00:00:00.000Z", source: "in_progress" });
  });

  it("evidenceWindowStartOf is at:null, source:null with neither", () => {
    expect(evidenceWindowStartOf({})).toEqual({ at: null, source: null });
  });
});

// The live collision (t#520): `--next` hands a node out WITHOUT moving status,
// so a node worked this way can reach `--report` — and this reconciliation —
// having NEVER entered `in_progress`. The old boundary (status_history alone)
// could then never fire; these pin the fix, `withHistory`'s tests above pin
// that the --go path (no handout_at at all) is completely unchanged.
describe("buildOutcomeReport — the handout boundary (t#520)", () => {
  const withHandout = (handoutAt, extra = {}) =>
    board([1, { produces: ["out/words.txt"], handout_at: handoutAt, ...extra }]).todos[0];

  it("fires on a node --next handed out that never entered in_progress at all", () => {
    const todo = withHandout("2026-01-01T00:00:00.000Z", { status_history: [] });
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2026-01-01T00:00:10.000Z",
    });
    expect(report.produces[0]).toMatchObject({ produced: true, evidence: "file" });
    expect(report.evidence_window).toEqual({ at: "2026-01-01T00:00:00.000Z", source: "handout" });
    expect(report.outcome).toBe("ok");
  });

  it("does NOT fire when the mtime predates the handout stamp", () => {
    const todo = withHandout("2026-01-05T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2026-01-01T00:00:00.000Z",
    });
    expect(report.produces[0]).toMatchObject({ produced: false, evidence: null });
    expect(report.outcome).toBe("issue");
  });

  it("a re-handed node measures from the NEW stamp — a write before the second hand-out does not count", () => {
    const todo = withHandout("2026-01-10T00:00:00.000Z");
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      statFile: () => "2026-01-05T00:00:00.000Z",
    });
    expect(report.produces[0].produced).toBe(false);
  });

  it("handout_at wins over status_history when both are present, older or not", () => {
    const todo = withHandout("2026-01-01T00:00:00.000Z", {
      status_history: [{ status: "in_progress", at: "2026-01-10T00:00:00.000Z" }],
    });
    const report = buildOutcomeReport({
      data: board([1]),
      todo,
      blocks: [],
      touches: touchesOf(),
      root: "D:/p",
      // After the hand-out but before the later in_progress stamp: the boundary
      // this task fixes would have rejected this exact file.
      statFile: () => "2026-01-02T00:00:00.000Z",
    });
    expect(report.produces[0].produced).toBe(true);
    expect(report.evidence_window).toEqual({ at: "2026-01-01T00:00:00.000Z", source: "handout" });
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

  it("refuses --write on a future-version board with exit 4 and no backup", () => {
    seed([todo(1, { produces: ["scripts/cli/outcome.mjs"] })]);
    writeFileSync(file, JSON.stringify({ version: 99, todos: JSON.parse(readFileSync(file, "utf8")).todos }));
    const before = readFileSync(file);
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [cli, "todos", "outcome", "1", "--write"], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      status = e.status;
      stderr = String(e.stderr || "");
    }
    expect(status).toBe(4);
    expect(stderr).toContain("is newer than this writer");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(path.dirname(file)).some((f) => f.includes(".corrupt-"))).toBe(false);
  });
});

describe("outcome weak file evidence (end to end, t#520)", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;
  let proj;

  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-outcome-appdata-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos }, null, 2));
    proj = mkdtempSync(path.join(os.tmpdir(), "cut-outcome-proj-"));
  };

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
      cwd: proj,
      encoding: "utf8",
    });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("no session bound, but the file is on disk after this attempt's start -> ok, weaker source", () => {
    seed([
      todo(1, {
        produces: ["words.txt"],
        status_history: [{ status: "in_progress", at: "2020-01-01T00:00:00.000Z" }],
      }),
    ]);
    writeFileSync(path.join(proj, "words.txt"), "ум\n");
    const out = run("1");
    expect(out).toContain("produced (file evidence only, mtime");
    expect(out).toContain("weaker than a transcript hit");
    expect(out).toContain("outcome: ok");
    const json = JSON.parse(run("1", "--json"));
    expect(json.produces[0].evidence).toBe("file");
  });

  it("no session bound, file predates this attempt's start -> still NOT produced", () => {
    seed([
      todo(1, {
        produces: ["words.txt"],
        status_history: [{ status: "in_progress", at: "2099-01-01T00:00:00.000Z" }],
      }),
    ]);
    writeFileSync(path.join(proj, "words.txt"), "ум\n");
    const out = run("1");
    expect(out).toContain("NOT produced");
    expect(out).toContain("outcome: issue");
    const json = JSON.parse(run("1", "--json"));
    expect(json.produces[0].evidence).toBeNull();
    expect(json.missing).toEqual(["words.txt"]);
  });
});
