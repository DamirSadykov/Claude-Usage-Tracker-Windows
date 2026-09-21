<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import ToolBar from "../../atoms/ToolBar.vue";
import LegendBar from "../../atoms/LegendBar.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SegControl from "../../atoms/SegControl.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import ProjectBand from "../../atoms/ProjectBand.vue";
import LaneFrame from "../../atoms/LaneFrame.vue";
import LaneRail from "../../atoms/LaneRail.vue";
import LanePort from "../../atoms/LanePort.vue";
import WaveColumn from "../../atoms/WaveColumn.vue";
import NodeCard from "../../atoms/NodeCard.vue";
import CollapsedCard from "../../atoms/CollapsedCard.vue";
import WireLayer from "../../atoms/WireLayer.vue";
import NodeInspector from "../NodeInspector.vue";
import { graphStats, chainOf } from "../mock";
import { useBoard } from "../useBoard";
import { isFreeLane } from "../adapt";
import type { ProjectBand as ProjectRow, TaskNode } from "../types";

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "bubbles" | "rings" | "specs"): void;
    (e: "open", id: string): void;
}>();

const { lanes, tasks, links, projects, nodeByLabel } = useBoard();

const linkMode = ref("deps");
const layoutMode = ref("lanes");
const costLayer = ref(false);
const hideDone = ref(false);
const selected = ref("");
const bodies = ref<Record<string, HTMLElement | null>>({});
const freeBodies = ref<Record<string, HTMLElement | null>>({});
const slots = ref<Record<string, HTMLElement | null>>({});
const flashed = ref("");
const wavePickerOpen = ref(false);
const folded = ref<string[]>([]);
const shownFlat = ref<Record<string, number>>({});
const FLAT_STEP = 12;
const groupOpen = ref(false);
const showDoneLanes = ref(false);

const allWaves = computed(() =>
    [...new Set(tasks.value.map((task) => task.wave))].sort((a, b) => a - b),
);
const shownWaves = ref<number[]>([]);

watch(
    allWaves,
    (waves) => {
        const known = new Set(waves);
        const kept = shownWaves.value.filter((wave) => known.has(wave));
        shownWaves.value = kept.length ? kept : [...waves];
    },
    { immediate: true },
);

const waveLabel = computed(() => {
    const picked = [...shownWaves.value].sort((a, b) => a - b);
    if (!picked.length) return "Волны: ни одной";
    if (picked.length === allWaves.value.length)
        return `Волны ${picked[0]}–${picked[picked.length - 1]}`;
    return `Волны ${picked.join(", ")}`;
});

const legendItems = [
    { text: "заблокирована — ждёт предшественника", color: "var(--crit)" },
    { text: "готова — auto-нода, runner может взять", color: "var(--ok)" },
    { text: "готова — ждёт тебя (ручной гейт)", color: "var(--theme)" },
    { text: "на проверке — сделана, ждёт приёмки", color: "var(--accent)" },
    { text: "⚡ auto-нода", color: "var(--warn)", mark: "none" as const },
];

watch(linkMode, (value) => {
    if (value === "refs") emit("mode", "bubbles");
});

function bindLane(id: string, el: unknown) {
    const frame = el as { body?: HTMLElement | null } | null;
    bodies.value[id] = frame?.body ?? null;
}

function laneById(id: string) {
    return lanes.value.find((lane) => lane.id === id);
}

function laneBadge(id: string) {
    const lane = laneById(id);
    if (!lane || isFreeLane(lane.id)) return "без темы";
    return `#${lane.kicker.split("#")[1] ?? ""}`;
}

function lanesOf(project: ProjectRow) {
    return lanes.value.filter(
        (lane) => project.lanes.includes(lane.id) && !lane.done,
    );
}

const doneLanes = computed(() => lanes.value.filter((lane) => lane.done));

function projectOfLane(laneId: string) {
    return projects.value.find((p) => p.lanes.includes(laneId))?.name ?? "";
}

function visible(task: TaskNode) {
    if (hideDone.value && task.done) return false;
    return shownWaves.value.includes(task.wave);
}

function tasksOf(laneId: string) {
    return tasks.value.filter((task) => task.lane === laneId && visible(task));
}

function projectTasks(project: ProjectRow) {
    return tasks.value.filter(
        (task) => project.lanes.includes(task.lane) && visible(task),
    );
}

function wavesOf(laneId: string) {
    return [...new Set(tasksOf(laneId).map((task) => task.wave))].sort((a, b) => a - b);
}

function cardsOf(laneId: string, wave: number) {
    return tasksOf(laneId).filter((task) => task.wave === wave);
}

function freeWaves(project: ProjectRow) {
    return [...new Set(projectTasks(project).map((task) => task.wave))].sort(
        (a, b) => a - b,
    );
}

function freeCards(project: ProjectRow, wave: number) {
    return projectTasks(project).filter((task) => task.wave === wave);
}

const chain = computed(() => chainOf(selected.value, links.value));

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

function linksOf(laneId: string) {
    const ids = new Set(tasksOf(laneId).map((task) => task.id));
    return links.value
        .filter((link) => ids.has(link.from) && ids.has(link.to))
        .map((link) => ({
            from: link.from,
            to: link.to,
            tone: chained(link) ? "spec" : "dep",
        }));
}

function freeLinks(project: ProjectRow) {
    const ids = new Set(projectTasks(project).map((task) => task.id));
    return links.value
        .filter((link) => ids.has(link.from) && ids.has(link.to))
        .map((link) => ({
            from: link.from,
            to: link.to,
            tone: chained(link)
                ? "spec"
                : laneOfTask(link.from) === laneOfTask(link.to)
                  ? "dep"
                  : "spec",
        }));
}

function onCanvasClick(event: MouseEvent) {
    wavePickerOpen.value = false;
    const el = event.target as HTMLElement | null;
    if (el?.closest(".node-card, .node-inspector")) return;
    selected.value = "";
}

function laneOfTask(id: string) {
    return tasks.value.find((task) => task.id === id)?.lane ?? "";
}

function crossCount(laneId: string) {
    return links.value.filter(
        (link) =>
            (laneOfTask(link.from) === laneId) !== (laneOfTask(link.to) === laneId),
    ).length;
}

function portTarget(laneId: string) {
    return links.value
        .filter(
            (link) =>
                (laneOfTask(link.from) === laneId) !==
                (laneOfTask(link.to) === laneId),
        )
        .map((link) =>
            laneOfTask(link.from) === laneId
                ? laneOfTask(link.to)
                : laneOfTask(link.from),
        )
        .find(Boolean);
}

function portSub(laneId: string) {
    const target = portTarget(laneId);
    if (!target) return "";
    return `${laneBadge(target)} · ${crossCount(laneId)} связи`;
}

async function jumpToLane(laneId: string) {
    const target = portTarget(laneId);
    if (!target) return;
    const el = slots.value[target];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    flashed.value = target;
    await nextTick();
    window.setTimeout(() => {
        if (flashed.value === target) flashed.value = "";
    }, 1400);
}

function plural(count: number, one: string, few: string, many: string) {
    const tail = count % 10;
    const teen = count % 100;
    if (teen >= 11 && teen <= 14) return `${count} ${many}`;
    if (tail === 1) return `${count} ${one}`;
    if (tail >= 2 && tail <= 4) return `${count} ${few}`;
    return `${count} ${many}`;
}

function foldSummary(laneId: string) {
    return `${plural(tasksOf(laneId).length, "задача", "задачи", "задач")} · ${plural(
        wavesOf(laneId).length,
        "волна",
        "волны",
        "волн",
    )}`;
}

function isFolded(id: string) {
    return folded.value.includes(id);
}

function toggleFold(id: string) {
    folded.value = isFolded(id)
        ? folded.value.filter((x) => x !== id)
        : [...folded.value, id];
}

const STATUS_ORDER: Record<string, number> = {
    ready: 0,
    waiting: 1,
    blocked: 2,
    done: 3,
};

function isFlat(laneId: string) {
    return wavesOf(laneId).length <= 1;
}

function flatTasks(laneId: string) {
    return [...tasksOf(laneId)].sort((a, b) => {
        const byActive = Number(Boolean(b.active)) - Number(Boolean(a.active));
        if (byActive) return byActive;
        return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    });
}

function flatShown(laneId: string) {
    return flatTasks(laneId).slice(0, shownFlat.value[laneId] ?? FLAT_STEP);
}

function flatRest(laneId: string) {
    return Math.max(0, flatTasks(laneId).length - flatShown(laneId).length);
}

function showMoreFlat(laneId: string) {
    shownFlat.value = {
        ...shownFlat.value,
        [laneId]: (shownFlat.value[laneId] ?? FLAT_STEP) + FLAT_STEP,
    };
}

function toggleWave(wave: number) {
    const set = new Set(shownWaves.value);
    if (set.has(wave)) set.delete(wave);
    else set.add(wave);
    shownWaves.value = [...set];
}

function allWavesOn() {
    shownWaves.value = [...allWaves.value];
}

function resetView() {
    linkMode.value = "deps";
    layoutMode.value = "lanes";
    costLayer.value = false;
    hideDone.value = false;
    selected.value = "";
    allWavesOn();
    wavePickerOpen.value = false;
    groupOpen.value = false;
    folded.value = [];
    shownFlat.value = {};
    showDoneLanes.value = false;
}
</script>

<template>
    <ToolBar>
        <SegControl
            v-model="linkMode"
            :options="[
                { id: 'deps', label: 'Зависимости' },
                { id: 'refs', label: 'Ссылки' },
            ]"
        />
        <SegControl
            v-model="layoutMode"
            :options="[
                { id: 'lanes', label: 'Дорожки по темам' },
                { id: 'canvas', label: 'Свободный холст' },
            ]"
        />
        <ToolButton
            variant="cost"
            :active="costLayer"
            @click="costLayer = !costLayer"
        >
            $ Слой прогона
        </ToolButton>
        <template #right>
            <div class="lanes-picker">
                <ToolButton
                    :active="shownWaves.length !== allWaves.length"
                    @click="wavePickerOpen = !wavePickerOpen"
                >
                    {{ waveLabel }}
                </ToolButton>
                <div v-if="wavePickerOpen" class="lanes-pop">
                    <div class="lanes-pop-head">Какие волны показывать</div>
                    <div class="lanes-pop-row">
                        <button
                            v-for="wave in allWaves"
                            :key="wave"
                            class="lanes-wave-chip"
                            :class="{ on: shownWaves.includes(wave) }"
                            @click="toggleWave(wave)"
                        >
                            {{ wave }}
                        </button>
                    </div>
                    <button class="lanes-pop-action" @click="allWavesOn">
                        показать все
                    </button>
                </div>
            </div>
            <ToolButton :active="hideDone" @click="hideDone = !hideDone">
                Свернуть готовое
            </ToolButton>
            <ToolButton @click="resetView">Сбросить вид</ToolButton>
        </template>
    </ToolBar>

    <LegendBar :items="legendItems">
        <template #right>
            <span class="lanes-stats">
                ⏱ {{ graphStats.active }} · {{ graphStats.spend }}
            </span>
        </template>
    </LegendBar>

    <div
        class="pipe-canvas"
        :class="{ 'lanes-shifted': selected }"
        @click="onCanvasClick"
    >
        <template v-for="project in projects" :key="project.name">
            <ProjectBand
                kicker="проект"
                :name="project.name"
                :meta="[project.tasks, project.cost]"
            />

            <div v-if="layoutMode === 'canvas'" class="pipe-section">
                <div
                    class="lanes-free"
                    :ref="(el: unknown) => (freeBodies[project.name] = el as HTMLElement)"
                >
                    <WireLayer
                        :container="freeBodies[project.name] ?? null"
                        :links="freeLinks(project)"
                    />
                    <div class="lanes-waves">
                        <WaveColumn
                            v-for="wave in freeWaves(project)"
                            :key="wave"
                            :head="`Волна ${wave}`"
                        >
                            <NodeCard
                                v-for="task in freeCards(project, wave)"
                                :key="task.id"
                                :class="{ 'lanes-dim': dimmed(task.id) }"
                                :data-node="task.id"
                                :id="task.id"
                                :title="task.title"
                                :status="task.status"
                                :auto="task.auto"
                                :done="task.done"
                                :active="task.active"
                                :selected="selected === task.id"
                                :cost="costLayer ? task.cost : undefined"
                                :cost-note="costLayer ? task.costNote : undefined"
                                :cost-share="costLayer ? task.costShare : undefined"
                                @click="selected = task.id"
                                @dblclick="emit('open', task.id)"
                            >
                                <MetaChip
                                    :text="laneBadge(task.lane)"
                                    :tone="isFreeLane(task.lane) ? 'muted' : 'theme'"
                                    mono
                                />
                            </NodeCard>
                        </WaveColumn>
                    </div>
                </div>
            </div>

            <div v-else class="pipe-section">
                <div
                    v-for="lane in lanesOf(project)"
                    :key="lane.id"
                    class="lanes-slot"
                    :class="{ flash: flashed === lane.id }"
                    :ref="(el: unknown) => (slots[lane.id] = el as HTMLElement)"
                >
                    <LaneFrame
                        :ref="(el: unknown) => bindLane(lane.id, el)"
                        :class="{ 'lanes-done': lane.done }"
                        :tone="lane.tone ?? 'plain'"
                    >
                        <template #rail>
                            <LaneRail
                                :kicker="lane.kicker"
                                :title="lane.title"
                                :note="lane.note"
                                :progress="lane.progress"
                                :progress-label="lane.progressLabel"
                                :cost="lane.cost"
                                :duration="lane.duration"
                                :tone="lane.tone === 'theme' ? 'theme' : 'plain'"
                            >
                                <MetaChip
                                    v-if="lane.done"
                                    text="тема закрыта"
                                    tone="ok"
                                />
                            </LaneRail>
                        </template>

                        <div v-if="isFolded(lane.id)" class="lanes-summary">
                            {{ foldSummary(lane.id) }}
                            <span class="lanes-more-action" @click="toggleFold(lane.id)">
                                развернуть
                            </span>
                        </div>

                        <div v-else-if="isFlat(lane.id)" class="lanes-grid-wrap">
                            <div class="lanes-grid">
                                <NodeCard
                                    v-for="task in flatShown(lane.id)"
                                    :key="task.id"
                                    :class="{ 'lanes-dim': dimmed(task.id) }"
                                    :data-node="task.id"
                                    :id="task.id"
                                    :title="task.title"
                                    :status="task.status"
                                    :auto="task.auto"
                                    :done="task.done"
                                    :active="task.active"
                                    :selected="selected === task.id"
                                    :cost="costLayer ? task.cost : undefined"
                                    :cost-note="costLayer ? task.costNote : undefined"
                                    :cost-share="costLayer ? task.costShare : undefined"
                                    @click="selected = task.id"
                                    @dblclick="emit('open', task.id)"
                                />
                            </div>
                            <div v-if="flatRest(lane.id)" class="lanes-grid-more">
                                ещё {{ flatRest(lane.id) }} без темы ·
                                <span
                                    class="lanes-more-action"
                                    @click="showMoreFlat(lane.id)"
                                    >показать</span
                                >
                                ·
                                <span
                                    class="lanes-more-action"
                                    @click.stop="groupOpen = true"
                                    >сгруппировать</span
                                >
                            </div>
                        </div>

                        <template v-else>
                        <WireLayer
                            :container="bodies[lane.id] ?? null"
                            :links="linksOf(lane.id)"
                        />

                        <div class="lanes-waves">
                            <WaveColumn
                                v-for="wave in wavesOf(lane.id)"
                                :key="wave"
                                :head="`Волна ${wave}`"
                            >
                                <NodeCard
                                    v-for="task in cardsOf(lane.id, wave)"
                                    :key="task.id"
                                    :class="{ 'lanes-dim': dimmed(task.id) }"
                                    :data-node="task.id"
                                    :id="task.id"
                                    :title="task.title"
                                    :status="task.status"
                                    :auto="task.auto"
                                    :done="task.done"
                                    :active="task.active"
                                    :selected="selected === task.id"
                                    :cost="costLayer ? task.cost : undefined"
                                    :cost-note="costLayer ? task.costNote : undefined"
                                    :cost-share="
                                        costLayer ? task.costShare : undefined
                                    "
                                    @click="selected = task.id"
                                    @dblclick="emit('open', task.id)"
                                />
                            </WaveColumn>

                            <div
                                v-for="(port, i) in (lane.ports ?? []).filter(
                                    (p) => p.side === 'right',
                                )"
                                :key="`port-${i}`"
                                class="lanes-aside lanes-port-slot"
                            >
                                <LanePort
                                    side="right"
                                    :label="port.label"
                                    :sub="portSub(lane.id)"
                                    :title="`${port.label} — ${crossCount(lane.id)} связи между дорожками`"
                                    @click="jumpToLane(lane.id)"
                                />
                            </div>

                            <div v-if="lane.tail" class="lanes-aside">
                                <CollapsedCard
                                    :label="lane.tail.label"
                                    :note="lane.tail.note"
                                />
                            </div>

                            <div v-if="lane.more" class="lanes-aside lanes-more">
                                {{ lane.more.text }}
                                <span
                                    class="lanes-more-action"
                                    @click.stop="groupOpen = !groupOpen"
                                    >{{ lane.more.action }}</span
                                >
                            </div>
                        </div>
                        </template>
                    </LaneFrame>

                    <button
                        class="lanes-fold"
                        :title="isFolded(lane.id) ? 'развернуть тему' : 'свернуть тему'"
                        @click="toggleFold(lane.id)"
                    >
                        {{ isFolded(lane.id) ? "▸" : "▾" }}
                    </button>

                    <LanePort
                        v-for="(port, i) in (lane.ports ?? []).filter(
                            (p) => p.side === 'left',
                        )"
                        :key="`left-${i}`"
                        class="lanes-port left"
                        side="left"
                        :label="port.label"
                        :sub="portSub(lane.id)"
                        :title="`${port.label} — ${crossCount(lane.id)} связи между дорожками`"
                        @click="jumpToLane(lane.id)"
                    />
                </div>
            </div>
        </template>

        <template v-if="doneLanes.length">
            <div class="lanes-done-band">
                <span class="lanes-done-kicker">закрытые темы</span>
                <span class="lanes-done-count">
                    {{ plural(doneLanes.length, "тема", "темы", "тем") }}
                </span>
                <button
                    class="lanes-done-toggle"
                    @click="showDoneLanes = !showDoneLanes"
                >
                    {{ showDoneLanes ? "скрыть" : "показать" }}
                </button>
            </div>

            <div v-if="showDoneLanes" class="pipe-section">
                <div
                    v-for="lane in doneLanes"
                    :key="lane.id"
                    class="lanes-slot"
                    :ref="(el: unknown) => (slots[lane.id] = el as HTMLElement)"
                >
                    <LaneFrame class="lanes-done" tone="plain">
                        <template #rail>
                            <LaneRail
                                :kicker="lane.kicker"
                                :title="lane.title"
                                :note="projectOfLane(lane.id)"
                                :progress-label="lane.progressLabel"
                                :cost="lane.cost"
                                :duration="lane.duration"
                                tone="plain"
                            >
                                <MetaChip text="тема закрыта" tone="ok" />
                            </LaneRail>
                        </template>

                        <div class="lanes-summary">
                            {{ foldSummary(lane.id) }} ·
                            <span
                                class="lanes-more-action"
                                @click="emit('open', lane.id)"
                                >открыть в доске</span
                            >
                        </div>
                    </LaneFrame>
                </div>
            </div>
        </template>

        <NodeInspector
            v-if="selected"
            class="lanes-inspector"
            :id="selected"
            :node="nodeByLabel.get(selected) ?? null"
            :cards="tasks"
            :edges="links"
            @close="selected = ''"
            @pick="selected = $event"
            @open="emit('open', $event)"
        />

        <div v-if="groupOpen" class="lanes-group">
            <div class="lanes-group-head">Сгруппировать свободные задачи</div>
            <p class="lanes-group-text">
                Разбор читает 62 задачи без темы и предлагает change'и: близкие по
                смыслу задачи собираются в тему, у темы появляется дельта спеки.
            </p>
            <p class="lanes-group-note">
                Фонового разбора под это пока нет. В трекере есть ночной триаж — он
                отдаёт сводку по доске, но темы не заводит; агента под группировку
                нужно заводить отдельно.
            </p>
            <div class="lanes-group-row">
                <ToolButton variant="pri" disabled>Запустить разбор</ToolButton>
                <ToolButton @click="groupOpen = false">Закрыть</ToolButton>
            </div>
        </div>

        <div class="pipe-spacer" />
    </div>
</template>

<style scoped>
.pipe-canvas {
    --lane-gap: 30px;
    position: relative;
}
.pipe-canvas.lanes-shifted {
    padding-right: 316px;
}
.lanes-stats {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-4);
    white-space: nowrap;
}
.lanes-fold {
    position: absolute;
    left: 168px;
    top: 12px;
    z-index: 3;
    width: 20px;
    height: 20px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--layer);
    color: var(--text-3);
    font: inherit;
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
}
.lanes-fold:hover {
    background: var(--layer-hover);
}
.lanes-summary {
    padding: 18px;
    font-size: 11.5px;
    color: var(--text-4);
}
.lanes-grid-wrap {
    padding: 14px 18px 18px;
}
.lanes-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(206px, 1fr));
    gap: 12px;
}
.lanes-grid-more {
    margin-top: 12px;
    font-size: 11.5px;
    color: var(--text-4);
}
.lanes-done {
    border-color: rgba(108, 203, 95, 0.28);
    background: rgba(108, 203, 95, 0.045);
}
.lanes-done-band {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 24px 6px;
    font-size: 11px;
    color: var(--text-4);
}
.lanes-done-kicker {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--ok);
}
.lanes-done-count {
    font-family: var(--mono);
}
.lanes-done-toggle {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
}
.lanes-slot {
    position: relative;
    border-radius: var(--r-card);
}
.lanes-slot + .lanes-slot {
    margin-top: 10px;
}
.lanes-slot.flash {
    box-shadow: 0 0 0 2px var(--accent);
}
.lanes-free {
    position: relative;
    padding: 14px 18px 18px;
    overflow-x: auto;
}
.lanes-waves {
    display: flex;
    align-items: flex-start;
    gap: var(--lane-gap);
    width: max-content;
}
.lanes-waves > * {
    flex: none;
}
.lanes-aside {
    align-self: center;
}
.lanes-port-slot {
    position: sticky;
    right: 4px;
    z-index: 3;
}
.lanes-more {
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--text-4);
    white-space: nowrap;
}
.lanes-more-action {
    color: var(--accent);
    cursor: pointer;
}
.lanes-port {
    position: absolute;
    z-index: 2;
}
.lanes-port.left {
    left: 14px;
    bottom: 14px;
}
.lanes-dim {
    opacity: 0.4;
}
.lanes-inspector {
    position: absolute;
    right: 20px;
    top: 14px;
    z-index: 7;
}
.lanes-picker {
    position: relative;
}
.lanes-pop {
    position: absolute;
    right: 0;
    top: 34px;
    z-index: 5;
    width: 208px;
    padding: 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.98);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.lanes-pop-head {
    margin-bottom: 8px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--text-4);
}
.lanes-pop-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 132px;
    overflow-y: auto;
}
.lanes-wave-chip {
    width: 30px;
    height: 26px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--layer);
    color: var(--text-3);
    font: inherit;
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
}
.lanes-wave-chip.on {
    background: var(--accent-soft);
    border-color: rgba(76, 194, 255, 0.45);
    color: var(--accent);
}
.lanes-pop-action {
    margin-top: 9px;
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
}
.lanes-group {
    position: absolute;
    right: 24px;
    bottom: 24px;
    z-index: 6;
    width: 320px;
    padding: 14px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.98);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.lanes-group-head {
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
}
.lanes-group-text {
    margin: 0 0 8px;
    font-size: 11.8px;
    line-height: 1.5;
    color: var(--text-3);
}
.lanes-group-note {
    margin: 0 0 12px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--warn);
}
.lanes-group-row {
    display: flex;
    gap: 8px;
}
</style>
