import { createChange, changeAddress, findChangeByTitle, parseArgs } from "./change.mjs";
import { boardPath, loadBoard, loadBoardForWrite, saveBoard } from "./board-io.mjs";
import { withBoardLock } from "./board-lock.mjs";

const isLegacyRoot = (t) => !!(t && (t.change ?? t.theme));

export function legacyRoots(data) {
  return (data?.todos ?? [])
    .filter(isLegacyRoot)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export function membersOfRoot(data, root) {
  const byId = new Map((data?.todos ?? []).map((t) => [t.id, t]));
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

export function planMigration(data) {
  const roots = legacyRoots(data);
  const claimed = new Set();
  const entries = [];
  for (const root of roots) {
    const members = membersOfRoot(data, root).filter((t) => !claimed.has(t.id));
    for (const t of members) claimed.add(t.id);
    const nestedRoots = (root.depends_on ?? [])
      .map((id) => (data.todos ?? []).find((t) => t.id === id))
      .filter((t) => t && isLegacyRoot(t));
    entries.push({ root, members, nestedRoots });
  }
  return entries;
}

export function migrate(data) {
  const entries = planMigration(data);
  const notes = [];
  const created = [];
  for (const { root, members, nestedRoots } of entries) {
    const existing = findChangeByTitle(data, root.subject, root.project ?? null);
    const change =
      existing ??
      createChange(data, {
        title: root.subject,
        delta: root.description ?? "",
        project: root.project ?? null,
        spec: root.spec ?? [],
        budget_usd: root.budget_usd,
        parallel_limit: root.parallel_limit,
      });
    if (!existing) {
      if (root.created_at) change.created_at = root.created_at;
      change.migrated_from = root.number;
      created.push({ change, root, members });
    }
    for (const t of members) t.change_id = change.id;
    for (const nested of nestedRoots)
      notes.push(
        `${changeAddress(change)} depended on root #${nested.number} — that edge is dropped: a change no longer nests inside another`,
      );
  }
  const rootIds = new Set(entries.map((e) => e.root.id));
  for (const t of data.todos ?? []) {
    if (rootIds.has(t.id)) continue;
    if (Array.isArray(t.depends_on) && t.depends_on.some((id) => rootIds.has(id)))
      t.depends_on = t.depends_on.filter((id) => !rootIds.has(id));
    if (Array.isArray(t.links) && t.links.some((id) => rootIds.has(id)))
      t.links = t.links.filter((id) => !rootIds.has(id));
  }
  data.todos = (data.todos ?? []).filter((t) => !rootIds.has(t.id));
  return { created, notes, roots: entries.length };
}

export function describe(data) {
  const entries = planMigration(data);
  const lines = [];
  let next = 1;
  for (const { root, members, nestedRoots } of entries) {
    const existing = findChangeByTitle(data, root.subject, root.project ?? null);
    const address = existing ? changeAddress(existing) : `c#${next++}`;
    lines.push(
      `${existing ? "=" : "+"} ${address} ← #${root.number} "${root.subject}" · ${members.length} задач(и)` +
        (root.project ? ` · ${root.project}` : ""),
    );
    for (const nested of nestedRoots)
      lines.push(`    ! ребро на корень #${nested.number} снимается — вложенных change'ей больше нет`);
  }
  return lines;
}

export function run(args) {
  const { flags } = parseArgs(args);
  const file = boardPath();
  withBoardLock(file, () => {
    const data = flags.go ? loadBoardForWrite(file) : loadBoard(file);
    const lines = describe(data);
    if (!lines.length) {
      process.stdout.write("нечего мигрировать: ни одного корня с флагом на доске\n");
      return;
    }
    process.stdout.write(lines.join("\n") + "\n");
    if (!flags.go) {
      process.stdout.write("\nсухой прогон, ничего не записано — повтори с --go\n");
      return;
    }
    const result = migrate(data);
    saveBoard(file, data);
    for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
    process.stdout.write(
      `ok: ${result.created.length} запис(и) заведено, ${result.roots} корней снято с доски\n`,
    );
  });
}
