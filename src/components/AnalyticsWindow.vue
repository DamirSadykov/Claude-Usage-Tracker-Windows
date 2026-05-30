<script setup lang="ts">
// Standalone analytics dashboard, rendered when index.html is loaded with the
// `#analytics` hash (see tauri.conf.json `analytics` window). Pulls a single
// extended bundle from `get_analytics_ext`, with a project + date-range filter
// and an "export JSON" affordance so the user can pipe the aggregates into
// their Claude Code CLI for higher-order insights.
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
);

const { t, locale } = useI18n();

interface Totals {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  total_tokens: number;
  cost: number;
  messages: number;
  sessions: number;
}
interface DailyPoint {
  date: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  total_tokens: number;
  cost: number;
}
interface ModelUsage {
  model: string;
  total_tokens: number;
  cost: number;
  messages: number;
}
interface ProjectUsage {
  project: string | null;
  total_tokens: number;
  cost: number;
  messages: number;
  sessions: number;
}
interface SessionUsage {
  session_id: string;
  project: string | null;
  start: string;
  end: string;
  total_tokens: number;
  cost: number;
  messages: number;
  cache_create: number;
}
interface SubagentUsage {
  agent_name: string;
  messages: number;
  sessions: number;
  total_tokens: number;
  cost: number;
}
interface SubagentSummary {
  subagent_messages: number;
  subagent_sessions: number;
  subagent_tokens: number;
  subagent_cost: number;
  main_tokens: number;
  main_cost: number;
}
interface Insight {
  kind: string;
  label_key: string;
  params: Record<string, unknown>;
}
interface AnalyticsExt {
  totals: Totals;
  daily: DailyPoint[];
  by_model: ModelUsage[];
  by_project: ProjectUsage[];
  by_subagent: SubagentUsage[];
  subagent_summary: SubagentSummary;
  costly_by_cost: SessionUsage[];
  costly_by_cache: SessionUsage[];
  anomalies: SessionUsage[];
  insights: Insight[];
  projects: string[];
}

// --- filters ---
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(d: number): string {
  return new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
}
const dateFrom = ref(daysAgo(30));
const dateTo = ref(today());
const projectFilter = ref<string>(""); // empty = all
const loading = ref(false);
const error = ref("");
const data = ref<AnalyticsExt | null>(null);

const fromIso = computed(() => new Date(dateFrom.value + "T00:00:00").toISOString());
const toIso = computed(() => new Date(dateTo.value + "T23:59:59.999").toISOString());

async function load() {
  loading.value = true;
  error.value = "";
  try {
    await invoke("ingest_cc_usage").catch(() => {});
    data.value = await invoke<AnalyticsExt>("get_analytics_ext", {
      from: fromIso.value,
      to: toIso.value,
      project: projectFilter.value || null,
      topN: 10,
    });
    await nextTick();
    renderCharts();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

// --- formatting ---
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "K";
  return String(n);
}
function fmtCost(n: number): string {
  return "$" + n.toFixed(2);
}
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function projectName(p: string | null): string {
  return p && p.length ? p : t("projectUnknown");
}

// --- presets ---
function setRange(days: number) {
  dateFrom.value = daysAgo(days);
  dateTo.value = today();
}

// --- charts ---
const costCanvas = ref<HTMLCanvasElement | null>(null);
const tokenCanvas = ref<HTMLCanvasElement | null>(null);
let costChart: Chart | null = null;
let tokenChart: Chart | null = null;

function renderCharts() {
  const d = data.value;
  if (!d) return;
  const labels = d.daily.map((p) => p.date.slice(5));
  const grid = "rgba(255,255,255,0.06)";
  const tick = "rgba(255,255,255,0.45)";

  // Cost over time (single line). Extra-usage credit history isn't available
  // per-day from the API, so this charts CC spend — which is what drives most
  // of the extra-usage curve in practice.
  if (costCanvas.value) {
    costChart?.destroy();
    costChart = new Chart(costCanvas.value, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: t("metricCost"),
            data: d.daily.map((p) => p.cost),
            borderColor: "#d97757",
            backgroundColor: "rgba(217,119,87,0.18)",
            fill: true,
            tension: 0.25,
            pointRadius: 2,
          },
        ],
      },
      options: chartOpts("$"),
    });
  }

  // Tokens by component, stacked.
  if (tokenCanvas.value) {
    tokenChart?.destroy();
    const series = [
      { key: "input" as const, color: "#d97757", label: t("tokInput") },
      { key: "output" as const, color: "#6ccb5f", label: t("tokOutput") },
      { key: "cache_create" as const, color: "#5b9bd5", label: t("tokCacheCreate") },
      { key: "cache_read" as const, color: "#9aa0a6", label: t("tokCacheRead") },
    ];
    tokenChart = new Chart(tokenCanvas.value, {
      type: "bar",
      data: {
        labels,
        datasets: series.map((s) => ({
          label: s.label,
          data: d.daily.map((p) => p[s.key]),
          backgroundColor: s.color,
          stack: "tok",
          maxBarThickness: 22,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: tick, font: { size: 11 } } },
          tooltip: {
            callbacks: { label: (c) => `${c.dataset.label}: ${fmtTokens(Number(c.parsed.y) || 0)}` },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: tick } },
          y: {
            stacked: true,
            grid: { color: grid },
            ticks: { color: tick, callback: (v) => fmtTokens(Number(v)) },
          },
        },
      },
    });
  }

  function chartOpts(unit: string) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tick } },
        y: {
          grid: { color: grid },
          ticks: {
            color: tick,
            callback: (v: string | number) => (unit === "$" ? "$" + v : fmtTokens(Number(v))),
          },
        },
      },
    } as const;
  }
}

// --- insight rendering ---
function insightText(ins: Insight): string {
  return t(ins.label_key, ins.params as Record<string, unknown>);
}

// --- export ---
const exportText = ref<string>("");
const exportOpen = ref(false);
async function doExport() {
  try {
    exportText.value = await invoke<string>("export_analytics_json", {
      from: fromIso.value,
      to: toIso.value,
      project: projectFilter.value || null,
    });
    exportOpen.value = true;
  } catch (e) {
    error.value = String(e);
  }
}
async function copyExport() {
  try {
    await navigator.clipboard.writeText(exportText.value);
  } catch {}
}

// Largest per-row metric (cost) — scales the costly-session bars.
function maxCost(rows: SessionUsage[]): number {
  return rows.reduce((m, r) => (r.cost > m ? r.cost : m), 0);
}
function maxCache(rows: SessionUsage[]): number {
  return rows.reduce((m, r) => (r.cache_create > m ? r.cache_create : m), 0);
}

watch([dateFrom, dateTo, projectFilter], load);
watch(locale, () => renderCharts());
onMounted(load);
</script>

<template>
  <div class="aw-root">
    <header class="aw-head">
      <h1>{{ t("analytics") }}</h1>
      <div class="aw-filters">
        <div class="aw-presets">
          <button @click="setRange(7)">{{ t("range7d") }}</button>
          <button @click="setRange(30)">{{ t("range30d") }}</button>
          <button @click="setRange(90)">90d</button>
        </div>
        <label>
          {{ t("from") }}
          <input type="date" v-model="dateFrom" />
        </label>
        <label>
          {{ t("to") }}
          <input type="date" v-model="dateTo" />
        </label>
        <label>
          {{ t("analyticsByProject") }}
          <select v-model="projectFilter">
            <option value="">{{ t("allProjects") }}</option>
            <option v-for="p in data?.projects ?? []" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
        <button class="aw-export" @click="doExport" :title="t('exportJsonHint')">
          {{ t("exportJson") }}
        </button>
      </div>
    </header>

    <main class="aw-main">
      <div v-if="error" class="aw-empty">{{ error }}</div>
      <div v-else-if="loading && !data" class="aw-empty">{{ t("loading") }}</div>

      <template v-else-if="data">
        <!-- KPI summary -->
        <section class="aw-kpis">
          <div class="aw-kpi">
            <div class="aw-kpi-val">{{ fmtCost(data.totals.cost) }}</div>
            <div class="aw-kpi-lbl">{{ t("analyticsTotal") }}</div>
          </div>
          <div class="aw-kpi">
            <div class="aw-kpi-val">{{ fmtTokens(data.totals.total_tokens) }}</div>
            <div class="aw-kpi-lbl">{{ t("metricTokens") }}</div>
          </div>
          <div class="aw-kpi">
            <div class="aw-kpi-val">{{ data.totals.sessions }}</div>
            <div class="aw-kpi-lbl">{{ t("analyticsPerSession") }}</div>
          </div>
          <div class="aw-kpi">
            <div class="aw-kpi-val">{{ data.subagent_summary.subagent_messages }}</div>
            <div class="aw-kpi-lbl">{{ t("subagentMessages") }}</div>
          </div>
        </section>

        <!-- Insights -->
        <section v-if="data.insights.length" class="aw-insights">
          <div v-for="ins in data.insights" :key="ins.kind" class="aw-insight" :data-kind="ins.kind">
            <span class="aw-insight-tag">{{ t("insight") }}</span>
            <span>{{ insightText(ins) }}</span>
          </div>
        </section>

        <!-- Charts -->
        <section class="aw-grid">
          <div class="aw-card">
            <div class="aw-card-hd">{{ t("chartCost") }}</div>
            <div class="aw-chart"><canvas ref="costCanvas"></canvas></div>
          </div>
          <div class="aw-card">
            <div class="aw-card-hd">{{ t("chartTokens") }}</div>
            <div class="aw-chart"><canvas ref="tokenCanvas"></canvas></div>
          </div>
        </section>

        <!-- Subagents -->
        <section class="aw-card" v-if="data.by_subagent.length">
          <div class="aw-card-hd">
            {{ t("subagentBreakdown") }}
            <span class="aw-sub">
              {{ data.subagent_summary.subagent_sessions }} {{ t("subagentSessionsShort") }} ·
              {{ fmtCost(data.subagent_summary.subagent_cost) }}
            </span>
          </div>
          <table class="aw-table">
            <thead>
              <tr>
                <th>{{ t("subagentAgent") }}</th>
                <th>{{ t("subagentMessages") }}</th>
                <th>{{ t("subagentSessions") }}</th>
                <th>{{ t("metricTokens") }}</th>
                <th>{{ t("analyticsTotal") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in data.by_subagent" :key="s.agent_name">
                <td>{{ s.agent_name }}</td>
                <td>{{ s.messages }}</td>
                <td>{{ s.sessions }}</td>
                <td>{{ fmtTokens(s.total_tokens) }}</td>
                <td>{{ fmtCost(s.cost) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Costly sessions -->
        <section class="aw-grid">
          <div class="aw-card">
            <div class="aw-card-hd">{{ t("costlyByCost") }}</div>
            <div class="aw-list">
              <div v-for="s in data.costly_by_cost" :key="'c' + s.session_id" class="aw-row">
                <span class="aw-row-when">{{ fmtWhen(s.start) }}</span>
                <span class="aw-row-proj">{{ projectName(s.project) }}</span>
                <span class="aw-row-val">{{ fmtCost(s.cost) }}</span>
                <div class="aw-row-bar">
                  <span :style="{ width: (maxCost(data.costly_by_cost) ? (s.cost / maxCost(data.costly_by_cost)) * 100 : 0) + '%' }"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="aw-card">
            <div class="aw-card-hd">
              {{ t("costlyByCache") }}
              <span class="aw-sub">{{ t("costlyByCacheHint") }}</span>
            </div>
            <div class="aw-list">
              <div v-for="s in data.costly_by_cache" :key="'k' + s.session_id" class="aw-row">
                <span class="aw-row-when">{{ fmtWhen(s.start) }}</span>
                <span class="aw-row-proj">{{ projectName(s.project) }}</span>
                <span class="aw-row-val">{{ fmtTokens(s.cache_create) }}</span>
                <div class="aw-row-bar">
                  <span :style="{ width: (maxCache(data.costly_by_cache) ? (s.cache_create / maxCache(data.costly_by_cache)) * 100 : 0) + '%' }"></span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>
    </main>

    <!-- Export modal -->
    <div v-if="exportOpen" class="aw-modal" @click.self="exportOpen = false">
      <div class="aw-modal-box">
        <div class="aw-modal-hd">
          <span>{{ t("exportJson") }}</span>
          <div class="aw-modal-actions">
            <button @click="copyExport">{{ t("copy") }}</button>
            <button @click="exportOpen = false">{{ t("dismiss") }}</button>
          </div>
        </div>
        <p class="aw-modal-hint">{{ t("exportJsonHint") }}</p>
        <textarea readonly :value="exportText"></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aw-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg, #1a1a1a);
  color: var(--text, #e8e8e8);
  font-family: var(--segoe);
}
.aw-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.aw-head h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.aw-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-left: auto;
}
.aw-filters label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
}
.aw-filters input,
.aw-filters select {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  color: var(--text, #e8e8e8);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--segoe);
}
.aw-presets {
  display: inline-flex;
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  overflow: hidden;
}
.aw-presets button {
  border: none;
  background: transparent;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.aw-presets button + button {
  border-left: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
}
.aw-presets button:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}
.aw-export {
  border: 1px solid var(--accent, #d97757);
  background: transparent;
  color: var(--accent, #d97757);
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.aw-export:hover {
  background: var(--accent, #d97757);
  color: #fff;
}

.aw-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.aw-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 14px;
}

.aw-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.aw-kpi {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.aw-kpi-val {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.aw-kpi-lbl {
  font-size: 11px;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-top: 4px;
}

.aw-insights {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.aw-insight {
  background: rgba(108, 203, 95, 0.08);
  border: 1px solid rgba(108, 203, 95, 0.35);
  border-radius: 7px;
  padding: 8px 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.aw-insight-tag {
  background: rgba(108, 203, 95, 0.3);
  color: #6ccb5f;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  flex-shrink: 0;
}

.aw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 14px;
}
.aw-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px;
}
.aw-card-hd {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 10px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: baseline;
}
.aw-sub {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  font-size: 12px;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
}
.aw-chart {
  height: 220px;
  position: relative;
}

.aw-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.aw-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 11px;
  text-transform: uppercase;
  padding: 6px 8px;
  border-bottom: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
}
.aw-table td {
  padding: 7px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-variant-numeric: tabular-nums;
}

.aw-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.aw-row {
  display: grid;
  grid-template-columns: 90px 1fr 70px;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.aw-row-when {
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-variant-numeric: tabular-nums;
}
.aw-row-proj {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aw-row-val {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
}
.aw-row-bar {
  grid-column: 1 / -1;
  height: 4px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 3px;
  overflow: hidden;
}
.aw-row-bar > span {
  display: block;
  height: 100%;
  background: var(--accent, #d97757);
  transition: width 200ms;
}

.aw-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 50;
}
.aw-modal-box {
  background: #232323;
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  width: min(720px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  padding: 14px;
  gap: 8px;
}
.aw-modal-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}
.aw-modal-actions {
  display: flex;
  gap: 6px;
}
.aw-modal-actions button {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 5px;
  color: var(--text);
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.aw-modal-actions button:hover {
  background: rgba(255, 255, 255, 0.1);
}
.aw-modal-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
}
.aw-modal-box textarea {
  flex: 1;
  min-height: 240px;
  background: rgba(0, 0, 0, 0.35);
  color: var(--text);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  padding: 10px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}
</style>
