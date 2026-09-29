<script setup lang="ts">
import { computed, watch } from "vue";
import StatusChip from "../atoms/StatusChip.vue";
import HintBar from "../atoms/HintBar.vue";
import ToolButton from "../atoms/ToolButton.vue";
import { useChange } from "./useChange";
import { changeAddress } from "./changeAdapt";
import { formatMoney } from "./adapt";

const props = withDefaults(defineProps<{ address: string; showGraph?: boolean; showHeading?: boolean }>(), { showGraph: false, showHeading: false });
const emit = defineEmits<{
    (e: "open", id: string): void;
    (e: "graph"): void;
}>();
const cc = useChange();

watch(() => props.address, (address) => cc.select(address), { immediate: true });

const budgetText = computed(() => {
    const ceiling = cc.current.value?.budget_usd;
    return ceiling !== undefined ? `лимит ${formatMoney(ceiling)}` : "лимит не задан";
});

const openTask = (n?: number) => {
    if (n) emit("open", `#${n}`);
};
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
            <div class="metrics-row">
                <span class="metric">прогресс {{ cc.progress.value.done }} / {{ cc.progress.value.total }} задач</span>
            </div>
            <div class="change-flat">
                <button v-for="row in cc.cost.value.rows" :key="row.taskNumber" class="task-row" type="button" @click="openTask(row.taskNumber)">
                    <span class="task-num">#{{ row.taskNumber }}</span><span class="task-subject">{{ row.subject }}</span><span class="task-cost" :class="{ unknown: !row.money.known }">{{ row.money.text }}</span>
                </button>
            </div>
        </template>
    </div>
</template>

<style scoped>
.change-detail { font-family: var(--segoe); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.change-title, .metrics-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.change-title { font-size: 14px; }.metrics-row { padding: 10px 14px; border: 1px solid var(--stroke-strong); border-radius: var(--r-card); background: rgba(0,0,0,.18); }.metric { font-size: 12.5px; color: var(--text-3); }
.change-flat { display: flex; flex-direction: column; gap: 8px; min-width: 0; }.change-empty, .change-empty-note { padding: 8px 4px; font-size: 12px; color: var(--text-4); }.task-row { font: inherit; display: grid; grid-template-columns: 48px 1fr auto; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: var(--node-bg); color: inherit; cursor: pointer; }.task-num, .task-cost { font-family: var(--mono); font-size: 11.5px; }.task-num { color: var(--text-4); }.task-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.task-cost { color: var(--high); }.task-cost.unknown { color: var(--text-4); }
</style>
