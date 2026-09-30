import type { Todo } from "../contracts/board";

export const DETAIL_SIBLING_PAGE_SIZE = 50;

export type DetailSiblingScope = "project" | "change";

export interface DetailSiblingPages<T extends Pick<Todo, "id" | "project" | "status"> & Pick<Todo, "change_id">> {
  open: T[];
  done: T[];
  visible: T[];
  hasMoreDone: boolean;
}

export interface DetailSiblingPager<T extends Pick<Todo, "id" | "project" | "status"> & Pick<Todo, "change_id">> {
  pages(rows: readonly T[], scopeId: string | null | undefined, activeId: string | null, doneLimit?: number, scope?: DetailSiblingScope): DetailSiblingPages<T>;
}

function statusRank(status: string): number {
  return ["backlog", "queue", "in_progress", "review", "done"].indexOf(status);
}

export function detailSiblingPages<T extends Pick<Todo, "id" | "project" | "status"> & Pick<Todo, "change_id">>(
  rows: readonly T[],
  scopeId: string | null | undefined,
  activeId: string | null,
  doneLimit = DETAIL_SIBLING_PAGE_SIZE,
  scope: DetailSiblingScope = "project",
): DetailSiblingPages<T> {
  const matching = rows.filter((row) => scope === "change"
    ? (row.change_id ?? null) === (scopeId ?? null)
    : (row.project ?? null) === (scopeId ?? null));
  const compare = (a: T, b: T) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    return byStatus || a.id.localeCompare(b.id);
  };
  const open = matching.filter((row) => row.status !== "done").sort(compare);
  const done = matching.filter((row) => row.status === "done").sort(compare);
  const visibleDone = done.slice(0, Math.max(0, doneLimit));
  const active = done.find((row) => row.id === activeId);
  if (active && !visibleDone.some((row) => row.id === active.id)) visibleDone.push(active);
  return {
    open,
    done,
    visible: [...open, ...visibleDone],
    hasMoreDone: done.length > doneLimit,
  };
}

export function createDetailSiblingPager<T extends Pick<Todo, "id" | "project" | "status"> & Pick<Todo, "change_id">>(): DetailSiblingPager<T> {
  let cachedScope: string | null | undefined;
  let cachedScopeKind: DetailSiblingScope = "project";
  let cachedShape = new Map<string, string>();
  let openIds: string[] = [];
  let doneIds: string[] = [];

  return {
    pages(rows, scopeId, activeId, doneLimit = DETAIL_SIBLING_PAGE_SIZE, scope = "project") {
      const normalizedScope = scopeId ?? null;
      const scopedRows = rows.filter((row) => scope === "change"
        ? (row.change_id ?? null) === normalizedScope
        : (row.project ?? null) === normalizedScope);
      const hasSameShape = cachedScope === normalizedScope
        && cachedScopeKind === scope
        && cachedShape.size === scopedRows.length
        && scopedRows.every((row) => cachedShape.get(row.id) === row.status);
      if (!hasSameShape) {
        const ordered = detailSiblingPages(scopedRows, normalizedScope, null, Number.MAX_SAFE_INTEGER, scope);
        openIds = ordered.open.map((row) => row.id);
        doneIds = ordered.done.map((row) => row.id);
        cachedScope = normalizedScope;
        cachedScopeKind = scope;
        cachedShape = new Map(scopedRows.map((row) => [row.id, row.status]));
      }

      const byId = new Map(rows.map((row) => [row.id, row]));
      const open = openIds.map((id) => byId.get(id)).filter((row): row is T => !!row);
      const done = doneIds.map((id) => byId.get(id)).filter((row): row is T => !!row);
      const visibleDone = done.slice(0, Math.max(0, doneLimit));
      const active = done.find((row) => row.id === activeId);
      if (active && !visibleDone.some((row) => row.id === active.id)) visibleDone.push(active);
      return { open, done, visible: [...open, ...visibleDone], hasMoreDone: done.length > doneLimit };
    },
  };
}
