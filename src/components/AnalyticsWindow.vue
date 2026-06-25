<script setup lang="ts">
// Standalone analytics dashboard, rendered when index.html is loaded with the
// `#analytics` hash (see tauri.conf.json `analytics` window). Pulls a single
// extended bundle from `get_analytics_ext`, with a project + date-range filter
// and an "export JSON" affordance so the user can pipe the aggregates into
// their Claude Code CLI for higher-order insights. The content is split across
// five tabs (Overview / Trends / Sessions / Tools / Insights).
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ProjectAutocomplete from "./ProjectAutocomplete.vue";
import ProjectLabel from "./ProjectLabel.vue";
import { useProjectLinks } from "../projectLinks";
import { useProjectGroups, type ProjectGroup } from "../projectGroups";
import { getInsightHelpHtml, hasInsightHelp } from "../insightHelp";
import { renderInsightHelp } from "../insightHelp/render";
import { fmtDateTime, fmtDay } from "../dateFormat";
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
  cache_hit_ratio: number; // 0..1
  cache_savings_usd: number; // can be < 0
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
interface TierBreakdown {
  standard: number;
  non_standard: number;
  unknown: number;
  standard_pct: number | null;
}
interface ToolErrorStats {
  total: number;
  errors: number;
  error_rate: number | null;
}
interface Productivity {
  active_ms: number;
  active_minutes: number;
  active_hours: number;
  turns: number;
  git_commits: number;
  git_pushes: number;
  edits: number;
  cost_per_active_hour: number | null;
  tokens_per_active_minute: number | null;
  cost_per_commit: number | null;
  cost_per_edit: number | null;
}
// Headline metrics for the trend badges. Mirrors the Rust `TrendMetrics`
// (serde snake_case). error_rate / cost_per_active_hour are Option → null.
// NB: trend error_rate is a FRACTION 0..1 (compared current vs previous), unlike
// `ToolErrorStats.error_rate` on the Quality tile which is a percent 0..100.
interface TrendMetrics {
  cost: number;
  total_tokens: number;
  cache_hit_ratio: number; // 0..1
  error_rate: number | null; // fraction 0..1
  cost_per_active_hour: number | null; // USD/hour
}
interface PeriodCompare {
  current: Totals;
  previous: Totals;
  current_trend: TrendMetrics;
  previous_trend: TrendMetrics;
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
  tier_breakdown: TierBreakdown;
  tool_error: ToolErrorStats;
  productivity: Productivity;
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
const compare = ref<PeriodCompare | null>(null);

// Efficiency goals, read from the shared store (SettingsPanel writes them).
// goalCostPerHourMax is USD/hour; goalErrorRateMax is a FRACTION 0..1. null =
// goal disabled (no indicator shown).
const goalCostPerHourMax = ref<number | null>(null);
const goalErrorRateMax = ref<number | null>(null);

const fromIso = computed(() => new Date(dateFrom.value + "T00:00:00").toISOString());
const toIso = computed(() => new Date(dateTo.value + "T23:59:59.999").toISOString());
// Previous window of equal length, immediately preceding the current one:
// prev_to = cur_from, prev_from = cur_from − (cur_to − cur_from).
const prevFromIso = computed(() => {
  const cf = new Date(fromIso.value).getTime();
  const ct = new Date(toIso.value).getTime();
  return new Date(cf - (ct - cf)).toISOString();
});

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
    // Period-over-period trend for the KPI badges (prev window of equal length).
    // Non-fatal: a failure here just hides the badges, it doesn't break the page.
    try {
      compare.value = await invoke<PeriodCompare>("get_analytics_compare", {
        curFrom: fromIso.value,
        curTo: toIso.value,
        prevFrom: prevFromIso.value,
        prevTo: fromIso.value,
      });
    } catch {
      compare.value = null;
    }
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
    try {
      compare.value = await invoke<PeriodCompare>("get_analytics_compare", {
        curFrom: fromIso.value,
        curTo: toIso.value,
        prevFrom: prevFromIso.value,
        prevTo: fromIso.value,
      });
    } catch {
      compare.value = null;
    }
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
function fmtPct(v: number): string {
  return v.toFixed(1) + "%";
}
// Active time in ms → "Xч Yмин" / "Yмин" / "Zс". Compact, locale-agnostic units
// (the unit suffixes are localized via i18n keys, the number is plain).
function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}${t("unitHourShort")} ${m}${t("unitMinShort")}` : `${h}${t("unitHourShort")}`;
  }
  if (totalMin >= 1) return `${totalMin}${t("unitMinShort")}`;
  return `${Math.floor(ms / 1000)}${t("unitSecShort")}`;
}
// Per-X derivatives are null when the denominator is zero — render "—", not 0/Inf.
function fmtCostOrDash(v: number | null): string {
  return v === null ? "—" : fmtCost(v);
}
function fmtTokensOrDash(v: number | null): string {
  return v === null ? "—" : fmtTokens(v);
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
// Session timestamp → numeric date+time for the active locale
// (ru "31.12.2026, 13:57" / en "12/31/2026, 01:57 PM").
function fmtWhen(iso: string): string {
  return fmtDateTime(iso, locale.value);
}
// Merge-link badges: which aliases each canonical absorbed (issue #13). Analytics
// shows resolved (canonical) names; canonicalOf is also used to total association
// groups whose members are raw alias names.
const { aliasesOf, canonicalOf } = useProjectLinks();

// Association groups ("who works with whom"): peer links, not a stat merge.
const { groups: projectGroups, save: saveGroups, relatedOf } = useProjectGroups();
const newGroupName = ref("");
// Per-group "add project" draft, keyed by group name.
const groupAddDraft = ref<Record<string, string>>({});

function createGroup() {
  const name = newGroupName.value.trim();
  if (!name || projectGroups.value.some((g) => g.name === name)) {
    newGroupName.value = "";
    return;
  }
  void saveGroups([...projectGroups.value, { name, projects: [] }]);
  newGroupName.value = "";
}
function deleteGroup(name: string) {
  void saveGroups(projectGroups.value.filter((g) => g.name !== name));
}
function addToGroup(name: string) {
  const p = (groupAddDraft.value[name] ?? "").trim();
  if (!p) return;
  const next = projectGroups.value.map((g) =>
    g.name === name && !g.projects.includes(p) ? { ...g, projects: [...g.projects, p] } : g,
  );
  groupAddDraft.value[name] = "";
  void saveGroups(next);
}
function removeFromGroup(name: string, project: string) {
  const next = projectGroups.value.map((g) =>
    g.name === name ? { ...g, projects: g.projects.filter((p) => p !== project) } : g,
  );
  void saveGroups(next);
}
// Read-only combined total for a group: sum the by_project rows of its members,
// mapping any member that's an alias to its canonical so merged usage is counted
// once (and not missed). Returns null when no member has data in the window.
function groupTotal(g: ProjectGroup): { tokens: number; cost: number } | null {
  const canon = new Set(g.projects.map((p) => canonicalOf(p) ?? p));
  let tokens = 0;
  let cost = 0;
  let any = false;
  for (const row of data.value?.by_project ?? []) {
    if (row.project && canon.has(row.project)) {
      tokens += row.total_tokens;
      cost += row.cost;
      any = true;
    }
  }
  return any ? { tokens, cost } : null;
}
// Formatted group total for the UI, or "" when no member has data in the window.
function groupTotalText(g: ProjectGroup): string {
  const tt = groupTotal(g);
  return tt ? `${t("groupTotalLabel")}: ${fmtTokens(tt.tokens)} · ${fmtCost(tt.cost)}` : "";
}

// --- trend badges (period over period) ---
// Each KPI tile that supports a trend shows a small badge: arrow + delta%.
// `polarity` says which direction is "good":
//   "up"      ↑ is better (green), ↓ worse (red)   — e.g. cache hit ratio
//   "down"    ↓ is better (green), ↑ worse (red)   — e.g. error rate, $/hour
//   "neutral" no colour — volume isn't good/bad     — e.g. cost, tokens
type Polarity = "up" | "down" | "neutral";
interface TrendBadge {
  text: string; // "+12%" / "−4%" / "—"
  arrow: "up" | "down" | "flat" | "none";
  cls: "good" | "bad" | "neutral"; // colour class
}
const NO_TREND: TrendBadge = { text: "—", arrow: "none", cls: "neutral" };

// Build a badge from current/previous values. cur/prev null or prev≤0 → "—".
function makeTrend(cur: number | null, prev: number | null, polarity: Polarity): TrendBadge {
  if (cur === null || prev === null || prev <= 0) return NO_TREND;
  const pct = ((cur - prev) / prev) * 100;
  const rounded = Math.round(pct);
  const arrow: TrendBadge["arrow"] = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  const text = `${sign}${Math.abs(rounded)}%`;
  let cls: TrendBadge["cls"] = "neutral";
  if (polarity !== "neutral" && rounded !== 0) {
    const improved = polarity === "up" ? rounded > 0 : rounded < 0;
    cls = improved ? "good" : "bad";
  }
  return { text, arrow, cls };
}

const trendCost = computed(() =>
  compare.value
    ? makeTrend(compare.value.current_trend.cost, compare.value.previous_trend.cost, "neutral")
    : NO_TREND,
);
const trendTokens = computed(() =>
  compare.value
    ? makeTrend(
        compare.value.current_trend.total_tokens,
        compare.value.previous_trend.total_tokens,
        "neutral",
      )
    : NO_TREND,
);
const trendCacheHit = computed(() =>
  compare.value
    ? makeTrend(
        compare.value.current_trend.cache_hit_ratio,
        compare.value.previous_trend.cache_hit_ratio,
        "up",
      )
    : NO_TREND,
);
// error_rate and cost_per_active_hour are both fraction/USD on each side, so
// the delta% composes directly. Lower is better → "down" polarity.
const trendErrorRate = computed(() =>
  compare.value
    ? makeTrend(
        compare.value.current_trend.error_rate,
        compare.value.previous_trend.error_rate,
        "down",
      )
    : NO_TREND,
);
const trendCostPerHour = computed(() =>
  compare.value
    ? makeTrend(
        compare.value.current_trend.cost_per_active_hour,
        compare.value.previous_trend.cost_per_active_hour,
        "down",
      )
    : NO_TREND,
);

// --- goal indicators ---
// Two tiles can carry a goal indicator. The error-rate goal is stored as a
// FRACTION 0..1; the tile metric `tool_error.error_rate` is a PERCENT 0..100 —
// so we scale the goal up by 100 before comparing. $/hour is USD on both sides.
type GoalState = "ok" | "exceeded" | null; // null = no goal set / no metric
const errorRateGoalState = computed<GoalState>(() => {
  const goal = goalErrorRateMax.value; // fraction 0..1
  const metric = data.value?.tool_error.error_rate; // percent 0..100
  if (goal === null || metric === null || metric === undefined) return null;
  return metric <= goal * 100 ? "ok" : "exceeded";
});
const costPerHourGoalState = computed<GoalState>(() => {
  const goal = goalCostPerHourMax.value; // USD/hour
  const metric = data.value?.productivity.cost_per_active_hour; // USD/hour
  if (goal === null || metric === null || metric === undefined) return null;
  return metric <= goal ? "ok" : "exceeded";
});

async function loadGoals() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    goalCostPerHourMax.value = (await store.get<number | null>("goalCostPerHourMax")) ?? null;
    goalErrorRateMax.value = (await store.get<number | null>("goalErrorRateMax")) ?? null;
  } catch {
    goalCostPerHourMax.value = null;
    goalErrorRateMax.value = null;
  }
}

// --- presets ---
function setRange(days: number) {
  dateFrom.value = daysAgo(days);
  dateTo.value = today();
}
// Which preset (if any) the current from/to range matches, for the active
// highlight on the segmented control. null = a custom range was picked.
const activeRange = computed<number | null>(() => {
  if (dateTo.value !== today()) return null;
  for (const d of [7, 30, 90]) if (dateFrom.value === daysAgo(d)) return d;
  return null;
});

// --- charts ---
// The cost chart appears on both the Overview and Trends tabs. The tabs are
// `v-if`-gated, so only one of the two cost canvases is ever mounted at a time —
// a single Chart instance bound to whichever is live is enough. The tokens
// chart lives only on Trends.
const costCanvas = ref<HTMLCanvasElement | null>(null); // Overview
const costCanvas2 = ref<HTMLCanvasElement | null>(null); // Trends
const tokenCanvas = ref<HTMLCanvasElement | null>(null); // Trends
let costChart: Chart | null = null;
let tokenChart: Chart | null = null;

// Vertical crosshair drawn at the hovered x-position on the cost chart. Paired
// with `interaction: { mode: "index", intersect: false }` so the tooltip (the
// value readout) and this guide line both track the cursor anywhere along x.
const costCrosshair = {
  id: "costCrosshair",
  afterDraw(chart: Chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length) return;
    const x = (active[0].element as unknown as { x: number }).x;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.stroke();
    ctx.restore();
  },
};

function renderCharts() {
  const d = data.value;
  if (!d) return;
  const labels = d.daily.map((p) => fmtDay(p.date, locale.value));
  const grid = "rgba(255,255,255,0.06)";
  const tick = "rgba(255,255,255,0.45)";

  // Cost over time (single line). Extra-usage credit history isn't available
  // per-day from the API, so this charts CC spend — which is what drives most
  // of the extra-usage curve in practice. Render into whichever cost canvas the
  // active tab has mounted (Overview or Trends).
  const costEl = costCanvas.value || costCanvas2.value;
  if (costEl) {
    costChart?.destroy();
    costChart = new Chart(costEl, {
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
        // Hover anywhere over a day → highlight that point + show its value,
        // not only when the cursor sits exactly on the 2px dot.
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          // Default tooltip prints the raw JS number ("$2.90000000000004").
          // Round it the same way the KPI/list cells do.
          tooltip: { callbacks: { label: (c) => fmtCost(Number(c.parsed.y) || 0) } },
        },
      },
      plugins: [costCrosshair],
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
const PCT_KEYS = new Set(["pct", "share_pct", "churn_pct", "delta_pct", "hit_pct", "standard_pct", "rate"]);
const COST_KEYS = new Set(["cost", "with_rate", "without_rate", "savings", "per_h", "median_h"]);
const TOK_KEYS = new Set(["avg_ctx"]);
// One-decimal numeric keys (hours of active work in low_roi). Passed as a plain
// number with no unit prefix — the i18n string carries the unit.
const NUM1_KEYS = new Set(["active_h"]);
function insightText(ins: Insight): string {
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(ins.params)) {
    if (typeof v === "number") {
      if (COST_KEYS.has(k)) p[k] = fmtCost(v);
      else if (PCT_KEYS.has(k)) p[k] = v.toFixed(0);
      else if (TOK_KEYS.has(k)) p[k] = fmtTokens(v);
      else if (NUM1_KEYS.has(k)) p[k] = v.toFixed(1);
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

// Open the shared settings window on the Budget tab (issue #45).
async function openSettings() {
  await invoke("open_settings_window", { tab: "budget" });
}

// Largest per-row metric (cost) — scales the costly-session bars.
function maxCost(rows: SessionUsage[]): number {
  return rows.reduce((m, r) => (r.cost > m ? r.cost : m), 0);
}
function maxCache(rows: SessionUsage[]): number {
  return rows.reduce((m, r) => (r.cache_create > m ? r.cache_create : m), 0);
}

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

// Backend now emits only actionable recommendations, so the section is a flat
// list (no observation/recommendation tab split). `activeInsights` is the
// non-ignored set; ignored ones live in the restorable "Hidden" block.
const activeInsights = computed(() =>
  (data.value?.insights ?? []).filter((i) => !ignoredKinds.value.includes(i.kind)),
);
const ignoredInsights = computed(() =>
  (data.value?.insights ?? []).filter((i) => ignoredKinds.value.includes(i.kind)),
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

// cold_rewrites carries a per-cause breakdown the flat label can't render. Map
// each cause to its localized label and pre-format the cost; the template lists
// only the causes the backend actually saw (zero-count ones are omitted there).
const COLD_CAUSE_LABEL: Record<string, string> = {
  compaction: "insightColdCauseCompaction",
  idle: "insightColdCauseIdle",
  model_switch: "insightColdCauseModelSwitch",
};
interface ColdCause {
  cause: string;
  label: string;
  n: number;
  cost: string;
}
function coldCauses(ins: Insight): ColdCause[] {
  const arr = (ins.params as Record<string, unknown>)?.causes;
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ cause: string; n: number; cost: number }>).map((c) => ({
    cause: c.cause,
    label: t(COLD_CAUSE_LABEL[c.cause] ?? c.cause),
    n: c.n,
    cost: fmtCost(c.cost),
  }));
}
const expandedAffected = ref<Set<string>>(new Set());
function toggleAffected(kind: string) {
  const next = new Set(expandedAffected.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  expandedAffected.value = next;
}

// Per-kind expandable help panel rendered below the insight card. The help
// bundle is imported at the top of the file; the renderer caches HTML per
// kind+locale so opening the same card twice is free.
const expandedHelp = ref<Set<string>>(new Set());
function toggleHelp(kind: string) {
  const next = new Set(expandedHelp.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  expandedHelp.value = next;
}
function helpAvailable(kind: string): boolean {
  return hasInsightHelp(kind, locale.value);
}
function helpHtml(kind: string): string {
  return getInsightHelpHtml(kind, locale.value);
}

// --- per-tile metric help (KPI tiles) ---
// Same text source as before: each tile has an `<key>Help` i18n string written
// in the lightweight markdown the insight renderer understands (## headings,
// `- ` bullets, **bold**, `inline code`), piped through the shared renderer.
// Rendered HTML is memoised per key+locale so re-opening a tile is free.
//
// Display is a floating popover (Teleport to <body> + position: fixed) instead
// of an inline body, so opening a tile's help never changes the tile's height,
// reflows the KPI grid, or extends the scroll area of `.aw-main`. At most one
// popover is open at a time.
const TILE_HELP_CACHE = new Map<string, string>();
function tileHelpHtml(key: string): string {
  const cacheKey = `${key}.${locale.value}`;
  const cached = TILE_HELP_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const html = renderInsightHelp(t(key));
  TILE_HELP_CACHE.set(cacheKey, html);
  return html;
}

// Currently open tile popover: which `<key>Help` i18n key, the fixed-position
// style computed from the trigger + the popover's REAL measured size, and a
// `visibility` flag. The popover mounts hidden (visibility:hidden) so we can
// measure its rendered height/width on `nextTick`, then compute the final
// top/left and reveal it — this avoids relying on a fixed height estimate that
// clips long content near the window edge.
interface TilePopoverStyle {
  top: string;
  left: string;
  maxWidth: string;
  maxHeight: string;
  visibility: "hidden" | "visible";
}
const tilePopover = ref<{
  key: string;
  style: TilePopoverStyle;
} | null>(null);
// The trigger button's rect, captured at open time, used to position the
// popover once its real size is known.
let tilePopoverAnchor: DOMRect | null = null;
// The popover element (Teleported) — used to exclude it from click-outside and
// to measure the rendered popover.
const tilePopoverEl = ref<HTMLElement | null>(null);

const POPOVER_WIDTH = 420; // 1.5× base width; matches max-width in CSS
const POPOVER_GAP = 8; // gap between trigger and popover
const VIEWPORT_MARGIN = 8; // keep this far from window edges

// First-pass style: position the popover roughly below the trigger but keep it
// hidden so it can be measured without flashing. Width is capped to the
// viewport; height is left unconstrained so we can read the natural height.
function provisionalPopoverStyle(r: DOMRect): TilePopoverStyle {
  const vw = window.innerWidth;
  const width = Math.min(POPOVER_WIDTH, vw - VIEWPORT_MARGIN * 2);
  let left = r.right - width;
  if (left < VIEWPORT_MARGIN) left = r.left;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
  return {
    top: `${Math.round(r.bottom + POPOVER_GAP)}px`,
    left: `${Math.round(left)}px`,
    maxWidth: `${Math.round(width)}px`,
    maxHeight: "none",
    visibility: "hidden",
  };
}

// Final style, computed from the trigger rect + the popover's REAL rendered
// size. Flips vertically by real height, caps height to the available space at
// the chosen edge (with inner scroll), and clamps both axes inside the viewport.
function finalPopoverStyle(r: DOMRect, popH: number): TilePopoverStyle {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(POPOVER_WIDTH, vw - VIEWPORT_MARGIN * 2);

  // Horizontal: anchor the popover's right edge to the button (the `?` lives in
  // the tile's top-right) so it opens leftwards; flip rightwards if it clips.
  let left = r.right - width;
  if (left < VIEWPORT_MARGIN) left = r.left;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));

  // Vertical: real space on each side of the trigger (minus the gap + margin).
  const spaceBelow = vh - r.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = r.top - POPOVER_GAP - VIEWPORT_MARGIN;

  let top: number;
  let maxHeight: number;
  if (popH <= spaceBelow) {
    // Fits fully below.
    top = r.bottom + POPOVER_GAP;
    maxHeight = spaceBelow;
  } else if (popH <= spaceAbove) {
    // Doesn't fit below but fits fully above — open upwards.
    top = r.top - POPOVER_GAP - popH;
    maxHeight = spaceAbove;
  } else if (spaceBelow >= spaceAbove) {
    // Fits neither side fully — pick the side with more room and cap the height
    // to it, letting the popover scroll internally.
    top = r.bottom + POPOVER_GAP;
    maxHeight = spaceBelow;
  } else {
    maxHeight = spaceAbove;
    top = r.top - POPOVER_GAP - maxHeight;
  }

  // Final clamp: guarantee the whole popover stays on-screen. effectiveH is the
  // smaller of the natural height and the cap we applied.
  const effectiveH = Math.min(popH, maxHeight);
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - effectiveH - VIEWPORT_MARGIN));

  return {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    maxWidth: `${Math.round(width)}px`,
    maxHeight: `${Math.floor(maxHeight)}px`,
    visibility: "visible",
  };
}

async function toggleTilePopover(key: string, ev: MouseEvent) {
  if (tilePopover.value?.key === key) {
    closeTilePopover();
    return;
  }
  const btn = ev.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  tilePopoverAnchor = rect;
  // Phase 1: mount hidden with a provisional position so it can be measured.
  tilePopover.value = { key, style: provisionalPopoverStyle(rect) };
  // Phase 2: after the popover renders, measure its real size and finalize.
  await nextTick();
  const el = tilePopoverEl.value;
  if (!el || !tilePopover.value || tilePopover.value.key !== key || !tilePopoverAnchor) return;
  const pr = el.getBoundingClientRect();
  tilePopover.value = {
    key,
    style: finalPopoverStyle(tilePopoverAnchor, pr.height || el.offsetHeight),
  };
}

function closeTilePopover() {
  tilePopover.value = null;
  tilePopoverAnchor = null;
}

function onTilePopoverKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && tilePopover.value) {
    closeTilePopover();
  }
}

function onTilePopoverPointerDown(ev: MouseEvent) {
  if (!tilePopover.value) return;
  const target = ev.target as Node;
  // Clicks on the popover itself stay open. Clicks on a `?` trigger are handled
  // by `toggleTilePopover` (which fires its own toggle) — so ignore them here to
  // avoid a close-then-reopen double toggle.
  if (tilePopoverEl.value?.contains(target)) return;
  if (target instanceof Element && target.closest(".aw-kpi-help")) return;
  closeTilePopover();
}

function onTilePopoverDismissScroll() {
  // Position is computed from the live rect; rather than chase it on scroll,
  // just close the popover (allowed by spec) to keep behaviour predictable.
  if (tilePopover.value) closeTilePopover();
}

// --- tabs ---
// The single-scroll dashboard is split into five tabs. Section order/visibility
// (the old `dashboardSections` machinery) is dropped — the tab structure fixes
// where each section lives.
type TabId = "overview" | "trends" | "sessions" | "tools" | "insights" | "projects";
const activeTab = ref<TabId>("overview");
const tabs = computed<{ id: TabId; label: string; count?: number }[]>(() => [
  { id: "overview", label: t("awTabOverview") },
  { id: "trends", label: t("awTabTrends") },
  { id: "sessions", label: t("awTabSessions") },
  { id: "tools", label: t("awTabTools") },
  { id: "insights", label: t("awTabInsights"), count: activeInsights.value.length },
  { id: "projects", label: t("awTabProjects") },
]);

// --- projects tab: per-project breakdown + merge links (issue #13) ---
// The merge maps a RAW project (alias) to a canonical name it's aggregated under,
// so a renamed/absorbed project's history stops fragmenting. Resolution is
// read-time in the backend, so unmerge restores the original split instantly.
interface ProjectLink {
  alias: string;
  canonical: string;
}
const rawProjects = ref<string[]>([]); // un-merged names, for the merge picker
const projectLinks = ref<ProjectLink[]>([]);
const mergeAlias = ref("");
const mergeCanonical = ref("");
const mergeError = ref("");

// Per-project breakdown: top-10 by default, "show more" reveals the long tail.
const PROJ_COLLAPSED_N = 10;
const projExpanded = ref(false);
const visibleProjects = computed(() => {
  const all = data.value?.by_project ?? [];
  return projExpanded.value ? all : all.slice(0, PROJ_COLLAPSED_N);
});

async function loadProjectMgmt() {
  try {
    [rawProjects.value, projectLinks.value] = await Promise.all([
      invoke<string[]>("get_raw_projects"),
      invoke<ProjectLink[]>("get_project_links"),
    ]);
  } catch (e) {
    mergeError.value = String(e);
  }
}

async function doMerge() {
  mergeError.value = "";
  const alias = mergeAlias.value.trim();
  const canonical = mergeCanonical.value.trim();
  if (!alias || !canonical) return;
  try {
    await invoke("set_project_link", { alias, canonical });
    mergeAlias.value = "";
    mergeCanonical.value = "";
    await loadProjectMgmt();
    await reload(); // refresh by_project + the filter list with the new merge
  } catch (e) {
    mergeError.value = String(e);
  }
}

async function doUnmerge(alias: string) {
  mergeError.value = "";
  try {
    await invoke("remove_project_link", { alias });
    await loadProjectMgmt();
    await reload();
  } catch (e) {
    mergeError.value = String(e);
  }
}

// --- session quality + productivity: hide sections with no data ---
// Quality shows only when at least one of its two metrics is known (non-null),
// so an empty window doesn't render a section full of "—".
const hasQuality = computed(
  () =>
    !!data.value &&
    (data.value.tier_breakdown.standard_pct !== null ||
      data.value.tool_error.error_rate !== null),
);
// Productivity shows when the window has any turns or edits (like subagents/tools
// hide when empty).
const hasProductivity = computed(
  () => !!data.value && (data.value.productivity.turns > 0 || data.value.productivity.edits > 0),
);

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
// Tabs are `v-if`-gated, so switching to a tab with charts remounts its
// canvases — re-render once the new DOM is in place.
watch(activeTab, (tab) => {
  void nextTick().then(renderCharts);
  if (tab === "projects") void loadProjectMgmt();
});
let unlistenLinks: UnlistenFn | null = null;
onMounted(async () => {
  // Tile-help popover dismissal: Esc, outside click, and any scroll/resize
  // (capture phase catches scrolls inside `.aw-main`, the inner scroll area).
  document.addEventListener("keydown", onTilePopoverKeydown);
  document.addEventListener("mousedown", onTilePopoverPointerDown, true);
  window.addEventListener("scroll", onTilePopoverDismissScroll, true);
  window.addEventListener("resize", onTilePopoverDismissScroll);

  await loadLocaleFromStore();
  await loadIgnored();
  await loadGoals();
  await load();

  // Refresh if a merge happens (here or in another window) — keeps the breakdown,
  // filter list and merge table in sync without a manual reload.
  unlistenLinks = await listen("project-links-changed", () => {
    void reload();
    if (activeTab.value === "projects") void loadProjectMgmt();
  });
});

onUnmounted(() => {
  document.removeEventListener("keydown", onTilePopoverKeydown);
  document.removeEventListener("mousedown", onTilePopoverPointerDown, true);
  window.removeEventListener("scroll", onTilePopoverDismissScroll, true);
  window.removeEventListener("resize", onTilePopoverDismissScroll);
  unlistenLinks?.();
});
</script>

<template>
  <div class="aw-root">
    <header class="aw-head">
      <h1>{{ t("analytics") }}</h1>
      <div class="aw-filters">
        <div class="aw-presets">
          <button :class="{ active: activeRange === 7 }" @click="setRange(7)">{{ t("range7d") }}</button>
          <button :class="{ active: activeRange === 30 }" @click="setRange(30)">{{ t("range30d") }}</button>
          <button :class="{ active: activeRange === 90 }" @click="setRange(90)">{{ t("range90d") }}</button>
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
          <ProjectAutocomplete
            v-model="projectFilter"
            :options="data?.projects ?? []"
            :placeholder="t('allProjects')"
            clearable
            commit-on="select"
            width="180px"
          />
        </label>
        <button class="aw-export" @click="doExport" :title="t('exportJsonHint')">
          {{ t("exportJson") }}
        </button>
        <button class="aw-settings" @click="openSettings" :title="t('settings')">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <nav v-if="data" class="aw-tabs">
      <button
        v-for="tb in tabs"
        :key="tb.id"
        class="aw-tab"
        :class="{ active: activeTab === tb.id }"
        @click="activeTab = tb.id"
      >
        {{ tb.label }}<span v-if="tb.count != null" class="aw-tab-cnt">{{ tb.count }}</span>
      </button>
    </nav>

    <main class="aw-main">
      <div v-if="error" class="aw-empty">{{ error }}</div>
      <div v-else-if="loading && !data" class="aw-empty">{{ t("loading") }}</div>

      <template v-else-if="data">
        <!-- ===== Overview: KPI totals + quality headline tiles + productivity + cost ===== -->
        <div v-if="activeTab === 'overview'" class="aw-panel">
          <div class="aw-group-hd">{{ t("sectionKpi") }}</div>
          <section class="aw-kpis">
            <div class="aw-kpi">
              <div class="aw-kpi-val">{{ fmtCost(data.totals.cost) }}</div>
              <div class="aw-kpi-lbl">{{ t("analyticsTotal") }}</div>
              <span
                class="aw-trend"
                :class="'t-' + trendCost.cls"
                :title="trendCost.arrow === 'none' ? t('trendNoData') : t('trendVsPrev')"
              >
                <span class="aw-trend-arrow" :data-dir="trendCost.arrow"></span>{{ trendCost.text }}
              </span>
            </div>
            <div class="aw-kpi">
              <div class="aw-kpi-val">{{ fmtTokens(data.totals.total_tokens) }}</div>
              <div class="aw-kpi-lbl">{{ t("metricTokens") }}</div>
              <span
                class="aw-trend"
                :class="'t-' + trendTokens.cls"
                :title="trendTokens.arrow === 'none' ? t('trendNoData') : t('trendVsPrev')"
              >
                <span class="aw-trend-arrow" :data-dir="trendTokens.arrow"></span>{{ trendTokens.text }}
              </span>
            </div>
            <div class="aw-kpi">
              <div class="aw-kpi-val">{{ data.totals.sessions }}</div>
              <div class="aw-kpi-lbl">{{ t("analyticsPerSession") }}</div>
            </div>
            <div class="aw-kpi" :title="t('subagentKpiHint')">
              <div class="aw-kpi-val">{{ data.subagent_summary.subagent_messages }}</div>
              <div class="aw-kpi-lbl">{{ t("subagentKpiLabel") }}</div>
            </div>
            <div
              v-if="data.totals.input + data.totals.cache_read > 0"
              class="aw-kpi"
              :title="t('kpiHitRatioHint')"
            >
              <button
                class="aw-kpi-help"
                :title="t(tilePopover?.key === 'kpiHitRatioHelp' ? 'hideHelp' : 'showHelp')"
                :aria-expanded="tilePopover?.key === 'kpiHitRatioHelp'"
                @click="toggleTilePopover('kpiHitRatioHelp', $event)"
              >?</button>
              <div class="aw-kpi-val">{{ (data.totals.cache_hit_ratio * 100).toFixed(0) }}%</div>
              <div class="aw-kpi-lbl">{{ t("kpiHitRatio") }}</div>
              <span
                class="aw-trend"
                :class="'t-' + trendCacheHit.cls"
                :title="trendCacheHit.arrow === 'none' ? t('trendNoData') : t('trendVsPrev')"
              >
                <span class="aw-trend-arrow" :data-dir="trendCacheHit.arrow"></span>{{ trendCacheHit.text }}
              </span>
            </div>
            <div class="aw-kpi" :title="t('kpiCacheSavingsHint')">
              <button
                class="aw-kpi-help"
                :title="t(tilePopover?.key === 'kpiCacheSavingsHelp' ? 'hideHelp' : 'showHelp')"
                :aria-expanded="tilePopover?.key === 'kpiCacheSavingsHelp'"
                @click="toggleTilePopover('kpiCacheSavingsHelp', $event)"
              >?</button>
              <div class="aw-kpi-val">{{ fmtCost(data.totals.cache_savings_usd) }}</div>
              <div class="aw-kpi-lbl">{{ t("kpiCacheSavings") }}</div>
            </div>
          </section>

          <!-- Session quality: service-tier split + tool error rate (prominent tiles) -->
          <section v-if="hasQuality" class="aw-kpis aw-headline">
            <div
              v-if="data.tier_breakdown.standard_pct !== null"
              class="aw-kpi"
              :title="t('qualityTierHint')"
            >
              <button
                class="aw-kpi-help"
                :title="t(tilePopover?.key === 'qualityTierHelp' ? 'hideHelp' : 'showHelp')"
                :aria-expanded="tilePopover?.key === 'qualityTierHelp'"
                @click="toggleTilePopover('qualityTierHelp', $event)"
              >?</button>
              <div class="aw-kpi-val">{{ fmtPct(data.tier_breakdown.standard_pct) }}</div>
              <div class="aw-kpi-lbl">{{ t("qualityTierLabel") }}</div>
            </div>
            <div
              v-if="data.tool_error.error_rate !== null"
              class="aw-kpi"
              :class="errorRateGoalState ? 'goal-' + errorRateGoalState : ''"
              :title="t('qualityErrorHint')"
            >
              <button
                class="aw-kpi-help"
                :title="t(tilePopover?.key === 'qualityErrorHelp' ? 'hideHelp' : 'showHelp')"
                :aria-expanded="tilePopover?.key === 'qualityErrorHelp'"
                @click="toggleTilePopover('qualityErrorHelp', $event)"
              >?</button>
              <div class="aw-kpi-val">{{ fmtPct(data.tool_error.error_rate) }}</div>
              <div class="aw-kpi-lbl">{{ t("qualityErrorLabel") }}</div>
              <span
                class="aw-trend"
                :class="'t-' + trendErrorRate.cls"
                :title="trendErrorRate.arrow === 'none' ? t('trendNoData') : t('trendVsPrev')"
              >
                <span class="aw-trend-arrow" :data-dir="trendErrorRate.arrow"></span>{{ trendErrorRate.text }}
              </span>
              <span
                v-if="errorRateGoalState"
                class="aw-goal"
                :class="'goal-' + errorRateGoalState"
              >{{ errorRateGoalState === 'ok' ? t('goalInGoal') : t('goalExceeded') }}</span>
            </div>
          </section>

          <!-- Productivity / ROI: active time, $/hour, $/commit, $/edit -->
          <template v-if="hasProductivity">
            <div class="aw-group-hd">{{ t("sectionProductivity") }}</div>
            <section class="aw-kpis">
              <div class="aw-kpi" :title="t('prodActiveTimeHint')">
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodActiveTimeHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodActiveTimeHelp'"
                  @click="toggleTilePopover('prodActiveTimeHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ fmtDuration(data.productivity.active_ms) }}</div>
                <div class="aw-kpi-lbl">{{ t("prodActiveTime") }}</div>
              </div>
              <div
                class="aw-kpi"
                :class="costPerHourGoalState ? 'goal-' + costPerHourGoalState : ''"
                :title="data.productivity.cost_per_active_hour === null ? t('prodNoActiveTime') : ''"
              >
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodCostPerHourHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodCostPerHourHelp'"
                  @click="toggleTilePopover('prodCostPerHourHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ fmtCostOrDash(data.productivity.cost_per_active_hour) }}</div>
                <div class="aw-kpi-lbl">{{ t("prodCostPerHour") }}</div>
                <span
                  class="aw-trend"
                  :class="'t-' + trendCostPerHour.cls"
                  :title="trendCostPerHour.arrow === 'none' ? t('trendNoData') : t('trendVsPrev')"
                >
                  <span class="aw-trend-arrow" :data-dir="trendCostPerHour.arrow"></span>{{ trendCostPerHour.text }}
                </span>
                <span
                  v-if="costPerHourGoalState"
                  class="aw-goal"
                  :class="'goal-' + costPerHourGoalState"
                >{{ costPerHourGoalState === 'ok' ? t('goalInGoal') : t('goalExceeded') }}</span>
              </div>
              <div
                class="aw-kpi"
                :title="data.productivity.tokens_per_active_minute === null ? t('prodNoActiveTime') : ''"
              >
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodTokensPerMinHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodTokensPerMinHelp'"
                  @click="toggleTilePopover('prodTokensPerMinHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ fmtTokensOrDash(data.productivity.tokens_per_active_minute) }}</div>
                <div class="aw-kpi-lbl">{{ t("prodTokensPerMin") }}</div>
              </div>
              <div class="aw-kpi">
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodCommitsHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodCommitsHelp'"
                  @click="toggleTilePopover('prodCommitsHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ data.productivity.git_commits }}</div>
                <div class="aw-kpi-lbl">{{ t("prodCommits") }}</div>
              </div>
              <div
                class="aw-kpi"
                :title="data.productivity.cost_per_commit === null ? t('prodNoCommits') : ''"
              >
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodCostPerCommitHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodCostPerCommitHelp'"
                  @click="toggleTilePopover('prodCostPerCommitHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ fmtCostOrDash(data.productivity.cost_per_commit) }}</div>
                <div class="aw-kpi-lbl">{{ t("prodCostPerCommit") }}</div>
              </div>
              <div class="aw-kpi">
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodEditsHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodEditsHelp'"
                  @click="toggleTilePopover('prodEditsHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ data.productivity.edits }}</div>
                <div class="aw-kpi-lbl">{{ t("prodEdits") }}</div>
              </div>
              <div class="aw-kpi" :title="t('prodEditsHint')">
                <button
                  class="aw-kpi-help"
                  :title="t(tilePopover?.key === 'prodCostPerEditHelp' ? 'hideHelp' : 'showHelp')"
                  :aria-expanded="tilePopover?.key === 'prodCostPerEditHelp'"
                  @click="toggleTilePopover('prodCostPerEditHelp', $event)"
                >?</button>
                <div class="aw-kpi-val">{{ fmtCostOrDash(data.productivity.cost_per_edit) }}</div>
                <div class="aw-kpi-lbl">{{ t("prodCostPerEdit") }}</div>
              </div>
            </section>
          </template>

          <!-- Headline cost chart -->
          <div class="aw-card">
            <div class="aw-card-hd">{{ t("chartCost") }}</div>
            <div class="aw-chart"><canvas ref="costCanvas"></canvas></div>
          </div>
        </div>

        <!-- ===== Trends: cost + tokens charts ===== -->
        <div v-if="activeTab === 'trends'" class="aw-panel">
          <section class="aw-grid">
            <div class="aw-card">
              <div class="aw-card-hd">{{ t("chartCost") }}</div>
              <div class="aw-chart"><canvas ref="costCanvas2"></canvas></div>
            </div>
            <div class="aw-card">
              <div class="aw-card-hd">{{ t("chartTokens") }}</div>
              <div class="aw-chart"><canvas ref="tokenCanvas"></canvas></div>
            </div>
          </section>
        </div>

        <!-- ===== Sessions: costly by cost + by cache ===== -->
        <div v-if="activeTab === 'sessions'" class="aw-panel">
          <section class="aw-grid">
            <div class="aw-card">
              <div class="aw-card-hd">{{ t("costlyByCost") }}</div>
              <div class="aw-list">
                <div v-for="s in data.costly_by_cost" :key="'c' + s.session_id" class="aw-row">
                  <div class="aw-row-line">
                    <span class="aw-row-when">{{ fmtWhen(s.start) }}</span>
                    <span v-if="!projectFilter" class="aw-row-proj">
                      <ProjectLabel :name="s.project" :aliases="aliasesOf(s.project)" />
                    </span>
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
                    <span v-if="!projectFilter" class="aw-row-proj">
                      <ProjectLabel :name="s.project" :aliases="aliasesOf(s.project)" />
                    </span>
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
        </div>

        <!-- ===== Tools: tool breakdown + subagents ===== -->
        <div v-if="activeTab === 'tools'" class="aw-panel">
          <!-- Tool breakdown — search + top-3 by default, "Show more" reveals long tail -->
          <section v-if="data.tool_breakdown.length" class="aw-card">
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

          <!-- Subagents -->
          <section v-if="data.by_subagent.length" class="aw-card">
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

          <div v-if="!data.tool_breakdown.length && !data.by_subagent.length" class="aw-empty-inline">
            {{ t("insightEmpty") }}
          </div>
        </div>

        <!-- ===== Insights: actionable recommendations ===== -->
        <div v-if="activeTab === 'insights'" class="aw-panel">
          <section class="aw-insights-block">
            <div class="aw-insights-hd">
              {{ t("sectionInsights") }}
              <span class="aw-tab-count">{{ activeInsights.length }}</span>
            </div>
            <div v-if="activeInsights.length" class="aw-insights">
              <div
                v-for="ins in activeInsights"
                :key="ins.kind"
                class="aw-insight"
                :data-kind="ins.kind"
              >
                <span class="aw-insight-tag">{{ t("insight") }}</span>
                <div class="aw-insight-body">
                  <div class="aw-insight-text">{{ insightText(ins) }}</div>
                  <ul v-if="ins.kind === 'cold_rewrites'" class="aw-cold-causes">
                    <li
                      v-for="c in coldCauses(ins)"
                      :key="c.cause"
                      class="aw-cold-cause"
                    >
                      <span class="aw-cold-cause-label">{{ c.label }}</span>
                      <span class="aw-cold-cause-val">{{ c.n }} × {{ c.cost }}</span>
                    </li>
                  </ul>
                  <div v-if="ins.kind === 'cold_rewrites'" class="aw-cold-fix">
                    {{ t('insightColdRewritesFix') }}
                  </div>
                  <div
                    v-if="affectedOf(ins).length || helpAvailable(ins.kind)"
                    class="aw-insight-links"
                  >
                    <button
                      v-if="affectedOf(ins).length"
                      class="aw-link-btn"
                      @click="toggleAffected(ins.kind)"
                    >
                      {{ expandedAffected.has(ins.kind) ? t('hideSessions') : t('showAffectedSessions') + ' (' + affectedOf(ins).length + ')' }}
                    </button>
                    <button
                      v-if="helpAvailable(ins.kind)"
                      class="aw-link-btn"
                      :aria-expanded="expandedHelp.has(ins.kind)"
                      @click="toggleHelp(ins.kind)"
                    >
                      {{ t(expandedHelp.has(ins.kind) ? 'hideHelp' : 'showHelp') }}
                    </button>
                  </div>
                  <ul v-if="expandedAffected.has(ins.kind)" class="aw-affected-list">
                    <li v-for="a in affectedOf(ins)" :key="a.session_id" class="aw-affected-item">
                      <button
                        class="aw-row-id"
                        @click="copyId(a.session_id)"
                        :title="t('copySession') + ': ' + a.session_id"
                      >{{ shortId(a.session_id) }}</button>
                      <span class="aw-row-proj">
                        <ProjectLabel :name="a.project" :aliases="aliasesOf(a.project)" />
                      </span>
                      <span class="aw-row-val">{{ fmtCost(a.cost) }}</span>
                    </li>
                  </ul>
                  <div
                    v-if="expandedHelp.has(ins.kind)"
                    class="aw-insight-help-body"
                    v-html="helpHtml(ins.kind)"
                  ></div>
                </div>
                <button
                  class="aw-insight-x"
                  :title="t('ignoreInsight')"
                  @click="ignoreInsight(ins.kind)"
                >
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                    <path d="M0 0L10 10M10 0L0 10" />
                  </svg>
                </button>
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
        </div>

        <!-- ===== Projects: merge management + per-project usage breakdown ===== -->
        <div v-if="activeTab === 'projects'" class="aw-panel">
          <section class="aw-proj-block">
            <div class="aw-group-hd">{{ t("projectMergeTitle") }}</div>
            <p class="aw-proj-desc">{{ t("projectMergeDesc") }}</p>

            <div class="aw-merge-form">
              <ProjectAutocomplete
                v-model="mergeAlias"
                :options="rawProjects"
                :placeholder="t('projectMergeAliasLabel')"
                width="180px"
              />
              <span class="aw-merge-arrow">→</span>
              <ProjectAutocomplete
                v-model="mergeCanonical"
                :options="rawProjects"
                :placeholder="t('projectMergeCanonicalPlaceholder')"
                width="200px"
              />
              <button
                class="aw-merge-btn"
                :disabled="!mergeAlias || !mergeCanonical.trim()"
                @click="doMerge"
              >
                {{ t("projectMergeBtn") }}
              </button>
            </div>
            <div v-if="mergeError" class="aw-merge-err">{{ mergeError }}</div>

            <ul v-if="projectLinks.length" class="aw-merge-list">
              <li v-for="l in projectLinks" :key="l.alias" class="aw-merge-row">
                <span class="aw-merge-alias">{{ l.alias }}</span>
                <span class="aw-merge-arrow">→</span>
                <span class="aw-merge-canon">{{ l.canonical }}</span>
                <button class="aw-link-btn" @click="doUnmerge(l.alias)">
                  {{ t("projectMergeUnmerge") }}
                </button>
              </li>
            </ul>
            <div v-else class="aw-proj-desc">{{ t("projectMergeEmpty") }}</div>
          </section>

          <section class="aw-proj-block">
            <div class="aw-group-hd">{{ t("awGroupsTitle") }}</div>
            <p class="aw-proj-desc">{{ t("groupsDesc") }}</p>

            <div class="aw-merge-form">
              <input
                v-model="newGroupName"
                class="aw-group-input"
                :placeholder="t('groupCreatePlaceholder')"
                @keydown.enter.prevent="createGroup"
              />
              <button class="aw-merge-btn" :disabled="!newGroupName.trim()" @click="createGroup">
                {{ t("groupCreate") }}
              </button>
            </div>

            <div v-if="projectGroups.length" class="aw-groups">
              <div v-for="g in projectGroups" :key="g.name" class="aw-group">
                <div class="aw-group-head">
                  <span class="aw-group-name">{{ g.name }}</span>
                  <span v-if="groupTotalText(g)" class="aw-group-total">{{ groupTotalText(g) }}</span>
                  <button class="aw-link-btn" @click="deleteGroup(g.name)">
                    {{ t("groupDelete") }}
                  </button>
                </div>
                <div v-if="g.projects.length" class="aw-group-members">
                  <span v-for="p in g.projects" :key="p" class="aw-chip">
                    {{ p }}
                    <button
                      class="aw-chip-x"
                      :aria-label="t('groupDelete')"
                      @click="removeFromGroup(g.name, p)"
                    >×</button>
                  </span>
                </div>
                <div class="aw-merge-form">
                  <ProjectAutocomplete
                    :model-value="groupAddDraft[g.name] ?? ''"
                    :options="rawProjects"
                    :placeholder="t('groupAddPlaceholder')"
                    width="180px"
                    @update:model-value="(v: string) => (groupAddDraft[g.name] = v)"
                  />
                  <button
                    class="aw-merge-btn"
                    :disabled="!(groupAddDraft[g.name] ?? '').trim()"
                    @click="addToGroup(g.name)"
                  >
                    {{ t("groupAdd") }}
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="aw-proj-desc">{{ t("groupsEmpty") }}</div>
          </section>

          <section class="aw-proj-block">
            <div class="aw-group-hd">{{ t("projectBreakdownTitle") }}</div>
            <table v-if="data.by_project.length" class="aw-table">
              <thead>
                <tr>
                  <th>{{ t("analyticsByProject") }}</th>
                  <th>{{ t("metricTokens") }}</th>
                  <th>{{ t("metricCost") }}</th>
                  <th>{{ t("subagentSessions") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in visibleProjects" :key="p.project ?? '∅'">
                  <td class="aw-proj-name">
                    <ProjectLabel
                      :name="p.project"
                      :aliases="aliasesOf(p.project)"
                      :related="relatedOf(p.project)"
                    />
                  </td>
                  <td>{{ fmtTokens(p.total_tokens) }}</td>
                  <td>{{ fmtCost(p.cost) }}</td>
                  <td>{{ p.sessions }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="aw-proj-desc">{{ t("projectMergeNoProjects") }}</div>
            <button
              v-if="data.by_project.length > PROJ_COLLAPSED_N"
              class="aw-link-btn"
              @click="projExpanded = !projExpanded"
            >
              {{ projExpanded ? t("showLess") : t("showMore") + ' (' + (data.by_project.length - PROJ_COLLAPSED_N) + ')' }}
            </button>
          </section>
        </div>
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

    <!-- KPI tile help popover — Teleported to <body> with position: fixed so it
         floats above the layout without changing tile height, reflowing the KPI
         grid, or extending the scroll area. Positioned from the trigger's rect. -->
    <Teleport to="body">
      <div
        v-if="tilePopover"
        ref="tilePopoverEl"
        class="aw-tile-popover aw-insight-help-body"
        role="dialog"
        :style="tilePopover.style"
        v-html="tileHelpHtml(tilePopover.key)"
      ></div>
    </Teleport>
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
  /* Claude-code orange accent for this window's controls (matches the cost
     chart line), instead of the app-wide Win11 blue. Overriding the token here
     repaints every `var(--accent)` control inside the window at once. */
  --accent: #d97757;
  --accent-soft: rgba(217, 119, 87, 0.18);
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
  border: 1px solid var(--stroke-strong);
  color: var(--text);
  border-radius: var(--card-radius);
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--segoe);
  /* Hints the platform to render the dropdown in a dark colour scheme so the
     OS popup menu (which the WebView can't fully restyle) picks dark fg/bg. */
  color-scheme: dark;
}
.aw-filters input:focus,
.aw-filters select:focus {
  outline: none;
  border-color: var(--accent);
}
/* `<option>` is system-painted on Windows — set explicit colours so the
   dropdown isn't white-on-white in dark mode. */
.aw-filters select option {
  background: #232323;
  color: #e8e8e8;
}
.aw-presets {
  display: inline-flex;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--card-radius);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
}
.aw-presets button {
  border: none;
  background: transparent;
  color: var(--text-2);
  padding: 5px 12px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.aw-presets button + button {
  border-left: 1px solid var(--stroke-strong);
}
.aw-presets button:hover {
  background: var(--card-bg-hover);
  color: var(--text);
}
/* Active range in the segmented control — accent fill. */
.aw-presets button.active,
.aw-presets button.active:hover {
  background: var(--accent);
  color: #fff;
}
.aw-export {
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
  border-radius: var(--card-radius);
  padding: 5px 12px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: filter 120ms;
}
.aw-export:hover {
  filter: brightness(1.1);
}

/* Settings gear — secondary icon button next to Export. */
.aw-settings {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--stroke-strong);
  background: transparent;
  color: var(--text-2);
  border-radius: var(--card-radius);
  padding: 5px 8px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.aw-settings:hover {
  border-color: var(--accent);
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}

/* Tab bar under the header — one row of buttons, the active one gets an accent
   underline (Win11 / Fluent pivot style). */
.aw-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--stroke-strong);
  flex-wrap: wrap;
}
.aw-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  padding: 10px 14px;
  font-size: 13px;
  font-family: var(--segoe);
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: -1px;
  transition: color 120ms, border-color 120ms;
}
.aw-tab:hover {
  color: var(--text);
}
.aw-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.aw-tab-cnt {
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 10px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 700;
  min-width: 18px;
  text-align: center;
}

.aw-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Each tab body stacks its sections like the old single-scroll page did. */
.aw-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Small uppercase group label inside a tab panel (e.g. "KPI summary"). */
.aw-group-hd {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: -6px;
}
.aw-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 14px;
}
/* Inline empty state inside a tab panel (e.g. Tools tab with no data). */
.aw-empty-inline {
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 13px;
  font-style: italic;
  padding: 24px 4px;
  text-align: center;
}

/* --- Projects tab: per-project breakdown + merge management (issue #13) --- */
.aw-proj-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aw-proj-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  max-width: 64ch;
  line-height: 1.5;
}
.aw-proj-name {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aw-merge-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.aw-merge-arrow {
  color: var(--text-4, rgba(255, 255, 255, 0.5));
}
.aw-merge-btn {
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
  border-radius: var(--card-radius);
  padding: 5px 14px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: filter 120ms;
}
.aw-merge-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.aw-merge-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.aw-merge-err {
  font-size: 12px;
  color: #e5736b;
}
.aw-merge-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.aw-merge-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.aw-merge-alias {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
}
.aw-merge-canon {
  color: var(--text, #e8e8e8);
  font-weight: 500;
  flex: 1;
}

/* --- Association groups (issue #13) --- */
.aw-group-input {
  background: var(--card-bg, #232323);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  color: var(--text);
  border-radius: var(--card-radius, 6px);
  padding: 7px 10px;
  font-size: 13px;
  font-family: var(--segoe);
  color-scheme: dark;
  width: 220px;
}
.aw-group-input:focus {
  outline: none;
  border-color: var(--accent);
}
.aw-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aw-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}
.aw-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aw-group-name {
  font-weight: 600;
  font-size: 13px;
}
.aw-group-total {
  font-size: 12px;
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.aw-group-head .aw-link-btn {
  flex-shrink: 0;
}
.aw-group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.aw-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  font-size: 12px;
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
}
.aw-chip-x {
  border: none;
  background: transparent;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.aw-chip-x:hover {
  color: var(--text, #e8e8e8);
}

.aw-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
/* Two prominent headline tiles (service tier + tool error rate). */
.aw-kpis.aw-headline {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.aw-kpis.aw-headline .aw-kpi-val {
  font-size: 28px;
}
.aw-kpi {
  position: relative;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
/* `?` help toggle on a KPI tile — reuses the insight-card help affordance, but
   pinned to the tile's top-right corner so it doesn't disturb the centred
   value/label. Opening it shows the floating `.aw-tile-popover` (Teleported to
   <body>), so the tile's height never changes. */
.aw-kpi-help {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.aw-kpi-help:hover,
.aw-kpi-help[aria-expanded="true"] {
  color: rgba(255, 255, 255, 0.95);
  border-color: rgba(255, 255, 255, 0.55);
  background: rgba(255, 255, 255, 0.06);
}
/* Floating help popover for KPI tiles. Teleported to <body> and fixed-position
   (coordinates set inline from the trigger's bounding rect, with edge clamping
   + flip in JS), so it never affects the tile/grid layout or the scroll area.
   Reuses the insight help-body typography via the shared `.aw-insight-help-body`
   class; this rule only adds the floating-card chrome. */
/* Two classes so this beats `.aw-insight-help-body` (defined later in the file,
   equal specificity) — otherwise its `padding: 4px` would override the X padding. */
.aw-tile-popover.aw-insight-help-body {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: 420px; /* 1.5× base; JS may shrink this further via inline style near edges */
  /* max-height is set inline from JS to the real space available at the chosen
     edge (it can't be a static vh — that ignores the trigger's position). */
  overflow-y: auto;
  text-align: left;
  padding: 12px 20px;
  background: var(--bg-2, #232323);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  /* Override the inline-body's top divider — the popover is a standalone card. */
  border-top: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.14));
  margin-top: 0;
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

/* Period-over-period trend badge: arrow + delta%, sitting under the KPI label.
   Colour: green = improved, red = worsened, muted = neutral / no data. */
.aw-trend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-4, rgba(255, 255, 255, 0.5));
}
.aw-trend.t-good {
  background: rgba(108, 203, 95, 0.16);
  color: #6ccb5f;
}
.aw-trend.t-bad {
  background: rgba(248, 113, 113, 0.16);
  color: #f87171;
}
.aw-trend.t-neutral {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-3, rgba(255, 255, 255, 0.7));
}
/* Triangle arrow drawn with borders so it inherits the badge text colour. */
.aw-trend-arrow {
  width: 0;
  height: 0;
}
.aw-trend-arrow[data-dir="up"] {
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-bottom: 5px solid currentColor;
}
.aw-trend-arrow[data-dir="down"] {
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-top: 5px solid currentColor;
}
.aw-trend-arrow[data-dir="flat"] {
  width: 7px;
  height: 2px;
  background: currentColor;
}
.aw-trend-arrow[data-dir="none"] {
  display: none;
}

/* Goal indicator pill on the two goal-bearing tiles. */
.aw-goal {
  display: inline-block;
  margin-top: 6px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 10px;
}
.aw-goal.goal-ok {
  background: rgba(108, 203, 95, 0.18);
  color: #6ccb5f;
}
.aw-goal.goal-exceeded {
  background: rgba(248, 113, 113, 0.18);
  color: #f87171;
}
/* Tint the whole tile border to match the goal state. */
.aw-kpi.goal-ok {
  border-color: rgba(108, 203, 95, 0.4);
}
.aw-kpi.goal-exceeded {
  border-color: rgba(248, 113, 113, 0.45);
}

.aw-insights-block {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--stroke-strong);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.aw-insights-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* Solid-green count pill next to the RECOMMENDATIONS title. */
.aw-tab-count {
  background: var(--success);
  color: #06250a;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 700;
  min-width: 18px;
  text-align: center;
}
.aw-insights-empty {
  color: var(--text-4);
  font-size: 12px;
  padding: 10px 4px;
  font-style: italic;
}
.aw-insights {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* Insight row: amber tag | body (text + links) | dismiss control. Neutral dark
   card on the panel surface — not the old green-tinted box. */
.aw-insight {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--stroke);
  border-radius: 8px;
  padding: 11px 12px;
  font-size: 13px;
}
.aw-insight-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.aw-insight-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  text-wrap: pretty;
}
/* Orange text links under the insight body (affected sessions / explain). */
.aw-insight-links {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.aw-insight-links .aw-link-btn {
  padding: 0;
}
.aw-insight-help-body {
  color: rgba(255, 255, 255, 0.78);
  font-size: 12.5px;
  line-height: 1.55;
  padding: 4px 4px 2px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  margin-top: 2px;
}
.aw-insight-help-body h4 {
  margin: 10px 0 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.95);
}
.aw-insight-help-body h4:first-child {
  margin-top: 0;
}
.aw-insight-help-body p {
  margin: 0 0 8px;
}
.aw-insight-help-body ul {
  margin: 0 0 8px;
  padding-left: 18px;
}
.aw-insight-help-body li {
  margin-bottom: 3px;
}
.aw-insight-help-body code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.aw-insight-help-body strong {
  color: rgba(255, 255, 255, 0.95);
}
.aw-insight-x {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-4);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 120ms, color 120ms;
}
.aw-insight-x:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.aw-cold-causes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Cap width so the label (left) and cost (right, space-between) stay close
     instead of stretching across the full card body. */
  max-width: 380px;
}
.aw-cold-cause {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  padding: 3px 8px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 5px;
}
.aw-cold-cause-label {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
}
.aw-cold-cause-val {
  font-variant-numeric: tabular-nums;
  color: var(--text-3, rgba(255, 255, 255, 0.6));
  white-space: nowrap;
}
.aw-cold-fix {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-3, rgba(255, 255, 255, 0.6));
  margin-top: 8px;
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
  border: 1px solid var(--stroke-strong);
  color: inherit;
  border-radius: var(--card-radius);
  padding: 4px 10px;
  font-size: 12px;
  min-width: 180px;
}
.aw-search:focus {
  outline: none;
  border-color: var(--accent);
}
.aw-insight-tag {
  flex: none;
  margin-top: 1px;
  background: rgba(232, 184, 80, 0.18);
  color: #e8b850;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
}
.aw-link-btn {
  background: transparent;
  border: none;
  color: var(--accent);
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
