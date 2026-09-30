import type { BoardIndexes } from "./boardStore";

export const TODO_STATUSES = ["backlog", "queue", "in_progress", "review", "done"] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export interface TodoFilters {
  status: string;
  project: string;
  priority: string;
  createdBy: string;
  change: "" | "change" | "task";
  createdFrom: string;
  createdTo: string;
  query: string;
  showDone: boolean;
}

export type TodoFilterField = keyof Omit<TodoFilters, "query">;

export const defaultTodoFilters = (): TodoFilters => ({
  status: "", project: "", priority: "", createdBy: "", change: "",
  createdFrom: "", createdTo: "", query: "", showDone: false,
});

export const isNotDoneFilter = (filters: Pick<TodoFilters, "status" | "showDone">): boolean => !filters.status && !filters.showDone;

export interface FilterableTodoRow {
  id: string; number?: number; subject: string; description: string; status: string;
  priority?: string; project?: string | null; change?: boolean; created_at: string;
  updated_at: string; scheduled_for?: string | null; created_by?: string;
  closed_at?: string | null;
  filterProject?: string | null;
}
export interface TodoProjection<T extends FilterableTodoRow = FilterableTodoRow> {
  columns: Record<TodoStatus, T[]>;
  visible: T[];
}

export interface TodoCardRow extends FilterableTodoRow {
  from?: string | null;
  aliases: string[];
  mergedInto?: string | null;
  refCount: number;
  cost?: number;
  costTitle?: string;
  importedAt?: string | null;
  hasPlan: boolean;
  spec: string[];
}

const emptyColumns = <T>(): Record<TodoStatus, T[]> => ({
  backlog: [], queue: [], in_progress: [], review: [], done: [],
});

function datePart(value: string | null | undefined): string { return (value ?? "").slice(0, 10); }

export function projectTodos<T extends FilterableTodoRow>(
  rows: readonly T[], filters: TodoFilters, indexes?: Pick<BoardIndexes, "search">,
): TodoProjection<T> {
  const columns = emptyColumns<T>();
  const visible: T[] = [];
  const query = filters.query.trim().toLocaleLowerCase();
  const numericQuery = query.replace(/^#/, "");
  for (const row of rows) {
    if (!filters.showDone && row.status === "done" && filters.status !== "done") continue;
    if (filters.status && row.status !== filters.status) continue;
    if (filters.project && (row.filterProject ?? row.project) !== filters.project) continue;
    if (filters.priority && row.priority !== filters.priority) continue;
    if (filters.createdBy && row.created_by !== filters.createdBy) continue;
    if (filters.change && (filters.change === "change") !== !!row.change) continue;
    const created = datePart(row.created_at);
    if (filters.createdFrom && created < filters.createdFrom) continue;
    if (filters.createdTo && created > filters.createdTo) continue;
    if (query) {
      const haystack = indexes?.search.get(row.id) ?? [row.number, row.subject, row.description, row.project ?? ""].join(" ").toLocaleLowerCase();
      if (!haystack.includes(query) && !( /^\d+$/.test(numericQuery) && String(row.number ?? "").includes(numericQuery))) continue;
    }
    const column = columns[row.status as TodoStatus];
    if (!column) continue;
    column.push(row);
    visible.push(row);
  }
  for (const status of TODO_STATUSES) {
    columns[status].sort((a, b) => {
      if (status === "done") {
        return (b.closed_at || "").localeCompare(a.closed_at || "")
          || (b.updated_at || "").localeCompare(a.updated_at || "");
      }
      const left = a.scheduled_for || "9999-99-99";
      const right = b.scheduled_for || "9999-99-99";
      return left === right ? (b.updated_at || "").localeCompare(a.updated_at || "") : left.localeCompare(right);
    });
  }
  return { columns, visible };
}
