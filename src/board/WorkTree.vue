<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import WorkTraceCharts from "./WorkTraceCharts.vue";
import {
  aggregateTree,
  modelCallNode,
  modelCalls,
  nodeType,
  pathTo,
  singleCall,
  timelineBar,
  timelineScale,
  treeView,
  type ToolCallType,
  type WorkNode,
} from "./workTree";
type RawCall = {
  id: string;
  name: string;
  input: unknown;
  result?: { timestamp: string; content: unknown };
  subagent?: RawTree;
};
type RawTurn = {
  id: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  calls: RawCall[];
};
type RawTree = {
  sessionId?: string;
  transcriptPath: string;
  startedAt?: string;
  endedAt?: string;
  cost: number;
  turns: RawTurn[];
};
type RawSession = { session: string; source: string; tree: RawTree };
type RawEvent = { ts: string; kind: string };
type RawAttempt = { number: number; startedAt: string; endedAt: string; events?: RawEvent[]; sessions: RawSession[] };
type Payload = { sessions: RawSession[]; attempts: RawAttempt[] };
type NodeType = ToolCallType | "text";
const props = defineProps<{ task: string; heading?: string }>();
const { t } = useI18n();
const tree = ref<Payload | null>(null),
  loading = ref(false),
  error = ref(""),
  selected = ref<WorkNode | null>(null),
  root = ref<HTMLElement | null>(null),
  collapsed = ref<Set<string>>(new Set()),
  showTimeline = ref(false),
  headersOnly = ref(false);
const enabledTypes = ref<Set<NodeType>>(new Set(["read", "edit", "shell", "agent", "web", "other", "text"]));
const transcripts = new Map<string, string>();
const TYPES: NodeType[] = ["read", "edit", "shell", "agent", "web", "other", "text"];
function stamp(v?: string) {
  const n = v ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function text(v: unknown) {
  return typeof v === "string" ? v || null : v && typeof v === "object" ? JSON.stringify(v) : null;
}
function line(v: string | null) {
  return v?.split(/\r?\n/, 1)[0] || null;
}
function makeTree(raw: RawTree, session: string, prefix: string, role = t("workSession")): WorkNode {
  const models = raw.turns.map((turn) =>
    modelCallNode({
      id: `${prefix}:${turn.id}`,
      model: turn.model || null,
      startedAt: stamp(turn.timestamp),
      endedAt: turn.calls.reduce<number | null>(
        (end, call) => Math.max(end ?? 0, stamp(call.result?.timestamp) ?? 0),
        stamp(turn.timestamp),
      ),
      cost: turn.cost,
      tokenBreakdown: {
        input: turn.inputTokens,
        output: turn.outputTokens,
        cacheWrite: turn.cacheCreationTokens,
        cacheRead: turn.cacheReadTokens,
      },
      transcriptPath: raw.transcriptPath,
      calls: turn.calls.map((call) => ({
        id: `${prefix}:${call.id}`,
        name: call.name,
        input: text(call.input),
        result: call.result ? text(call.result.content) : null,
        startedAt: stamp(turn.timestamp),
        endedAt: stamp(call.result?.timestamp) ?? stamp(turn.timestamp),
        subagent: call.subagent ? makeTree(call.subagent, session, `${prefix}:${call.id}:agent`) : null,
      })),
    }),
  );
  const node = aggregateTree({
    id: prefix,
    kind: "session" as const,
    name: `${role} · ${(raw.sessionId || session).slice(0, 8)}`,
    model: null,
    startedAt: stamp(raw.startedAt),
    endedAt: stamp(raw.endedAt),
    tokens: 0,
    cost: raw.cost,
    input: null,
    result: null,
    transcriptPath: raw.transcriptPath,
    children: models,
  });
  const visit = (n: WorkNode) => {
    transcripts.set(n.id, n.transcriptPath ?? raw.transcriptPath);
    n.children.forEach(visit);
  };
  visit(node);
  return node;
}
function roleOf(attempt: RawAttempt, raw: RawTree) {
  const done = stamp(attempt.events?.find((event) => event.kind === "worker_done")?.ts),
    start = stamp(raw.startedAt);
  return done !== null && start !== null && start >= done ? t("workRoleReviewer") : t("workRoleWorker");
}
const roots = computed(() => {
  transcripts.clear();
  if (!tree.value) return [];
  const sessions = tree.value.sessions.map((entry) =>
    makeTree(entry.tree, entry.session, `session:${entry.session}:${entry.source}`),
  );
  const attempts = tree.value.attempts.map((attempt) =>
    aggregateTree({
      id: `attempt:${attempt.number}`,
      kind: "run" as const,
      name: `${t("workAttempt")} ${attempt.number}`,
      model: null,
      startedAt: stamp(attempt.startedAt),
      endedAt: stamp(attempt.endedAt),
      tokens: 0,
      cost: 0,
      input: null,
      result: null,
      transcriptPath: null,
      children: attempt.sessions.map((entry) =>
        makeTree(entry.tree, entry.session, `attempt:${attempt.number}:${entry.session}`, roleOf(attempt, entry.tree)),
      ),
    }),
  );
  return [...sessions, ...attempts];
});
const traceRoot = computed<WorkNode | null>(() =>
  roots.value.length
    ? aggregateTree({
        id: `task:${props.task}`,
        kind: "task",
        name: props.task,
        model: null,
        startedAt: null,
        endedAt: null,
        tokens: 0,
        cost: 0,
        input: null,
        result: null,
        transcriptPath: null,
        children: roots.value,
      })
    : null,
);
const visibleRoots = computed(() =>
  roots.value
    .map((n) => treeView(n, { types: enabledTypes.value, headersOnly: headersOnly.value }))
    .filter((n): n is WorkNode => n !== null),
);
const modelNumbers = computed(
  () => new Map(traceRoot.value ? modelCalls(traceRoot.value).map((node, index) => [node.id, index + 1]) : []),
);
const rows = computed(() => {
  const out: { node: WorkNode; depth: number; scale: ReturnType<typeof timelineScale>; modelNumber: number }[] = [];
  const visit = (n: WorkNode, depth: number, scale: ReturnType<typeof timelineScale>) => {
    out.push({ node: n, depth, scale, modelNumber: modelNumbers.value.get(n.id) ?? 0 });
    if (!collapsed.value.has(n.id) && !singleCall(n)) n.children.forEach((c) => visit(c, depth + 1, scale));
  };
  visibleRoots.value.forEach((n) => visit(n, 0, timelineScale(n)));
  return out;
});
const maxContext = computed(() => {
  const values: number[] = [];
  const visit = (node: WorkNode) => {
    if (node.kind === "model" && node.tokenBreakdown)
      values.push(node.tokenBreakdown.input + node.tokenBreakdown.cacheRead + node.tokenBreakdown.cacheWrite);
    node.children.forEach(visit);
  };
  traceRoot.value?.children.forEach(visit);
  return Math.max(1, ...values);
});
function expandable(n: WorkNode) {
  return n.children.length > 0 && !singleCall(n);
}
function label(row: { node: WorkNode; modelNumber: number }) {
  const n = row.node,
    call = singleCall(n),
    number = n.sequence ?? row.modelNumber;
  if (call)
    return `${number}. ${n.sequence ? "" : `${call.name} `}${line(call.input) ?? (n.sequence ? call.name : "")}`;
  if (n.kind === "tool") return `${n.sequence}. ${line(n.input) ?? n.name}`;
  if (n.kind === "model") return `${number}. ${n.name || t("workTraceReply")}`;
  return n.name;
}
function usageOf(n: WorkNode) {
  return modelCalls(n).reduce(
    (sum, m) => ({
      input: sum.input + (m.tokenBreakdown?.input ?? 0),
      cacheRead: sum.cacheRead + (m.tokenBreakdown?.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (m.tokenBreakdown?.cacheWrite ?? 0),
      output: sum.output + (m.tokenBreakdown?.output ?? 0),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
}
function costLines(n: WorkNode) {
  const usage = n.kind === "model" && n.tokenBreakdown ? n.tokenBreakdown : usageOf(n),
    out = [
      `${t("workCostInput")}: ${tokenCount(usage.input) || 0}`,
      `${t("workCostCacheRead")}: ${tokenCount(usage.cacheRead) || 0}`,
      `${t("workCostCacheWrite")}: ${tokenCount(usage.cacheWrite) || 0}`,
      `${t("workCostOutput")}: ${tokenCount(usage.output) || 0}`,
    ];
  if (n.kind === "model" && n.cost > own(n)) out.push(`${t("workCostWithNested")}: ${cost(n.cost)}`);
  return out;
}
function costTitle(n: WorkNode) {
  return [`${t("workCost")} ${cost(own(n))}`, ...costLines(n), t("workCostHint")].join("\n");
}
function responseOf(n: WorkNode) {
  return n.kind === "tool" ? line(n.result) : singleCall(n) ? line(singleCall(n)!.result) : null;
}
function toggle(n: WorkNode) {
  if (!expandable(n)) return;
  const next = new Set(collapsed.value);
  next.has(n.id) ? next.delete(n.id) : next.add(n.id);
  collapsed.value = next;
  try {
    localStorage.setItem("work-tree:collapsed", JSON.stringify([...next]));
  } catch {}
}
function activate(n: WorkNode) {
  const same = selected.value?.id === n.id;
  selected.value = n;
  if (same) toggle(n);
}
function toggleType(type: NodeType) {
  const next = new Set(enabledTypes.value);
  next.has(type) ? next.delete(type) : next.add(type);
  enabledTypes.value = next;
}
function tokenCount(n: number) {
  return n ? new Intl.NumberFormat().format(n) : "";
}
function cost(n: number) {
  return `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
}
function own(n: WorkNode) {
  return n.ownCost ?? n.cost;
}
function icon(n: WorkNode) {
  return n.kind === "model" ? "●" : n.kind === "agent" ? "↳" : n.kind === "tool" ? "›" : n.kind === "group" ? "≡" : "◆";
}
function duration(n: WorkNode) {
  if (n.startedAt === null || n.endedAt === null) return "";
  const seconds = Math.max(0, Math.round((n.endedAt - n.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
async function load() {
  if (!props.task) return;
  loading.value = true;
  error.value = "";
  selected.value = null;
  try {
    tree.value = await invoke<Payload>("get_task_work_tree", { task: props.task });
  } catch (e) {
    tree.value = null;
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}
async function selectChart(id: string) {
  let path: WorkNode[] | null = null;
  for (const n of visibleRoots.value) path ??= pathTo(n, id);
  if (!path) {
    headersOnly.value = false;
    enabledTypes.value = new Set(TYPES);
    await nextTick();
    for (const n of visibleRoots.value) path ??= pathTo(n, id);
  }
  if (!path) return;
  const next = new Set(collapsed.value);
  path.slice(0, -1).forEach((n) => next.delete(n.id));
  collapsed.value = next;
  selected.value = path[path.length - 1];
  await nextTick();
  root.value
    ?.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function reveal() {
  const path = selected.value && transcripts.get(selected.value.id);
  if (!path) return;
  try {
    await invoke("reveal_work_transcript", { transcriptPath: path });
  } catch (e) {
    error.value = String(e);
  }
}
watch(() => props.task, load, { immediate: true });
watch(
  roots,
  () => {
    try {
      const saved = JSON.parse(localStorage.getItem("work-tree:collapsed") ?? "[]");
      collapsed.value = Array.isArray(saved) ? new Set(saved) : new Set();
    } catch {
      collapsed.value = new Set();
    }
  },
  { immediate: true },
);
</script>
<template>
  <section class="work-tree-wrap">
    <h3 v-if="heading" class="work-heading">{{ heading }}</h3>
    <div v-if="loading" class="work-empty">{{ t("loading") }}</div>
    <div v-else-if="error" class="work-empty">{{ error }}</div>
    <div v-else-if="!roots.length" class="work-empty">{{ t("workEmpty") }}</div>
    <template v-else
      ><WorkTraceCharts :root="traceRoot" @select="selectChart" />
      <div class="work-controls">
        <fieldset>
          <legend>{{ t("workTraceFilters") }}</legend>
          <label v-for="type in TYPES" :key="type"
            ><input type="checkbox" :checked="enabledTypes.has(type)" @change="toggleType(type)" />{{
              t(`workTraceType_${type}`)
            }}</label
          >
        </fieldset>
        <label><input v-model="headersOnly" type="checkbox" />{{ t("workTraceHeadersOnly") }}</label
        ><label><input v-model="showTimeline" type="checkbox" />{{ t("workTraceTimeline") }}</label>
      </div>
      <nav ref="root" class="work-tree" :class="{ timeline: showTimeline }">
        <button
          v-for="row in rows"
          :key="row.node.id"
          type="button"
          class="work-row"
          :class="{
            selected: selected?.id === row.node.id,
            expensive: own(row.node) >= 1,
            'model-row': row.node.kind === 'model',
          }"
          :style="{ '--depth': row.depth }"
          :data-work-id="row.node.id"
          @click="activate(row.node)"
        >
          <span
            class="toggle"
            :class="{ empty: !expandable(row.node), closed: collapsed.has(row.node.id) }"
            @click.stop="toggle(row.node)"
          /><span>{{ icon(row.node) }}</span
          ><span class="name">{{ label(row) }}</span
          ><span v-if="row.node.kind === 'model'" class="type-label">{{
            t(`workTraceType_${nodeType(row.node)}`)
          }}</span
          ><span v-if="row.node.kind === 'tool' && line(row.node.input)" class="meta">{{ row.node.name }}</span
          ><span v-if="row.node.sequence && row.modelNumber" class="meta">#{{ row.modelNumber }}</span
          ><span v-if="row.node.model && !row.node.sequence" class="meta">{{ row.node.model }}</span
          ><span
            v-if="row.node.tokenBreakdown"
            class="context"
            :title="`${t('workTraceContext')}: ${tokenCount(row.node.tokenBreakdown.input + row.node.tokenBreakdown.cacheRead + row.node.tokenBreakdown.cacheWrite)}`"
            ><i
              :style="{
                width: `${Math.max(4, ((row.node.tokenBreakdown.input + row.node.tokenBreakdown.cacheRead + row.node.tokenBreakdown.cacheWrite) / maxContext) * 100)}%`,
              }"
            />{{
              tokenCount(
                row.node.tokenBreakdown.input + row.node.tokenBreakdown.cacheRead + row.node.tokenBreakdown.cacheWrite,
              )
            }}</span
          ><span v-if="own(row.node)" class="cost" :title="costTitle(row.node)">{{ cost(own(row.node)) }}</span
          ><span v-if="expandable(row.node)" class="meta">{{ row.node.children.length }}</span
          ><span v-if="duration(row.node)" class="meta" :title="t('workTraceDuration')">{{ duration(row.node) }}</span
          ><span v-if="showTimeline && timelineBar(row.node, row.scale)" class="bar"
            ><i
              :style="{
                left: `${timelineBar(row.node, row.scale)?.start}%`,
                width: `${timelineBar(row.node, row.scale)?.width}%`,
              }" /></span
          ><span v-if="responseOf(row.node)" class="response">{{ responseOf(row.node) }}</span>
        </button>
      </nav>
      <aside v-if="selected" class="details">
        <strong>{{ selected.name || t("workTraceReply") }}</strong
        ><template v-if="singleCall(selected)"
          ><b>{{ t("workTraceInput") }}</b>
          <pre>{{ singleCall(selected)!.input }}</pre>
          <template v-if="singleCall(selected)!.result"
            ><b>{{ t("workTraceResponse") }}</b>
            <pre>{{ line(singleCall(selected)!.result) }}</pre>
          </template></template
        ><span v-if="selected.model">{{ selected.model }}</span
        ><template v-if="selected.input"
          ><b>{{ t("workTraceInput") }}</b>
          <pre>{{ selected.input }}</pre></template
        ><template v-if="selected.result"
          ><b>{{ t("workTraceResponse") }}</b>
          <pre>{{ line(selected.result) }}</pre></template
        ><template v-if="own(selected)"
          ><b>{{ t("workCost") }} {{ cost(own(selected)) }}</b>
          <ul class="cost-lines">
            <li v-for="item in costLines(selected)" :key="item">{{ item }}</li>
          </ul>
          <small>{{ t("workCostHint") }}</small></template
        ><button v-if="transcripts.get(selected.id)" type="button" @click="reveal">
          {{ t("workRevealTranscript") }}
        </button>
      </aside></template
    >
  </section>
</template>
<style scoped>
.work-tree-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.work-heading {
  font-size: 14px;
  margin: 4px 0;
}
.work-empty {
  color: var(--text-4);
  font-size: 13px;
  padding: 8px;
}
.work-controls,
.work-controls fieldset {
  align-items: center;
  border: 0;
  display: flex;
  flex-wrap: wrap;
  font-size: 12px;
  gap: 8px;
  margin: 0;
  padding: 0;
}
.work-controls legend {
  color: var(--text-3);
  margin-right: 5px;
}
.work-controls input {
  margin: 0 3px 0 0;
}
.work-tree {
  border: 1px solid var(--stroke-strong);
  border-radius: var(--r-ctl);
  max-height: 370px;
  overflow: auto;
}
.work-row {
  --indent: calc(var(--depth) * 15px);
  align-items: center;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: grid;
  font: inherit;
  font-size: 13px;
  gap: 6px;
  grid-template-columns: 10px 13px minmax(90px, 1fr) auto auto auto auto auto auto;
  min-height: 29px;
  padding: 4px 8px 4px calc(8px + var(--indent));
  text-align: left;
  width: 100%;
}
.work-tree.timeline .work-row {
  grid-template-columns: 10px 13px minmax(90px, 1fr) auto auto auto auto auto auto minmax(70px, 22%);
}
.work-row:hover {
  background: var(--card-bg-hover);
}
.work-row.selected {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 var(--accent);
}
.model-row {
  background: color-mix(in srgb, var(--accent-soft) 38%, transparent);
}
.toggle:before {
  color: var(--text-3);
  content: "▾";
}
.toggle.closed:before {
  content: "▸";
}
.toggle.empty:before {
  content: "";
}
.name,
.response {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type-label {
  background: var(--accent-soft);
  border-radius: 9px;
  color: var(--accent);
  font-size: 12px;
  padding: 1px 5px;
  white-space: nowrap;
}
.context {
  align-items: center;
  color: var(--text-3);
  display: flex;
  font-family: var(--mono, monospace);
  font-size: 12px;
  gap: 4px;
  min-width: 62px;
}
.context:before {
  background: color-mix(in srgb, var(--stroke-strong) 60%, transparent);
  content: "";
  height: 5px;
  position: absolute;
  width: 34px;
}
.context i {
  background: var(--accent);
  display: block;
  height: 5px;
  min-width: 2px;
  position: relative;
}
.response {
  color: var(--text-3);
  font-size: 12px;
  grid-column: 3/-1;
}
.meta,
.cost {
  color: var(--text-3);
  font-family: var(--mono, monospace);
  font-size: 12px;
}
.expensive .cost {
  color: var(--high);
  font-weight: 700;
}
.bar {
  background: color-mix(in srgb, var(--stroke-strong) 60%, transparent);
  display: block;
  height: 7px;
  overflow: hidden;
  position: relative;
}
.bar i {
  background: var(--accent);
  border-radius: 4px;
  display: block;
  height: 100%;
  position: absolute;
}
.expensive .bar i {
  background: var(--high);
}
.details {
  border: 1px solid var(--stroke-strong);
  border-radius: var(--r-ctl);
  display: flex;
  flex-direction: column;
  font-size: 13px;
  gap: 6px;
  padding: 9px;
}
.cost-lines {
  font-family: var(--mono, monospace);
  margin: 0;
  padding-left: 16px;
}
.details small {
  color: var(--text-3);
}
.details pre {
  background: rgba(0, 0, 0, 0.16);
  margin: 0;
  max-height: 130px;
  overflow: auto;
  padding: 7px;
  white-space: pre-wrap;
}
.details button {
  align-self: start;
  background: var(--node-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: var(--r-ctl);
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 5px 8px;
}
</style>
