import fs from "node:fs";
import { withBoardLock } from "./board-lock.mjs";

export const CURRENT = 2;

export class BoardUnreadableError extends Error {
  constructor(message, { file, backup = null, reason } = {}) {
    super(message);
    this.name = "BoardUnreadableError";
    this.exitCode = 4;
    this.file = file;
    this.backup = backup;
    this.reason = reason;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function detectBoardIssue(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "not-json" };
  }
  if (!isPlainObject(parsed)) return { kind: "unreadable", reason: "not-object" };
  if (!Array.isArray(parsed.todos)) return { kind: "unreadable", reason: "todos-not-array" };
  if (parsed.todos.some((t) => !isPlainObject(t)))
    return { kind: "unreadable", reason: "todo-not-object" };
  if ("changes" in parsed && parsed.changes !== undefined && !Array.isArray(parsed.changes))
    return { kind: "unreadable", reason: "changes-not-array" };

  const version = Number.isInteger(parsed.version) ? parsed.version : 1;
  if (version > CURRENT) return { kind: "future-version", data: parsed, version };
  return { kind: "ok", data: { ...parsed, version } };
}

function backupTimestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeCorruptBackup(file, raw) {
  const backup = `${file}.corrupt-${backupTimestamp()}`;
  let fd;
  try {
    fd = fs.openSync(backup, "wx");
  } catch (e) {
    if (e && e.code === "EEXIST") return { path: backup, madeNow: false };
    return { path: null, error: e };
  }
  try {
    fs.writeSync(fd, raw);
    return { path: backup, madeNow: true };
  } catch (e) {
    return { path: null, error: e };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function ensureCorruptBackup(file, raw) {
  try {
    return withBoardLock(file, () => writeCorruptBackup(file, raw));
  } catch (e) {
    return { path: null, error: e };
  }
}

export function readBoardTolerant(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { data: { version: CURRENT, todos: [] }, issue: null };
    return {
      data: { version: CURRENT, todos: [] },
      issue: { kind: "unreadable", reason: "read-error", file, backup: null, backupError: e },
    };
  }

  const result = detectBoardIssue(raw);
  if (result.kind === "ok") return { data: result.data, issue: null };
  if (result.kind === "future-version")
    return { data: result.data, issue: { kind: "future-version", file, version: result.version } };

  const backup = ensureCorruptBackup(file, raw);
  return {
    data: { version: CURRENT, todos: [] },
    issue: {
      kind: "unreadable",
      reason: result.reason,
      file,
      backup: backup.path,
      backupError: backup.error || null,
    },
  };
}

export function recoveryLine(issue) {
  if (issue.kind === "future-version")
    return `board recovery: ${issue.file} is version ${issue.version} (CURRENT ${CURRENT}) — reading known fields, not writing`;
  const backupPart = issue.backup
    ? `backup: ${issue.backup}`
    : `backup: none${issue.backupError ? ` (${issue.backupError.message || issue.backupError})` : ""}`;
  return `board recovery: ${issue.file} unreadable (${issue.reason}) — ${backupPart}; continuing with an empty board`;
}

export function refusalFor(issue) {
  if (issue.kind === "future-version")
    return new BoardUnreadableError(
      `board version ${issue.version} is newer than this writer (CURRENT ${CURRENT}): ${issue.file}`,
      { file: issue.file, backup: null, reason: "future-version" },
    );
  return new BoardUnreadableError(
    `board unreadable (${issue.reason}): ${issue.file} — backup: ${issue.backup || "none"}`,
    { file: issue.file, backup: issue.backup || null, reason: issue.reason },
  );
}
