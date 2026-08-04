<script setup lang="ts">
import { computed } from "vue";
import LanesView from "./views/LanesView.vue";
import WiresView from "./views/WiresView.vue";
import RingsView from "./views/RingsView.vue";
import BubblesView from "./views/BubblesView.vue";
import SpecLanesView from "./views/SpecLanesView.vue";
import SpecReaderView from "./views/SpecReaderView.vue";
import SpecReviewView from "./views/SpecReviewView.vue";
import { SPEC_MODES, type PipelineMode } from "./modes";
import "./pipeline.css";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: false });

const emit = defineEmits<{ (e: "open", id: string): void }>();

const mode = defineModel<PipelineMode>("mode", { default: "lanes" });

const views = {
    lanes: LanesView,
    wires: WiresView,
    bubbles: BubblesView,
    rings: RingsView,
    specs: SpecLanesView,
    reader: SpecReaderView,
    review: SpecReviewView,
};

const current = computed(() => views[mode.value]);
const isSpecDoc = computed(() => SPEC_MODES.includes(mode.value));
</script>

<template>
    <div class="pipe-root pipe-embed">
        <component
            :is="current"
            v-if="isSpecDoc"
            :chrome="chrome"
            @mode="mode = $event"
            @open="emit('open', $event)"
        />
        <component
            :is="current"
            v-else
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
