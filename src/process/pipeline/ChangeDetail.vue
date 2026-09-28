<script setup lang="ts">
import { computed, ref, watch } from "vue";
import StatusChip from "../atoms/StatusChip.vue";
import MetaChip from "../atoms/MetaChip.vue";
import Kicker from "../atoms/Kicker.vue";
import HintBar from "../atoms/HintBar.vue";
import ToolButton from "../atoms/ToolButton.vue";
import SectionCard from "../atoms/SectionCard.vue";
import FocusRowItem from "../atoms/FocusRowItem.vue";
import CollapsedCard from "../atoms/CollapsedCard.vue";
import PanelRow from "../atoms/PanelRow.vue";
import { useChange } from "./useChange";
import { changeAddress } from "./changeAdapt";
import { formatMoney } from "./adapt";

const props = withDefaults(defineProps<{ address: string; showGraph?: boolean; showHeading?: boolean }>(), { showGraph: false, showHeading: false });
const emit = defineEmits<{
    (e: "open", id: string): void;
    (e: "graph"): void;
}>();
const cc = useChange();
const tab = ref("delta");
const passedOpen = ref(false);

watch(() => props.address, (address) => cc.select(address), { immediate: true });
watch(tab, (value) => cc.setActiveTab(value), { immediate: true });

const budgetText = computed(() => {
    const ceiling = cc.current.value?.budget_usd;
    return ceiling !== undefined ? `лимит ${formatMoney(ceiling)}` : "лимит не задан";
});

const blockerLabel: Record<string, string> = {
    "spec-answer-missing": "нет ответа на спеку",
    "concurrent-change": "конкурентный change",
    "task-outcome-issue": "issue",
    "retry-exhausted": "retry исчерпан",
    "spec-silently-behind": "спека отстаёт",
};

const openTask = (n?: number) => {
    if (n) emit("open", `#${n}`);
};

const passedNote = computed(() =>
    cc.passed.value.length ? cc.passed.value.map((p) => p.label).join(" · ") : "нечего показать",
);
</script>

<template>
    <div class="change-detail">
        <HintBar v-if="!cc.live.value" icon="⚠" tone="warn" class="change-demo-hint">
            Приложение недоступно (invoke не отвечает) — показан фиксированный пример,
            а не доска.
        </HintBar>
        <HintBar v-else-if="cc.closeError.value" icon="✗" tone="warn" class="change-demo-hint">
            {{ cc.closeError.value }}
        </HintBar>

        <template v-if="!cc.current.value">
            <div class="change-empty">На доске нет ни одного change'а</div>
        </template>

        <template v-else>
            <div v-if="props.showHeading" class="change-title">
                <strong>CHANGE {{ changeAddress(cc.current.value) }} · {{ cc.current.value.title }}</strong>
                <StatusChip :text="budgetText" tone="cost" />
                <StatusChip :text="cc.open.value ? 'открыт' : 'закрыт'" :tone="cc.open.value ? 'default' : 'spec'" />
                <ToolButton v-if="props.showGraph" @click="emit('graph')">Открыть в графе</ToolButton>
            </div>
            <div class="change-tabs">
                <ToolButton v-for="item in [{ id: 'delta', label: 'Дельта' }, { id: 'tasks', label: 'Задачи' }, { id: 'feed', label: 'Лента' }, { id: 'spec', label: 'Спека' }]" :key="item.id" :active="tab === item.id" @click="tab = item.id">
                    {{ item.label }}<template v-if="item.id === 'tasks'"> {{ cc.members.value.length }}</template>
                </ToolButton>
            </div>
            <div class="metrics-row">
                <span v-if="tab === 'delta'" class="metric" :class="{ crit: cc.blockers.value.length }">
                    {{ cc.blockers.value.length }} {{ cc.blockers.value.length === 1 ? "блокер мешает" : "блокеров мешают" }} закрыть
                </span>
                <span v-if="tab === 'delta'" class="metric" :class="{ warn: cc.waiting.value.length }">{{ cc.waiting.value.length }} ждёт тебя</span>
                <span v-if="tab === 'delta'" class="metric ok">{{ cc.passed.value.length }} проверок пройдено</span>
                <span class="metric">прогресс {{ cc.progress.value.done }} / {{ cc.progress.value.total }} задач · {{ cc.edits.value }} правок спеки</span>
            </div>

            <div v-if="tab === 'delta'" class="change-columns">
                <section class="change-col">
                    <Kicker>Мешает закрыть</Kicker>
                    <div class="col-body">
                        <SectionCard v-for="b in cc.blockers.value" :key="b.id" :address="blockerLabel[b.rule] ?? b.rule" :title="b.title" :prose="b.detail" tone="warn">
                            <template #chips><ToolButton v-if="b.taskNumber" @click="openTask(b.taskNumber)">Открыть #{{ b.taskNumber }}</ToolButton></template>
                        </SectionCard>
                        <div v-if="!cc.blockers.value.length" class="change-empty-note">Ничего не мешает — по проверенным правилам блокеров нет</div>
                    </div>
                </section>
                <section class="change-col">
                    <Kicker>Ждёт тебя</Kicker>
                    <div class="col-body">
                        <FocusRowItem v-for="w in cc.waiting.value" :key="w.id" :id="`#${w.taskNumber}`" :title="w.subject" :count="w.note" kind="task" @click="openTask(w.taskNumber)" />
                        <div v-if="!cc.waiting.value.length" class="change-empty-note">Нет задач в review</div>
                    </div>
                    <div class="col-passed">
                        <CollapsedCard v-if="!passedOpen" :label="`Пройдено ${cc.passed.value.length}`" :note="passedNote" @click="passedOpen = true" />
                        <template v-else><Kicker>Пройдено</Kicker><PanelRow v-for="p in cc.passed.value" :key="p.id" icon="✓" :text="p.label" tone="ok" /><ToolButton class="collapse-back" @click="passedOpen = false">Свернуть</ToolButton></template>
                    </div>
                </section>
            </div>
            <div v-else-if="tab === 'tasks'" class="change-flat">
                <button v-for="row in cc.cost.value.rows" :key="row.taskNumber" class="task-row" type="button" @click="openTask(row.taskNumber)">
                    <span class="task-num">#{{ row.taskNumber }}</span><span class="task-subject">{{ row.subject }}</span><span class="task-cost" :class="{ unknown: !row.money.known }">{{ row.money.text }}</span>
                </button>
            </div>
            <div v-else-if="tab === 'feed'" class="change-flat"><PanelRow v-for="(e, i) in cc.history.value" :key="i" :text="e.label" :meta="e.at" mono /><div v-if="!cc.history.value.length" class="change-empty-note">Нет событий с датами</div></div>
            <div v-else class="change-flat">
                <SectionCard v-for="row in cc.specSummary.value" :key="row.address" :address="row.address" :title="`+${row.added} / -${row.removed} строк`" :tone="row.concurrent ? 'warn' : 'spec'"><template #chips><MetaChip v-for="t in row.tasks" :key="t.taskNumber" :tone="t.verdict ? 'ok' : 'muted'">#{{ t.taskNumber }} {{ t.verdict ?? "без ответа" }}</MetaChip></template></SectionCard>
                <div v-if="!cc.specSummary.value.length" class="change-empty-note">Ни change, ни его задачи не ссылаются на раздел спеки</div>
            </div>
        </template>
    </div>
</template>

<style scoped>
.change-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.change-title, .change-tabs, .metrics-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.change-title { font-size: 14px; }.metrics-row { padding: 10px 14px; border: 1px solid var(--stroke-strong); border-radius: var(--r-card); background: rgba(0,0,0,.18); }.metric { font-size: 12.5px; color: var(--text-3); }.metric.crit { color: var(--crit); font-weight: 600; }.metric.warn { color: var(--warn); font-weight: 600; }.metric.ok { color: var(--ok); }
.change-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.change-col, .col-body, .col-passed, .change-flat { display: flex; flex-direction: column; gap: 8px; min-width: 0; }.col-passed { margin-top: 6px; }.collapse-back { align-self: flex-start; }.change-empty, .change-empty-note { padding: 8px 4px; font-size: 12px; color: var(--text-4); }.task-row { display: grid; grid-template-columns: 48px 1fr auto; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: var(--node-bg); color: inherit; cursor: pointer; }.task-num, .task-cost { font-family: var(--mono); font-size: 11.5px; }.task-num { color: var(--text-4); }.task-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.task-cost { color: var(--high); }.task-cost.unknown { color: var(--text-4); }
</style>
