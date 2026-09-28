import type { Todo } from "../contracts/board";

export const DETAIL_SIBLING_PAGE_SIZE = 50;

export interface DetailSiblingPages<T extends Pick<Todo, "id" | "project" | "status">> {
  open: T[];
  done: T[];
  visible: T[];
  hasMoreDone: boolean;
}

/** Keeps the expensive partition and ordering stable for cosmetic row updates. */
export interface DetailSiblingPager<T extends Pick<Todo, "id" | "project" | "status">> {
  pages(rows: readonly T[], project: string | null | undefined, activeId: string | null, doneLimit?: number): DetailSiblingPages<T>;
}

function statusRank(status: string): number {
  return ["backlog", "queue", "in_progress", "review", "done"].indexOf(status);
}

// Keep the rail cheap: board rows are already compact, and only completed work
// is paged. The active task is always included, even if it lies beyond the
// current completed page, so selecting it never makes the rail look broken.
export function detailSiblingPages<T extends Pick<Todo, "id" | "project" | "status">>(
  rows: readonly T[],
  project: string | null | undefined,
  activeId: string | null,
  doneLimit = DETAIL_SIBLING_PAGE_SIZE,
): DetailSiblingPages<T> {
  const matching = rows.filter((row) => (row.project ?? null) === (project ?? null));
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

export function createDetailSiblingPager<T extends Pick<Todo, "id" | "project" | "status">>(): DetailSiblingPager<T> {
  let cachedProject: string | null | undefined;
  let cachedShape = new Map<string, string>();
  let openIds: string[] = [];
  let doneIds: string[] = [];

  return {
    pages(rows, project, activeId, doneLimit = DETAIL_SIBLING_PAGE_SIZE) {
      const normalizedProject = project ?? null;
      const projectRows = rows.filter((row) => (row.project ?? null) === normalizedProject);
      // Only rail-structural fields invalidate the ordering. Subject, priority,
      // timestamp, and changes in another project still use the current row
      // objects below without sorting this project's rail again.
      const hasSameShape = cachedProject === normalizedProject
        && cachedShape.size === projectRows.length
        && projectRows.every((row) => cachedShape.get(row.id) === row.status);
      if (!hasSameShape) {
        const ordered = detailSiblingPages(projectRows, normalizedProject, null, Number.MAX_SAFE_INTEGER);
        openIds = ordered.open.map((row) => row.id);
        doneIds = ordered.done.map((row) => row.id);
        cachedProject = normalizedProject;
        cachedShape = new Map(projectRows.map((row) => [row.id, row.status]));
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
