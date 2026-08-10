<script setup lang="ts">
import { ref } from "vue";

withDefaults(
    defineProps<{
        tone?: "theme" | "warn" | "plain";
    }>(),
    { tone: "plain" },
);

const body = ref<HTMLElement | null>(null);

defineExpose({ body });
</script>

<template>
    <div class="lane-frame" :class="`tone-${tone}`">
        <slot name="rail" />
        <div ref="body" class="lane-body">
            <slot />
        </div>
    </div>
</template>

<style scoped>
.lane-frame {
    position: relative;
    display: flex;
    align-items: stretch;
    border: 1px solid var(--stroke);
    border-radius: var(--r-card);
    background: rgba(255, 255, 255, 0.012);
    overflow: visible;
}
.lane-frame.tone-theme {
    border-color: var(--theme-stroke);
    background: var(--theme-bg);
}
.lane-frame.tone-warn {
    border-color: rgba(255, 193, 7, 0.24);
    background: rgba(255, 193, 7, 0.045);
}
.lane-body {
    position: relative;
    flex: 1;
    min-width: 0;
    padding: 14px 18px 18px;
    overflow-x: auto;
}
</style>
