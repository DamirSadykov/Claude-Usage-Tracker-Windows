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

// Each Tauri window is a separate WebView; vue-i18n boots from navigator
// language and doesn't see the popup's saved locale. Read it from the shared
// store so the analytics window opens in the same language the user picked.
async function loadLocaleFromStore() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const saved = await store.get<string>("locale");
    if (saved) locale.value = saved;
  } catch {
    // store missing or unreadable → keep detected default
  }
}

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
  category: "observation" | "recommendation";
}
interface ToolUsage {
  tool_name: string;
  calls: number;
  messages: number;
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
  tool_breakdown: ToolUsage[];
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
    // Kick off ingest in the background — see AnalyticsPanel.vue for context.
    invoke("ingest_cc_usage")
      .then((n) => {
        if (typeof n === "number" && n > 0) void reload();
      })
      .catch(() => {});
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

async function reload() {
  try {
    data.value = await invoke<AnalyticsExt>("get_analytics_ext", {
      from: fromIso.value,
      to: toIso.value,
      project: projectFilter.value || null,
      topN: 10,
    });
    await nextTick();
    renderCharts();
  } catch {}
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
// Sessions are keyed by UUID (the transcript file name). Show a compact form
// in the table, copy the full id on click so the user can `grep` it.
function shortId(id: string): string {
  return id.length > 13 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
  } catch {}
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
      options: {
        ...chartOpts("$"),
        plugins: {
          legend: { display: false },
          // Default tooltip prints the raw JS number ("$2.90000000000004").
          // Round it the same way the KPI/list cells do.
          tooltip: { callbacks: { label: (c) => fmtCost(Number(c.parsed.y) || 0) } },
        },
      },
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
            // For cost ticks, round to 2 decimals — Chart.js' auto-ticks emit
            // raw floats (e.g. 2.90000000000004) which leak into the axis.
            callback: (v: string | number) =>
              unit === "$" ? "$" + Number(v).toFixed(2) : fmtTokens(Number(v)),
          },
        },
      },
    } as const;
  }
}

// --- insight rendering ---
// vue-i18n doesn't take the full ICU `{n, number, …}` syntax in its default
// parser, so format numbers in JS before substituting. `cost`/`*_rate` →
// "$X.XX" (rate is also dollars: $/msg). Percent-like fields → integer
// percent. `avg_ctx` → compact token form. Everything else passed through.
const PCT_KEYS = new Set(["pct", "share_pct", "churn_pct", "delta_pct"]);
const COST_KEYS = new Set(["cost", "with_rate", "without_rate"]);
const TOK_KEYS = new Set(["avg_ctx"]);
function insightText(ins: Insight): string {
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(ins.params)) {
    if (typeof v === "number") {
      if (COST_KEYS.has(k)) p[k] = fmtCost(v);
      else if (PCT_KEYS.has(k)) p[k] = v.toFixed(0);
      else if (TOK_KEYS.has(k)) p[k] = fmtTokens(v);
      else p[k] = v;
    } else {
      p[k] = v as string;
    }
  }
  return t(ins.label_key, p);
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

// --- insight tabs ---
// Backend tags each insight as `observation` (factual) or `recommendation`
// (actionable). Default to Recommendations because they're the reason a user
// opens the dashboard. If a period has none, fall through to Findings.
const insightTab = ref<"observation" | "recommendation">("recommendation");

// --- ignored insights (persisted) ---
// Stored as an array of kind strings in settings.json. Anything in here is
// hidden from the active list and exposed in a separate "Скрытые" block with
// a restore button. Persistence keeps the choice across app restarts.
const ignoredKinds = ref<string[]>([]);
async function loadIgnored() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const raw = await store.get<string[]>("ignoredInsights");
    if (Array.isArray(raw)) ignoredKinds.value = raw;
  } catch {}
}
async function saveIgnored() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("ignoredInsights", [...ignoredKinds.value]);
    await store.save();
  } catch {}
}
function ignoreInsight(kind: string) {
  if (!ignoredKinds.value.includes(kind)) {
    ignoredKinds.value = [...ignoredKinds.value, kind];
    saveIgnored();
  }
}
function restoreInsight(kind: string) {
  ignoredKinds.value = ignoredKinds.value.filter((k) => k !== kind);
  saveIgnored();
}

const observations = computed(() =>
  (data.value?.insights ?? []).filter(
    (i) => i.category === "observation" && !ignoredKinds.value.includes(i.kind),
  ),
);
const recommendations = computed(() =>
  (data.value?.insights ?? []).filter(
    (i) => i.category === "recommendation" && !ignoredKinds.value.includes(i.kind),
  ),
);
const ignoredInsights = computed(() =>
  (data.value?.insights ?? []).filter((i) => ignoredKinds.value.includes(i.kind)),
);
const activeInsights = computed(() =>
  insightTab.value === "observation" ? observations.value : recommendations.value,
);
// When the period has zero (non-ignored) recs, auto-jump to Findings so the
// section isn't just an "empty" placeholder on the default tab.
watch(
  [() => data.value?.insights, ignoredKinds],
  () => {
    if (!data.value?.insights?.length) return;
    if (recommendations.value.length === 0 && observations.value.length > 0) {
      insightTab.value = "observation";
    } else if (recommendations.value.length > 0) {
      insightTab.value = "recommendation";
    }
  },
  { immediate: false },
);

// --- affected sessions per insight (expandable list) ---
interface AffectedSession {
  session_id: string;
  project: string | null;
  cost: number;
}
function affectedOf(ins: Insight): AffectedSession[] {
  const a = (ins.params as Record<string, unknown>)?.affected;
  return Array.isArray(a) ? (a as AffectedSession[]) : [];
}
const expandedAffected = ref<Set<string>>(new Set());
function toggleAffected(kind: string) {
  const next = new Set(expandedAffected.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  expandedAffected.value = next;
}

// --- tool breakdown: collapse + search ---
// Top-3 by default; «подробнее» reveals the long tail. A search box filters
// across the entire list (search wins over collapse — if there's a query, all
// matches show regardless of `toolExpanded`).
const toolExpanded = ref(false);
const toolSearch = ref("");
const TOOL_COLLAPSED_N = 3;
const filteredTools = computed(() => {
  const q = toolSearch.value.trim().toLowerCase();
  const all = data.value?.tool_breakdown ?? [];
  if (q) return all.filter((t) => t.tool_name.toLowerCase().includes(q));
  return all;
});
const visibleTools = computed(() => {
  if (toolSearch.value.trim()) return filteredTools.value;
  return toolExpanded.value ? filteredTools.value : filteredTools.value.slice(0, TOOL_COLLAPSED_N);
});

watch([dateFrom, dateTo, projectFilter], load);
watch(locale, () => renderCharts());
onMounted(async () => {
  await loadLocaleFromStore();
  await loadIgnored();
  await load();
});
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
          <div class="aw-kpi" :title="t('subagentKpiHint')">
            <div class="aw-kpi-val">{{ data.subagent_summary.subagent_messages }}</div>
            <div class="aw-kpi-lbl">{{ t("subagentKpiLabel") }}</div>
          </div>
        </section>

        <!-- Insights — tabbed: observations (factual) vs recommendations (actionable) -->
        <section v-if="data.insights.length" class="aw-insights-block">
          <div class="aw-tabs">
            <button
              class="aw-tab"
              :class="{ 'aw-tab--active': insightTab === 'recommendation' }"
              @click="insightTab = 'recommendation'"
            >
              {{ t("insightTabRecommendations") }}
              <span class="aw-tab-count">{{ recommendations.length }}</span>
            </button>
            <button
              class="aw-tab"
              :class="{ 'aw-tab--active': insightTab === 'observation' }"
              @click="insightTab = 'observation'"
            >
              {{ t("insightTabObservations") }}
              <span class="aw-tab-count">{{ observations.length }}</span>
            </button>
          </div>
          <div v-if="activeInsights.length" class="aw-insights">
            <div
              v-for="ins in activeInsights"
              :key="ins.kind"
              class="aw-insight"
              :data-kind="ins.kind"
              :data-category="ins.category"
            >
              <div class="aw-insight-row">
                <span class="aw-insight-tag">{{ t("insight") }}</span>
                <span class="aw-insight-text">{{ insightText(ins) }}</span>
                <button
                  class="aw-insight-x"
                  :title="t('ignoreInsight')"
                  @click="ignoreInsight(ins.kind)"
                >×</button>
              </div>
              <div v-if="affectedOf(ins).length" class="aw-affected">
                <button class="aw-link-btn" @click="toggleAffected(ins.kind)">
                  {{ expandedAffected.has(ins.kind) ? t('hideSessions') : t('showAffectedSessions') + ' (' + affectedOf(ins).length + ')' }}
                </button>
                <ul v-if="expandedAffected.has(ins.kind)" class="aw-affected-list">
                  <li v-for="a in affectedOf(ins)" :key="a.session_id" class="aw-affected-item">
                    <button
                      class="aw-row-id"
                      @click="copyId(a.session_id)"
                      :title="t('copySession') + ': ' + a.session_id"
                    >{{ shortId(a.session_id) }}</button>
                    <span class="aw-row-proj">{{ projectName(a.project) }}</span>
                    <span class="aw-row-val">{{ fmtCost(a.cost) }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div v-else class="aw-insights-empty">{{ t("insightEmpty") }}</div>

          <!-- Hidden insights — restorable -->
          <details v-if="ignoredInsights.length" class="aw-ignored">
            <summary>{{ t('hiddenInsights') }} ({{ ignoredInsights.length }})</summary>
            <div class="aw-ignored-list">
              <div v-for="ins in ignoredInsights" :key="'h' + ins.kind" class="aw-ignored-row">
                <span class="aw-ignored-text">{{ insightText(ins) }}</span>
                <button class="aw-link-btn" @click="restoreInsight(ins.kind)">
                  {{ t('restore') }}
                </button>
              </div>
            </div>
          </details>
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

        <!-- Tool breakdown — search + top-3 by default, "Show more" reveals long tail -->
        <section class="aw-card" v-if="data.tool_breakdown.length">
          <div class="aw-card-hd">
            {{ t("toolBreakdown") }}
            <span class="aw-sub">{{ t("toolBreakdownHint") }}</span>
            <input
              v-model="toolSearch"
              class="aw-search"
              type="search"
              :placeholder="t('toolSearchPlaceholder')"
            />
          </div>
          <table v-if="visibleTools.length" class="aw-table">
            <thead>
              <tr>
                <th>{{ t("toolName") }}</th>
                <th>{{ t("toolCalls") }}</th>
                <th>{{ t("toolMessages") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tu in visibleTools" :key="tu.tool_name">
                <td>{{ tu.tool_name }}</td>
                <td>{{ tu.calls.toLocaleString() }}</td>
                <td>{{ tu.messages.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="aw-insights-empty">{{ t('toolSearchEmpty') }}</div>
          <button
            v-if="!toolSearch.trim() && data.tool_breakdown.length > TOOL_COLLAPSED_N"
            class="aw-link-btn"
            @click="toolExpanded = !toolExpanded"
          >
            {{ toolExpanded ? t("showLess") : t("showMore") + ' (' + (data.tool_breakdown.length - TOOL_COLLAPSED_N) + ')' }}
          </button>
        </section>

        <!-- Costly sessions -->
        <section class="aw-grid">
          <div class="aw-card">
            <div class="aw-card-hd">{{ t("costlyByCost") }}</div>
            <div class="aw-list">
              <div v-for="s in data.costly_by_cost" :key="'c' + s.session_id" class="aw-row">
                <div class="aw-row-line">
                  <span class="aw-row-when">{{ fmtWhen(s.start) }}</span>
                  <span v-if="!projectFilter" class="aw-row-proj">{{ projectName(s.project) }}</span>
                  <button
                    class="aw-row-id"
                    @click="copyId(s.session_id)"
                    :title="t('copySession') + ': ' + s.session_id"
                  >{{ shortId(s.session_id) }}</button>
                  <span class="aw-row-val">{{ fmtCost(s.cost) }}</span>
                </div>
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
                <div class="aw-row-line">
                  <span class="aw-row-when">{{ fmtWhen(s.start) }}</span>
                  <span v-if="!projectFilter" class="aw-row-proj">{{ projectName(s.project) }}</span>
                  <button
                    class="aw-row-id"
                    @click="copyId(s.session_id)"
                    :title="t('copySession') + ': ' + s.session_id"
                  >{{ shortId(s.session_id) }}</button>
                  <span class="aw-row-val">{{ fmtTokens(s.cache_create) }}</span>
                </div>
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
  /* Hints the platform to render the dropdown in a dark colour scheme so the
     OS popup menu (which the WebView can't fully restyle) picks dark fg/bg. */
  color-scheme: dark;
}
/* `<option>` is system-painted on Windows — set explicit colours so the
   dropdown isn't white-on-white in dark mode. */
.aw-filters select option {
  background: #232323;
  color: #e8e8e8;
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

.aw-insights-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aw-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.aw-tab {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.55);
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.aw-tab:hover {
  color: rgba(255, 255, 255, 0.85);
}
.aw-tab--active {
  color: #6ccb5f;
  border-bottom-color: #6ccb5f;
}
.aw-tab-count {
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  border-radius: 10px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 700;
  min-width: 18px;
  text-align: center;
}
.aw-tab--active .aw-tab-count {
  background: rgba(108, 203, 95, 0.25);
}
.aw-insights-empty {
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
  padding: 10px 4px;
  font-style: italic;
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
  flex-direction: column;
  gap: 8px;
}
.aw-insight-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aw-insight-text {
  flex: 1;
}
.aw-insight-x {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.aw-insight-x:hover {
  color: rgba(255, 255, 255, 0.85);
}
.aw-affected {
  font-size: 12px;
  padding-left: 2px;
}
.aw-affected-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.aw-affected-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 5px;
}
.aw-ignored {
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  padding-top: 8px;
  font-size: 12px;
}
.aw-ignored summary {
  cursor: pointer;
  color: rgba(255, 255, 255, 0.55);
  user-select: none;
}
.aw-ignored summary:hover {
  color: rgba(255, 255, 255, 0.8);
}
.aw-ignored-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.aw-ignored-row {
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.55);
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 5px;
}
.aw-ignored-text {
  flex: 1;
}
.aw-search {
  margin-left: auto;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: inherit;
  border-radius: 5px;
  padding: 4px 10px;
  font-size: 12px;
  min-width: 180px;
}
.aw-search:focus {
  outline: none;
  border-color: rgba(108, 203, 95, 0.5);
}
.aw-insight[data-category="recommendation"] {
  background: rgba(232, 184, 80, 0.08);
  border-color: rgba(232, 184, 80, 0.4);
}
.aw-insight[data-category="recommendation"] .aw-insight-tag {
  background: rgba(232, 184, 80, 0.3);
  color: #e8b850;
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
.aw-link-btn {
  background: transparent;
  border: none;
  color: #6ccb5f;
  font-size: 12px;
  padding: 8px 0 0;
  cursor: pointer;
  text-align: left;
}
.aw-link-btn:hover {
  text-decoration: underline;
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
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.aw-row-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.aw-row-when {
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.aw-row-proj {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
/* Click-to-copy session id chip. Filter-active rows have no project span, so
   the chip takes the slack via flex:1 to keep the bar full-width. */
.aw-row-id {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 4px;
  padding: 2px 7px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.aw-row-id:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text, #e8e8e8);
  border-color: var(--accent, #d97757);
}
.aw-row-proj:has(+ .aw-row-id) {
  flex: 1;
}
.aw-row-line:not(:has(.aw-row-proj)) .aw-row-id {
  flex: 1;
  text-align: left;
}
.aw-row-val {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  flex-shrink: 0;
}
.aw-row-bar {
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
