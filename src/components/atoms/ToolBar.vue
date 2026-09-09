<script setup lang="ts">
defineOptions({ name: "ToolBar" });
</script>

<template>
    <div class="tool-bar">
        <slot />
        <span class="tool-bar-spacer" />
        <slot name="right" />
    </div>
</template>

<style scoped>
.tool-bar {
    flex: none;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    background: #1b1b1b;
    border-bottom: 1px solid var(--stroke);
}
.tool-bar-spacer {
    flex: 1;
}
</style>
