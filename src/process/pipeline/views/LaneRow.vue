<script setup lang="ts">
import { ref } from "vue";
import NodeCard from "../../atoms/NodeCard.vue";
import WaveColumn from "../../atoms/WaveColumn.vue";
import WireLayer from "../../atoms/WireLayer.vue";
import type { TaskNode } from "../types";

defineProps<{
    laneId: string;
    waves: readonly number[];
    cardsByWave: ReadonlyMap<number, readonly TaskNode[]>;
    links: readonly { from: string; to: string; tone?: string }[];
    costLayer: boolean;
}>();
const emit = defineEmits<{ (e: "pick", id: string): void; (e: "open", id: string): void }>();
const body = ref<HTMLElement | null>(null);

defineExpose({ body });
</script>

<template>
    <div ref="body" class="lane-row" :data-lane="laneId">
        <WireLayer :container="body" :links="links" />
        <div class="lane-row-waves">
            <WaveColumn v-for="wave in waves" :key="wave" :head="`Волна ${wave}`">
                <NodeCard
                    v-for="task in cardsByWave.get(wave) ?? []"
                    :key="task.id"
                    :data-node="task.id"
                    :id="task.id"
                    :title="task.title"
                    :status="task.status"
                    :auto="task.auto"
                    :done="task.done"
                    :active="task.active"
                    :cost="costLayer ? task.cost : undefined"
                    :cost-note="costLayer ? task.costNote : undefined"
                    :cost-share="costLayer ? task.costShare : undefined"
                    @click="emit('pick', task.id)"
                    @dblclick="emit('open', task.id)"
                />
            </WaveColumn>
            <slot />
        </div>
    </div>
</template>

<style scoped>
.lane-row { position: relative; }
.lane-row-waves { display: flex; align-items: flex-start; gap: var(--lane-gap, 30px); width: max-content; }
.lane-row-waves > * { flex: none; }
</style>
