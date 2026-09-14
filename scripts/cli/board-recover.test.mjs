import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT,
  BoardUnreadableError,
  detectBoardIssue,
  readBoardTolerant,
  recoveryLine,
  refusalFor,
} from "./board-recover.mjs";
import { boardLockPath } from "./board-lock.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "board-fixtures",
);

describe("detectBoardIssue — the common unreadable minimum", () => {
  it("is ok on a well-formed CURRENT board", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 2, todos: [] }));
    expect(r.kind).toBe("ok");
    expect(r.data.version).toBe(2);
  });

  it("flags text that does not parse as JSON", () => {
    expect(detectBoardIssue("{ not json").kind).toBe("unreadable");
    expect(detectBoardIssue("").reason).toBe("not-json");
  });

  it("flags a root that is not an object", () => {
    const r = detectBoardIssue(JSON.stringify([{ id: "a" }]));
    expect(r.kind).toBe("unreadable");
    expect(r.reason).toBe("not-object");
  });

  it("flags todos that is not an array", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 2, todos: "nope" }));
    expect(r.kind).toBe("unreadable");
    expect(r.reason).toBe("todos-not-array");
  });

  it("flags a todos element that is not an object", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 2, todos: [{ id: "a" }, "nope"] }));
    expect(r.kind).toBe("unreadable");
    expect(r.reason).toBe("todo-not-object");
  });

  it("flags changes present and not an array", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 2, todos: [], changes: "nope" }));
    expect(r.kind).toBe("unreadable");
    expect(r.reason).toBe("changes-not-array");
  });

  it("treats a missing version as stale version 1 rather than as unreadable", () => {
    const r = detectBoardIssue(JSON.stringify({ todos: [] }));
    expect(r.kind).toBe("stale-version");
    expect(r.version).toBe(1);
  });

  it("treats a non-integer version as stale version 1 rather than as unreadable", () => {
    const r = detectBoardIssue(JSON.stringify({ version: "2", todos: [] }));
    expect(r.kind).toBe("stale-version");
    expect(r.version).toBe(1);

    const r2 = detectBoardIssue(JSON.stringify({ version: 1.5, todos: [] }));
    expect(r2.kind).toBe("stale-version");
    expect(r2.version).toBe(1);
  });

  it("does not flag a mismatched field type on a todo node (Node vs Rust asymmetry)", () => {
    const raw = readFileSync(path.join(FIXTURES, "corrupt", "todo-field-type.json"), "utf8");
    const r = detectBoardIssue(raw);
    expect(r.kind).toBe("ok");
  });

  it("flags a version above CURRENT as future, not unreadable, and keeps the data", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 99, todos: [{ id: "a" }] }));
    expect(r.kind).toBe("future-version");
    expect(r.version).toBe(99);
    expect(r.data.todos).toHaveLength(1);
  });

  it("flags a version below CURRENT as stale, not unreadable, and keeps the data", () => {
    const r = detectBoardIssue(JSON.stringify({ version: 1, todos: [{ id: "a" }] }));
    expect(r.kind).toBe("stale-version");
    expect(r.version).toBe(1);
    expect(r.data.todos).toHaveLength(1);
  });

  for (const name of ["truncated.json", "not-object.json", "todos-not-array.json", "empty-file.json"]) {
    it(`flags corrupt fixture ${name} as unreadable`, () => {
      const raw = readFileSync(path.join(FIXTURES, "corrupt", name), "utf8");
      expect(detectBoardIssue(raw).kind).toBe("unreadable");
    });
  }
});

describe("readBoardTolerant — the forgiving read + backup", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "board-recover-"));
    file = path.join(dir, "todos.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("yields an empty CURRENT board with no issue when the file is missing", () => {
    const { data, issue } = readBoardTolerant(file);
    expect(issue).toBeNull();
    expect(data).toEqual({ version: CURRENT, todos: [] });
  });

  it("backs up an unreadable file exactly once across two detections", () => {
    writeFileSync(file, "{ not json");
    const first = readBoardTolerant(file);
    expect(first.issue.kind).toBe("unreadable");
    expect(first.issue.reason).toBe("not-json");
    expect(first.issue.backup).toMatch(/\.corrupt-\d{8}T\d{6}Z$/);
    expect(existsSync(first.issue.backup)).toBe(true);
    expect(readFileSync(first.issue.backup, "utf8")).toBe("{ not json");

    const before = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    const second = readBoardTolerant(file);
    expect(second.issue.backup).toBe(first.issue.backup);
    const after = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(after).toEqual(before);

    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("does not wait for a live lock before skipping a corrupt backup", () => {
    writeFileSync(file, "{ not json");
    const lock = boardLockPath(file);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, writer: "cli", at: new Date().toISOString() }));

    const started = performance.now();
    const { issue } = readBoardTolerant(file);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(issue.backup).toBeNull();
    expect(issue.backupError.message).toContain(lock);
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("includes the OS error in a read failure reason", () => {
    const { issue } = readBoardTolerant(dir);
    expect(issue.reason).toMatch(/^read-error: /);
  });

  it("returns the parsed data (not a synthetic empty board) for a future version", () => {
    writeFileSync(file, JSON.stringify({ version: 99, todos: [{ id: "a", number: 1 }] }));
    const { data, issue } = readBoardTolerant(file);
    expect(issue.kind).toBe("future-version");
    expect(issue.version).toBe(99);
    expect(data.todos).toHaveLength(1);
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("returns the parsed data without a backup for a stale version", () => {
    writeFileSync(file, JSON.stringify({ version: 1, todos: [{ id: "a", number: 1 }] }));
    const { data, issue } = readBoardTolerant(file);
    expect(issue.kind).toBe("stale-version");
    expect(issue.version).toBe(1);
    expect(data.todos).toHaveLength(1);
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });
});

describe("recoveryLine / refusalFor — message shapes", () => {
  it("formats the unreadable refusal exactly per spec", () => {
    const err = refusalFor({ kind: "unreadable", reason: "not-json", file: "C:\\x\\todos.json", backup: "C:\\x\\todos.json.corrupt-20260101T000000Z" });
    expect(err).toBeInstanceOf(BoardUnreadableError);
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe(
      "board unreadable (not-json): C:\\x\\todos.json — backup: C:\\x\\todos.json.corrupt-20260101T000000Z",
    );
  });

  it("formats the unreadable refusal with no backup", () => {
    const err = refusalFor({ kind: "unreadable", reason: "not-json", file: "C:\\x\\todos.json", backup: null });
    expect(err.message).toBe("board unreadable (not-json): C:\\x\\todos.json — backup: none");
  });

  it("formats the future-version refusal exactly per spec", () => {
    const err = refusalFor({ kind: "future-version", file: "C:\\x\\todos.json", version: 99 });
    expect(err.message).toBe(
      `board version 99 is newer than this writer (CURRENT ${CURRENT}): C:\\x\\todos.json`,
    );
    expect(err.reason).toBe("future-version");
    expect(err.exitCode).toBe(4);
  });

  it("formats the stale-version refusal exactly per spec", () => {
    const err = refusalFor({ kind: "stale-version", file: "C:\\x\\todos.json", version: 1 });
    expect(err.message).toBe(
      `board version 1 is older than this writer (CURRENT ${CURRENT}) and needs migration: C:\\x\\todos.json — open the tracker's task window, then retry`,
    );
    expect(err.reason).toBe("stale-version");
    expect(err.exitCode).toBe(4);
  });

  it("recoveryLine names the source file and the backup for an unreadable board", () => {
    const line = recoveryLine({
      kind: "unreadable",
      reason: "todos-not-array",
      file: "C:\\x\\todos.json",
      backup: "C:\\x\\todos.json.corrupt-20260101T000000Z",
    });
    expect(line).toContain("C:\\x\\todos.json");
    expect(line).toContain("C:\\x\\todos.json.corrupt-20260101T000000Z");
  });

  it("recoveryLine names the versions for a future-version board", () => {
    const line = recoveryLine({ kind: "future-version", file: "C:\\x\\todos.json", version: 99 });
    expect(line).toContain("99");
    expect(line).toContain(String(CURRENT));
  });

  it("formats the stale-version recovery line exactly per spec", () => {
    const line = recoveryLine({ kind: "stale-version", file: "C:\\x\\todos.json", version: 1 });
    expect(line).toBe(
      `board recovery: C:\\x\\todos.json is version 1 (CURRENT ${CURRENT}) — reading known fields, not writing; open the tracker's task window to migrate, then retry`,
    );
  });
});
