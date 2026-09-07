<script setup lang="ts">
withDefaults(
    defineProps<{
        text?: string;
        mono?: boolean;
        tone?: "default" | "cost" | "warn" | "spec";
        caret?: boolean;
    }>(),
    { text: "", mono: false, tone: "default", caret: false },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="status-chip"
        :class="[`tone-${tone}`, { mono }]"
        @click="emit('click', $event)"
    >
        <span v-if="$slots.icon" class="status-chip-icon">
            <slot name="icon" />
        </span>
        <slot>{{ text }}</slot>
        <span v-if="caret" class="status-chip-caret">›</span>
    </button>
</template>

<style scoped>
.status-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px;
    background: var(--layer);
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
}
.status-chip:hover {
    background: var(--layer-hover);
}
.status-chip.mono {
    font-family: var(--mono);
}
.status-chip-icon {
    display: inline-flex;
    align-items: center;
    line-height: 1;
}
.status-chip-caret {
    color: var(--text-4);
}
.status-chip.tone-cost {
    color: var(--high);
    border-color: rgba(217, 119, 87, 0.4);
    background: rgba(217, 119, 87, 0.1);
}
.status-chip.tone-warn {
    color: var(--warn);
    border-color: rgba(255, 193, 7, 0.35);
    background: rgba(255, 193, 7, 0.08);
}
.status-chip.tone-spec {
    color: var(--accent);
    border-color: rgba(76, 194, 255, 0.45);
    background: var(--accent-soft);
}
.status-chip.tone-cost:hover,
.status-chip.tone-warn:hover,
.status-chip.tone-spec:hover {
    filter: brightness(1.12);
}
</style>
