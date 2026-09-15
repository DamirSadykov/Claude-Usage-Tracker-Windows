<script setup lang="ts">
withDefaults(
    defineProps<{
        title: string;
        note?: string;
        size?: number;
    }>(),
    { size: 96 },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="cluster-bubble"
        :style="{ width: `${size}px`, height: `${size}px` }"
        @click="emit('click', $event)"
    >
        <span class="cluster-title">{{ title }}</span>
        <span v-if="note" class="cluster-note">{{ note }}</span>
    </div>
</template>

<style scoped>
.cluster-bubble {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px;
    border: 1px dashed rgba(255, 255, 255, 0.09);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.02);
    text-align: center;
    cursor: pointer;
}
.cluster-title {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.25;
    color: var(--text-3);
}
.cluster-note {
    font-size: 10px;
    line-height: 1.3;
    color: var(--text-4);
}
</style>
