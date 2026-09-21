<script setup lang="ts">
interface SegOption {
    id: string;
    label: string;
    count?: number | string;
}

defineProps<{ modelValue: string; options: SegOption[] }>();

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
</script>

<template>
    <div class="seg-control">
        <button
            v-for="option in options"
            :key="option.id"
            type="button"
            :class="{ active: option.id === modelValue }"
            @click="emit('update:modelValue', option.id)"
        >
            {{ option.label }}
            <span v-if="option.count !== undefined" class="seg-count">{{
                option.count
            }}</span>
        </button>
    </div>
</template>

<style scoped>
.seg-control {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: var(--layer);
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-pill);
}
.seg-control button {
    height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 12px;
    border: 0;
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--text-3);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
}
.seg-control button:hover {
    color: var(--text-2);
}
.seg-control button.active {
    background: var(--layer-2);
    color: var(--text);
}
.seg-count {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10.5px;
    font-family: var(--mono);
}
</style>
