<script setup lang="ts">
withDefaults(
    defineProps<{
        label: string;
        title?: string;
        tone?: "focus" | "hub" | "spec" | "plain";
        dim?: boolean;
        counter?: string;
        badge?: string;
        cost?: string;
    }>(),
    { tone: "plain", dim: false },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="ring-card"
        :class="[`tone-${tone}`, { dim }]"
        @click="emit('click', $event)"
    >
        <div class="ring-label">{{ label }}</div>
        <div v-if="title" class="ring-title">{{ title }}</div>
        <div v-if="badge || cost" class="ring-foot">
            <span v-if="badge" class="ring-badge">{{ badge }}</span>
            <span v-if="cost" class="ring-cost">{{ cost }}</span>
        </div>
        <span v-if="counter" class="ring-counter">{{ counter }}</span>
    </div>
</template>

<style scoped>
.ring-card {
    position: relative;
    width: 172px;
    padding: 9px 10px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: 9px;
    background: var(--node-bg);
    cursor: pointer;
    transition:
        background 0.12s,
        border-color 0.12s;
}
.ring-card.dim {
    opacity: 0.55;
}
.ring-label {
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text);
}
.ring-title {
    margin-top: 4px;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--text-3);
}
.ring-foot {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 8px;
}
.ring-badge {
    font-size: 11px;
    color: var(--text-4);
}
.ring-cost {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--high);
}
.ring-counter {
    position: absolute;
    right: 8px;
    bottom: 6px;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-4);
}

.ring-card.tone-plain:hover {
    background: var(--node-bg-2);
}
.ring-card.tone-plain .ring-title {
    font-size: 11px;
}

.ring-card.tone-hub {
    border-color: rgba(76, 194, 255, 0.5);
    background: rgba(76, 194, 255, 0.07);
}
.ring-card.tone-hub .ring-label {
    color: var(--accent);
}

.ring-card.tone-spec {
    border-color: rgba(76, 194, 255, 0.35);
}
.ring-card.tone-spec .ring-label {
    color: var(--accent);
}

.ring-card.tone-focus {
    width: 230px;
    padding: 11px 13px 12px;
    border-color: rgba(227, 179, 65, 0.35);
    background: rgba(227, 179, 65, 0.11);
}
.ring-card.tone-focus .ring-label {
    font-family: var(--segoe);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
    color: var(--theme);
}
.ring-card.tone-focus .ring-title {
    margin-top: 6px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
}
</style>
