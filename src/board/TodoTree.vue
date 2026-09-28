<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { visibleBoardTreeRows, type BoardTreeNode } from "./boardTree";

const props = withDefaults(defineProps<{
  tree: readonly BoardTreeNode[];
  selectedId?: string | null;
}>(), { selectedId: null });

const emit = defineEmits<{
  select: [node: BoardTreeNode];
  "update:selectedId": [id: string | null];
  open: [node: BoardTreeNode];
}>();

const COLLAPSED_KEY = "todo-tree:collapsed";
const SELECTED_KEY = "todo-tree:selected";
const collapsed = ref<Set<string>>(new Set());
const localSelectedId = ref<string | null>(readSelected());
const root = ref<HTMLElement | null>(null);
const initialized = ref(false);
const selectedId = computed(() => props.selectedId ?? localSelectedId.value);
const rows = computed(() => visibleBoardTreeRows(props.tree, collapsed.value));

function readCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? new Set(saved) : new Set();
  } catch {
    return new Set();
  }
}

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function persistCollapsed(value: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value]));
  } catch {}
}

function select(node: BoardTreeNode): void {
  localSelectedId.value = node.id;
  try {
    localStorage.setItem(SELECTED_KEY, node.id);
  } catch {}
  emit("update:selectedId", node.id);
  emit("select", node);
}

function toggle(node: BoardTreeNode): void {
  if (!node.children.length) return;
  const next = new Set(collapsed.value);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  collapsed.value = next;
  persistCollapsed(next);
}

function open(node: BoardTreeNode): void {
  if (node.kind !== "group") emit("open", node);
}

function onKeydown(event: KeyboardEvent): void {
  const index = rows.value.findIndex(({ node }) => node.id === selectedId.value);
  const current = index < 0 ? 0 : index;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = index < 0
      ? rows.value[event.key === "ArrowDown" ? 0 : rows.value.length - 1]
      : rows.value[current + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) select(next.node);
    return;
  }
  const row = rows.value[current];
  if (!row) return;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    if (row.node.children.length && collapsed.value.has(row.node.id)) toggle(row.node);
    else if (row.node.children.length) select(row.node.children[0]);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (row.node.children.length && !collapsed.value.has(row.node.id)) toggle(row.node);
    else {
      for (let candidate = current - 1; candidate >= 0; candidate--) {
        if (rows.value[candidate].depth < row.depth) {
          select(rows.value[candidate].node);
          break;
        }
      }
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    open(row.node);
  }
}

function statusClass(status: string | null): string {
  return status ? `status-${status}` : "";
}

function cost(value: number): string {
  return "$" + (value >= 100 ? Math.round(value) : value.toFixed(2));
}

function expandSelectedAncestors(tree: readonly BoardTreeNode[], id: string | null, value: ReadonlySet<string>): Set<string> {
  if (!id) return new Set(value);
  const next = new Set(value);
  const visit = (node: BoardTreeNode): boolean => {
    if (node.id === id) return true;
    for (const child of node.children) {
      if (visit(child)) {
        next.delete(node.id);
        return true;
      }
    }
    return false;
  };
  for (const node of tree) visit(node);
  return next;
}

watch(() => props.tree, (tree) => {
  if (initialized.value || !tree.length) return;
  const saved = readCollapsed();
  const defaults = new Set<string>();
  const visit = (node: BoardTreeNode) => {
    if (node.children.length && (node.closed || node.kind === "group")) defaults.add(node.id);
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  collapsed.value = expandSelectedAncestors(tree, selectedId.value, new Set([...defaults, ...saved]));
  initialized.value = true;
}, { immediate: true });

watch([() => props.tree, selectedId], ([tree, id]) => {
  if (!tree.length || !id) return;
  const next = expandSelectedAncestors(tree, id, collapsed.value);
  if (next.size === collapsed.value.size && [...next].every((nodeId) => collapsed.value.has(nodeId))) return;
  collapsed.value = next;
  persistCollapsed(next);
}, { immediate: true });

async function scrollSelected(id: string | null): Promise<void> {
  await nextTick();
  if (!id) return;
  root.value?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}

watch(selectedId, scrollSelected, { flush: "post", immediate: true });
watch(rows, () => scrollSelected(selectedId.value), { flush: "post" });
</script>

<template>
  <nav ref="root" class="todo-tree" tabindex="0" @keydown="onKeydown">
    <button
      v-for="row in rows"
      :key="row.node.id"
      class="todo-tree-row"
      :class="{ selected: row.node.id === selectedId, closed: row.node.closed, group: row.node.kind === 'group' }"
      :data-tree-id="row.node.id"
      :style="{ '--tree-depth': row.depth }"
      @click="select(row.node)"
      @dblclick="open(row.node)"
    >
      <span class="todo-tree-toggle" :class="{ empty: !row.node.children.length, collapsed: collapsed.has(row.node.id) }" @click.stop="toggle(row.node)"></span>
      <span v-if="row.node.status" class="todo-tree-status" :class="statusClass(row.node.status)"></span>
      <span class="todo-tree-title"><span v-if="row.node.number !== null" class="todo-tree-number">{{ row.node.kind === 'change' || row.node.kind === 'legacy' ? 'c#' : '#' }}{{ row.node.number }}</span>{{ row.node.title }}</span>
      <span v-if="row.node.kind !== 'task'" class="todo-tree-progress">{{ row.node.progress.done }}/{{ row.node.progress.total }}</span>
      <span v-if="row.node.kind !== 'group'" class="todo-tree-cost">{{ cost(row.node.cost) }}</span>
    </button>
  </nav>
</template>

<style scoped>
.todo-tree { min-width: 0; overflow: auto; background: var(--card-bg); color: var(--text); font-family: var(--segoe); outline: none; }
.todo-tree:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.todo-tree-row { --tree-indent: calc(var(--tree-depth) * 16px); align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: flex; gap: 6px; min-height: 30px; padding: 4px 8px 4px calc(8px + var(--tree-indent)); text-align: left; width: 100%; }
.todo-tree-row:hover { background: var(--card-bg-hover); }
.todo-tree-row.selected { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.todo-tree-row.closed:not(.selected) { color: var(--text-3); }
.todo-tree-toggle { color: var(--text-3); flex: 0 0 10px; font-size: 12px; text-align: center; }
.todo-tree-toggle::before { content: "\25be"; }
.todo-tree-toggle.collapsed::before { content: "\25b8"; }
.todo-tree-toggle.empty { color: var(--text-4); }
.todo-tree-toggle.empty::before { content: ""; }
.todo-tree-status { background: var(--text-4); border-radius: 50%; flex: 0 0 7px; height: 7px; }
.todo-tree-status.status-queue { background: var(--accent); }
.todo-tree-status.status-in_progress { background: var(--text-2); }
.todo-tree-status.status-review { background: var(--text-3); }
.todo-tree-status.status-done { background: var(--success, var(--text-4)); }
.todo-tree-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-tree-number { color: var(--text-3); font-family: var(--mono, monospace); margin-right: 5px; }
.todo-tree-progress, .todo-tree-cost { color: var(--text-3); flex: 0 0 auto; font-family: var(--mono, monospace); font-size: 11px; }
.todo-tree-cost { margin-left: auto; }
.todo-tree-row.group .todo-tree-title { color: var(--text-2); }
</style>
