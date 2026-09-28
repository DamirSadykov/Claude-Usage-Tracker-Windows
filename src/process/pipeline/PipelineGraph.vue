<script setup lang="ts">
import { computed, ref } from "vue";
import type { TodoFilters } from "../../board/todoFilter";
import LanesView from "./views/LanesView.vue";
import WiresView from "./views/WiresView.vue";
import RingsView from "./views/RingsView.vue";
import BubblesView from "./views/BubblesView.vue";
import SpecLanesView from "./views/SpecLanesView.vue";
import SpecReaderView from "./views/SpecReaderView.vue";
import SpecReviewView from "./views/SpecReviewView.vue";
import ChangeView from "./views/ChangeView.vue";
import { SPEC_MODES, type PipelineMode } from "./modes";
import "./pipeline.css";

const props = withDefaults(defineProps<{
    chrome?: boolean;
    query?: string;
    filters?: TodoFilters;
    focusLane?: string;
}>(), { chrome: false, query: "", focusLane: "" });

const emit = defineEmits<{ (e: "open", id: string): void }>();

const mode = defineModel<PipelineMode>("mode", { default: "lanes" });
const activeHit = defineModel<string | null>("activeHit", { default: null });
const viewRef = ref<{ cycleHit?: (direction: 1 | -1) => void } | null>(null);

function cycleHit(direction: 1 | -1 = 1) {
    viewRef.value?.cycleHit?.(direction);
}
defineExpose({ cycleHit });

const views = {
    lanes: LanesView,
    wires: WiresView,
    bubbles: BubblesView,
    rings: RingsView,
    specs: SpecLanesView,
    reader: SpecReaderView,
    review: SpecReviewView,
    change: ChangeView,
};

const current = computed(() => views[mode.value]);
const isSpecDoc = computed(() => SPEC_MODES.includes(mode.value));
</script>

<template>
    <div class="pipe-root pipe-embed">
        <component
            :is="current"
            ref="viewRef"
            v-if="isSpecDoc"
            :chrome="chrome"
            @mode="mode = $event"
            @open="emit('open', $event)"
        />
        <component
            :is="current"
            ref="viewRef"
            v-else
            :query="props.query"
            :filters="props.filters"
            :focus-lane="props.focusLane"
            :active-hit="activeHit"
            @update:active-hit="activeHit = $event"
            @mode="mode = $event"
            @open="emit('open', $event)"
        />
    </div>
</template>

<style scoped>
.pipe-embed {
    flex: 1;
    min-height: 0;
    height: auto;
}
</style>
