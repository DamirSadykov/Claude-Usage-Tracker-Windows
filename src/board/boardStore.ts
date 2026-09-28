// One compact board snapshot per WebView.  Do not put full Todo records here:
// detail panes fetch those on demand, while board and graph can share this cheap
// immutable projection.
import { shallowRef, type ShallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BoardChange } from "../contracts/board";

export interface BoardRow {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  kind: string;
  change: boolean;
  change_id?: string | null;
  scheduled_for?: string | null;
  project?: string | null;
  from?: string | null;
  links: string[];
  depends_on: string[];
  created_at: string;
  updated_at: string;
  ref_count: number;
  comment_count: number;
}

export interface BoardPayload {
  revision: number;
  todos: BoardRow[];
  changes: BoardChange[];
  state: "ok" | "unreadable" | "future-version";
}

export interface BoardIndexes {
  byId: Map<string, BoardRow>;
  /** prerequisite -> tasks waiting on it */
  dependencyChildren: Map<string, string[]>;
  /** task -> non-blocking links, including inline t# references when supplied */
  links: Map<string, string[]>;
  search: Map<string, string>;
}

export interface BoardMutation {
  revision: number;
  row: BoardRow | null;
}

function freezeRow(row: BoardRow): BoardRow {
  // Publicly the compact row retains mutable-looking array types for existing
  // consumers; the actual snapshot is frozen at the boundary.
  return Object.freeze({
    ...row,
    links: Object.freeze([...(row.links ?? [])]),
    depends_on: Object.freeze([...(row.depends_on ?? [])]),
  }) as unknown as BoardRow;
}

export function buildIndexes(rows: readonly BoardRow[]): BoardIndexes {
  const byId = new Map<string, BoardRow>();
  const dependencyChildren = new Map<string, string[]>();
  const links = new Map<string, string[]>();
  const search = new Map<string, string>();
  for (const row of rows) {
    byId.set(row.id, row);
    links.set(row.id, row.links);
    search.set(row.id, [row.number, row.subject, row.description, row.status, row.priority, row.project ?? ""].join(" ").toLocaleLowerCase());
    for (const prerequisite of row.depends_on) {
      const children = dependencyChildren.get(prerequisite) ?? [];
      children.push(row.id);
      dependencyChildren.set(prerequisite, children);
    }
  }
  for (const children of dependencyChildren.values()) Object.freeze(children);
  return { byId, dependencyChildren, links, search };
}

function snapshot(payload: BoardPayload) {
  const rows = Object.freeze(payload.todos.map(freezeRow));
  return { rows, changes: Object.freeze([...payload.changes]), indexes: buildIndexes(rows) };
}

const rows = shallowRef<readonly BoardRow[]>(Object.freeze([]));
const changes = shallowRef<readonly BoardChange[]>(Object.freeze([]));
const indexes = shallowRef<BoardIndexes>(buildIndexes(rows.value));
const revision = shallowRef(0);
const stale = shallowRef(false);
const loading = shallowRef(false);
const error = shallowRef("");
let unlisten: UnlistenFn | undefined;
let started = false;
let starting: Promise<void> | undefined;
let wake: (() => void) | undefined;

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function install(payload: BoardPayload) {
  const next = snapshot(payload);
  rows.value = next.rows;
  changes.value = next.changes;
  indexes.value = next.indexes;
  revision.value = payload.revision;
  stale.value = false;
  error.value = payload.state === "ok" ? "" : payload.state;
}

async function reload(force = false): Promise<void> {
  if (!force && !visible()) {
    stale.value = true;
    return;
  }
  loading.value = true;
  try {
    const payload = await invoke<BoardPayload>("get_board");
    // A delayed reply must never roll a newer mutation backwards.
    if (payload.revision >= revision.value) install(payload);
  } catch (cause) {
    error.value = String(cause);
  } finally {
    loading.value = false;
  }
}

/** Start the sole file watcher for this renderer. Safe to call from many views. */
async function start(): Promise<void> {
  if (starting) return starting;
  if (started) return;
  started = true;
  starting = (async () => {
    unlisten = await listen("todos-file-changed", () => {
      if (visible()) void reload();
      else stale.value = true;
    });
    wake = () => { if (visible() && stale.value) void reload(); };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", wake);
    }
    if (visible()) await reload();
    else stale.value = true;
  })();
  try {
    await starting;
  } finally {
    starting = undefined;
  }
}

function applyMutation(result: BoardMutation): void {
  // The watcher echoes local writes. This revision gate makes that echo free.
  if (result.revision <= revision.value) return;
  if (!result.row) {
    revision.value = result.revision;
    stale.value = true;
    return;
  }
  const row = freezeRow(result.row);
  const nextRows = Object.freeze(rows.value.map((old) => old.id === row.id ? row : old));
  rows.value = nextRows;
  indexes.value = buildIndexes(nextRows);
  revision.value = result.revision;
  stale.value = false;
}

export interface BoardStore {
  rows: ShallowRef<readonly BoardRow[]>;
  changes: ShallowRef<readonly BoardChange[]>;
  indexes: ShallowRef<BoardIndexes>;
  revision: ShallowRef<number>;
  stale: ShallowRef<boolean>;
  loading: ShallowRef<boolean>;
  error: ShallowRef<string>;
  start(): Promise<void>;
  reload(force?: boolean): Promise<void>;
  applyMutation(result: BoardMutation): void;
  dispose(): void;
}

/** Module scope is intentionally per renderer/WebView, not application-global. */
export const boardStore: BoardStore = {
  rows, changes, indexes, revision, stale, loading, error, start, reload, applyMutation,
  dispose() {
    unlisten?.();
    unlisten = undefined;
    if (wake && typeof window !== "undefined") {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    }
    wake = undefined;
    started = false;
  },
};
