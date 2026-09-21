<script setup lang="ts">
withDefaults(
    defineProps<{
        active?: boolean;
        variant?: "default" | "pri" | "cost" | "warn" | "ghost" | "icon";
    }>(),
    { active: false, variant: "default" },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="tool-button"
        :class="[variant !== 'default' ? variant : '', { active }]"
        @click="emit('click', $event)"
    >
        <slot />
    </button>
</template>

<style scoped>
.tool-button {
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--layer);
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
}
.tool-button:hover {
    background: var(--layer-hover);
}
.tool-button.active {
    background: var(--accent-soft);
    border-color: rgba(76, 194, 255, 0.45);
    color: var(--accent);
}
.tool-button.pri {
    background: var(--accent);
    border-color: transparent;
    color: #06283a;
    font-weight: 600;
}
.tool-button.pri:hover {
    background: var(--accent-2);
}
.tool-button.ghost {
    background: transparent;
}
.tool-button.ghost:hover {
    background: var(--layer-hover);
}
.tool-button.cost {
    color: var(--high);
    border-color: rgba(217, 119, 87, 0.4);
    background: rgba(217, 119, 87, 0.1);
    font-weight: 600;
}
.tool-button.warn {
    color: var(--warn);
    border-color: rgba(255, 193, 7, 0.35);
    background: rgba(255, 193, 7, 0.08);
}
.tool-button.icon {
    padding: 0 9px;
}
</style>
