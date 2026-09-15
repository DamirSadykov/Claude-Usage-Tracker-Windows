<script setup lang="ts">
withDefaults(
    defineProps<{
        text?: string;
        tone?:
            | "muted"
            | "theme"
            | "ok"
            | "warn"
            | "crit"
            | "spec"
            | "file"
            | "run";
        mono?: boolean;
    }>(),
    { text: "", tone: "muted", mono: false },
);
</script>

<template>
    <span class="meta-chip" :class="[`tone-${tone}`, { mono }]">
        <slot>{{ text }}</slot>
    </span>
</template>

<style scoped>
.meta-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    font-size: 10.5px;
    line-height: 1.4;
    white-space: nowrap;
}
.meta-chip.mono {
    font-family: var(--mono);
}
.meta-chip.tone-muted {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-4);
}
.meta-chip.tone-theme {
    background: rgba(227, 179, 65, 0.12);
    color: var(--theme);
}
.meta-chip.tone-ok,
.meta-chip.tone-file {
    background: rgba(108, 203, 95, 0.12);
    color: var(--ok);
}
.meta-chip.tone-warn {
    background: rgba(255, 193, 7, 0.12);
    color: var(--warn);
}
.meta-chip.tone-crit {
    background: rgba(248, 113, 113, 0.12);
    color: var(--crit);
}
.meta-chip.tone-spec {
    background: rgba(76, 194, 255, 0.12);
    color: var(--accent);
}
.meta-chip.tone-run {
    background: rgba(217, 119, 87, 0.12);
    color: var(--high);
}
</style>
