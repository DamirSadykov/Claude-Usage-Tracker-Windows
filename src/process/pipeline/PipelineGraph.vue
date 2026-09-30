<script setup lang="ts">
import { computed, ref } from "vue";
import type { TodoFilters } from "../../board/todoFilter";
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
}>(), { chrome: false, query: "" });

const emit = defineEmits<{ (e: "open", id: string): void; (e: "trace", id: string): void }>();

const mode = defineModel<PipelineMode>("mode", { default: "bubbles" });
const activeHit = defineModel<string | null>("activeHit", { default: null });
const viewRef = ref<{ cycleHit?: (direction: 1 | -1) => void } | null>(null);

function cycleHit(direction: 1 | -1 = 1) {
    viewRef.value?.cycleHit?.(direction);
}
defineExpose({ cycleHit });

const views = {
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
            @trace="emit('trace', $event)"
        />
        <component
            :is="current"
            ref="viewRef"
            v-else
            :query="props.query"
            :filters="props.filters"
            :active-hit="activeHit"
            @update:active-hit="activeHit = $event"
            @mode="mode = $event"
            @open="emit('open', $event)"
            @trace="emit('trace', $event)"
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
