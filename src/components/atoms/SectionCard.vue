<script setup lang="ts">
withDefaults(
    defineProps<{
        address: string;
        title: string;
        part?: string;
        partWarn?: string;
        prose?: string;
        tone?: "spec" | "warn";
        selected?: boolean;
    }>(),
    { tone: "spec", selected: false },
);
</script>

<template>
    <div class="section-card" :class="[`tone-${tone}`, { selected }]">
        <div class="section-card-address">{{ address }}</div>
        <div class="section-card-title">{{ title }}</div>
        <div v-if="part || partWarn" class="section-card-part">
            <span v-if="part">{{ part }}</span>
            <span v-if="partWarn" class="warn">{{ partWarn }}</span>
        </div>
        <div v-if="prose" class="section-card-prose">{{ prose }}</div>
        <div v-if="$slots.chips" class="section-card-chips">
            <slot name="chips" />
        </div>
    </div>
</template>

<style scoped>
.section-card {
    width: 100%;
    padding: 14px;
    border: 1px solid var(--stroke-strong);
    border-radius: 9px;
    background: var(--node-bg);
}
.section-card.tone-spec {
    border-color: var(--accent);
    background: rgba(76, 194, 255, 0.05);
    box-shadow: 0 0 0 1px rgba(76, 194, 255, 0.25);
}
.section-card.tone-warn {
    border-color: var(--warn);
    background: rgba(255, 193, 7, 0.05);
    box-shadow: 0 0 0 1px rgba(255, 193, 7, 0.25);
}
.section-card.selected {
    box-shadow: 0 0 0 2px var(--accent);
}
.section-card-address {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.3;
}
.section-card.tone-spec .section-card-address {
    color: var(--accent);
}
.section-card.tone-warn .section-card-address {
    color: var(--warn);
}
.section-card-title {
    margin-top: 5px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
}
.section-card-part {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-4);
}
.section-card-part .warn {
    color: var(--warn);
}
.section-card-prose {
    margin-top: 10px;
    font-size: 11.8px;
    line-height: 1.5;
    color: var(--text-3);
}
.section-card-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    margin-top: 12px;
}
</style>
