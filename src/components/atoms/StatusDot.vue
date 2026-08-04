<script setup lang="ts">
defineProps<{
    status: "blocked" | "ready" | "waiting" | "done";
}>();
</script>

<template>
    <span class="status-dot" :class="status" />
</template>

<style scoped>
.status-dot {
    flex: none;
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
}
.status-dot.blocked {
    background: var(--crit);
}
.status-dot.ready {
    background: var(--ok);
}
.status-dot.waiting {
    background: var(--theme);
}
.status-dot.done {
    background: var(--ok);
    opacity: 0.5;
}
</style>
