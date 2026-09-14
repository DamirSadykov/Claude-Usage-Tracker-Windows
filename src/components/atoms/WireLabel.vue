<script setup lang="ts">
withDefaults(
    defineProps<{
        x: number;
        y: number;
        text: string;
        tone?: "spec" | "file" | "handoff" | "after";
        dot?: boolean;
    }>(),
    { tone: "after", dot: false },
);
</script>

<template>
    <span
        class="wire-label"
        :class="`tone-${tone}`"
        :style="{ left: `${x}px`, top: `${y}px` }"
    >
        <i v-if="dot" class="wire-label-dot" />
        <span class="wire-label-text">{{ text }}</span>
    </span>
</template>

<style scoped>
.wire-label {
    position: absolute;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 124px;
    padding: 2px 7px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-pill);
    background: rgba(29, 29, 29, 0.98);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 1.5;
    color: var(--text-4);
    transform: translate(-50%, -50%);
    pointer-events: none;
}
.wire-label.tone-spec {
    border-color: var(--accent);
    color: var(--accent);
}
.wire-label.tone-file {
    border-color: var(--ok);
    color: var(--ok);
}
.wire-label.tone-handoff {
    border-color: var(--high);
    color: var(--high);
}
.wire-label-dot {
    flex: none;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
}
.wire-label-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
