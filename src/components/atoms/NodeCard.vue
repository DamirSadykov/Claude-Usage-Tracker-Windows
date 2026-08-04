<script setup lang="ts">
import { computed } from "vue";
import type { NodeStatus, PortRef } from "../pipeline/types";
import StatusDot from "./StatusDot.vue";
import PortChip from "./PortChip.vue";
import CostFooter from "./CostFooter.vue";

const props = defineProps<{
    id: string;
    title: string;
    status?: NodeStatus;
    auto?: boolean;
    done?: boolean;
    active?: boolean;
    selected?: boolean;
    ports?: PortRef[];
    cost?: string;
    costShare?: number;
    costNote?: string;
    warn?: string;
    width?: number;
}>();

const emit = defineEmits<{ (e: "click"): void }>();

const style = computed(() =>
    props.width === undefined ? undefined : { width: `${props.width}px` },
);

const hasIo = computed(
    () => Boolean(props.warn) || (props.ports?.length ?? 0) > 0,
);
</script>

<template>
    <div
        class="node-card"
        :class="{ done, active, selected }"
        :style="style"
        @click="emit('click')"
    >
        <div class="node-head">
            <span class="node-id">{{ id }}</span>
            <span v-if="auto" class="node-auto">⚡</span>
            <StatusDot v-if="status" class="node-dot" :status="status" />
        </div>
        <div class="node-title" :title="title">{{ title }}</div>
        <slot />
        <div v-if="hasIo" class="node-io">
            <PortChip
                v-for="(port, i) in ports"
                :key="`${port.dir}-${port.label}-${i}`"
                :dir="port.dir"
                :label="port.label"
                :exists="port.exists"
            />
            <PortChip v-if="warn" :label="warn" tone="warn" />
        </div>
        <div v-if="$slots.footer || cost" class="node-foot">
            <slot name="footer">
                <CostFooter
                    v-if="cost"
                    :cost="cost"
                    :share="costShare"
                    :note="costNote"
                />
            </slot>
        </div>
    </div>
</template>

<style scoped>
.node-card {
    position: relative;
    box-sizing: border-box;
    min-height: 62px;
    padding: 9px 10px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: 9px;
    background: var(--node-bg);
    cursor: pointer;
    transition:
        background 0.12s,
        border-color 0.12s;
}
.node-card:hover {
    background: var(--node-bg-2);
}
.node-card.done {
    border-style: dashed;
    border-color: rgba(108, 203, 95, 0.4);
    background: rgba(255, 255, 255, 0.015);
}
.node-card.done .node-id,
.node-card.done .node-title {
    opacity: 0.42;
}
.node-card.active {
    background: #2a2440;
    border-color: #6b5bc4;
}
.node-card.selected {
    border-color: transparent;
    box-shadow: 0 0 0 2px var(--accent);
}
.node-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
}
.node-id {
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text);
}
.node-auto {
    color: var(--warn);
    font-size: 10px;
    line-height: 1;
}
.node-dot {
    margin-left: auto;
}
.node-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    font-size: 11.6px;
    line-height: 1.35;
    color: var(--text-3);
    overflow-wrap: anywhere;
}
.node-io {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
}
.node-foot {
    margin: 9px -10px -10px;
}
</style>
