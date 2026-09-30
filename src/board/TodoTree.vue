<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { boardTreeSummary, visibleBoardTreeRows, type BoardTreeNode } from "./boardTree";

const props = withDefaults(defineProps<{
  tree: readonly BoardTreeNode[];
  selectedId?: string | null;
  searching?: boolean;
}>(), { selectedId: null, searching: false });

const emit = defineEmits<{
  select: [node: BoardTreeNode];
  "update:selectedId": [id: string | null];
  open: [node: BoardTreeNode];
}>();

const COLLAPSED_KEY = "todo-tree:collapsed";
const SELECTED_KEY = "todo-tree:selected";
const collapsed = ref<Set<string>>(new Set());
const manuallyExpanded = new Set<string>();
const completedChanges = ref<Set<string>>(new Set());
const localSelectedId = ref<string | null>(readSelected());
const root = ref<HTMLElement | null>(null);
const initialized = ref(false);
const selectedId = computed(() => props.selectedId ?? localSelectedId.value);
const shownCollapsed = computed(() => props.searching ? new Set([...collapsed.value].filter((id) => !completedChanges.value.has(id))) : collapsed.value);
const rows = computed(() => visibleBoardTreeRows(props.tree, shownCollapsed.value));
const summary = computed(() => boardTreeSummary(props.tree));
const { t } = useI18n();

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

function activate(node: BoardTreeNode): void {
  if (node.kind === "task") select(node);
  else toggle(node);
}

function toggle(node: BoardTreeNode): void {
  if (!node.children.length) return;
  const next = new Set(collapsed.value);
  if (next.has(node.id)) {
    next.delete(node.id);
    if (node.kind === "change" || node.kind === "legacy") manuallyExpanded.add(node.id);
  }
  else next.add(node.id);
  collapsed.value = next;
  persistCollapsed(next);
}

function expandAll(): void {
  const next = expandSelectedAncestors(props.tree, selectedId.value, new Set());
  collapsed.value = next;
  persistCollapsed(next);
}

function collapseAll(): void {
  const next = new Set<string>();
  const visit = (node: BoardTreeNode) => {
    if (node.kind !== "group" && node.children.length) next.add(node.id);
    node.children.forEach(visit);
  };
  props.tree.forEach(visit);
  const visibleSelection = expandSelectedAncestors(props.tree, selectedId.value, next);
  collapsed.value = visibleSelection;
  persistCollapsed(visibleSelection);
}

function toggleFromCaret(event: MouseEvent, node: BoardTreeNode): void {
  if (!node.children.length) return;
  event.stopPropagation();
  toggle(node);
}

function open(node: BoardTreeNode): void {
  if (node.kind === "task" || node.kind === "change" || node.kind === "legacy") emit("open", node);
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
  if (!tree.length) return;
  const complete = new Set<string>();
  const visit = (node: BoardTreeNode) => {
    if ((node.kind === "change" || node.kind === "legacy") && node.children.length && node.closed) complete.add(node.id);
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  if (!initialized.value) {
    const saved = readCollapsed();
    collapsed.value = expandSelectedAncestors(tree, selectedId.value, new Set([...complete, ...saved]));
    initialized.value = true;
  } else {
    const next = new Set(collapsed.value);
    for (const id of complete) {
      if (!completedChanges.value.has(id) && !manuallyExpanded.has(id)) next.add(id);
    }
    const visibleSelection = expandSelectedAncestors(tree, selectedId.value, next);
    if (visibleSelection.size !== collapsed.value.size || [...visibleSelection].some((id) => !collapsed.value.has(id))) {
      collapsed.value = visibleSelection;
      persistCollapsed(visibleSelection);
    }
  }
  completedChanges.value = complete;
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
    <div class="todo-tree-actions">
      <button type="button" @click="expandAll">{{ t('todoTreeExpandAll') }}</button>
      <button type="button" @click="collapseAll">{{ t('todoTreeCollapseAll') }}</button>
    </div>
    <div class="todo-tree-head">
      <span>{{ t('todoTreeColumns') }}</span><span>{{ t('todoTreeDone') }}</span><span>{{ t('todoTreeCost') }}</span>
    </div>
    <div class="todo-tree-rows">
      <button
        v-for="row in rows"
        :key="row.node.id"
        class="todo-tree-row"
        :class="{ selected: row.node.id === selectedId, closed: row.node.closed, group: row.node.kind === 'group', ungrouped: row.node.kind === 'ungrouped', change: row.node.kind === 'change', legacy: row.node.kind === 'legacy' }"
        :data-tree-id="row.node.id"
        :style="{ '--tree-depth': row.depth }"
        @click="activate(row.node)"
        @dblclick="open(row.node)"
      >
        <span class="todo-tree-toggle" :class="{ empty: !row.node.children.length, collapsed: shownCollapsed.has(row.node.id) }" @click="toggleFromCaret($event, row.node)"></span>
        <span class="todo-tree-title"><span v-if="row.node.status" class="todo-tree-status" :class="statusClass(row.node.status)"></span><span v-if="row.node.number !== null" class="todo-tree-number">{{ row.node.kind === 'change' || row.node.kind === 'legacy' ? 'c#' : '#' }}{{ row.node.number }}</span>{{ row.node.kind === 'ungrouped' ? t('todoTreeWithoutChange') : row.node.title }}</span>
        <span v-if="row.node.kind !== 'task' && row.node.kind !== 'ungrouped'" class="todo-tree-progress" :class="{ complete: row.node.progress.done === row.node.progress.total }">{{ row.node.progress.done }}/{{ row.node.progress.total }}</span>
        <span v-else></span>
        <span v-if="row.node.kind !== 'ungrouped'" class="todo-tree-cost">{{ cost(row.node.cost) }}</span>
        <span v-else></span>
        <span v-if="row.node.kind === 'change' || row.node.kind === 'legacy'" class="todo-tree-bar" aria-hidden="true"><i :style="{ width: `${row.node.progress.total ? row.node.progress.done / row.node.progress.total * 100 : 0}%` }"></i></span>
      </button>
    </div>
    <footer class="todo-tree-footer">{{ t('todoTreeSummary', { active: summary.active, total: summary.total, cost: cost(summary.cost) }) }}</footer>
  </nav>
</template>

<style scoped>
.todo-tree { min-width: 0; overflow: hidden; background: transparent; color: var(--text); display: flex; flex-direction: column; font-family: var(--segoe); outline: none; }
.todo-tree:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.todo-tree-actions { border-bottom: 1px solid var(--stroke); display: flex; gap: 6px; padding: 7px 10px; }
.todo-tree-actions button { background: transparent; border: 1px solid var(--stroke); border-radius: 3px; color: var(--text-3); cursor: pointer; font: 600 10px var(--segoe); padding: 3px 6px; }
.todo-tree-actions button:hover { background: var(--card-bg-hover); color: var(--text); }
.todo-tree-head { border-bottom: 1px solid var(--stroke); color: var(--text-4); display: grid; font-size: 10px; font-weight: 600; gap: 6px; grid-template-columns: minmax(0, 1fr) 62px 54px; letter-spacing: .09em; line-height: 1; padding: 8px 14px 7px 30px; text-transform: uppercase; }
.todo-tree-head span:not(:first-child) { text-align: right; }
.todo-tree-rows { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; }
.todo-tree-row { --tree-indent: calc(var(--tree-depth) * 16px); align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: grid; font-family: var(--segoe); font-size: 12.5px; gap: 6px; grid-template-columns: 14px minmax(0, 1fr) 62px 54px; height: 30px; padding: 0 14px 0 calc(10px + var(--tree-indent)); position: relative; text-align: left; width: 100%; }
.todo-tree-row:hover { background: var(--card-bg-hover); }
.todo-tree-row.selected { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.todo-tree-row.closed:not(.selected) { color: var(--text-3); }
.todo-tree-row.change.closed, .todo-tree-row.legacy.closed { opacity: .55; }
.todo-tree-toggle { color: var(--text-3); flex: 0 0 10px; font-size: 12px; text-align: center; }
.todo-tree-toggle::before { content: "\25be"; }
.todo-tree-toggle.collapsed::before { content: "\25b8"; }
.todo-tree-toggle.empty { color: var(--text-4); }
.todo-tree-toggle.empty::before { content: ""; }
.todo-tree-status { border-radius: 50%; box-sizing: border-box; display: inline-block; height: 8px; margin-right: 7px; vertical-align: middle; width: 8px; }
.todo-tree-status.status-queue { border: 1.5px solid var(--text-3); }
.todo-tree-status.status-in_progress { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.todo-tree-status.status-review { background: var(--tree-review); }
.todo-tree-status.status-done { background: var(--success); }
.todo-tree-status.status-backlog { border: 1.5px dashed var(--text-4); }
.todo-tree-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-tree-number { color: var(--text-3); font-family: var(--mono); margin-right: 5px; }
.todo-tree-row.selected .todo-tree-number { color: var(--accent); }
.todo-tree-progress, .todo-tree-cost { color: var(--text-4); font-family: var(--mono); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.todo-tree-progress.complete { color: var(--tree-complete); }
.todo-tree-cost { color: var(--tree-cost); }
.todo-tree-row.group .todo-tree-title { color: var(--text); font-family: var(--mono); font-size: 12px; font-weight: 600; }
.todo-tree-row.ungrouped .todo-tree-title { color: var(--text-4); font-family: var(--segoe); font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
.todo-tree-row.change .todo-tree-title, .todo-tree-row.legacy .todo-tree-title { font-weight: 500; }
.todo-tree-row.change .todo-tree-number, .todo-tree-row.legacy .todo-tree-number { color: var(--theme); }
.todo-tree-bar { background: var(--track); bottom: 3px; height: 2px; left: calc(40px + var(--tree-indent)); overflow: hidden; position: absolute; right: 14px; }
.todo-tree-bar i { background: var(--theme); display: block; height: 100%; opacity: .7; }
.todo-tree-footer { border-top: 1px solid var(--stroke); color: var(--text-4); font-family: var(--mono); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1; padding: 9px 14px; }
</style>
