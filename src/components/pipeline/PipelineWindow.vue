<script setup lang="ts">
import { ref, computed } from "vue";
import AppBar from "../atoms/AppBar.vue";
import SegControl from "../atoms/SegControl.vue";
import SearchField from "../atoms/SearchField.vue";
import StatusChip from "../atoms/StatusChip.vue";
import ToolButton from "../atoms/ToolButton.vue";
import PipelineGraph from "./PipelineGraph.vue";
import { SPEC_MODES, type PipelineMode } from "./modes";
import "./pipeline.css";

const mode = ref<PipelineMode>("lanes");
const tab = ref("graph");
const scope = ref("local");
const query = ref("");

const isSpecDoc = computed(() => SPEC_MODES.includes(mode.value));

const headline = computed(() => {
    if (mode.value === "specs") return "Реестр спек: 24 раздела, 3 предупреждения";
    if (mode.value === "wires") return "graph/tasks.flow · синхронизирован";
    if (mode.value === "rings") return "";
    return "Доска в норме: 0 просрочек";
});
</script>

<template>
    <div class="pipe-root">
        <AppBar v-if="!isSpecDoc" title="Задачи">
            <template #modes>
                <SegControl
                    v-model="scope"
                    :options="[
                        { id: 'local', label: 'Мои задачи' },
                        { id: 'external', label: 'Внешние', count: 2 },
                    ]"
                />
            </template>
            <template #center>
                <StatusChip v-if="headline" :text="headline" caret />
            </template>
            <template #right>
                <SearchField v-model="query" placeholder="Найти узел…" />
                <SegControl
                    v-model="tab"
                    :options="[
                        { id: 'board', label: 'Доска' },
                        { id: 'graph', label: 'Граф' },
                        { id: 'specs', label: 'Спеки' },
                    ]"
                    @update:model-value="
                        (value: string) => (mode = value === 'specs' ? 'reader' : 'lanes')
                    "
                />
                <ToolButton variant="pri">+ Добавить</ToolButton>
            </template>
        </AppBar>

        <PipelineGraph v-model:mode="mode" :chrome="true" />
    </div>
</template>
