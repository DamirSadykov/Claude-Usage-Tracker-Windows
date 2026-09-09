<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
    <div class="side-panel">
        <div v-if="title" class="side-panel-title">{{ title }}</div>
        <div class="side-panel-body">
            <slot />
        </div>
        <div v-if="$slots.footer" class="side-panel-footer">
            <slot name="footer" />
        </div>
    </div>
</template>

<style scoped>
.side-panel {
    width: 246px;
    padding: 14px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.96);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.side-panel-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
    color: var(--text-4);
}
.side-panel-body {
    margin-top: 10px;
}
.side-panel-footer {
    margin-top: 12px;
}
</style>
