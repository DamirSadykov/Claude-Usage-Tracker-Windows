<script setup lang="ts">
withDefaults(
    defineProps<{
        icon?: string;
        text: string;
        meta?: string;
        tone?: "muted" | "ok" | "warn" | "accent" | "crit";
        mono?: boolean;
    }>(),
    { icon: "", meta: "", tone: "muted", mono: false },
);
</script>

<template>
    <div class="panel-row" :class="`tone-${tone}`">
        <span v-if="icon" class="panel-row-icon">{{ icon }}</span>
        <span class="panel-row-text" :class="{ mono }">{{ text }}</span>
        <span v-if="meta" class="panel-row-meta">{{ meta }}</span>
    </div>
</template>

<style scoped>
.panel-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 2px;
}
.panel-row-icon {
    flex: none;
    width: 12px;
    font-size: 11px;
    line-height: 1;
    text-align: center;
    color: var(--text-4);
}
.panel-row-text {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.panel-row-text.mono {
    font-family: var(--mono);
    font-size: 11.5px;
}
.panel-row-meta {
    flex: none;
    font-size: 11px;
    color: var(--text-4);
}
.panel-row.tone-ok .panel-row-icon,
.panel-row.tone-ok .panel-row-text {
    color: var(--ok);
}
.panel-row.tone-warn .panel-row-icon,
.panel-row.tone-warn .panel-row-text {
    color: var(--warn);
}
.panel-row.tone-accent .panel-row-icon,
.panel-row.tone-accent .panel-row-text {
    color: var(--accent);
}
.panel-row.tone-crit .panel-row-icon,
.panel-row.tone-crit .panel-row-text {
    color: var(--crit);
}
</style>
