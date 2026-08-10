<script setup lang="ts">
defineProps<{
    name: string;
    meta?: string[];
    kicker?: string;
}>();
</script>

<template>
    <div class="project-band">
        <span v-if="kicker" class="project-kicker">{{ kicker }}</span>
        <span v-if="kicker" class="project-sep">·</span>
        <span class="project-name">{{ name }}</span>
        <template v-for="(item, i) in meta" :key="i">
            <span class="project-sep">·</span>
            <span>{{ item }}</span>
        </template>
    </div>
</template>

<style scoped>
.project-band {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 24px 6px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-4);
}
.project-kicker {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
}
.project-name {
    font-family: var(--mono);
    color: var(--text-3);
}
.project-sep {
    opacity: 0.5;
}
</style>
