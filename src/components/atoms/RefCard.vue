<script setup lang="ts">
withDefaults(
    defineProps<{
        id: string;
        title: string;
        state?: string;
        tone?: "task" | "spec" | "external";
        muted?: boolean;
    }>(),
    { tone: "task", muted: false },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="ref-card"
        :class="[`tone-${tone}`, { muted }]"
        @click="emit('click', $event)"
    >
        <div class="ref-card-head">
            <span class="ref-card-id">{{ id }}</span>
            <template v-if="state">
                <span class="ref-card-sep">·</span>
                <span class="ref-card-state">{{ state }}</span>
            </template>
        </div>
        <div class="ref-card-title">{{ title }}</div>
    </div>
</template>

<style scoped>
.ref-card {
    width: 100%;
    min-height: 62px;
    padding: 9px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: 9px;
    background: var(--node-bg);
    cursor: pointer;
    transition:
        background 0.12s,
        border-color 0.12s;
}
.ref-card:hover {
    background: var(--node-bg-2);
}
.ref-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
}
.ref-card-id {
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text);
}
.ref-card.tone-spec .ref-card-id {
    color: var(--accent);
}
.ref-card.tone-external .ref-card-id {
    color: var(--text-2);
}
.ref-card-sep {
    font-size: 11px;
    color: var(--text-4);
}
.ref-card-state {
    font-size: 11px;
    color: var(--text-4);
}
.ref-card-title {
    font-size: 11.6px;
    line-height: 1.35;
    color: var(--text-3);
}
.ref-card.muted {
    border-style: dashed;
}
.ref-card.muted .ref-card-head,
.ref-card.muted .ref-card-title {
    opacity: 0.6;
}
</style>
