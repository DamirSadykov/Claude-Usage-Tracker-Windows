<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { marked } from "marked";
import { useI18n } from "vue-i18n";
import HintBar from "../atoms/HintBar.vue";
import { useChange } from "./useChange";
import { useBoard } from "./useBoard";
import LaneRow from "./views/LaneRow.vue";
import { attemptsOf, changeAddress } from "./changeAdapt";
import { formatMoney, isDone } from "./adapt";
import { visibleGraph } from "./visibleGraph";
import type { TaskNode } from "./types";
import type { BoardChange, ChangeMeasure, ChangeOut } from "../../contracts/board";

interface RetroProposal {
    id: string;
    type: string;
    addressee: string;
    what: string;
    measure: string | {
        cases?: string;
        baseline?: string;
        observe: string;
        source: string;
        fails_if: string;
    };
    episodes?: Array<{
        id: string;
        expected: string;
        observed: string;
        outcome?: string;
        detected_at?: string | null;
        detection_gap?: {
            observable?: string | null;
            recognized?: { signal?: string | null; by?: string | null };
            reached_user?: string | null;
        };
    }>;
    status?: "proposed" | "accepted" | "rejected";
    reason?: string;
}
type ChangeWithRetro = BoardChange & { ext?: { retro?: { proposals?: RetroProposal[] } } };

const props = withDefaults(defineProps<{ address: string; showHeading?: boolean }>(), { showHeading: false });
const emit = defineEmits<{ (e: "open", id: string): void; (e: "trace", id: string): void; }>();
const cc = useChange();
const cb = useBoard();
const { t, locale } = useI18n();
watch(() => props.address, (address) => cc.select(address), { immediate: true });

const current = computed(() => cc.current.value as ChangeWithRetro | null);
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
function openRef(ref: string) { if (/^t#\d+$/i.test(ref)) emit("open", `#${ref.slice(2)}`); else if (/^c#\d+$/i.test(ref)) cc.select(ref); }
function isBoardRef(ref: string) { return /^(?:t|c)#\d+$/i.test(ref); }
function factText(measure: ChangeMeasure) { return measure.actual?.trim() || "—"; }
function isMeasureCommand(how: string) { return /^\s*\$?\s*(?:node|npm|npx|cargo|git|todos)\b/i.test(how); }
function measureCommand(how: string) { return how.trim().replace(/^\$\s*/, ""); }
function outRows(): ChangeOut[] { return current.value?.out ?? []; }
function measureRows(): ChangeMeasure[] { return current.value?.measure ?? []; }
const proposalRows = computed(() => current.value?.ext?.retro?.proposals ?? []);
const changeTab = ref<"overview" | "proposals">("overview");
watch(() => current.value?.id, () => { changeTab.value = "overview"; });
function proposalStatus(status: RetroProposal["status"]) {
    return t(status === "accepted" ? "changeProposalAccepted" : status === "rejected" ? "changeProposalRejected" : "changeProposalProposed");
}
const proposalRoleKeys: Record<string, string> = {
  architect: "changeRoleArchitect",
  critic: "changeRoleCritic",
  worker: "changeRoleWorker",
  review: "changeRoleReview",
  human: "changeRoleHuman",
};
const proposalTypeKeys: Record<string, string> = {
  process: "changeProposalTypeProcess",
  project_invariant: "changeProposalTypeInvariant",
};
function proposalType(type: string) {
    const key = proposalTypeKeys[type];
    return key ? t(key) : type;
}
const deciding = ref<{ id: string; status: "accepted" | "rejected"; reason: string } | null>(null);
function startDecision(id: string, status: "accepted" | "rejected") {
    deciding.value = { id, status, reason: "" };
}
async function confirmDecision() {
    const d = deciding.value;
    if (!d) return;
    const reason = d.reason.trim() || t(d.status === "accepted" ? "changeProposalAccepted" : "changeProposalRejected");
    await cc.setProposal(d.id, d.status, reason);
    deciding.value = null;
}
function proposalAddressee(addressee: string) {
    const key = proposalRoleKeys[addressee];
    return key ? t(key) : addressee;
}
function episodeDetectedAt(episode: NonNullable<RetroProposal["episodes"]>[number]) {
    if (!episode.detected_at) return "—";
    const timestamp = Date.parse(episode.detected_at);
    if (Number.isNaN(timestamp)) return episode.detected_at;
    return new Date(timestamp).toLocaleString(locale.value === "ru" ? "ru-RU" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}
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
const renderIndex = computed(() => {
    if (cb.live.value) return cb.projection.value;
    const change = current.value;
    return visibleGraph(
        0,
        cc.members.value,
        change ? [change] : [],
        new Map(cc.graph.value.nodes.map((node) => [node.id, node])),
    );
});
const changeTasks = computed(() => current.value ? renderIndex.value.tasksByLane.get(current.value.id) ?? [] : []);
const changeWaves = computed(() => current.value ? renderIndex.value.wavesByLane.get(current.value.id) ?? [] : []);
const changeCardsByWave = computed<ReadonlyMap<number, readonly TaskNode[]>>(() =>
    current.value
        ? renderIndex.value.tasksByLaneWave.get(current.value.id) ?? new Map<number, readonly TaskNode[]>()
        : new Map<number, readonly TaskNode[]>(),
);
const changeLinks = computed(() => {
    const ids = new Set(changeTasks.value.map((task) => task.id));
    return renderIndex.value.links
        .filter((link) => ids.has(link.from) && ids.has(link.to))
        .map((link) => ({ ...link, tone: "dep" }));
});
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
        </div>
      </header>
      <div class="change-body">
        <div class="change-main">
      <div v-if="proposalRows.length" class="change-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="changeTab === 'overview'" :class="{ active: changeTab === 'overview' }" @click="changeTab = 'overview'">{{ t('changeTabOverview') }}</button>
        <button type="button" role="tab" :aria-selected="changeTab === 'proposals'" :class="{ active: changeTab === 'proposals' }" @click="changeTab = 'proposals'">{{ t('changeProposals') }} <span>{{ proposalRows.length }}</span></button>
      </div>
      <section v-if="briefVisible && changeTab === 'overview'" class="change-brief brief" :aria-label="t('changeBrief')">
        <div v-if="current.delta" class="brief-delta"><div class="brief-heading bh">{{ t("changeWhy") }}</div><div class="brief-prose prose" v-html="deltaHtml" /></div>
        <div v-if="cc.members.value.length || outRows().length" class="bgrid">
          <div v-if="cc.members.value.length"><div class="brief-heading bh">{{ t("changeIncludes") }}</div><ul class="brief-list brief-includes ok"><li v-for="task in cc.members.value" :key="task.id" :class="{ y: isDone(task.status) }"><button type="button" @click="openTask(task.number)"><span class="brief-task-number">t#{{ task.number }}</span><span>{{ task.subject }}</span></button></li></ul></div>
          <div v-if="outRows().length"><div class="brief-heading bh">{{ t("changeExcludes") }}</div><ul class="brief-list brief-out no"><li v-for="(item, index) in outRows()" :key="`${item.what}-${index}`"><div>{{ item.what }}</div><small>{{ item.why }}</small><button v-if="item.ref && isBoardRef(item.ref)" class="brief-ref" type="button" @click="openRef(item.ref)">{{ item.ref }}</button><a v-else-if="item.ref" class="brief-ref" :href="item.ref" target="_blank" rel="noopener">{{ item.ref }}</a></li></ul></div>
        </div>
        <div v-if="measureRows().length" class="brief-measure"><div class="brief-heading bh">{{ t("changeMeasure") }} <span v-if="measureSummary" class="measure-summary">{{ measureSummary }}</span></div><table class="measure-table"><thead><tr><th>{{ t('changeMeasureMetricCommand') }}</th><th>{{ t('changeMeasureTarget') }}</th><th>{{ t('changeMeasureActual') }}</th></tr></thead><tbody><tr v-for="(item, index) in measureRows()" :key="`${item.what}-${index}`"><td class="measure-what"><span class="measure-status" :class="item.ok === true ? 'ok' : item.ok === false ? 'off' : 'pending'" :title="measureStatusText(item)" role="img" :aria-label="measureStatusText(item)" /><div><strong>{{ item.what }}</strong><code v-if="isMeasureCommand(item.how)">$ {{ measureCommand(item.how) }}</code><span v-else class="measure-how">{{ item.how }}</span></div></td><td class="measure-target">{{ item.target || '—' }}</td><td class="measure-fact" :class="item.ok === true ? 'ok' : item.ok === false ? 'off' : ''"><span>{{ factText(item) }}</span><small v-if="item.note" class="measure-note">{{ item.note }}</small></td></tr></tbody></table></div>
          </section>
        <section v-if="proposalRows.length && changeTab === 'proposals'" class="change-proposals" :aria-label="t('changeProposals')">
          <div class="brief-heading">{{ t('changeProposals') }}</div>
          <article v-for="proposal in proposalRows" :key="proposal.id" class="proposal-card">
            <div class="proposal-head"><span class="proposal-type">{{ proposalType(proposal.type) }}</span><span class="proposal-status" :class="proposal.status || 'proposed'">{{ proposalStatus(proposal.status) }}</span></div>
            <strong>{{ proposal.what }}</strong>
            <dl class="proposal-details"><div><dt>{{ t('changeProposalAddressee') }}</dt><dd>{{ proposalAddressee(proposal.addressee) }}</dd></div><div v-if="typeof proposal.measure === 'string'"><dt>{{ t('changeProposalMeasure') }}</dt><dd>{{ proposal.measure }}</dd></div></dl>
            <div v-if="typeof proposal.measure !== 'string'" class="proposal-measure">
              <div class="proposal-subheading">{{ t('changeProposalMeasure') }}</div>
              <dl><div><dt>{{ t('changeProposalObserve') }}</dt><dd>{{ proposal.measure.observe }}</dd></div><div><dt>{{ t('changeProposalSource') }}</dt><dd>{{ proposal.measure.source }}</dd></div><div><dt>{{ t('changeProposalFailsIf') }}</dt><dd>{{ proposal.measure.fails_if }}</dd></div></dl>
            </div>
            <div v-for="episode in proposal.episodes || []" :key="episode.id" class="proposal-episode">
              <div class="proposal-subheading">{{ t('changeProposalEpisode') }} <span>{{ episode.id }}</span></div>
              <dl><div><dt>{{ t('changeProposalExpected') }}</dt><dd>{{ episode.expected }}</dd></div><div><dt>{{ t('changeProposalObserved') }}</dt><dd>{{ episode.observed }}</dd></div><div><dt>{{ t('changeProposalDetectedAt') }}</dt><dd>{{ episodeDetectedAt(episode) }}</dd></div></dl>
            </div>
            <small v-if="proposal.reason" class="proposal-reason">{{ proposal.reason }}</small>
            <div v-if="cc.live.value && (proposal.status || 'proposed') === 'proposed'" class="proposal-actions">
              <template v-if="deciding && deciding.id === proposal.id">
                <input v-model="deciding.reason" class="proposal-reason-input" :placeholder="t('changeProposalReason')" @keydown.enter="confirmDecision" @keydown.esc="deciding = null">
                <button type="button" class="proposal-btn primary" @click="confirmDecision">{{ t(deciding.status === 'accepted' ? 'changeProposalAccept' : 'changeProposalReject') }}</button>
                <button type="button" class="proposal-btn" @click="deciding = null">{{ t('changeProposalCancel') }}</button>
              </template>
              <template v-else>
                <button type="button" class="proposal-btn accept" @click="startDecision(proposal.id, 'accepted')">{{ t('changeProposalAccept') }}</button>
                <button type="button" class="proposal-btn reject" @click="startDecision(proposal.id, 'rejected')">{{ t('changeProposalReject') }}</button>
              </template>
            </div>
          </article>
        </section>
        <section v-show="changeTab === 'overview'" class="change-tasks" :aria-label="t('changeTasks')">
          <div class="change-lane-wrap">
            <LaneRow
              v-if="changeTasks.length"
              :lane-id="current.id"
              :waves="changeWaves"
              :cards-by-wave="changeCardsByWave"
              :links="changeLinks"
              cost-layer
              @pick="emit('open', $event)"
              @open="emit('open', $event)"
            />
          </div>
        </section>
        </div>
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
.proposal-actions { display: flex; gap: 6px; align-items: center; }.proposal-reason-input { flex: 1; min-width: 0; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: var(--layer); color: var(--text); font: 12px/1.3 var(--segoe); padding: 4px 7px; }.proposal-btn { border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: transparent; color: var(--text-2); cursor: pointer; font: 500 11.5px/1 var(--segoe); padding: 5px 9px; }.proposal-btn.accept { color: var(--ok); }.proposal-btn.reject { color: var(--high); }.proposal-btn.primary { border-color: var(--accent); color: var(--text); }.change-tabs { border-bottom: 1px solid var(--stroke); display: flex; gap: 16px; }.change-tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--text-3); cursor: pointer; font-family: var(--segoe); padding: 8px 1px; }.change-tabs button.active { border-bottom-color: var(--accent); color: var(--text); }.change-tabs span { color: var(--text-4); font-family: var(--mono); }.change-proposals { border: 1px solid var(--stroke); border-radius: var(--r-card); background: var(--layer); padding: 14px 16px; }.proposal-card { display: grid; gap: 9px; padding: 11px 0; border-top: 1px solid var(--stroke); }.proposal-card:first-of-type { border-top: 0; padding-top: 3px; }.proposal-head { display: flex; gap: 7px; align-items: center; }.proposal-type, .proposal-status { border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); padding: 3px 6px; color: var(--text-3); font: 500 10px/1 var(--mono); }.proposal-status.accepted { color: var(--ok); }.proposal-status.rejected { color: var(--high); }.proposal-card > strong { color: var(--text-2); font: 600 13px/1.4 var(--segoe); }.proposal-card dl { display: grid; gap: 5px; margin: 0; }.proposal-card dl > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 8px; }.proposal-card dt { color: var(--text-4); font: 600 10px/1.4 var(--segoe); text-transform: uppercase; }.proposal-card dd { margin: 0; color: var(--text-3); font: 11.5px/1.4 var(--segoe); }.proposal-subheading { color: var(--text-4); font: 600 10px/1.4 var(--segoe); letter-spacing: .06em; text-transform: uppercase; }.proposal-subheading span { margin-left: 4px; color: var(--theme); font-family: var(--mono); letter-spacing: 0; text-transform: none; }.proposal-measure, .proposal-episode { display: grid; gap: 6px; border-left: 2px solid var(--stroke-strong); padding: 7px 9px; background: var(--node-bg); }.proposal-episode { border-left-color: var(--theme); }.proposal-reason { color: var(--text-4); font: 11px/1.35 var(--segoe); }
.change-body { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: start; }.change-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }.change-tasks { min-width: 0; }.change-lane-wrap { min-width: 0; overflow-x: auto; padding-bottom: 4px; }.summary-bar i { background: var(--high); display: block; height: 100%; }.change-summary { display: grid; gap: 10px; min-width: 0; }.summary-card { background: var(--layer); border: 1px solid var(--stroke); border-radius: var(--r-card); display: grid; gap: 7px; grid-template-columns: minmax(0, 1fr); min-width: 0; padding: 11px; }.summary-card h3 { color: var(--text-4); font: 600 10px/1 var(--segoe); letter-spacing: .08em; margin: 0; text-transform: uppercase; }.summary-card strong { color: var(--text); font: 600 12px/1.3 var(--mono); }.summary-card span { color: var(--text-3); font-size: 11px; }.summary-bar { background: var(--stroke); height: 5px; overflow: hidden; }.summary-card button { background: transparent; border: 0; color: var(--text-3); cursor: pointer; display: flex; font: 11px/1.35 var(--segoe); gap: 6px; justify-content: space-between; padding: 0; text-align: left; }.summary-card button:hover { color: var(--accent); }.summary-card button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.summary-card button b { flex: none; color: var(--high); font: 500 11px/1.35 var(--mono); }
@media (max-width: 900px) { .change-body { grid-template-columns: 1fr; } }
@media (max-width: 680px) { .bgrid { grid-template-columns: 1fr; }.measure-table th:first-child { width: 48%; }.measure-table th:nth-child(2), .measure-table th:nth-child(3) { width: 26%; }}
</style>
