<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
    defineProps<{
        head?: string;
        width?: number;
    }>(),
    { width: 206 },
);

const style = computed(() => ({ width: `${props.width}px` }));
</script>

<template>
    <div class="wave-column" :style="style">
        <div v-if="head" class="wave-head">{{ head }}</div>
        <slot />
    </div>
</template>

<style scoped>
.wave-column {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.wave-head {
    margin-bottom: 2px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
    color: var(--text-4);
}
</style>
