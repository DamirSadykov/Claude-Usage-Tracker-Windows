<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
    defineProps<{
        kicker: string;
        title: string;
        note?: string;
        progress?: number;
        progressLabel?: string;
        cost?: string;
        duration?: string;
        tone?: "theme" | "plain";
        metrics?: string[];
    }>(),
    { tone: "theme" },
);

const fill = computed(() => {
    const value = props.progress ?? 0;
    return `${Math.max(0, Math.min(1, value)) * 100}%`;
});
</script>

<template>
    <div class="lane-rail" :class="`tone-${tone}`">
        <div class="rail-kicker">{{ kicker }}</div>
        <div class="rail-title" :title="title">{{ title }}</div>
        <div v-if="note" class="rail-note" :title="note">{{ note }}</div>
        <div v-if="progress !== undefined" class="rail-progress">
            <i :style="{ width: fill }" />
        </div>
        <div v-if="progressLabel" class="rail-meta">{{ progressLabel }}</div>
        <div v-for="(metric, i) in metrics" :key="i" class="rail-meta">
            {{ metric }}
        </div>
        <div v-if="cost || duration" class="rail-cost">
            <template v-if="cost">{{ cost }}</template>
            <span v-if="duration">{{ duration }}</span>
        </div>
        <slot />
    </div>
</template>

<style scoped>
.lane-rail {
    flex: none;
    box-sizing: border-box;
    width: 196px;
    padding: 14px 14px 16px;
    border-right: 1px solid var(--stroke);
    background: rgba(0, 0, 0, 0.14);
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.lane-rail.tone-theme {
    background: var(--theme-bg-2);
}
.rail-kicker {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
    color: var(--theme);
}
.lane-rail.tone-plain .rail-kicker {
    color: var(--text-4);
}
.rail-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.32;
    color: var(--text);
}
.rail-note {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--text-4);
}
.rail-progress {
    height: 3px;
    border-radius: 2px;
    background: var(--track);
    overflow: hidden;
}
.rail-progress i {
    display: block;
    height: 100%;
    background: var(--theme);
}
.lane-rail.tone-plain .rail-progress i {
    background: var(--accent);
}
.rail-meta {
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-4);
}
.rail-cost {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--high);
}
.rail-cost span {
    color: var(--text-4);
}
</style>
