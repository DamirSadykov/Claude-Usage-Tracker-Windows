<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { collapseReadingNodes, isExpensiveNode, timelineBar, timelineScale, type WorkNode } from "./workTree";

type RawCall = { id: string; name: string; input: unknown; result?: { timestamp: string; content: unknown }; subagent?: RawTree };
type RawTurn = { id: string; timestamp: string; model: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number; calls: RawCall[] };
type RawTree = { sessionId?: string; transcriptPath: string; startedAt?: string; endedAt?: string; cost: number; turns: RawTurn[] };
type RawSession = { session: string; source: string; tree: RawTree };
type RawAttempt = { number: number; startedAt: string; endedAt: string; sessions: RawSession[] };
type Payload = { sessions: RawSession[]; attempts: RawAttempt[] };

const props = defineProps<{ task: string; heading?: string }>();
const { t } = useI18n();
const tree = ref<Payload | null>(null);
const loading = ref(false);
const error = ref("");
const selected = ref<WorkNode | null>(null);
const collapsed = ref<Set<string>>(new Set());
const root = ref<HTMLElement | null>(null);
const transcriptByNode = new Map<string, string>();
const COLLAPSED_KEY = "work-tree:collapsed";

function stamp(value?: string): number | null { const n = value ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : null; }
function tokens(turn: RawTurn): number { return turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens; }
function brief(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function shortCall(call: RawCall): string {
  const arg = brief(call.input);
  return arg ? `${call.name} · ${arg}` : call.name;
}
function makeTree(raw: RawTree, session: string, prefix: string): WorkNode {
  const turns = raw.turns.map((turn) => {
    const calls = turn.calls.map((call) => {
      const agent = call.subagent ? makeTree(call.subagent, session, `${prefix}:${call.id}:agent`) : null;
      const node: WorkNode = { id: `${prefix}:${call.id}`, kind: agent ? "agent" : "tool", name: shortCall(call), model: null, startedAt: stamp(turn.timestamp), endedAt: stamp(call.result?.timestamp) ?? stamp(turn.timestamp), tokens: 0, cost: 0, input: brief(call.input), result: call.result ? brief(call.result.content) : null, transcriptPath: agent?.transcriptPath ?? null, children: agent ? agent.children : [] };
      transcriptByNode.set(node.id, agent?.transcriptPath ?? raw.transcriptPath);
      return node;
    });
    const node: WorkNode = { id: `${prefix}:${turn.id}`, kind: "turn", name: t("workTurn"), model: turn.model || null, startedAt: stamp(turn.timestamp), endedAt: calls.reduce((end, call) => Math.max(end ?? 0, call.endedAt ?? 0), stamp(turn.timestamp)), tokens: tokens(turn), cost: turn.cost, input: null, result: null, transcriptPath: null, children: collapseReadingNodes(calls) };
    transcriptByNode.set(node.id, raw.transcriptPath);
    return node;
  });
  const node: WorkNode = { id: prefix, kind: "session", name: raw.sessionId || session, model: null, startedAt: stamp(raw.startedAt), endedAt: stamp(raw.endedAt), tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0), cost: raw.cost, input: null, result: null, transcriptPath: raw.transcriptPath, children: turns };
  transcriptByNode.set(node.id, raw.transcriptPath);
  return node;
}
const roots = computed(() => {
  transcriptByNode.clear();
  const data = tree.value;
  if (!data) return [];
  const direct = data.sessions.map((entry) => makeTree(entry.tree, entry.session, `session:${entry.session}:${entry.source}`));
  const attempts = data.attempts.map((attempt) => ({ id: `attempt:${attempt.number}`, kind: "run" as const, name: `${t("workAttempt")} ${attempt.number}`, model: null, startedAt: stamp(attempt.startedAt), endedAt: stamp(attempt.endedAt), tokens: 0, cost: 0, input: null, result: null, transcriptPath: null, children: attempt.sessions.map((entry) => makeTree(entry.tree, entry.session, `attempt:${attempt.number}:${entry.session}`)) }));
  return [...direct, ...attempts];
});
type Row = { node: WorkNode; depth: number; scale: ReturnType<typeof timelineScale> };
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const visit = (node: WorkNode, depth: number, scale: ReturnType<typeof timelineScale>) => { out.push({ node, depth, scale }); if (!collapsed.value.has(node.id)) node.children.forEach((child) => visit(child, depth + 1, scale)); };
  roots.value.forEach((node) => visit(node, 0, timelineScale(node)));
  return out;
});
function restore(): Set<string> { try { const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"); return Array.isArray(saved) ? new Set(saved.filter((id): id is string => typeof id === "string")) : new Set(); } catch { return new Set(); } }
function persist() { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed.value])); } catch {} }
function toggle(node: WorkNode) { if (!node.children.length) return; const next = new Set(collapsed.value); next.has(node.id) ? next.delete(node.id) : next.add(node.id); collapsed.value = next; persist(); }
function select(node: WorkNode) { selected.value = node; }
function activate(node: WorkNode) { const same = selected.value?.id === node.id; select(node); if (node.children.length && same) toggle(node); }
function cost(value: number) { return `$${value >= 100 ? Math.round(value) : value.toFixed(2)}`; }
function tokenCount(value: number) { return value ? new Intl.NumberFormat().format(value) : ""; }
function transcriptOf(node: WorkNode): string | null { return transcriptByNode.get(node.id) ?? node.children.map(transcriptOf).find(Boolean) ?? null; }
async function reveal() { const node = selected.value; const transcriptPath = node && transcriptOf(node); if (!transcriptPath) return; try { await invoke("reveal_work_transcript", { transcriptPath }); } catch (e) { error.value = String(e); } }
async function load() { if (!props.task) return; loading.value = true; error.value = ""; selected.value = null; try { tree.value = await invoke<Payload>("get_task_work_tree", { task: props.task }); } catch (e) { tree.value = null; error.value = String(e); } finally { loading.value = false; } }
function onKeydown(event: KeyboardEvent) { const index = rows.value.findIndex((row) => row.node.id === selected.value?.id); const current = index < 0 ? 0 : index; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const row = rows.value[index < 0 ? (event.key === "ArrowDown" ? 0 : rows.value.length - 1) : current + (event.key === "ArrowDown" ? 1 : -1)]; if (row) select(row.node); return; } const row = rows.value[current]; if (!row) return; if (event.key === "ArrowRight" && row.node.children.length) { event.preventDefault(); if (collapsed.value.has(row.node.id)) toggle(row.node); else select(row.node.children[0]); } else if (event.key === "ArrowLeft") { event.preventDefault(); if (row.node.children.length && !collapsed.value.has(row.node.id)) toggle(row.node); else { const parent = rows.value.slice(0, current).reverse().find((candidate) => candidate.depth < row.depth); if (parent) select(parent.node); } } }
watch(() => props.task, load, { immediate: true });
watch(roots, (value) => { const next = restore(); const visit = (node: WorkNode, isRoot = false) => { if (node.children.length && (!isRoot || node.kind === "reads")) next.add(node.id); node.children.forEach((child) => visit(child)); }; value.forEach((node) => visit(node, true)); collapsed.value = next; }, { immediate: true });
watch(selected, async (node) => { await nextTick(); node && root.value?.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(node.id)}"]`)?.scrollIntoView({ block: "nearest" }); });
</script>

<template>
  <section class="work-tree-wrap">
    <h3 v-if="heading" class="work-heading">{{ heading }}</h3>
    <div v-if="loading" class="work-empty">{{ t("loading") }}</div>
    <div v-else-if="error" class="work-empty">{{ error }}</div>
    <div v-else-if="!roots.length" class="work-empty">{{ t("workEmpty") }}</div>
    <template v-else>
      <nav ref="root" class="work-tree" tabindex="0" @keydown="onKeydown">
        <button v-for="row in rows" :key="row.node.id" type="button" class="work-row" :class="{ selected: selected?.id === row.node.id, expensive: isExpensiveNode(row.node) }" :data-work-id="row.node.id" :style="{ '--work-depth': row.depth }" @click="activate(row.node)">
          <span class="work-toggle" :class="{ empty: !row.node.children.length, collapsed: collapsed.has(row.node.id) }" @click.stop="toggle(row.node)"></span><span class="work-kind">{{ row.node.kind === 'reads' ? '◫' : row.node.kind === 'tool' ? '›' : '●' }}</span><span class="work-name">{{ row.node.name }}<small v-if="row.node.count"> ×{{ row.node.count }}</small></span><span v-if="row.node.model" class="work-model">{{ row.node.model }}</span><span v-if="row.node.tokens" class="work-tokens">{{ tokenCount(row.node.tokens) }}</span><span v-if="row.node.cost" class="work-cost">{{ cost(row.node.cost) }}</span><span v-if="timelineBar(row.node, row.scale)" class="work-timeline"><i :style="{ left: `${timelineBar(row.node, row.scale)?.start}%`, width: `${timelineBar(row.node, row.scale)?.width}%` }"></i></span>
        </button>
      </nav>
      <aside v-if="selected" class="work-details"><strong>{{ selected.name }}</strong><span v-if="selected.model">{{ selected.model }}</span><span v-if="selected.tokens">{{ tokenCount(selected.tokens) }} {{ t("workTokens") }} · {{ cost(selected.cost) }}</span><pre v-if="selected.input">{{ selected.input }}</pre><pre v-if="selected.result">{{ selected.result }}</pre><button v-if="transcriptOf(selected)" type="button" class="work-reveal" @click="reveal">{{ t("workRevealTranscript") }}</button></aside>
    </template>
  </section>
</template>

<style scoped>
.work-tree-wrap { display:flex; flex-direction:column; gap:8px; min-width:0; }.work-heading { font-size:13px; margin:4px 0; }.work-empty { color:var(--text-4); font-size:12px; padding:8px; }.work-tree { border:1px solid var(--stroke-strong); border-radius:var(--r-ctl); max-height:370px; overflow:auto; outline:none; }.work-row { --indent:calc(var(--work-depth) * 15px); align-items:center; background:transparent; border:0; color:inherit; cursor:pointer; display:grid; font:inherit; font-size:12px; gap:6px; grid-template-columns:10px 13px minmax(80px, 1fr) auto auto auto minmax(70px, 22%); min-height:29px; padding:4px 8px 4px calc(8px + var(--indent)); text-align:left; width:100%; }.work-row:hover { background:var(--card-bg-hover); }.work-row.selected { background:var(--accent-soft); box-shadow:inset 2px 0 var(--accent); }.work-toggle::before { content:'▾'; color:var(--text-3); }.work-toggle.collapsed::before { content:'▸'; }.work-toggle.empty::before { content:''; }.work-kind,.work-model,.work-tokens,.work-cost { color:var(--text-3); font-family:var(--mono, monospace); font-size:10px; }.work-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.work-name small { color:var(--text-3); }.work-row.expensive .work-cost { color:var(--high); font-weight:700; }.work-timeline { background:color-mix(in srgb, var(--stroke-strong) 60%, transparent); display:block; height:7px; overflow:hidden; position:relative; }.work-timeline i { background:var(--accent); border-radius:4px; display:block; height:100%; position:absolute; }.work-row.expensive .work-timeline i { background:var(--high); }.work-details { border:1px solid var(--stroke-strong); border-radius:var(--r-ctl); display:flex; flex-direction:column; font-size:12px; gap:6px; padding:9px; }.work-details > span { color:var(--text-3); }.work-details pre { background:rgba(0,0,0,.16); margin:0; max-height:130px; overflow:auto; padding:7px; white-space:pre-wrap; }.work-reveal { align-self:start; background:var(--node-bg); border:1px solid var(--stroke-strong); border-radius:var(--r-ctl); color:inherit; cursor:pointer; font:inherit; padding:5px 8px; }
</style>
