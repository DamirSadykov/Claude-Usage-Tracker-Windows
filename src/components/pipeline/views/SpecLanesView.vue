<script setup lang="ts">
import { computed, ref } from "vue";
import ToolBar from "../../atoms/ToolBar.vue";
import LegendBar from "../../atoms/LegendBar.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SegControl from "../../atoms/SegControl.vue";
import Kicker from "../../atoms/Kicker.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import ProjectBand from "../../atoms/ProjectBand.vue";
import LaneFrame from "../../atoms/LaneFrame.vue";
import WaveColumn from "../../atoms/WaveColumn.vue";
import RefCard from "../../atoms/RefCard.vue";
import SectionCard from "../../atoms/SectionCard.vue";
import FileRow from "../../atoms/FileRow.vue";
import WireLayer from "../../atoms/WireLayer.vue";
import { specLanes, orphanMiddle, graphStats } from "../mock";
import type { SpecLane } from "../types";

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "rings" | "specs"): void;
}>();

interface LaneWire {
    from: string;
    to: string;
    dashed?: boolean;
    [key: string]: unknown;
}

const layer = ref("links");
const layout = ref("sections");
const hideEmpty = ref(false);
const picked = ref("");
const bodies = ref<Record<string, HTMLElement | null>>({});

const legendItems = [
    { text: "сплошная: ссылка из текста задачи", mark: "line" as const },
    { text: "пунктир: обратная ссылка раздела", mark: "dash" as const },
    { text: "раздел спеки", color: "var(--accent)" },
    {
        text: "⚠ упомянутый файл не найден — spec/file-missing",
        mark: "none" as const,
        color: "var(--warn)",
    },
];

const sectionLanes = computed(() =>
    specLanes.filter((lane) => lane.id !== "orphan"),
);
const orphanLane = computed(() =>
    specLanes.find((lane) => lane.id === "orphan"),
);

const orphanWires: LaneWire[] = [
    { from: "orphan:in", to: "orphan:mid" },
    { from: "orphan:mid", to: "orphan:out" },
];

function bindFrame(id: string, el: unknown) {
    const instance = el as { body?: HTMLElement | null } | null;
    bodies.value[id] = instance?.body ?? null;
}

function laneWires(lane: SpecLane): LaneWire[] {
    const wires: LaneWire[] = [];
    for (const item of lane.incoming) {
        wires.push({ from: `${lane.id}:in:${item.id}`, to: `${lane.id}:section` });
    }
    for (const item of lane.outgoing) {
        wires.push({ from: `${lane.id}:section`, to: `${lane.id}:out:${item.id}` });
    }
    lane.files.forEach((_, index) => {
        const source = lane.outgoing[Math.min(index, lane.outgoing.length - 1)];
        if (!source) return;
        wires.push({
            from: `${lane.id}:out:${source.id}`,
            to: `${lane.id}:file:${index}`,
            dashed: true,
        });
    });
    return wires;
}

function onLayer(value: string) {
    if (value === "deps") {
        emit("mode", "lanes");
        return;
    }
    layer.value = value;
}

function onLayout(value: string) {
    if (value === "themes") {
        emit("mode", "lanes");
        return;
    }
    layout.value = value;
}

function pick(key: string) {
    picked.value = picked.value === key ? "" : key;
}

function reset() {
    picked.value = "";
    hideEmpty.value = false;
}
</script>

<template>
    <ToolBar>
        <SegControl
            :model-value="layer"
            :options="[
                { id: 'deps', label: 'Зависимости' },
                { id: 'links', label: 'Ссылки' },
            ]"
            @update:model-value="onLayer"
        />
        <SegControl
            :model-value="layout"
            :options="[
                { id: 'sections', label: 'Дорожки по разделам' },
                { id: 'themes', label: 'Дорожки по темам' },
                { id: 'canvas', label: 'Свободный холст' },
            ]"
            @update:model-value="onLayout"
        />
        <ToolButton variant="cost">$ Слой прогона</ToolButton>
        <template #right>
            <ToolButton :active="hideEmpty" @click="hideEmpty = !hideEmpty">
                Скрыть разделы без ссылок
            </ToolButton>
            <ToolButton @click="reset">Сбросить вид</ToolButton>
        </template>
    </ToolBar>

    <LegendBar :items="legendItems">
        <template #right>
            <span>{{ graphStats.refs }}</span>
        </template>
    </LegendBar>

    <div class="pipe-canvas">
        <ProjectBand
            kicker="домен спеки"
            name="tasks v5"
            :meta="['14 разделов', '4 открытых change\'а']"
        />

        <div class="pipe-section spec-stack">
            <LaneFrame
                v-for="lane in sectionLanes"
                :key="lane.id"
                :ref="(el) => bindFrame(lane.id, el)"
                :tone="lane.tone === 'warn' ? 'warn' : 'plain'"
            >
                <template #rail>
                    <div class="spec-rail" :class="{ warn: lane.tone === 'warn' }">
                        <Kicker
                            tone="accent"
                            :style="
                                lane.tone === 'warn'
                                    ? { color: 'var(--warn)' }
                                    : undefined
                            "
                        >
                            {{ lane.kicker }}
                        </Kicker>
                        <div class="rail-address">{{ lane.address }}</div>
                        <div v-if="lane.note" class="rail-note">{{ lane.note }}</div>
                        <div
                            v-if="lane.lintLabel"
                            class="rail-lint"
                            :class="{ warn: lane.lintTone === 'warn' }"
                        >
                            <span v-if="lane.lintTone === 'warn'" class="rail-tri"
                                >▲</span
                            >
                            <i v-else class="rail-dot" />
                            <span>{{ lane.lintLabel }}</span>
                        </div>
                        <div v-if="lane.metrics" class="rail-metrics">
                            <template v-for="(metric, i) in lane.metrics" :key="i">
                                <span v-if="i" class="rail-sep">·</span>
                                <span :class="{ accent: i === 0 }">{{ metric }}</span>
                            </template>
                        </div>
                    </div>
                </template>

                <WireLayer :container="bodies[lane.id]" :links="laneWires(lane)" />

                <div class="lane-cols">
                    <WaveColumn
                        :head="`ссылаются на раздел · ${lane.incoming.length}`"
                        :width="232"
                    >
                        <RefCard
                            v-for="item in lane.incoming"
                            :key="item.id"
                            :data-node="`${lane.id}:in:${item.id}`"
                            :id="item.id"
                            :title="item.title"
                            :state="item.state"
                            :class="{ picked: picked === `${lane.id}:in:${item.id}` }"
                            @click="pick(`${lane.id}:in:${item.id}`)"
                        />
                    </WaveColumn>

                    <WaveColumn head="раздел" :width="300">
                        <SectionCard
                            :data-node="`${lane.id}:section`"
                            :address="lane.address"
                            :title="lane.title"
                            :part="lane.part"
                            :part-warn="lane.partWarn"
                            :prose="lane.prose"
                            :tone="lane.tone === 'warn' ? 'warn' : 'spec'"
                            :selected="picked === `${lane.id}:section`"
                            @click="pick(`${lane.id}:section`)"
                        >
                            <template v-if="lane.chips" #chips>
                                <MetaChip
                                    v-for="chip in lane.chips"
                                    :key="chip.text"
                                    :text="chip.text"
                                    :tone="chip.tone"
                                />
                            </template>
                        </SectionCard>
                    </WaveColumn>

                    <WaveColumn
                        :head="`раздел ссылается · ${lane.outgoing.length}`"
                        :width="232"
                    >
                        <RefCard
                            v-for="item in lane.outgoing"
                            :key="item.id"
                            :data-node="`${lane.id}:out:${item.id}`"
                            :id="item.id"
                            :title="item.title"
                            :tone="item.tone"
                            muted
                            :class="{ picked: picked === `${lane.id}:out:${item.id}` }"
                            @click="pick(`${lane.id}:out:${item.id}`)"
                        />
                    </WaveColumn>

                    <WaveColumn
                        v-if="lane.files.length"
                        :head="`упомянутые файлы · ${lane.files.length}`"
                        :width="320"
                    >
                        <FileRow
                            v-for="(file, i) in lane.files"
                            :key="file.path"
                            :data-node="`${lane.id}:file:${i}`"
                            :path="file.path"
                            :anchor="file.anchor"
                            :exists="file.exists"
                            :note="file.note"
                        />
                    </WaveColumn>
                </div>
            </LaneFrame>
        </div>

        <div v-if="orphanLane && !hideEmpty" class="orphan-wrap">
            <LaneFrame :ref="(el) => bindFrame('orphan', el)" tone="plain">
                <template #rail>
                    <div class="spec-rail">
                        <Kicker>{{ orphanLane.kicker }}</Kicker>
                        <div class="rail-title">{{ orphanLane.title }}</div>
                        <div class="rail-note">{{ orphanLane.note }}</div>
                    </div>
                </template>

                <WireLayer :container="bodies.orphan" :links="orphanWires" />

                <div class="lane-cols">
                    <WaveColumn :width="232">
                        <RefCard
                            v-if="orphanLane.incoming[0]"
                            data-node="orphan:in"
                            :id="orphanLane.incoming[0].id"
                            :title="orphanLane.incoming[0].title"
                            :class="{ picked: picked === 'orphan:in' }"
                            @click="pick('orphan:in')"
                        />
                    </WaveColumn>
                    <WaveColumn :width="300">
                        <RefCard
                            data-node="orphan:mid"
                            :id="orphanMiddle.id"
                            :title="orphanMiddle.title"
                            :class="{ picked: picked === 'orphan:mid' }"
                            @click="pick('orphan:mid')"
                        />
                    </WaveColumn>
                    <WaveColumn :width="232">
                        <RefCard
                            v-if="orphanLane.outgoing[0]"
                            data-node="orphan:out"
                            :id="orphanLane.outgoing[0].id"
                            :title="orphanLane.outgoing[0].title"
                            :tone="orphanLane.outgoing[0].tone"
                            :class="{ picked: picked === 'orphan:out' }"
                            @click="pick('orphan:out')"
                        />
                    </WaveColumn>
                    <div v-if="orphanLane.more" class="orphan-more">
                        {{ orphanLane.more.text }}
                        <a>{{ orphanLane.more.action }}</a>
                    </div>
                </div>
            </LaneFrame>
        </div>

        <div class="pipe-spacer" />
    </div>
</template>

<style scoped>
.spec-stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.orphan-wrap {
    margin: 0 28px 14px;
}
.lane-cols {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 52px;
}
.spec-rail {
    flex: none;
    box-sizing: border-box;
    width: 196px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border-right: 1px solid var(--stroke);
    background: rgba(0, 0, 0, 0.14);
}
.rail-address {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--accent);
}
.spec-rail.warn .rail-address {
    color: var(--warn);
}
.rail-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.32;
    color: var(--text);
}
.rail-note {
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--text-4);
}
.rail-lint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--ok);
}
.rail-lint.warn {
    color: var(--warn);
}
.rail-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
}
.rail-tri {
    flex: none;
    font-size: 9px;
    line-height: 1;
}
.rail-metrics {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-4);
}
.rail-metrics .accent {
    color: var(--accent);
}
.rail-sep {
    opacity: 0.5;
}
.orphan-more {
    align-self: center;
    padding-top: 4px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--text-4);
}
.orphan-more a {
    color: var(--accent);
    cursor: pointer;
}
.picked {
    box-shadow: 0 0 0 2px var(--accent);
}
</style>
