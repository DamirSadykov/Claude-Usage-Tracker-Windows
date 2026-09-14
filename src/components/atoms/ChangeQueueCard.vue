<script setup lang="ts">
withDefaults(
    defineProps<{
        id: string;
        title: string;
        meta?: string;
        tone?: "muted" | "ok" | "warn" | "accent";
        active?: boolean;
    }>(),
    { meta: "", tone: "muted", active: false },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="queue-card"
        :class="[`tone-${tone}`, { active }]"
        @click="emit('click', $event)"
    >
        <div class="queue-card-head">
            <span class="queue-card-id">{{ id }}</span>
            <span v-if="meta" class="queue-card-meta">{{ meta }}</span>
        </div>
        <div class="queue-card-title">{{ title }}</div>
    </div>
</template>

<style scoped>
.queue-card {
    padding: 9px 11px;
    border: 1px solid var(--stroke-strong);
    border-left: 2px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--node-bg);
    cursor: pointer;
}
.queue-card:hover {
    background: var(--node-bg-2);
}
.queue-card.active {
    background: var(--accent-soft);
    border-color: rgba(76, 194, 255, 0.45);
}
.queue-card.tone-ok {
    border-left-color: var(--ok);
}
.queue-card.tone-warn {
    border-left-color: var(--warn);
}
.queue-card.tone-accent {
    border-left-color: var(--accent);
}
.queue-card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
}
.queue-card-id {
    flex: none;
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--accent);
}
.queue-card-meta {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-4);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.queue-card.tone-ok .queue-card-meta {
    color: var(--ok);
}
.queue-card.tone-warn .queue-card-meta {
    color: var(--warn);
}
.queue-card-title {
    font-size: 11.8px;
    line-height: 1.4;
    color: var(--text-2);
}
</style>
