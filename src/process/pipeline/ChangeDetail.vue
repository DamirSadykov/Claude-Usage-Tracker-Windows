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
function isMeasureCommand(how: string) { return /^\s*\$?\s*(?:node|npm|npx|cargo|git|todos)\b/i.test(how); }
function measureCommand(how: string) { return how.trim().replace(/^\$\s*/, ""); }
function outRows(): ChangeOut[] { return current.value?.out ?? []; }
function measureRows(): ChangeMeasure[] { return current.value?.measure ?? []; }
const measureSummary = computed(() => {
    const rows = measureRows();
    const normal = rows.filter((measure) => measure.ok === true).length;
    const assessed = rows.filter((measure) => measure.ok === true || measure.ok === false).length;
    return assessed ? t("changeMeasureSummary", { normal, assessed }) : "";
});
function measureStatusText(measure: ChangeMeasure) {
    if (measure.ok === true) return t("changeMeasureOk");
    if (measure.ok === false) return t("changeMeasureOff");
    return t("changeMeasureUnmarked");
}
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
        <div v-if="measureRows().length" class="brief-measure"><div class="brief-heading bh">{{ t("changeMeasure") }} <span v-if="measureSummary" class="measure-summary">{{ measureSummary }}</span></div><table class="measure-table"><thead><tr><th>{{ t('changeMeasureMetricCommand') }}</th><th>{{ t('changeMeasureTarget') }}</th><th>{{ t('changeMeasureActual') }}</th></tr></thead><tbody><tr v-for="(item, index) in measureRows()" :key="`${item.what}-${index}`"><td class="measure-what"><span class="measure-status" :class="item.ok === true ? 'ok' : item.ok === false ? 'off' : 'pending'" :title="measureStatusText(item)" role="img" :aria-label="measureStatusText(item)" /><div><strong>{{ item.what }}</strong><code v-if="isMeasureCommand(item.how)">$ {{ measureCommand(item.how) }}</code><span v-else class="measure-how">{{ item.how }}</span></div></td><td class="measure-target">{{ item.target || '—' }}</td><td class="measure-fact" :class="item.ok === true ? 'ok' : item.ok === false ? 'off' : ''"><span>{{ factText(item) }}</span><small v-if="item.note" class="measure-note">{{ item.note }}</small></td></tr></tbody></table></div>
      </section>
      <div class="change-body">
        <section class="change-tasks" :aria-label="t('changeTasks')">
          <table v-if="taskRows.length" class="change-task-table"><colgroup><col class="task-status-col"><col class="task-number-col"><col><col class="task-kind-col"><col class="task-attempts-col"><col class="task-cost-col"><col class="task-time-col"></colgroup><thead><tr><th>{{ t('changeTaskStatus') }}</th><th>#</th><th>{{ t('changeTaskTitle') }}</th><th>{{ t('changeTaskKind') }}</th><th>{{ t('changeTaskAttempts') }}</th><th>$</th><th>{{ t('changeTaskTime') }}</th></tr></thead>
            <tbody><tr v-for="row in taskRows" :key="row.id" tabindex="0" @click="openTask(row.number)" @keyup.enter="openTask(row.number)"><td><span class="status-dot" :class="row.status"></span><span class="sr-only">{{ row.status }}</span></td><td class="task-num">#{{ row.number }}</td><td class="task-subject"><span>{{ row.subject }}</span><button class="trace-link" type="button" @click.stop="openTrace(row.number)">{{ t('changeTrace') }} ↗</button></td><td>{{ row.kind }}</td><td>{{ row.hasAttempts ? row.attempts : '' }}</td><td class="task-cost"><template v-if="row.cost !== null"><span class="cost-bar"><i :style="{ width: `${maxCost ? (row.cost / maxCost) * 100 : 0}%` }" /></span>{{ formatMoney(row.cost) }}</template></td><td>{{ row.duration === null ? '' : formatDuration(row.duration) }}</td></tr></tbody>
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
.measure-summary { margin-left: 8px; color: var(--text-3); font: 500 10.5px/1 var(--mono); letter-spacing: 0; text-transform: none; }.measure-table { border-collapse: collapse; table-layout: fixed; width: 100%; font-size: 12px; }.measure-table th { border-bottom: 1px solid var(--stroke-strong); color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .07em; padding: 7px; text-align: left; text-transform: uppercase; }.measure-table th:first-child { width: 50%; }.measure-table th:nth-child(2), .measure-table th:nth-child(3) { width: 25%; }.measure-table td { border-bottom: 1px solid var(--stroke); padding: 8px 7px; vertical-align: top; }.measure-what { display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 8px; }.measure-what strong, .measure-how, .measure-what code { display: block; }.measure-what strong { color: var(--text-2); font-weight: 600; }.measure-how { margin-top: 3px; color: var(--text-3); line-height: 1.35; }.measure-what code { margin-top: 4px; overflow: hidden; padding: 3px 5px; border-radius: 4px; background: var(--node-bg); color: var(--text-2); font: 11px/1.25 var(--mono); text-overflow: ellipsis; white-space: nowrap; }.measure-status { align-self: center; background: var(--text-4); border-radius: 50%; height: 7px; width: 7px; }.measure-status.ok { background: var(--ok); }.measure-status.off { background: var(--high); }.measure-target, .measure-fact { color: var(--text-4); font: 11.5px/1.35 var(--mono); }.measure-fact > span { color: var(--text-2); }.measure-fact.ok > span { color: var(--ok); }.measure-fact.off > span { color: var(--high); }.measure-note { display: block; margin-top: 3px; color: var(--text-4); font: 11px/1.3 var(--segoe); }
.change-body { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: start; }.change-tasks { min-width: 0; }.change-task-table { border-collapse: collapse; table-layout: fixed; width: 100%; font-size: 12px; }.task-status-col { width: 24px; }.task-number-col { width: 56px; }.task-kind-col { width: 80px; }.task-attempts-col { width: 90px; }.task-cost-col { width: 150px; }.task-time-col { width: 60px; }.change-task-table th { border-bottom: 1px solid var(--stroke-strong); color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .07em; padding: 8px 7px; text-align: left; text-transform: uppercase; }.change-task-table th:first-child, .change-task-table td:first-child { padding-left: 0; padding-right: 0; }.change-task-table td { border-bottom: 1px solid var(--stroke); color: var(--text-3); overflow: hidden; padding: 9px 7px; text-overflow: ellipsis; white-space: nowrap; }.change-task-table tbody tr { cursor: pointer; }.change-task-table tbody tr:hover { background: var(--accent-soft); }.task-num, .task-cost { font-family: var(--mono); font-size: 11.5px; white-space: nowrap; }.task-num { color: var(--text-4); }.task-subject { color: var(--text); }.task-subject > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.status-dot { background: var(--text-4); border-radius: 50%; display: inline-block; height: 7px; width: 7px; }.status-dot.done { background: var(--ok); }.status-dot.in_progress { background: var(--accent); }.status-dot.review { background: var(--warn); }.task-cost { color: var(--high); }.cost-bar { background: var(--stroke); display: inline-block; height: 3px; margin-right: 5px; vertical-align: middle; width: 30px; }.cost-bar i, .summary-bar i { background: var(--high); display: block; height: 100%; }.trace-link { background: transparent; border: 0; color: var(--accent); cursor: pointer; display: none; float: right; font: 500 11px/1 var(--mono); margin-left: 7px; padding: 0; }.change-task-table tr:hover .trace-link, .change-task-table tr:focus .trace-link { display: inline; }.change-summary { display: grid; gap: 10px; }.summary-card { background: var(--layer); border: 1px solid var(--stroke); border-radius: var(--r-card); display: grid; gap: 7px; padding: 11px; }.summary-card h3 { color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .08em; margin: 0; text-transform: uppercase; }.summary-card strong { color: var(--text); font: 600 12px/1.3 var(--mono); }.summary-card span { color: var(--text-3); font-size: 11px; }.summary-bar { background: var(--stroke); height: 5px; overflow: hidden; }.summary-card button { background: transparent; border: 0; color: var(--text-3); cursor: pointer; display: flex; font: 11px/1.35 var(--segoe); gap: 6px; justify-content: space-between; padding: 0; text-align: left; }.summary-card button:hover { color: var(--accent); }.summary-card button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.summary-card button b { color: var(--high); font: 500 11px/1.35 var(--mono); }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
@media (max-width: 680px) { .bgrid, .change-body { grid-template-columns: 1fr; }.measure-table th:first-child { width: 48%; }.measure-table th:nth-child(2), .measure-table th:nth-child(3) { width: 26%; }.change-tasks { overflow-x: auto; }.change-task-table { min-width: 610px; } }
</style>
