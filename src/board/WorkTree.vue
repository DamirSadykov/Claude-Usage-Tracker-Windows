<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import WorkTraceCharts from "./WorkTraceCharts.vue";
import {
  aggregateTree,
  attemptReview,
  attemptReviewSummary,
  contextLabels,
  modelCallNode,
  modelCalls,
  nodeType,
  pathTo,
  singleCall,
  tokenCosts,
  treeView,
  typeSummary,
  type ToolCallType,
  type ContextLabel,
  type WorkContextInput,
  type AttemptReviewSummary,
  type ReviewLevel,
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
  agentType?: string | null;
  fork?: boolean;
  compacted?: boolean;
  compactionAt?: string[];
  turns: RawTurn[];
};
type RawContext = WorkContextInput & { role?: "worker" | "review" | null };
type RawSession = { session: string; source: string; tree: RawTree; context: RawContext };
type RawAttempt = { number: number; startedAt: string; endedAt: string; sessions: RawSession[]; result?: string; review?: unknown };
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
function makeTree(raw: RawTree, session: string, prefix: string, context?: RawContext): WorkNode {
  const labels = contextLabels(context),
    role =
      context?.role === "worker"
        ? t("workRoleWorker")
        : context?.role === "review"
          ? t("workRoleReviewer")
          : t("workSession"),
    parentTask = context?.parentTask ?? Number.parseInt(props.task.replace(/^#/, ""), 10);
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
      calls: turn.calls.map((call) => {
        const subagentContext: RawContext | undefined = call.subagent
          ? {
              mode: call.subagent.fork || call.subagent.agentType === "fork" ? "fork" : "fresh",
              agentType: call.subagent.agentType,
              fork: call.subagent.fork,
              parentTask: Number.isFinite(parentTask) ? parentTask : null,
              parentSession: raw.sessionId || session,
              compacted: call.subagent.compacted,
            }
          : undefined;
        return {
          id: `${prefix}:${call.id}`,
          name: call.name,
          input: text(call.input),
          result: call.result ? text(call.result.content) : null,
          startedAt: stamp(turn.timestamp),
          endedAt: stamp(call.result?.timestamp) ?? stamp(turn.timestamp),
          subagent: call.subagent
            ? makeTree(call.subagent, session, `${prefix}:${call.id}:agent`, subagentContext)
            : null,
        };
      }),
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
    contextLabels: labels,
    role: context?.role ?? null,
    compactionAt: (raw.compactionAt ?? []).map(stamp).filter((at): at is number => at !== null),
  });
  const visit = (n: WorkNode) => {
    transcripts.set(n.id, n.transcriptPath ?? raw.transcriptPath);
    n.children.forEach(visit);
  };
  visit(node);
  return node;
}
const roots = computed(() => {
  transcripts.clear();
  if (!tree.value) return [];
  const sessions = tree.value.sessions.map((entry) =>
    makeTree(entry.tree, entry.session, `session:${entry.session}:${entry.source}`, entry.context),
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
      result: attempt.result ?? null,
      transcriptPath: null,
      review: attemptReview(attempt.review),
      children: attempt.sessions.map((entry) =>
        makeTree(entry.tree, entry.session, `attempt:${attempt.number}:${entry.session}`, entry.context),
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
  const out: { node: WorkNode; depth: number; modelNumber: number }[] = [];
  const visit = (n: WorkNode, depth: number) => {
    out.push({ node: n, depth, modelNumber: modelNumbers.value.get(n.id) ?? 0 });
    if (!collapsed.value.has(n.id) && !singleCall(n)) n.children.forEach((c) => visit(c, depth + 1));
  };
  visibleRoots.value.forEach((n) => visit(n, 0));
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
const typeMetrics = computed(() => new Map(traceRoot.value ? typeSummary(traceRoot.value).map((item) => [item.type, item]) : []));
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
function contextText(label: ContextLabel) {
  if (label.kind === "inherits")
    return [
      t("workContextInheritsFrom"),
      label.parentTask ? `t#${label.parentTask}` : null,
      label.parentSession ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
  return t(`workContext${label.kind[0].toUpperCase()}${label.kind.slice(1)}`);
}
function contextTitle(label: ContextLabel) {
  return t(`workContext${label.kind[0].toUpperCase()}${label.kind.slice(1)}Hint`);
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
    prices = tokenCosts(n.model, usage),
    out = [
      `${t("workCostInput")}: ${tokenCount(usage.input) || 0} · ${cost(prices.inputCost)}`,
      `${t("workCostCacheRead")}: ${tokenCount(usage.cacheRead) || 0} · ${cost(prices.cacheReadCost)}`,
      `${t("workCostCacheWrite")}: ${tokenCount(usage.cacheWrite) || 0} · ${cost(prices.cacheWriteCost)}`,
      `${t("workCostOutput")}: ${tokenCount(usage.output) || 0} · ${cost(prices.outputCost)}`,
    ];
  if (n.kind === "model" && n.cost > own(n)) out.push(`${t("workCostWithNested")}: ${cost(n.cost)}`);
  return out;
}
function inspectorResponse(response: string | null) {
  return response?.trim() === "Script completed" ? null : response;
}
function costTitle(n: WorkNode) {
  return [`${t("workCost")} ${cost(own(n))}`, ...costLines(n), t("workCostHint")].join("\n");
}
function responseOf(n: WorkNode) {
  const response = n.kind === "tool" ? line(n.result) : singleCall(n) ? line(singleCall(n)!.result) : null;
  return response === "Script completed" ? null : response;
}
function reviewText(n: WorkNode) {
  const summary = attemptReviewSummary(n.result, n.review);
  if (!summary) return "";
  const findings = summary.counts.critical + summary.counts.high + summary.counts.medium + summary.counts.low;
  return summary.passed ? t("todoReviewApproved") : `${t("todoReviewFindings")} ${findings}`;
}
const selectedReview = computed<AttemptReviewSummary | null>(() => {
  if (!selected.value || !traceRoot.value) return null;
  const path = pathTo(traceRoot.value, selected.value.id);
  if (!path) return null;
  const attempt = [...path].reverse().find((node) => node.kind === "run");
  if (!attempt || (selected.value.kind !== "run" && selected.value.role !== "review")) return null;
  return attemptReviewSummary(attempt.result, attempt.review);
});
const reviewLevels: readonly ReviewLevel[] = ["critical", "high", "medium", "low"];
function findingLocation(finding: AttemptReviewSummary["findings"][number]) {
  return finding.file ? `${finding.file}${finding.line === null ? "" : `:${finding.line}`}` : "";
}
async function copyInput() {
  const source = singleCall(selected.value!)?.input ?? selected.value?.input;
  if (source) await navigator.clipboard.writeText(source);
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
function percent(value: number) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value);
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
        <div class="type-chips">
          <button v-for="type in TYPES" :key="type" type="button" :disabled="!typeMetrics.get(type)" :class="{ off: !enabledTypes.has(type) }" @click="toggleType(type)">
            <i :class="`type-${type}`">●</i>{{ t(`workTraceType_${type}`) }} · {{ typeMetrics.get(type)?.nodes ?? 0 }} · {{ cost(typeMetrics.get(type)?.cost ?? 0) }} · {{ percent(typeMetrics.get(type)?.share ?? 0) }}
          </button>
        </div>
        <label><input v-model="headersOnly" type="checkbox" />{{ t("workTraceHeadersOnly") }}</label>
      </div>
      <div class="trace-body"><nav ref="root" class="work-tree">
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
          ><span
            v-for="context in row.node.contextLabels"
            :key="context.kind"
            class="type-label"
            :title="contextTitle(context)"
            >{{ contextText(context) }}</span
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
            ><span class="track"
              ><i
                :style="{
                  width: `${Math.max(4, ((row.node.tokenBreakdown.input + row.node.tokenBreakdown.cacheRead + row.node.tokenBreakdown.cacheWrite) / maxContext) * 100)}%`,
                }" /></span
            >{{
              tokenCount(
                row.node.tokenBreakdown.input + row.node.tokenBreakdown.cacheRead + row.node.tokenBreakdown.cacheWrite,
              )
            }}</span
          ><span v-if="own(row.node)" class="cost" :title="costTitle(row.node)">{{ cost(own(row.node)) }}</span
          ><span v-if="expandable(row.node)" class="meta">{{ row.node.children.length }}</span
          ><span v-if="duration(row.node)" class="meta" :title="t('workTraceDuration')">{{ duration(row.node) }}</span
          ><span v-if="responseOf(row.node)" class="response">{{ responseOf(row.node) }}</span>
          <span v-if="row.node.kind === 'run' && reviewText(row.node)" class="review" @click.stop="activate(row.node)">{{ reviewText(row.node) }}</span>
        </button>
      </nav>
      <aside v-if="selected" class="details">
        <strong>{{ selected.name || t("workTraceReply") }}</strong
        ><section v-if="selectedReview" class="review-summary">
          <b>{{ t("todoReview") }}</b>
          <span>{{ selectedReview.passed ? t("todoReviewApproved") : t("todoReviewFindings") }}</span>
          <div class="review-counts">
            <span v-for="level in reviewLevels" :key="level" class="review-count" :class="`review-${level}`">{{ t(`workReviewLevel_${level}`) }} · {{ selectedReview.counts[level] }}</span>
          </div>
          <ul v-if="selectedReview.findings.length" class="review-findings">
            <li v-for="finding in selectedReview.findings" :key="`${finding.level}:${finding.file}:${finding.line}:${finding.text}`">
              <span class="finding-level" :class="finding.level ? `review-${finding.level}` : 'review-unknown'">{{ finding.level ? t(`workReviewLevel_${finding.level}`) : t("workReviewLevel_unknown") }}</span>
              <code v-if="findingLocation(finding)">{{ findingLocation(finding) }}</code>
              <span>{{ finding.text }}</span>
              <small v-if="finding.evidence">{{ finding.evidence }}</small>
            </li>
          </ul>
        </section>
        ><template v-if="singleCall(selected)"
          ><b>{{ t("workTraceInput") }}</b>
          <pre>{{ singleCall(selected)!.input }}</pre><button type="button" @click="copyInput">{{ t("workCopyInput") }}</button>
          <template v-if="inspectorResponse(singleCall(selected)!.result)"
            ><b>{{ t("workTraceResponse") }}</b>
            <pre>{{ inspectorResponse(singleCall(selected)!.result) }}</pre>
          </template></template
        ><span v-if="selected.model">{{ selected.model }}</span
        ><template v-if="selected.input"
          ><b>{{ t("workTraceInput") }}</b>
          <pre>{{ selected.input }}</pre><button type="button" @click="copyInput">{{ t("workCopyInput") }}</button></template
        ><template v-if="inspectorResponse(selected.result)"
          ><b>{{ t("workTraceResponse") }}</b>
          <pre>{{ inspectorResponse(selected.result) }}</pre></template
        ><template v-if="selected.tokenBreakdown"
          ><div class="token-stack"><i :style="{ flex: selected.tokenBreakdown.input }" /><i :style="{ flex: selected.tokenBreakdown.cacheRead }" /><i :style="{ flex: selected.tokenBreakdown.cacheWrite }" /><i :style="{ flex: selected.tokenBreakdown.output }" /></div></template
        ><template v-if="own(selected)"
          ><b>{{ t("workCost") }} {{ cost(own(selected)) }}</b>
          <ul class="cost-lines">
            <li v-for="item in costLines(selected)" :key="item">{{ item }}</li>
          </ul>
          <small>{{ t("workCostHint") }}</small></template
        ><button v-if="transcripts.get(selected.id)" type="button" @click="reveal">
          {{ t("workRevealTranscript") }}
        </button>
      </aside></div></template
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
.type-chips {
  align-items: center;
  border: 0;
  display: flex;
  flex-wrap: wrap;
  font-size: 12px;
  gap: 8px;
  margin: 0;
  padding: 0;
}
.work-controls input {
  margin: 0 3px 0 0;
}
.type-chips button {
  background: var(--node-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: var(--r-pill);
  color: var(--text-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 3px 7px;
}
.type-chips button.off { color: var(--text-3); opacity: .5; }
.type-chips i { font-style: normal; margin-right: 3px; }
.type-read { color: var(--accent); }.type-edit { color: var(--ok); }.type-shell { color: var(--warn); }.type-agent { color: var(--high); }.type-web { color: var(--accent-2); }.type-other, .type-text { color: var(--text-3); }
.trace-body { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(250px, .65fr); }
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
.review { color: var(--tree-review); font-size: 12px; grid-column: 3 / -1; }
.review-summary { border-bottom: 1px solid var(--stroke-strong); display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
.review-counts { display: flex; flex-wrap: wrap; gap: 4px; }
.review-count, .finding-level { border-radius: var(--r-pill); font-size: 11px; padding: 2px 6px; }
.review-critical { background: var(--crit); color: var(--text-2); }
.review-high { background: var(--high); color: var(--text-2); }
.review-medium { background: var(--warn); color: var(--text); }
.review-low { background: var(--accent-soft); color: var(--accent); }
.review-unknown { background: var(--node-bg); color: var(--text-3); }
.review-findings { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; }
.review-findings li { display: flex; flex-wrap: wrap; gap: 5px; }
.review-findings code { color: var(--text-2); font-family: var(--mono); font-size: 12px; }
.review-findings small { color: var(--text-3); flex-basis: 100%; }
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
  font-family: var(--mono);
  font-size: 12px;
  gap: 4px;
  min-width: 62px;
}
.context .track {
  background: color-mix(in srgb, var(--stroke-strong) 60%, transparent);
  display: block;
  height: 5px;
  width: 34px;
}
.context i {
  background: var(--accent);
  display: block;
  height: 100%;
  min-width: 2px;
}
.response {
  color: var(--text-3);
  font-size: 12px;
  grid-column: 3/-1;
}
.meta,
.cost {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 12px;
}
.expensive .cost {
  color: var(--high);
  font-weight: 700;
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
  font-family: var(--mono);
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
.token-stack { display: flex; height: 7px; overflow: hidden; width: 100%; }
.token-stack i:nth-child(1) { background: var(--accent); }.token-stack i:nth-child(2) { background: var(--accent-2); }.token-stack i:nth-child(3) { background: var(--warn); }.token-stack i:nth-child(4) { background: var(--high); }
@media (max-width: 720px) { .trace-body { grid-template-columns: 1fr; } }
</style>
