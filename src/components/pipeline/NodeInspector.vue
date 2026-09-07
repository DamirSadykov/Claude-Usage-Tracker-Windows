<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import Kicker from "../atoms/Kicker.vue";
import FocusRowItem from "../atoms/FocusRowItem.vue";
import ToolButton from "../atoms/ToolButton.vue";
import { formatDuration, formatMoney, moneyOf } from "./adapt";
import { links as mockLinks, runDetails, tasks as mockTasks } from "./mock";
import type { RunGraphNode } from "../../graphModel";
import type { TaskLink, TaskNode } from "./types";

const props = defineProps<{
    id: string;
    node?: Partial<RunGraphNode> | null;
    cards?: TaskNode[] | null;
    edges?: TaskLink[] | null;
}>();

const cards = computed(() => props.cards ?? mockTasks);
const links = computed(() => props.edges ?? mockLinks);

const emit = defineEmits<{
    (e: "close"): void;
    (e: "pick", id: string): void;
    (e: "open", id: string): void;
}>();

const BLANK: RunGraphNode = {
    id: "",
    number: 0,
    subject: "",
    status: "",
    gate: false,
    group: false,
    cost: null,
    duration_minutes: null,
    duration_calendar: false,
    measurability: "no_blocks",
    blocks: 0,
    tokens: null,
    messages: null,
    tool_calls: null,
    tool_errors: null,
    task_cost: null,
    unattributed_cost: null,
    agents: [],
};

const REASON: Record<string, string> = {
    no_in_progress: "задача не бралась в работу — блока нет",
    no_blocks: "сессия старше журнала привязок",
    empty_blocks: "блок вырожден — работа ушла в соседний",
};

const task = computed(() => cards.value.find((t) => t.id === props.id));
const detail = computed(() =>
    props.node === undefined ? runDetails[props.id] : props.node,
);
const node = computed<RunGraphNode>(() => ({ ...BLANK, ...(detail.value ?? {}) }));
const money = computed(() => moneyOf(node.value));

const reason = computed(() =>
    node.value.measurability === "measured"
        ? ""
        : (REASON[node.value.measurability] ?? "прогон не измерен"),
);

const preds = computed(() =>
    links.value.filter((link) => link.to === props.id).map((link) => link.from),
);
const succs = computed(() =>
    links.value.filter((link) => link.from === props.id).map((link) => link.to),
);
const specPorts = computed(() =>
    (task.value?.ports ?? []).filter((port) => port.kind === "spec"),
);

function titleOf(id: string) {
    return cards.value.find((t) => t.id === id)?.title ?? "";
}

function tokensText(value: number) {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
    return String(value);
}

function plural(count: number, one: string, few: string, many: string) {
    const tail = count % 10;
    const teen = count % 100;
    if (teen >= 11 && teen <= 14) return `${count} ${many}`;
    if (tail === 1) return `${count} ${one}`;
    if (tail >= 2 && tail <= 4) return `${count} ${few}`;
    return `${count} ${many}`;
}

function whoOf(agent: RunGraphNode["agents"][number]) {
    if (!agent.agent_id) return "главный цикл";
    return agent.description || agent.agent_type || "агент";
}

function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
    <div class="node-inspector" @click.stop>
        <div class="ni-head">
            <span class="ni-id">{{ id }}</span>
            <button type="button" class="ni-close" title="Закрыть" @click="emit('close')">
                ✕
            </button>
        </div>
        <div class="ni-title">{{ task?.title ?? "задача не на доске" }}</div>

        <div class="ni-sum">
            <span v-if="money.known" class="ni-money">{{ money.text }}</span>
            <span v-else class="ni-unknown">неизвестно</span>
            <span v-if="node.duration_minutes !== null">
                {{ formatDuration(node.duration_minutes) }}
                <span v-if="node.duration_calendar">*</span>
            </span>
            <span v-if="node.tokens !== null">{{ tokensText(node.tokens) }}</span>
            <span v-if="node.tool_calls !== null">
                {{ plural(node.tool_calls, "вызов", "вызова", "вызовов") }}
            </span>
            <span v-if="node.tool_errors" class="ni-err">
                {{ plural(node.tool_errors, "ошибка", "ошибки", "ошибок") }}
            </span>
        </div>
        <div v-if="money.reason" class="ni-reason">{{ money.reason }}</div>

        <div
            v-if="node.task_cost !== null || node.unattributed_cost !== null"
            class="ni-sum dim"
        >
            <span v-if="node.task_cost !== null">
                по задаче целиком {{ formatMoney(node.task_cost) }}
            </span>
            <span v-if="node.unattributed_cost !== null">
                вне блоков {{ formatMoney(node.unattributed_cost) }}
            </span>
        </div>

        <div class="ni-sec"><Kicker>Агенты</Kicker></div>
        <div v-if="!node.agents.length" class="ni-empty">прогонов не было</div>
        <div
            v-for="(agent, i) in node.agents"
            :key="agent.agent_id ?? `main-${i}`"
            class="ni-agent"
        >
            <i class="ni-dot" :class="{ sub: agent.agent_id }" />
            <span class="ni-who">{{ whoOf(agent) }}</span>
            <span class="ni-num">{{ formatMoney(agent.cost) }}</span>
            <span class="ni-num dim">{{ agent.messages }}✎</span>
        </div>

        <div class="ni-sec"><Kicker>Прогоны</Kicker></div>
        <div class="ni-line">{{ plural(node.blocks, "блок", "блока", "блоков") }}</div>
        <div v-if="reason" class="ni-reason">{{ reason }}</div>

        <div class="ni-sec">
            <Kicker>Связи</Kicker>
            <span class="ni-count">
                {{ preds.length }} ← · → {{ succs.length }}
            </span>
        </div>
        <div v-if="!preds.length && !succs.length" class="ni-empty">
            задача ни с чем не связана
        </div>
        <FocusRowItem
            v-for="pid in preds"
            :key="`in-${pid}`"
            :id="pid"
            :title="titleOf(pid)"
            count="←"
            @click="emit('pick', pid)"
        />
        <FocusRowItem
            v-for="sid in succs"
            :key="`out-${sid}`"
            :id="sid"
            :title="titleOf(sid)"
            count="→"
            @click="emit('pick', sid)"
        />

        <div class="ni-sec"><Kicker>Спека</Kicker></div>
        <div v-if="!specPorts.length" class="ni-empty">раздел не привязан</div>
        <div v-for="(port, i) in specPorts" :key="`${port.dir}-${i}`" class="ni-port">
            <span class="ni-dir" :class="{ write: port.dir === 'W' }">
                {{ port.dir }}
            </span>
            <span class="ni-addr">{{ port.label }}</span>
        </div>

        <ToolButton class="ni-open" @click="emit('open', id)">
            Открыть {{ id }} в доске
        </ToolButton>
    </div>
</template>

<style scoped>
.node-inspector {
    box-sizing: border-box;
    width: 300px;
    max-height: calc(100% - 28px);
    padding: 13px 14px 14px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.98);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    overflow-y: auto;
}
.ni-head {
    display: flex;
    align-items: center;
    gap: 8px;
}
.ni-id {
    flex: 1;
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
}
.ni-close {
    padding: 0 2px;
    border: 0;
    background: none;
    color: var(--text-4);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
}
.ni-close:hover {
    color: var(--text-2);
}
.ni-title {
    margin-top: 5px;
    font-size: 11.8px;
    line-height: 1.4;
    color: var(--text-3);
}
.ni-sum {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin-top: 10px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
}
.ni-sum.dim {
    margin-top: 5px;
    font-size: 11px;
    color: var(--text-4);
}
.ni-money {
    font-weight: 600;
    color: var(--text);
}
.ni-unknown {
    color: var(--text-4);
}
.ni-err {
    color: var(--crit);
}
.ni-reason {
    margin-top: 4px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-4);
}
.ni-sec {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin: 13px 0 5px;
}
.ni-count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-4);
}
.ni-empty {
    font-size: 11.5px;
    color: var(--text-4);
}
.ni-line {
    font-size: 11.5px;
    color: var(--text-2);
}
.ni-agent {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
}
.ni-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-4);
}
.ni-dot.sub {
    background: var(--accent);
}
.ni-who {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ni-num {
    flex: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
}
.ni-num.dim {
    color: var(--text-4);
}
.ni-port {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
}
.ni-dir {
    flex: none;
    width: 15px;
    text-align: center;
    border-radius: var(--r-pill);
    background: rgba(255, 255, 255, 0.06);
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-4);
}
.ni-dir.write {
    background: rgba(76, 194, 255, 0.12);
    color: var(--accent);
}
.ni-open {
    width: 100%;
    margin-top: 13px;
    justify-content: center;
}
.ni-addr {
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
