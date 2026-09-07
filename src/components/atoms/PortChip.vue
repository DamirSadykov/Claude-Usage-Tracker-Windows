<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
    dir?: "R" | "W";
    label: string;
    exists?: boolean;
    tone?: "spec" | "file" | "handoff" | "warn";
}>();

const missing = computed(() => props.exists === false);
</script>

<template>
    <i
        class="port-chip"
        :class="[
            dir === 'W' ? 'dir-w' : 'dir-r',
            tone ? `tone-${tone}` : '',
            { missing },
        ]"
    >
        <b v-if="dir">{{ dir }}</b>
        <span class="port-chip-label">{{ label }}</span>
        <em v-if="missing">✕</em>
    </i>
</template>

<style scoped>
.port-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 6px 2px 5px;
    border-left: 2px solid var(--accent);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.05);
    font-family: var(--mono);
    font-size: 9.5px;
    font-style: normal;
    line-height: 1.4;
    color: var(--text-3);
}
.port-chip.dir-w {
    border-left-color: var(--ok);
}
.port-chip.tone-spec {
    border-left-color: var(--accent);
}
.port-chip.tone-file {
    border-left-color: var(--ok);
}
.port-chip.tone-handoff {
    border-left-color: var(--high);
}
.port-chip.tone-warn {
    border-left-color: var(--warn);
    color: var(--warn);
}
.port-chip.missing {
    border-left-color: var(--crit);
    color: var(--crit);
}
.port-chip b {
    flex: none;
    color: var(--text-4);
    font-weight: 600;
}
.port-chip.missing b,
.port-chip.tone-warn b {
    color: inherit;
}
.port-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.port-chip em {
    flex: none;
    font-style: normal;
}
</style>
