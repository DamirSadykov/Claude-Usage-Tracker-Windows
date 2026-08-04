<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";

const props = defineProps<{
    radii: number[];
    cx?: number;
    cy?: number;
}>();

const root = ref<SVGSVGElement | null>(null);
const size = ref({ w: 0, h: 0 });

let ro: ResizeObserver | null = null;
let frame = 0;

function measure() {
    const host = root.value?.parentElement;
    if (!host) return;
    size.value = { w: host.clientWidth, h: host.clientHeight };
}

function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
}

const width = computed(() => Math.max(1, size.value.w));
const height = computed(() => Math.max(1, size.value.h));
const centerX = computed(() => props.cx ?? width.value / 2);
const centerY = computed(() => props.cy ?? height.value / 2);

onMounted(() => {
    ro = new ResizeObserver(schedule);
    const host = root.value?.parentElement;
    if (host) ro.observe(host);
    window.addEventListener("resize", schedule);
    schedule();
});

onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    ro?.disconnect();
    window.removeEventListener("resize", schedule);
});

defineExpose({ remeasure: schedule });
</script>

<template>
    <svg
        ref="root"
        class="ring-backdrop"
        :viewBox="`0 0 ${width} ${height}`"
    >
        <circle
            v-for="r in radii"
            :key="r"
            class="ring"
            :cx="centerX"
            :cy="centerY"
            :r="r"
        />
    </svg>
</template>

<style scoped>
.ring-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
    z-index: 0;
}
.ring {
    fill: none;
    stroke: rgba(255, 255, 255, 0.07);
    stroke-dasharray: 3 6;
}
</style>
