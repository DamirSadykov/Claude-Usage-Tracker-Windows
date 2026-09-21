import { writeFileSync } from "node:fs";
import path from "node:path";
import { renameWithRetry } from "./board-lock.mjs";
import {
  CURRENT,
  BoardUnreadableError,
  readBoardTolerant,
  recoveryLine,
  refusalFor,
} from "./board-recover.mjs";

export { CURRENT, BoardUnreadableError };

export const STATUSES = ["backlog", "queue", "in_progress", "review", "done"];
export const col = (status) => (STATUSES.includes(status) ? status : "backlog");
export const isDone = (todo) => !!todo && col(todo.status) === "done";
export const isChangeRoot = (todo) => !!(todo && (todo.change ?? todo.theme));

export function normalizeLimit(value, { integer = true } = {}) {
  if (value == null || value === true) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "none" || s === "clear" || s === "off") return null;
  const num = s.replace(/^<=/, "").replace(/^\$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(num)) return undefined;
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
}

export function todosPath() {
  const appData =
    process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", "todos.json");
}

const printedRecovery = new Set();

export function load(file) {
  const { data, issue } = readBoardTolerant(file);
  hydrateProcessAliases(data);
  if (issue) {
    const key = `${issue.kind}:${file}`;
    if (!printedRecovery.has(key)) {
      printedRecovery.add(key);
      process.stderr.write(recoveryLine(issue) + "\n");
    }
    Object.defineProperty(data, "__boardIssue", { value: issue, enumerable: false, configurable: true });
  }
  return data;
}

const TODO_PROCESS_FIELDS = ["produces", "verify", "retry_limit", "on_issue", "budget_usd", "parallel_limit", "outcome", "outcome_reason", "outcome_at", "handout_at"];
const CHANGE_PROCESS_FIELDS = ["spec", "budget_usd", "parallel_limit"];

function aliasProcess(row, fields) {
  if (!row || typeof row !== "object" || !row.ext?.process || typeof row.ext.process !== "object") return;
  for (const field of fields) {
    if (!Object.hasOwn(row.ext.process, field) || Object.hasOwn(row, field)) continue;
    Object.defineProperty(row, field, { value: row.ext.process[field], writable: true, configurable: true, enumerable: true });
  }
}

export function hydrateProcessAliases(data) {
  if (data?.version < 3) return;
  for (const todo of data.todos || []) aliasProcess(todo, TODO_PROCESS_FIELDS);
  for (const change of data.changes || []) aliasProcess(change, CHANGE_PROCESS_FIELDS);
}

function moveProcess(row, fields) {
  if (!row || typeof row !== "object") return;
  const ext = row.ext && typeof row.ext === "object" && !Array.isArray(row.ext) ? row.ext : {};
  const process = ext.process && typeof ext.process === "object" && !Array.isArray(ext.process) ? ext.process : {};
  for (const field of fields) {
    if (row[field] !== undefined) process[field] = row[field];
    else delete process[field];
    delete row[field];
  }
  if (Object.keys(process).length) ext.process = process;
  if (Object.keys(ext).length) row.ext = ext;
}

export function migrateToV3(data) {
  for (const todo of data.todos || []) moveProcess(todo, TODO_PROCESS_FIELDS);
  for (const change of data.changes || []) moveProcess(change, CHANGE_PROCESS_FIELDS);
}

let deferred = null;

export function save(file, data) {
  const issue = data && data.__boardIssue;
  if (issue) throw refusalFor(issue);
  if (deferred) {
    deferred.dirty = true;
    return;
  }
  data.version = CURRENT;
  const wire = structuredClone(data);
  migrateToV3(wire);
  wire.version = CURRENT;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(wire, null, 2) + "\n");
  renameWithRetry(tmp, file);
}

export function withDeferredSave(file, data, fn) {
  if (deferred) return fn();
  deferred = { dirty: false };
  let out;
  try {
    out = fn();
  } catch (error) {
    deferred = null;
    throw error;
  }
  const dirty = deferred.dirty;
  deferred = null;
  if (dirty) save(file, data);
  return out;
}

export const boardPath = () => todosPath();
export const loadBoard = (file = todosPath()) => load(file);
export function assertBoardWritable(data) {
  const issue = data && data.__boardIssue;
  if (issue) throw refusalFor(issue);
  return data;
}
export const loadBoardForWrite = (file = todosPath()) => assertBoardWritable(load(file));
export const saveBoard = (file, data) => save(file, data);

export function resolveTask(data, token) {
  const text = String(token ?? "").trim();
  if (!text) return undefined;
  const byId = data.todos.find((todo) => todo && todo.id === text);
  if (byId) return byId;
  const number = text.replace(/^t?#?/i, "");
  if (/^\d+$/.test(number)) {
    const n = parseInt(number, 10);
    return data.todos.find((todo) => todo && todo.number === n);
  }
  return undefined;
}

export function changeAsRoot(record, data) {
  if (!record) return null;
  const members = (data?.todos ?? []).filter((todo) => todo && todo.change_id === record.id);
  const closed = members.length > 0 && members.every((todo) => isDone(todo));
  return {
    id: record.id, number: record.number, address: `c#${record.number}`,
    subject: record.title, description: record.delta ?? "", plan: record.plan ?? "",
    spec: Array.isArray(record.spec) ? [...record.spec] : [], status: closed ? "done" : "queue",
    budget_usd: record.budget_usd, parallel_limit: record.parallel_limit, record: true,
    depends_on: members.map((todo) => todo.id),
  };
}

export function changeRootsFor(data, todo) {
  if (todo?.change_id) {
    const record = (data?.changes ?? []).find((change) => change && change.id === todo.change_id);
    if (record) return [changeAsRoot(record, data)];
  }
  const roots = [];
  const seen = new Set([todo.id]);
  let frontier = [todo.id];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const candidate of data.todos) {
        if (!candidate || seen.has(candidate.id) || !Array.isArray(candidate.depends_on) || !candidate.depends_on.includes(id)) continue;
        seen.add(candidate.id);
        if (isChangeRoot(candidate)) roots.push(candidate);
        else next.push(candidate.id);
      }
    }
    frontier = next;
  }
  return roots;
}

function resolveSpecAddresses(todo, roots) {
  const own = Array.isArray(todo.spec) ? todo.spec.filter(Boolean) : [];
  if (own.length) return { source: "task", addresses: own };
  const seen = new Set();
  const addresses = [];
  for (const root of roots) for (const address of Array.isArray(root.spec) ? root.spec.filter(Boolean) : []) {
    if (!seen.has(address)) { seen.add(address); addresses.push(address); }
  }
  return { source: "root", addresses };
}

export const specAddressesForManual = (todo, roots) => resolveSpecAddresses(todo, roots);

export function changeAddress(change) {
  if (!change) return "";
  return change.legacy ? `t#${change.number}` : `c#${change.number}`;
}

export function findChange(data, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  const match = text.match(/^c\s*#?\s*(\d+)$/i);
  const number = match ? Number(match[1]) : /^\d+$/.test(text) ? Number(text) : undefined;
  const changes = Array.isArray(data?.changes) ? data.changes.filter(Boolean) : [];
  if (number !== undefined) return changes.find((change) => change.number === number) ?? null;
  return changes.find((change) => change.id === text) ?? null;
}
