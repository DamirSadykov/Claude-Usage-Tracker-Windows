<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { BoardChange } from "../contracts/board";
import type { BoardTreeNode } from "./boardTree";
import type { BoardRow } from "./boardStore";

const props = defineProps<{
  change: BoardChange;
  node: BoardTreeNode;
  rows: readonly BoardRow[];
}>();

const emit = defineEmits<{
  "select-task": [BoardRow];
  "open-graph": [BoardChange];
}>();

const { t } = useI18n();

const members = computed(() => {
  const rowsById = new Map(props.rows.map((row) => [row.id, row]));
  return props.node.children
    .map((node) => ({ row: rowsById.get(node.id), cost: node.cost }))
    .filter((member): member is { row: BoardRow; cost: number } => !!member.row);
});

const spent = computed(() => props.node.cost);
const budget = computed(() => Number.isFinite(props.change.budget_usd) ? props.change.budget_usd ?? 0 : 0);
const budgetRatio = computed(() => budget.value > 0 ? Math.min(100, spent.value / budget.value * 100) : 0);

function statusLabel(status: string): string {
  const keys: Record<string, string> = {
    backlog: "colBacklog",
    queue: "colQueue",
    in_progress: "statusInProgress",
    review: "colReview",
    done: "statusDone",
  };
  return keys[status] ? t(keys[status]) : status;
}

function formatCost(cost: number): string {
  return "$" + (cost >= 100 ? Math.round(cost) : cost.toFixed(2));
}
</script>

<template>
  <section class="cdp-pane">
    <header class="cdp-header">
      <h2><span class="cdp-number">c#{{ change.number }}</span>{{ change.title }}</h2>
      <button class="cdp-graph" type="button" @click="emit('open-graph', change)">
        {{ t("viewGraph") }}
      </button>
    </header>

    <details v-if="change.delta" class="cdp-vision">
      <summary>{{ t("todoDescription") }}</summary>
      <p>{{ change.delta }}</p>
    </details>

    <div class="cdp-metrics">
      <div class="cdp-metric">
        <span>{{ node.progress.done }}/{{ node.progress.total }}</span>
        <div class="cdp-progress" role="progressbar" :aria-valuenow="node.progress.done" :aria-valuemax="node.progress.total">
          <i :style="{ width: node.progress.total ? (node.progress.done / node.progress.total * 100) + '%' : '0%' }"></i>
        </div>
      </div>
      <div class="cdp-budget">
        <span>{{ formatCost(spent) }} / {{ formatCost(budget) }}</span>
        <div v-if="budget > 0" class="cdp-progress" role="progressbar" :aria-valuenow="spent" :aria-valuemax="budget">
          <i :class="{ over: spent > budget }" :style="{ width: budgetRatio + '%' }"></i>
        </div>
      </div>
    </div>

    <div class="cdp-list" :aria-label="t('tasks')">
      <button
        v-for="member in members"
        :key="member.row.id"
        class="cdp-task"
        :class="{ done: member.row.status === 'done' }"
        type="button"
        @click="emit('select-task', member.row)"
      >
        <span class="cdp-task-status">{{ statusLabel(member.row.status) }}</span>
        <span class="cdp-task-title"><b>#{{ member.row.number }}</b>{{ member.row.subject }}</span>
        <span class="cdp-task-cost">{{ formatCost(member.cost) }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.cdp-pane { display: grid; gap: 16px; min-width: 0; padding: 20px; color: var(--text, #e8e8e8); }
.cdp-header { display: flex; align-items: start; gap: 12px; }
.cdp-header h2 { flex: 1; margin: 0; font-size: 18px; line-height: 1.35; }
.cdp-number { margin-right: 7px; color: var(--accent, #8ba8ff); font-variant-numeric: tabular-nums; }
.cdp-graph { border: 1px solid var(--border, #3e4655); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; padding: 6px 9px; white-space: nowrap; }
.cdp-graph:hover { border-color: var(--accent, #8ba8ff); color: var(--accent, #8ba8ff); }
.cdp-vision { border: 1px solid var(--border, #3e4655); border-radius: 6px; padding: 8px 10px; }
.cdp-vision summary { cursor: pointer; color: var(--muted, #aab1bd); }
.cdp-vision p { margin: 10px 0 2px; white-space: pre-wrap; line-height: 1.45; }
.cdp-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.cdp-metric, .cdp-budget { display: grid; gap: 6px; font-variant-numeric: tabular-nums; }
.cdp-progress { height: 5px; overflow: hidden; border-radius: 999px; background: var(--border, #3e4655); }
.cdp-progress i { display: block; height: 100%; border-radius: inherit; background: var(--accent, #8ba8ff); }
.cdp-progress i.over { background: #db6d6d; }
.cdp-list { display: grid; border-top: 1px solid var(--border, #3e4655); }
.cdp-task { display: grid; grid-template-columns: minmax(88px, auto) minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; border: 0; border-bottom: 1px solid var(--border, #3e4655); background: transparent; color: inherit; cursor: pointer; padding: 10px 2px; text-align: left; }
.cdp-task:hover { background: color-mix(in srgb, var(--accent, #8ba8ff) 10%, transparent); }
.cdp-task.done { color: var(--muted, #8f96a1); }
.cdp-task-status { font-size: 12px; }
.cdp-task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdp-task-title b { margin-right: 6px; font-weight: 500; }
.cdp-task-cost { font-size: 12px; font-variant-numeric: tabular-nums; }
@media (max-width: 520px) { .cdp-metrics { grid-template-columns: 1fr; } .cdp-task { grid-template-columns: 1fr auto; } .cdp-task-status { grid-column: 1 / -1; } }
</style>
