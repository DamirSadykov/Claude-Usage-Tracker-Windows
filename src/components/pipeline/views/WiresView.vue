<script setup lang="ts">
import { computed, ref } from "vue";
import ToolBar from "../../atoms/ToolBar.vue";
import LegendBar from "../../atoms/LegendBar.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SegControl from "../../atoms/SegControl.vue";
import LaneFrame from "../../atoms/LaneFrame.vue";
import LaneRail from "../../atoms/LaneRail.vue";
import WaveColumn from "../../atoms/WaveColumn.vue";
import NodeCard from "../../atoms/NodeCard.vue";
import WireLayer from "../../atoms/WireLayer.vue";
import WireLabel from "../../atoms/WireLabel.vue";
import Kicker from "../../atoms/Kicker.vue";
import NodeInspector from "../NodeInspector.vue";
import { lanes, tasks, links, wireLegend, graphStats, chainOf } from "../mock";
import type { Artifact, ArtifactKind, TaskNode } from "../types";

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "rings" | "specs"): void;
    (e: "open", id: string): void;
}>();

const graphMode = ref("both");
const labelFilter = ref("all");
const portsOn = ref(true);
const costOn = ref(false);
const selected = ref(tasks.find((task) => task.selected)?.id ?? "");

const lane = lanes[0];
const visibleWaves = [2, 3, 4, 5];
const columnWidth = 196;

const frame = ref<InstanceType<typeof LaneFrame> | null>(null);
const body = computed(() => frame.value?.body ?? null);

const laneTasks = computed(() =>
    tasks.filter((task) => task.lane === lane.id && visibleWaves.includes(task.wave)),
);

const laneLinks = computed(() => {
    const ids = new Set(laneTasks.value.map((task) => task.id));
    return links.filter((link) => ids.has(link.from) && ids.has(link.to));
});

const columns = computed(() => {
    const grouped = new Map<number, TaskNode[]>();
    for (const task of laneTasks.value) {
        const list = grouped.get(task.wave) ?? [];
        list.push(task);
        grouped.set(task.wave, list);
    }
    const rows = new Map<string, number>();
    let free = 0;
    return [...grouped.keys()]
        .sort((a, b) => a - b)
        .map((wave) => {
            const list = grouped.get(wave) ?? [];
            for (const task of list) {
                const parent = laneLinks.value.find((link) => link.to === task.id);
                const row = parent ? rows.get(parent.from) : undefined;
                rows.set(task.id, row ?? free++);
            }
            return {
                wave,
                tasks: [...list].sort(
                    (a, b) => (rows.get(a.id) ?? 0) - (rows.get(b.id) ?? 0),
                ),
            };
        });
});

const chain = computed(() => chainOf(selected.value));

function dimmed(id: string) {
    return Boolean(selected.value) && !chain.value.has(id);
}

function chained(link: { from: string; to: string }) {
    return (
        Boolean(selected.value) &&
        chain.value.has(link.from) &&
        chain.value.has(link.to)
    );
}

const wireLinks = computed(() =>
    laneLinks.value.map((link) => ({
        from: link.from,
        to: link.to,
        tone: chained(link) ? "spec" : link.artifact ? link.artifact.kind : "dep",
        dashed: link.artifact?.kind === "after",
    })),
);

const artifactByWire = computed(() => {
    const map = new Map<string, Artifact>();
    for (const link of laneLinks.value) {
        if (link.artifact) map.set(`${link.from}->${link.to}`, link.artifact);
    }
    return map;
});

interface WireSegment {
    key: string;
    mid: { x: number; y: number };
}

function labelsOf(segments: WireSegment[]) {
    const out: {
        key: string;
        x: number;
        y: number;
        text: string;
        tone: ArtifactKind;
        dot: boolean;
    }[] = [];
    for (const segment of segments) {
        const artifact = artifactByWire.value.get(segment.key);
        if (!artifact) continue;
        if (labelFilter.value !== "all" && artifact.kind !== labelFilter.value) continue;
        out.push({
            key: segment.key,
            x: segment.mid.x,
            y: segment.mid.y,
            text: artifact.short,
            tone: artifact.kind,
            dot: artifact.kind !== "after",
        });
    }
    return out;
}

const legendColor: Record<string, string> = {
    spec: "var(--accent)",
    file: "var(--ok)",
    run: "var(--high)",
    after: "var(--text-4)",
};

const legendItems = computed(() =>
    wireLegend.map((item) => ({
        text: item.text,
        color: legendColor[item.tone],
        mark: item.tone === "after" ? ("none" as const) : ("dot" as const),
    })),
);

const selectedWire = computed(() =>
    laneLinks.value.find((link) => link.to === selected.value),
);

const captionParts = computed(() => {
    const change = lane.kicker.match(/#\d+/)?.[0] ?? "";
    const parts: { text: string; mono?: boolean }[] = [
        { text: "ТЕМА · change" },
        { text: change, mono: true },
        { text: `· ${lane.title.toLowerCase()}` },
    ];
    for (const stat of graphStats.artifacts.split(" · ")) {
        const parsed = stat.match(/^(\d+)\s+(.+)$/);
        parts.push({ text: "·" });
        if (parsed) {
            parts.push({ text: parsed[1], mono: true });
            parts.push({ text: parsed[2] });
        } else {
            parts.push({ text: stat });
        }
    }
    return parts;
});

function onCanvasClick(event: MouseEvent) {
    const el = event.target as HTMLElement | null;
    if (el?.closest(".node-card, .node-inspector")) return;
    selected.value = "";
}

function onGraphMode(value: string) {
    if (value === "deps") {
        emit("mode", "lanes");
        return;
    }
    graphMode.value = value;
}
</script>

<template>
    <ToolBar>
        <SegControl
            :model-value="graphMode"
            :options="[
                { id: 'both', label: 'Зависимости + артефакты' },
                { id: 'deps', label: 'Только зависимости' },
                { id: 'dsl', label: 'Только DSL' },
            ]"
            @update:model-value="onGraphMode"
        />
        <span class="wires-field">Подписи проводов</span>
        <SegControl
            v-model="labelFilter"
            :options="[
                { id: 'all', label: 'все' },
                { id: 'spec', label: 'spec' },
                { id: 'file', label: 'file' },
                { id: 'handoff', label: 'handoff' },
            ]"
        />
        <ToolButton :active="portsOn" @click="portsOn = !portsOn">
            Порты на карточках
        </ToolButton>
        <ToolButton variant="cost" :active="costOn" @click="costOn = !costOn">
            $ Слой прогона
        </ToolButton>
        <template #right>
            <ToolButton variant="warn">⚠ lint: 2</ToolButton>
            <ToolButton>Открыть исходник</ToolButton>
        </template>
    </ToolBar>

    <LegendBar :items="legendItems">
        <template #right>
            <span v-if="selectedWire" class="wires-selected">
                <span>выбран провод:</span>
                <span class="pipe-mono wires-selected-ids">
                    {{ selectedWire.from }} → {{ selectedWire.to }}
                </span>
                <span v-if="selectedWire.artifact" class="pipe-mono wires-selected-path">
                    · {{ selectedWire.artifact.address }}
                </span>
            </span>
        </template>
    </LegendBar>

    <div class="pipe-canvas" @click="onCanvasClick">
        <div class="wires-caption">
            <span
                v-for="(part, i) in captionParts"
                :key="i"
                :class="{ 'pipe-mono': part.mono }"
            >
                {{ part.text }}
            </span>
        </div>

        <LaneFrame ref="frame" class="wires-lane" tone="theme">
            <template #rail>
                <LaneRail
                    :kicker="lane.kicker"
                    :title="lane.title"
                    :progress="lane.progress"
                    :progress-label="lane.progressLabel"
                    :cost="lane.cost"
                    :duration="lane.duration"
                    tone="theme"
                >
                    <div class="rail-artifacts">
                        <Kicker>артефакты темы</Kicker>
                        <div
                            v-for="(line, i) in lane.artifactSummary"
                            :key="i"
                            class="rail-artifacts-line"
                        >
                            {{ line }}
                        </div>
                    </div>
                </LaneRail>
            </template>

            <WireLayer :container="body" :links="wireLinks" attr="data-node">
                <template #default="{ segments }">
                    <WireLabel
                        v-for="label in labelsOf(segments)"
                        :key="label.key"
                        :x="label.x"
                        :y="label.y"
                        :text="label.text"
                        :tone="label.tone"
                        :dot="label.dot"
                    />
                </template>
            </WireLayer>

            <div class="wires-columns">
                <WaveColumn
                    v-for="column in columns"
                    :key="column.wave"
                    :head="`волна ${column.wave}`"
                    :width="columnWidth"
                >
                    <NodeCard
                        v-for="task in column.tasks"
                        :key="task.id"
                        :class="{ 'wires-dim': dimmed(task.id) }"
                        :data-node="task.id"
                        :id="task.id"
                        :title="task.title"
                        :status="task.status"
                        :auto="task.auto"
                        :done="task.done"
                        :active="task.active"
                        :selected="selected === task.id"
                        :ports="portsOn ? task.ports : undefined"
                        :warn="task.warn"
                        :cost="costOn ? task.cost : undefined"
                        :cost-note="costOn ? task.costNote : undefined"
                        :cost-share="costOn ? task.costShare : undefined"
                        @click="selected = task.id"
                        @dblclick="emit('open', task.id)"
                    />
                </WaveColumn>
            </div>
        </LaneFrame>

        <NodeInspector
            v-if="selected"
            class="wires-inspector"
            :id="selected"
            @close="selected = ''"
            @pick="selected = $event"
            @open="emit('open', $event)"
        />
    </div>
</template>

<style scoped>
.wires-field {
    margin-left: 6px;
    font-size: 11px;
    color: var(--text-4);
}
.wires-selected {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-4);
}
.wires-selected-ids {
    color: var(--accent);
}
.wires-selected-path {
    color: var(--ok);
}
.wires-caption {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 5px;
    padding: 13px 22px 9px;
    font-size: 11px;
    color: var(--text-4);
}
.wires-lane {
    margin: 0 20px 20px;
}
.wires-dim {
    opacity: 0.4;
}
.wires-inspector {
    position: absolute;
    right: 20px;
    top: 14px;
    z-index: 7;
}
.wires-columns {
    display: flex;
    align-items: flex-start;
    gap: 134px;
    min-width: max-content;
}
.rail-artifacts {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.rail-artifacts-line {
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-4);
}
</style>
