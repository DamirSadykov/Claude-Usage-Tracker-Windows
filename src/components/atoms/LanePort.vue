<script setup lang="ts">
defineProps<{
    side: "left" | "right";
    label: string;
    sub?: string;
    compact?: boolean;
}>();

defineEmits<{ (e: "click", value: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="lane-port"
        :class="[side, { compact }]"
        @click="$emit('click', $event)"
    >
        <span class="lane-port-dot">{{ side === "right" ? "→" : "←" }}</span>
        <span class="lane-port-label">
            <b v-if="sub">{{ sub }}</b>
            <i>{{ label }}</i>
        </span>
    </button>
</template>

<style scoped>
.lane-port {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 150px;
    padding: 4px 8px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-pill);
    background: rgba(29, 29, 29, 0.96);
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.lane-port:hover {
    border-color: var(--accent);
}
.lane-port.right {
    flex-direction: row-reverse;
}
.lane-port-dot {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--stroke-strong);
    background: var(--layer);
    color: var(--text-3);
    font-size: 9px;
    line-height: 1;
}
.lane-port-label {
    min-width: 0;
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.lane-port-label b {
    display: block;
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-2);
}
.lane-port-label i {
    font-style: normal;
}
.lane-port.compact .lane-port-label i {
    display: none;
}
</style>
