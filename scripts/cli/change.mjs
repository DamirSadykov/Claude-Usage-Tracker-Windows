import { randomUUID } from "node:crypto";

export const CHANGE_REF = /^c\s*#?\s*(\d+)$/i;

export function parseChangeRef(ref) {
  const s = String(ref ?? "").trim();
  if (!s) return null;
  const m = s.match(CHANGE_REF);
  if (m) return { number: Number(m[1]) };
  if (/^\d+$/.test(s)) return { number: Number(s) };
  return { id: s };
}

export function changesOf(data) {
  return Array.isArray(data?.changes) ? data.changes.filter(Boolean) : [];
}

export function nextChangeNumber(data) {
  let max = 0;
  for (const c of changesOf(data)) {
    if (typeof c.number === "number" && c.number > max) max = c.number;
  }
  return max + 1;
}

export function changeAddress(change) {
  if (!change) return "";
  if (change.legacy) return `t#${change.number}`;
  return `c#${change.number}`;
}

export function createChange(data, fields = {}) {
  if (!Array.isArray(data.changes)) data.changes = [];
  const title = String(fields.title ?? "").trim();
  if (!title) throw new Error("a change needs a title");
  const now = new Date().toISOString();
  const change = {
    id: randomUUID(),
    number: nextChangeNumber(data),
    title,
    delta: String(fields.delta ?? ""),
    project: fields.project ?? null,
    spec: Array.isArray(fields.spec) ? [...fields.spec] : [],
    created_at: now,
    updated_at: now,
  };
  if (fields.budget_usd !== undefined && fields.budget_usd !== null)
    change.budget_usd = fields.budget_usd;
  if (fields.parallel_limit !== undefined && fields.parallel_limit !== null)
    change.parallel_limit = fields.parallel_limit;
  data.changes.push(change);
  return change;
}

export function byRecency(a, b) {
  const ta = Date.parse(a?.created_at ?? "");
  const tb = Date.parse(b?.created_at ?? "");
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  return (b?.number ?? 0) - (a?.number ?? 0);
}

export function sortedChanges(data) {
  return [...changesOf(data)].sort(byRecency);
}

export function findChange(data, ref) {
  const parsed = parseChangeRef(ref);
  if (!parsed) return null;
  const list = changesOf(data);
  if (parsed.number !== undefined)
    return list.find((c) => c.number === parsed.number) ?? null;
  return list.find((c) => c.id === parsed.id) ?? null;
}

export function findChangeByTitle(data, title, project) {
  const wanted = String(title ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const sameBoard = (c) =>
    project === undefined || (c.project ?? null) === (project ?? null);
  return (
    changesOf(data).find(
      (c) => sameBoard(c) && String(c.title ?? "").trim().toLowerCase() === wanted,
    ) ?? null
  );
}

const isClosedTask = (t) => (t?.status ?? "") === "done";

const isLegacyRoot = (t) => !!(t && (t.change ?? t.theme));

export function legacyRootsOf(data, todo) {
  if (!todo) return [];
  const byId = new Map((data?.todos ?? []).map((t) => [t.id, t]));
  const seen = new Set([todo.id]);
  const roots = [];
  const dependents = (id) =>
    (data?.todos ?? []).filter((t) => (t.depends_on ?? []).includes(id));
  const walk = (id) => {
    for (const up of dependents(id)) {
      if (seen.has(up.id)) continue;
      seen.add(up.id);
      if (isLegacyRoot(up)) roots.push(up);
      else walk(up.id);
    }
  };
  if (isLegacyRoot(todo)) return [todo];
  walk(todo.id);
  return roots.filter((r) => byId.has(r.id));
}

export function legacyChange(root) {
  if (!root) return null;
  const change = {
    id: root.id,
    number: root.number,
    title: root.subject,
    delta: root.description ?? "",
    project: root.project ?? null,
    spec: Array.isArray(root.spec) ? [...root.spec] : [],
    legacy: true,
  };
  if (root.budget_usd !== undefined && root.budget_usd !== null)
    change.budget_usd = root.budget_usd;
  if (root.parallel_limit !== undefined && root.parallel_limit !== null)
    change.parallel_limit = root.parallel_limit;
  return change;
}

export function changeOfTask(data, todo) {
  if (!todo) return null;
  if (todo.change_id) {
    const hit = changesOf(data).find((c) => c.id === todo.change_id);
    if (hit) return hit;
  }
  const [root] = legacyRootsOf(data, todo);
  return root ? legacyChange(root) : null;
}

export function membersOf(data, change) {
  if (!change) return [];
  const todos = data?.todos ?? [];
  if (!change.legacy) return todos.filter((t) => t.change_id === change.id);
  const byId = new Map(todos.map((t) => [t.id, t]));
  const root = byId.get(change.id);
  if (!root) return [];
  const out = [];
  const seen = new Set([root.id]);
  const stack = [...(root.depends_on ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const t = byId.get(id);
    if (!t || isLegacyRoot(t)) continue;
    out.push(t);
    stack.push(...(t.depends_on ?? []));
  }
  return out;
}

export function changeProgress(data, change) {
  const members = membersOf(data, change);
  return {
    total: members.length,
    done: members.filter(isClosedTask).length,
  };
}

export function changeStatus(data, change) {
  if (!change) return "open";
  const { total, done } = changeProgress(data, change);
  return total > 0 && done === total ? "closed" : "open";
}

export function isChangeOpen(data, change) {
  return changeStatus(data, change) === "open";
}
