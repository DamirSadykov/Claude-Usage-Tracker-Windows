<script setup lang="ts">
import { computed, watch } from "vue";
import { marked } from "marked";
import { useI18n } from "vue-i18n";
import HintBar from "../atoms/HintBar.vue";
import ToolButton from "../atoms/ToolButton.vue";
import { useChange } from "./useChange";
import { attemptsOf, changeAddress } from "./changeAdapt";
import { formatDuration, formatMoney, isDone } from "./adapt";
import type { BoardChange, ChangeMeasure, ChangeOut } from "../../contracts/board";

const props = withDefaults(defineProps<{ address: string; showGraph?: boolean; showHeading?: boolean }>(), { showGraph: false, showHeading: false });
const emit = defineEmits<{ (e: "open", id: string): void; (e: "trace", id: string): void; (e: "graph"): void; }>();
const cc = useChange();
const { t, locale } = useI18n();
watch(() => props.address, (address) => cc.select(address), { immediate: true });

const current = computed(() => cc.current.value as BoardChange | null);
const briefVisible = computed(() => Boolean(current.value?.delta || cc.members.value.length || current.value?.out?.length || current.value?.measure?.length));
const deltaHtml = computed(() => current.value?.delta ? marked.parse(current.value.delta) : "");
const costPartial = computed(() => cc.cost.value.known && cc.cost.value.unknownCount > 0);
const spentText = computed(() => cc.cost.value.known ? `${costPartial.value ? "≥ " : ""}${formatMoney(cc.cost.value.cost)}` : t("changeCostUnknown"));
const spentTitle = computed(() => costPartial.value ? t("changeCostPartial", { count: cc.cost.value.unknownCount }) : "");
const budgetText = computed(() => current.value?.budget_usd === undefined ? "—" : formatMoney(current.value.budget_usd));
const lifecycleText = computed(() => {
    const created = current.value?.created_at;
    if (!created || Number.isNaN(Date.parse(created))) return "";
    const start = new Date(created);
    const end = current.value?.closed_at && !Number.isNaN(Date.parse(current.value.closed_at)) ? new Date(current.value.closed_at) : new Date();
    const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
    const date = start.toLocaleDateString(locale.value === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "short" });
    return t("changeSince", { date, days });
});
function openTask(n?: number) { if (n) emit("open", `#${n}`); }
function openTrace(n?: number) { if (n) emit("trace", `#${n}`); }
function openRef(ref: string) { if (/^t#\d+$/i.test(ref)) emit("open", `#${ref.slice(2)}`); else if (/^c#\d+$/i.test(ref)) cc.select(ref); }
function isBoardRef(ref: string) { return /^(?:t|c)#\d+$/i.test(ref); }
function factText(measure: ChangeMeasure) { return measure.actual?.trim() || "—"; }
function outRows(): ChangeOut[] { return current.value?.out ?? []; }
function measureRows(): ChangeMeasure[] { return current.value?.measure ?? []; }
const taskRows = computed(() => {
    const nodes = new Map(cc.graph.value.nodes.map((node) => [node.id, node]));
    const members = cc.members.value as Array<{ id: string; number?: number; subject: string; status: string; kind?: string; depends_on?: string[]; status_history?: Array<{ status: string; at: string }> }>;
    const byId = new Map(members.map((task) => [task.id, task]));
    const ordered: typeof members = [];
    const seen = new Set<string>();
    const visit = (task: typeof members[number]) => {
        if (seen.has(task.id)) return;
        seen.add(task.id);
        for (const id of task.depends_on ?? []) { const dependency = byId.get(id); if (dependency) visit(dependency); }
        ordered.push(task);
    };
    for (const task of members) visit(task);
    return ordered.map((task) => {
        const node = nodes.get(task.id);
        const cost = node?.cost ?? node?.task_cost ?? null;
        return { ...task, cost, duration: node?.duration_minutes ?? null, attempts: attemptsOf(task), hasAttempts: Boolean(task.status_history?.length) };
    });
});
const hasKinds = computed(() => taskRows.value.some((row) => Boolean(row.kind)));
const hasAttempts = computed(() => taskRows.value.some((row) => row.hasAttempts));
const hasCosts = computed(() => taskRows.value.some((row) => row.cost !== null));
const hasDurations = computed(() => taskRows.value.some((row) => row.duration !== null));
const budgetRatio = computed(() => cc.cost.value.known && current.value?.budget_usd && current.value.budget_usd > 0 ? Math.min(1, cc.cost.value.cost / current.value.budget_usd) : 0);
const remainingBudget = computed(() => cc.cost.value.known ? Math.max(0, (current.value?.budget_usd ?? 0) - cc.cost.value.cost) : null);
const progressRatio = computed(() => cc.progress.value.total ? cc.progress.value.done / cc.progress.value.total : 0);
const remainingTasks = computed(() => taskRows.value.filter((row) => !isDone(row.status)).map((row) => `#${row.number}`).join(", "));
const expensiveTasks = computed(() => taskRows.value.filter((row) => row.cost !== null).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 3));
const maxCost = computed(() => Math.max(0, ...expensiveTasks.value.map((row) => row.cost ?? 0), ...taskRows.value.map((row) => row.cost ?? 0)));
</script>

<template>
  <div class="change-detail">
    <HintBar v-if="!cc.live.value" icon="⚠" tone="warn" class="change-demo-hint">{{ t("changeDemoUnavailable") }}</HintBar>
    <HintBar v-else-if="cc.closeError.value" icon="✗" tone="warn" class="change-demo-hint">{{ cc.closeError.value }}</HintBar>
    <template v-if="!current"><div class="change-empty">{{ t("changeEmpty") }}</div></template>
    <template v-else>
      <header v-if="props.showHeading" class="change-head head">
        <h2><span class="change-number n">{{ changeAddress(current) }}</span>{{ current.title }}</h2>
        <div class="change-meta meta">
          <span class="change-status stseg" :class="{ closed: !cc.open.value }">{{ cc.open.value ? t("changeOpen") : t("changeClosed") }}</span>
          <span class="change-chip chip change-chip-ok">{{ t("changeTasksProgress", { done: cc.progress.value.done, total: cc.progress.value.total }) }}</span>
          <span class="change-chip chip change-chip-money" :title="spentTitle">{{ spentText }} / {{ budgetText }}</span>
          <span v-if="lifecycleText" class="change-chip chip">{{ lifecycleText }}</span>
          <ToolButton v-if="props.showGraph" @click="emit('graph')">{{ t("changeOpenGraph") }}</ToolButton>
        </div>
      </header>
      <section v-if="briefVisible" class="change-brief brief" :aria-label="t('changeBrief')">
        <div v-if="current.delta" class="brief-delta"><div class="brief-heading bh">{{ t("changeWhy") }}</div><div class="brief-prose prose" v-html="deltaHtml" /></div>
        <div v-if="cc.members.value.length || outRows().length" class="bgrid">
          <div v-if="cc.members.value.length"><div class="brief-heading bh">{{ t("changeIncludes") }}</div><ul class="brief-list brief-includes ok"><li v-for="task in cc.members.value" :key="task.id" :class="{ y: isDone(task.status) }"><button type="button" @click="openTask(task.number)"><span class="brief-task-number">t#{{ task.number }}</span><span>{{ task.subject }}</span></button></li></ul></div>
          <div v-if="outRows().length"><div class="brief-heading bh">{{ t("changeExcludes") }}</div><ul class="brief-list brief-out no"><li v-for="(item, index) in outRows()" :key="`${item.what}-${index}`"><div>{{ item.what }}</div><small>{{ item.why }}</small><button v-if="item.ref && isBoardRef(item.ref)" class="brief-ref" type="button" @click="openRef(item.ref)">{{ item.ref }}</button><a v-else-if="item.ref" class="brief-ref" :href="item.ref" target="_blank" rel="noopener">{{ item.ref }}</a></li></ul></div>
        </div>
        <div v-if="measureRows().length" class="brief-measure"><div class="brief-heading bh">{{ t("changeMeasure") }}</div><div class="measure-list"><article v-for="(item, index) in measureRows()" :key="`${item.what}-${index}`" class="measure-row"><strong>{{ item.what }}</strong><span>{{ item.how }}</span><span v-if="item.target" class="measure-target">{{ t("changeTarget", { value: item.target }) }}</span><span class="measure-fact">{{ t("changeActual", { value: factText(item) }) }}</span></article></div></div>
      </section>
      <div class="change-body">
        <section class="change-tasks" :aria-label="t('changeTasks')">
          <table v-if="taskRows.length" class="change-task-table"><thead><tr><th>{{ t('changeTaskStatus') }}</th><th>#</th><th>{{ t('changeTaskTitle') }}</th><th v-if="hasKinds">{{ t('changeTaskKind') }}</th><th v-if="hasAttempts">{{ t('changeTaskAttempts') }}</th><th v-if="hasCosts">$</th><th v-if="hasDurations">{{ t('changeTaskTime') }}</th></tr></thead>
            <tbody><tr v-for="row in taskRows" :key="row.id" tabindex="0" @click="openTask(row.number)" @keyup.enter="openTask(row.number)"><td><span class="status-dot" :class="row.status"></span><span class="sr-only">{{ row.status }}</span></td><td class="task-num">#{{ row.number }}</td><td class="task-subject">{{ row.subject }}<button class="trace-link" type="button" @click.stop="openTrace(row.number)">{{ t('changeTrace') }} ↗</button></td><td v-if="hasKinds">{{ row.kind }}</td><td v-if="hasAttempts">{{ row.hasAttempts ? row.attempts : '' }}</td><td v-if="hasCosts" class="task-cost"><template v-if="row.cost !== null"><span class="cost-bar"><i :style="{ width: `${maxCost ? (row.cost / maxCost) * 100 : 0}%` }" /></span>{{ formatMoney(row.cost) }}</template></td><td v-if="hasDurations">{{ row.duration === null ? '' : formatDuration(row.duration) }}</td></tr></tbody>
          </table>
        </section>
        <aside class="change-summary">
          <section v-if="current.budget_usd !== undefined" class="summary-card"><h3>{{ t('changeBudget') }}</h3><strong :title="spentTitle">{{ spentText }} / {{ budgetText }}</strong><span>{{ remainingBudget === null ? t('changeRemainingUnknown') : t('changeRemaining', { value: `${costPartial ? "≤ " : ""}${formatMoney(remainingBudget)}` }) }}</span><div class="summary-bar"><i :style="{ width: `${budgetRatio * 100}%` }" /></div></section>
          <section class="summary-card"><h3>{{ t('changeProgress') }}</h3><strong>{{ t('changeTasksProgress', { done: cc.progress.value.done, total: cc.progress.value.total }) }}</strong><div class="summary-bar"><i :style="{ width: `${progressRatio * 100}%` }" /></div><span v-if="remainingTasks">{{ t('changeRemainingTasks', { tasks: remainingTasks }) }}</span></section>
          <section v-if="expensiveTasks.length" class="summary-card"><h3>{{ t('changeExpensiveTasks') }}</h3><button v-for="row in expensiveTasks" :key="row.id" type="button" @click="openTask(row.number)"><span>#{{ row.number }} {{ row.subject }}</span><b>{{ formatMoney(row.cost!) }}</b></button></section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.change-detail { font-family: var(--segoe); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.change-head { display: grid; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--stroke); }.change-head h2 { margin: 0; font: 600 18px/1.3 var(--segoe); color: var(--text); }.change-number { margin-right: 8px; font-family: var(--mono); color: var(--theme); }.change-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.change-status, .change-chip { padding: 4px 8px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); font: 500 11px/1 var(--mono); color: var(--text-3); }.change-status { color: var(--theme); background: var(--accent-soft); }.change-status.closed { color: var(--text-4); background: transparent; }.change-chip-ok { color: var(--ok); }.change-chip-money { color: var(--high); }
.change-brief { border: 1px solid var(--stroke); border-radius: var(--r-card); background: var(--layer); padding: 14px 16px; display: grid; gap: 14px; }.bgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; border-top: 1px solid var(--stroke); padding-top: 12px; }.brief-heading { margin-bottom: 7px; font: 600 10.5px/1 var(--segoe); letter-spacing: .09em; text-transform: uppercase; color: var(--text-4); }.brief-prose { max-width: 96ch; font-size: 13px; line-height: 1.6; color: var(--text-2); }.brief-prose :deep(p) { margin: 0 0 12px; }.brief-prose :deep(p:last-child), .brief-prose :deep(ul:last-child) { margin-bottom: 0; }.brief-prose :deep(p > strong:first-child) { display: block; margin-bottom: 3px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }.brief-prose :deep(ul) { margin: 0 0 12px; padding-left: 18px; display: grid; gap: 3px; }.brief-prose :deep(code) { padding: 1px 5px; border-radius: 4px; background: var(--node-bg); font-family: var(--mono); font-size: 12px; color: var(--text); }
.brief-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 5px; font: 400 13px/1.5 var(--segoe); color: var(--text-2); }.brief-list li { position: relative; min-width: 0; padding-left: 20px; }.brief-list li::before { position: absolute; left: 0; top: 0; content: "+"; font-family: var(--mono); color: var(--ok); }.brief-list.no li::before { content: "–"; color: var(--text-4); }.brief-list.no li { color: var(--text-3); }.brief-list.ok li::before { content: "○"; color: var(--text-4); }.brief-list.ok li.y::before { content: "✓"; color: var(--ok); }.brief-includes button, .brief-ref { border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }.brief-includes button:hover, .brief-ref:hover { color: var(--accent); }.brief-task-number, .brief-ref { margin-right: 6px; font: 600 11.5px/1 var(--mono); color: var(--theme); }.brief-out small { display: block; color: var(--text-4); }.brief-out .brief-ref { display: inline-block; margin-top: 4px; text-decoration: none; }.brief-measure { border-top: 1px solid var(--stroke); padding-top: 12px; }
.measure-list { display: grid; gap: 8px; }.measure-row { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(160px, 1.2fr) auto auto; align-items: baseline; gap: 8px 14px; font-size: 12.5px; color: var(--text-3); }.measure-row strong { color: var(--text-2); font-weight: 600; }.measure-target, .measure-fact { font-family: var(--mono); font-size: 11.5px; color: var(--text-4); }.measure-fact { color: var(--text-2); }
.change-body { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: start; }.change-task-table { border-collapse: collapse; width: 100%; font-size: 12px; }.change-task-table th { border-bottom: 1px solid var(--stroke-strong); color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .07em; padding: 8px 7px; text-align: left; text-transform: uppercase; }.change-task-table td { border-bottom: 1px solid var(--stroke); color: var(--text-3); padding: 9px 7px; }.change-task-table tbody tr { cursor: pointer; }.change-task-table tbody tr:hover { background: var(--accent-soft); }.task-num, .task-cost { font-family: var(--mono); font-size: 11.5px; white-space: nowrap; }.task-num { color: var(--text-4); }.task-subject { color: var(--text); max-width: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.status-dot { background: var(--text-4); border-radius: 50%; display: inline-block; height: 7px; width: 7px; }.status-dot.done { background: var(--ok); }.status-dot.in_progress { background: var(--accent); }.status-dot.review { background: var(--warn); }.task-cost { color: var(--high); }.cost-bar { background: var(--stroke); display: inline-block; height: 3px; margin-right: 5px; vertical-align: middle; width: 30px; }.cost-bar i, .summary-bar i { background: var(--high); display: block; height: 100%; }.trace-link { background: transparent; border: 0; color: var(--accent); cursor: pointer; display: none; float: right; font: 500 11px/1 var(--mono); }.change-task-table tr:hover .trace-link, .change-task-table tr:focus .trace-link { display: inline; }.change-summary { display: grid; gap: 10px; }.summary-card { background: var(--layer); border: 1px solid var(--stroke); border-radius: var(--r-card); display: grid; gap: 7px; padding: 11px; }.summary-card h3 { color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .08em; margin: 0; text-transform: uppercase; }.summary-card strong { color: var(--text); font: 600 12px/1.3 var(--mono); }.summary-card span { color: var(--text-3); font-size: 11px; }.summary-bar { background: var(--stroke); height: 5px; overflow: hidden; }.summary-card button { background: transparent; border: 0; color: var(--text-3); cursor: pointer; display: flex; font: 11px/1.35 var(--segoe); gap: 6px; justify-content: space-between; padding: 0; text-align: left; }.summary-card button:hover { color: var(--accent); }.summary-card button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.summary-card button b { color: var(--high); font: 500 11px/1.35 var(--mono); }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
@media (max-width: 680px) { .bgrid, .change-body { grid-template-columns: 1fr; }.measure-row { grid-template-columns: 1fr 1fr; }.measure-target, .measure-fact { grid-column: span 1; } }
</style>
