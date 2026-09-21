<script setup lang="ts">
import { computed, ref } from "vue";
import AppBar from "../../atoms/AppBar.vue";
import SegControl from "../../atoms/SegControl.vue";
import StatusChip from "../../atoms/StatusChip.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import Kicker from "../../atoms/Kicker.vue";
import HintBar from "../../atoms/HintBar.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SectionCard from "../../atoms/SectionCard.vue";
import FocusRowItem from "../../atoms/FocusRowItem.vue";
import CollapsedCard from "../../atoms/CollapsedCard.vue";
import PanelRow from "../../atoms/PanelRow.vue";
import { useChange } from "../useChange";
import { changeAddress } from "../changeAdapt";
import { formatMoney } from "../adapt";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: true });

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "rings" | "specs" | "reader" | "review" | "change"): void;
    (e: "open", id: string): void;
}>();

const cc = useChange();

const tab = ref("delta");
const passedOpen = ref(false);

const address = computed(() => (cc.current.value ? changeAddress(cc.current.value) : ""));
const headline = computed(() =>
    cc.current.value ? `CHANGE ${address.value} · ${cc.current.value.title}` : "CHANGE",
);

const budgetText = computed(() => {
    const c = cc.cost.value;
    const fact = c.known ? formatMoney(c.cost) : "неизвестно";
    const ceiling = cc.current.value?.budget_usd;
    const base = ceiling !== undefined ? `${fact} / $${ceiling}` : fact;
    return c.unknownCount ? `${base} · ${c.unknownCount} без замера` : base;
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
    <AppBar v-if="chrome" :title="headline">
        <template #modes>
            <SegControl
                v-model="tab"
                :options="[
                    { id: 'delta', label: 'Дельта' },
                    { id: 'tasks', label: 'Задачи', count: cc.members.value.length },
                    { id: 'feed', label: 'Лента' },
                    { id: 'spec', label: 'Спека' },
                ]"
            />
        </template>
        <template #center>
            <StatusChip v-if="cc.current.value" :text="budgetText" tone="cost" />
            <StatusChip
                v-if="cc.current.value"
                :text="cc.open.value ? 'открыт' : 'закрыт'"
                :tone="cc.open.value ? 'default' : 'spec'"
            />
        </template>
        <template #right>
            <SegControl
                :model-value="'change'"
                :options="[
                    { id: 'graph', label: 'Граф' },
                    { id: 'specs', label: 'Спеки' },
                    { id: 'change', label: 'Change' },
                ]"
                @update:model-value="
                    (value: string) => emit('mode', value === 'specs' ? 'reader' : value === 'change' ? 'change' : 'lanes')
                "
            />
            <div class="change-picker">
                <MetaChip
                    v-for="c in cc.changes.value"
                    :key="c.id"
                    class="picker-chip"
                    :tone="changeAddress(c) === address ? 'spec' : 'muted'"
                    @click="cc.select(changeAddress(c))"
                >
                    {{ changeAddress(c) }}
                </MetaChip>
            </div>
            <ToolButton
                v-if="cc.current.value && cc.live.value"
                variant="warn"
                :active="cc.closing.value"
                @click="cc.closeChange()"
            >
                Закрыть change
            </ToolButton>
        </template>
    </AppBar>

    <div class="pipe-canvas plain change-shell">
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
            <div class="metrics-row">
                <span class="metric" :class="{ crit: cc.blockers.value.length }">
                    {{ cc.blockers.value.length }} {{ cc.blockers.value.length === 1 ? "блокер мешает" : "блокеров мешают" }} закрыть
                </span>
                <span class="metric" :class="{ warn: cc.waiting.value.length }">
                    {{ cc.waiting.value.length }} ждёт тебя
                </span>
                <span class="metric ok">{{ cc.passed.value.length }} проверок пройдено</span>
                <span class="metric">
                    прогресс {{ cc.progress.value.done }} / {{ cc.progress.value.total }} задач
                    · {{ cc.edits.value }} правок спеки
                </span>
            </div>

            <div v-if="tab === 'delta'" class="change-columns">
                <section class="change-col col-blockers">
                    <Kicker>Мешает закрыть</Kicker>
                    <div class="col-body">
                        <SectionCard
                            v-for="b in cc.blockers.value"
                            :key="b.id"
                            :address="blockerLabel[b.rule] ?? b.rule"
                            :title="b.title"
                            :prose="b.detail"
                            tone="warn"
                        >
                            <template #chips>
                                <ToolButton v-if="b.taskNumber" @click="openTask(b.taskNumber)">
                                    Открыть #{{ b.taskNumber }}
                                </ToolButton>
                            </template>
                        </SectionCard>
                        <div v-if="!cc.blockers.value.length" class="change-empty-note">
                            Ничего не мешает — по проверенным правилам блокеров нет
                        </div>
                    </div>
                </section>

                <section class="change-col col-waiting">
                    <Kicker>Ждёт тебя</Kicker>
                    <div class="col-body">
                        <FocusRowItem
                            v-for="w in cc.waiting.value"
                            :key="w.id"
                            :id="`#${w.taskNumber}`"
                            :title="w.subject"
                            :count="w.note"
                            kind="task"
                            @click="openTask(w.taskNumber)"
                        />
                        <div v-if="!cc.waiting.value.length" class="change-empty-note">
                            Нет задач в review
                        </div>
                    </div>
                    <div class="col-passed">
                        <CollapsedCard
                            v-if="!passedOpen"
                            :label="`Пройдено ${cc.passed.value.length}`"
                            :note="passedNote"
                            @click="passedOpen = true"
                        />
                        <template v-else>
                            <Kicker>Пройдено</Kicker>
                            <PanelRow
                                v-for="p in cc.passed.value"
                                :key="p.id"
                                icon="✓"
                                :text="p.label"
                                tone="ok"
                            />
                            <ToolButton class="collapse-back" @click="passedOpen = false">
                                Свернуть
                            </ToolButton>
                        </template>
                    </div>
                </section>

                <section class="change-col col-spec">
                    <Kicker>Спека</Kicker>
                    <div class="col-body">
                        <SectionCard
                            v-for="row in cc.specSummary.value"
                            :key="row.address"
                            :address="row.address"
                            :title="`+${row.added} / -${row.removed} строк`"
                            :tone="row.concurrent ? 'warn' : 'spec'"
                        >
                            <template #chips>
                                <MetaChip
                                    v-for="t in row.tasks"
                                    :key="t.taskNumber"
                                    :tone="t.verdict ? 'ok' : 'muted'"
                                >
                                    #{{ t.taskNumber }} {{ t.verdict ?? "без ответа" }}
                                </MetaChip>
                                <MetaChip v-if="row.concurrent" tone="warn">
                                    делит с {{ row.openOthers.join(", ") }}
                                </MetaChip>
                            </template>
                        </SectionCard>
                        <div v-if="!cc.specSummary.value.length" class="change-empty-note">
                            Ни change, ни его задачи не ссылаются на раздел спеки
                        </div>
                    </div>

                    <Kicker class="history-kicker">История change'а</Kicker>
                    <div class="col-body history-body">
                        <PanelRow
                            v-for="(e, i) in cc.history.value.slice(0, 12)"
                            :key="i"
                            :text="e.label"
                            :meta="e.at.slice(0, 10)"
                            mono
                        />
                        <div v-if="!cc.history.value.length" class="change-empty-note">
                            Нет событий с датами
                        </div>
                    </div>
                </section>
            </div>

            <div v-else-if="tab === 'tasks'" class="change-flat">
                <div v-for="row in cc.cost.value.rows" :key="row.taskNumber" class="task-row">
                    <span class="task-num">#{{ row.taskNumber }}</span>
                    <span class="task-subject">{{ row.subject }}</span>
                    <span class="task-cost" :class="{ unknown: !row.money.known }">
                        {{ row.money.text }}
                    </span>
                </div>
            </div>

            <div v-else-if="tab === 'feed'" class="change-flat">
                <PanelRow
                    v-for="(e, i) in cc.history.value"
                    :key="i"
                    :text="e.label"
                    :meta="e.at"
                    mono
                />
                <div v-if="!cc.history.value.length" class="change-empty-note">
                    Нет событий с датами
                </div>
            </div>

            <div v-else class="change-flat">
                <SectionCard
                    v-for="row in cc.specSummary.value"
                    :key="row.address"
                    :address="row.address"
                    :title="`+${row.added} / -${row.removed} строк`"
                    :tone="row.concurrent ? 'warn' : 'spec'"
                >
                    <template #chips>
                        <MetaChip
                            v-for="t in row.tasks"
                            :key="t.taskNumber"
                            :tone="t.verdict ? 'ok' : 'muted'"
                        >
                            #{{ t.taskNumber }} {{ t.verdict ?? "без ответа" }}
                        </MetaChip>
                    </template>
                </SectionCard>
                <div v-if="!cc.specSummary.value.length" class="change-empty-note">
                    Ни change, ни его задачи не ссылаются на раздел спеки
                </div>
            </div>
        </template>
    </div>
</template>

<style scoped>
.change-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 20px 28px;
    overflow-y: auto;
}
.change-demo-hint {
    margin-bottom: 4px;
}
.change-picker {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 260px;
    overflow-x: auto;
}
.picker-chip {
    cursor: pointer;
    flex: none;
}
.change-empty {
    padding: 24px 4px;
    color: var(--text-4);
    font-size: 13px;
}
.metrics-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 18px;
    padding: 10px 14px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(0, 0, 0, 0.18);
}
.metric {
    font-size: 12.5px;
    color: var(--text-3);
}
.metric.crit {
    color: var(--crit);
    font-weight: 600;
}
.metric.warn {
    color: var(--warn);
    font-weight: 600;
}
.metric.ok {
    color: var(--ok);
}
.change-columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    align-items: start;
}
.change-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}
.col-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.col-passed {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.collapse-back {
    align-self: flex-start;
}
.history-kicker {
    margin-top: 12px;
}
.history-body {
    gap: 0;
}
.change-empty-note {
    padding: 8px 4px;
    font-size: 11.5px;
    color: var(--text-4);
}
.change-flat {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.task-row {
    display: grid;
    grid-template-columns: 48px 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--node-bg);
}
.task-num {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-4);
}
.task-subject {
    min-width: 0;
    font-size: 12.5px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.task-cost {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--high);
}
.task-cost.unknown {
    color: var(--text-4);
}
</style>
