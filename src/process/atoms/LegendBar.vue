<script setup lang="ts">
interface LegendItem {
    text: string;
    color?: string;
    mark?: "dot" | "line" | "dash" | "none";
}

defineProps<{ items: LegendItem[] }>();

function markOf(item: LegendItem) {
    return item.mark ?? "dot";
}
</script>

<template>
    <div class="legend-bar">
        <span
            v-for="(item, i) in items"
            :key="i"
            class="legend-item"
            :class="{ bare: markOf(item) === 'none' }"
            :style="item.color ? { color: item.color } : undefined"
        >
            <i v-if="markOf(item) === 'dot'" class="legend-dot" />
            <i
                v-else-if="markOf(item) === 'line' || markOf(item) === 'dash'"
                class="legend-line"
                :class="{ dash: markOf(item) === 'dash' }"
            />
            <span class="legend-text">{{ item.text }}</span>
        </span>
        <span class="legend-spacer" />
        <slot name="right" />
    </div>
</template>

<style scoped>
.legend-bar {
    flex: none;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 16px;
    font-size: 11px;
    color: var(--text-4);
    border-bottom: 1px solid var(--stroke);
}
.legend-spacer {
    flex: 1;
}
.legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
}
.legend-text {
    color: var(--text-4);
}
.legend-item.bare .legend-text {
    color: inherit;
}
.legend-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
}
.legend-line {
    flex: none;
    width: 16px;
    height: 0;
    border-top: 1px solid currentColor;
}
.legend-line.dash {
    border-top-style: dashed;
}
</style>
