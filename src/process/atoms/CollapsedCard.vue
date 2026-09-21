<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
    defineProps<{
        label: string;
        note: string;
        width?: number;
    }>(),
    { width: 206 },
);

const emit = defineEmits<{ (e: "click"): void }>();

const style = computed(() => ({ width: `${props.width}px` }));
</script>

<template>
    <button
        type="button"
        class="collapsed-card"
        :style="style"
        @click="emit('click')"
    >
        <b><span class="collapsed-caret">▸</span> {{ label }}</b>
        <span class="collapsed-note">{{ note }}</span>
    </button>
</template>

<style scoped>
.collapsed-card {
    box-sizing: border-box;
    display: block;
    padding: 12px;
    border: 1px dashed var(--stroke-strong);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.012);
    color: var(--text-4);
    font: inherit;
    font-size: 11px;
    line-height: 1.45;
    text-align: left;
    cursor: pointer;
}
.collapsed-card:hover {
    background: rgba(255, 255, 255, 0.03);
}
.collapsed-card b {
    display: block;
    margin-bottom: 4px;
    color: var(--text-3);
    font-weight: 500;
    font-size: 11.5px;
}
.collapsed-caret {
    color: var(--text-4);
}
.collapsed-note {
    display: block;
}
</style>
