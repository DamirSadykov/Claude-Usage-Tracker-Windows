<script setup lang="ts">
withDefaults(
    defineProps<{
        mark?: string;
        task?: string;
        note?: string;
        tone?: "plain" | "change" | "conflict";
        dim?: boolean;
    }>(),
    { mark: "", task: "", note: "", tone: "plain", dim: false },
);
</script>

<template>
    <div class="spec-para" :class="[`tone-${tone}`, { dim }]">
        <div class="spec-para-gutter">
            <span v-if="mark" class="spec-para-mark">{{ mark }}</span>
            <span v-if="task && !$slots.actions" class="spec-para-task">{{
                task
            }}</span>
        </div>
        <div class="spec-para-body">
            <div class="spec-para-text">
                <slot />
            </div>
            <div v-if="$slots.actions" class="spec-para-note">
                <span v-if="task" class="spec-para-badge">{{ task }}</span>
                <span v-if="note" class="spec-para-caption">{{ note }}</span>
                <span class="spec-para-gap" />
                <slot name="actions" />
            </div>
        </div>
    </div>
</template>

<style scoped>
.spec-para {
    display: grid;
    grid-template-columns: 48px 1fr;
    gap: 12px;
    align-items: start;
    padding: 10px 14px 10px 0;
    border-left: 2px solid transparent;
    border-radius: 0 var(--r-card) var(--r-card) 0;
}
.spec-para.tone-change {
    border-left-color: var(--ok);
    background: rgba(108, 203, 95, 0.04);
}
.spec-para.tone-conflict {
    border-left-color: var(--warn);
    background: rgba(255, 193, 7, 0.05);
}
.spec-para.dim {
    opacity: 0.42;
}
.spec-para-gutter {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    padding-top: 3px;
}
.spec-para-mark {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-4);
}
.spec-para-task {
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(76, 194, 255, 0.12);
    color: var(--accent);
    font-family: var(--mono);
    font-size: 10.5px;
}
.spec-para-body {
    min-width: 0;
}
.spec-para-text {
    font-size: 13.2px;
    line-height: 1.68;
    color: var(--text-2);
}
.spec-para-note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding: 7px 9px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: rgba(0, 0, 0, 0.24);
}
.spec-para-badge {
    flex: none;
    padding: 3px 8px;
    border-radius: var(--r-ctl);
    background: rgba(76, 194, 255, 0.12);
    color: var(--accent);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
}
.spec-para.tone-conflict .spec-para-badge {
    background: rgba(255, 193, 7, 0.14);
    color: var(--warn);
}
.spec-para-caption {
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.spec-para-gap {
    flex: 1;
}
</style>
