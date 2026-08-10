<script setup lang="ts">
withDefaults(
    defineProps<{
        slug: string;
        title?: string;
        badge?: string;
        badgeTone?: "muted" | "spec" | "theme" | "ok" | "warn";
        count?: number | string;
        active?: boolean;
        marked?: boolean;
    }>(),
    {
        title: "",
        badge: "",
        badgeTone: "muted",
        active: false,
        marked: false,
    },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="spec-tree-item"
        :class="{ active }"
        @click="emit('click', $event)"
    >
        <span class="spec-tree-head">
            <i v-if="marked" class="spec-tree-dot" />
            <span class="spec-tree-slug">{{ slug }}</span>
            <span class="spec-tree-gap" />
            <span
                v-if="badge"
                class="spec-tree-badge"
                :class="`tone-${badgeTone}`"
                >{{ badge }}</span
            >
            <span v-if="count !== undefined" class="spec-tree-count">{{
                count
            }}</span>
        </span>
        <span v-if="title" class="spec-tree-title">{{ title }}</span>
    </button>
</template>

<style scoped>
.spec-tree-item {
    display: block;
    width: 100%;
    padding: 6px 10px 7px;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.spec-tree-item:hover {
    background: rgba(255, 255, 255, 0.04);
}
.spec-tree-item.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
}
.spec-tree-head {
    display: flex;
    align-items: center;
    gap: 6px;
}
.spec-tree-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--theme);
}
.spec-tree-slug {
    min-width: 0;
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.spec-tree-gap {
    flex: 1;
}
.spec-tree-badge {
    flex: none;
    padding: 1px 7px;
    border-radius: var(--r-pill);
    font-size: 10.5px;
    line-height: 1.4;
    white-space: nowrap;
}
.spec-tree-badge.tone-muted {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-3);
}
.spec-tree-badge.tone-spec {
    background: rgba(76, 194, 255, 0.12);
    color: var(--accent);
}
.spec-tree-badge.tone-theme {
    background: rgba(227, 179, 65, 0.12);
    color: var(--theme);
}
.spec-tree-badge.tone-ok {
    background: rgba(108, 203, 95, 0.12);
    color: var(--ok);
}
.spec-tree-badge.tone-warn {
    background: rgba(255, 193, 7, 0.12);
    color: var(--warn);
}
.spec-tree-count {
    flex: none;
    min-width: 18px;
    padding: 1px 5px;
    border-radius: var(--r-pill);
    background: rgba(255, 255, 255, 0.07);
    color: var(--text-3);
    font-family: var(--mono);
    font-size: 10.5px;
    text-align: center;
}
.spec-tree-item.active .spec-tree-count {
    background: rgba(76, 194, 255, 0.18);
    color: var(--accent);
}
.spec-tree-title {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
