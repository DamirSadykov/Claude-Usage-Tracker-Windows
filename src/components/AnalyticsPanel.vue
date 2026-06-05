<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { fmtDateTime, fmtDay } from "../dateFormat";
import {
  Chart,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";

Chart.register(
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
);

const { t, locale } = useI18n();

const props = defineProps<{ active: boolean }>();

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
}
interface HeatCell {
  weekday: number;
  hour: number;
  total_tokens: number;
  cost: number;
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
interface Analytics {
  daily: DailyPoint[];
  by_model: ModelUsage[];
  by_project: ProjectUsage[];
  anomalies: SessionUsage[];
  heatmap: HeatCell[];
  totals: Totals;
}
interface PeriodCompare {
  current: Totals;
  previous: Totals;
}

type Metric = "tokens" | "cost";

const rangeDays = ref(7);
const metric = ref<Metric>("cost");
const loading = ref(false);
const error = ref("");
const data = ref<Analytics | null>(null);
const compare = ref<PeriodCompare | null>(null);

const dailyCanvas = ref<HTMLCanvasElement | null>(null);
const modelCanvas = ref<HTMLCanvasElement | null>(null);
let dailyChart: Chart | null = null;
let modelChart: Chart | null = null;

// --- formatting ---
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "K";
  return String(n);
}
function fmtCost(n: number): string {
  return "$" + n.toFixed(2);
}
function fmtMetric(tokens: number, cost: number): string {
  return metric.value === "cost" ? fmtCost(cost) : fmtTokens(tokens);
}
function metricVal(tokens: number, cost: number): number {
  return metric.value === "cost" ? cost : tokens;
}

// "claude-opus-4-7" → "Opus 4.7"
function modelLabel(m: string): string {
  const fam = m.includes("opus")
    ? "Opus"
    : m.includes("sonnet")
      ? "Sonnet"
      : m.includes("haiku")
        ? "Haiku"
        : m;
  const ver = m.match(/(\d+)-(\d+)/);
  return ver ? `${fam} ${ver[1]}.${ver[2]}` : fam;
}

// Each family anchors a hue; individual versions within a family get distinct
// shades around that hue, so "Opus 4.7" and "Opus 4.8" read as different
// colours while still grouping visually by family. [h, s, l] of the base shade.
const FAMILY_HSL: Record<string, [number, number, number]> = {
  Opus: [16, 63, 59], // #d97757
  Sonnet: [113, 50, 58], // #6ccb5f
  Haiku: [209, 58, 59], // #5b9bd5
};
const FALLBACK_HSL: [number, number, number] = [220, 8, 62];

// Build a stable label→colour map from the models actually present. Versions
// in a family are sorted and spread across a lightness (and slight hue) range
// so every model gets its own colour, not one shared per family.
const modelColorMap = computed<Record<string, string>>(() => {
  const families = new Map<string, string[]>();
  for (const m of data.value?.by_model ?? []) {
    const label = modelLabel(m.model);
    const fam = label.split(" ")[0];
    const list = families.get(fam) ?? [];
    if (!list.includes(label)) list.push(label);
    families.set(fam, list);
  }
  const map: Record<string, string> = {};
  for (const [fam, labels] of families) {
    labels.sort();
    const [h, s, l] = FAMILY_HSL[fam] ?? FALLBACK_HSL;
    const n = labels.length;
    labels.forEach((label, i) => {
      // Symmetric spread around the base: single model keeps the base shade.
      const t = n === 1 ? 0 : i / (n - 1) - 0.5; // -0.5 … +0.5
      const light = Math.round(l + t * 30);
      const hue = Math.round(h + t * 16);
      map[label] = `hsl(${hue} ${s}% ${light}%)`;
    });
  }
  return map;
});
function modelColor(label: string): string {
  return modelColorMap.value[label] ?? `hsl(${FALLBACK_HSL[0]} ${FALLBACK_HSL[1]}% ${FALLBACK_HSL[2]}%)`;
}

// Token components. cache_read is muted — it's the cheap per-turn re-read of
// the cached context and typically dwarfs everything else.
type TokenKey = "input" | "output" | "cache_create" | "cache_read";
const TOKEN_TYPES: { key: TokenKey; color: string }[] = [
  { key: "input", color: "#d97757" },
  { key: "output", color: "#6ccb5f" },
  { key: "cache_create", color: "#5b9bd5" },
  { key: "cache_read", color: "#9aa0a6" },
];
const TOKEN_LABEL: Record<TokenKey, string> = {
  input: "tokInput",
  output: "tokOutput",
  cache_create: "tokCacheCreate",
  cache_read: "tokCacheRead",
};

const tokenBreakdown = computed(() => {
  const tot = data.value?.totals;
  if (!tot) return [];
  return TOKEN_TYPES.map((tt) => ({ key: tt.key, color: tt.color, value: tot[tt.key] }));
});

// Token types the user has hidden from the daily chart (e.g. mute cache_read
// to see the rest at a usable scale).
const hiddenTokens = ref<Set<TokenKey>>(new Set());
function toggleToken(k: TokenKey) {
  const next = new Set(hiddenTokens.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  hiddenTokens.value = next;
  if (props.active) renderCharts();
}

// Time chart granularity: per-day or aggregated into weeks (Monday-anchored).
type Gran = "day" | "week";
const granularity = ref<Gran>("day");

interface ChartPoint {
  label: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  cost: number;
}

function mondayOf(dateStr: string): string {
  const dt = new Date(dateStr + "T00:00:00");
  const offset = (dt.getDay() + 6) % 7; // 0 = Monday
  dt.setDate(dt.getDate() - offset);
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${m}-${d}`;
}

// Daily points, optionally rolled up into weekly buckets for the chart.
const chartPoints = computed<ChartPoint[]>(() => {
  const daily = data.value?.daily ?? [];
  if (granularity.value === "day") {
    return daily.map((p) => ({
      label: fmtDay(p.date, locale.value),
      input: p.input,
      output: p.output,
      cache_create: p.cache_create,
      cache_read: p.cache_read,
      cost: p.cost,
    }));
  }
  const weeks = new Map<string, ChartPoint>();
  for (const p of daily) {
    const wk = mondayOf(p.date);
    let a = weeks.get(wk);
    if (!a) {
      a = { label: fmtDay(wk, locale.value), input: 0, output: 0, cache_create: 0, cache_read: 0, cost: 0 };
      weeks.set(wk, a);
    }
    a.input += p.input;
    a.output += p.output;
    a.cache_create += p.cache_create;
    a.cache_read += p.cache_read;
    a.cost += p.cost;
  }
  return [...weeks.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, v]) => v);
});

// --- weekday/heatmap helpers ---
// strftime %w: 0=Sun..6=Sat. Display Monday-first.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayLabels = computed(() =>
  WEEKDAY_ORDER.map((w) => t(`day${w}`)),
);

// 7×24 matrix indexed [displayRow][hour] = metric value.
const heatMatrix = computed<number[][]>(() => {
  const grid: number[][] = WEEKDAY_ORDER.map(() => new Array(24).fill(0));
  if (!data.value) return grid;
  for (const c of data.value.heatmap) {
    const row = WEEKDAY_ORDER.indexOf(c.weekday);
    if (row >= 0 && c.hour >= 0 && c.hour < 24) {
      grid[row][c.hour] = metricVal(c.total_tokens, c.cost);
    }
  }
  return grid;
});
const heatMax = computed(() => {
  let max = 0;
  for (const row of heatMatrix.value) for (const v of row) if (v > max) max = v;
  return max;
});
function heatStyle(v: number): Record<string, string> {
  const alpha = heatMax.value > 0 ? Math.min(1, 0.12 + (v / heatMax.value) * 0.88) : 0;
  return { background: v > 0 ? `rgba(217, 119, 87, ${alpha})` : "rgba(255,255,255,0.04)" };
}

const compareDelta = computed(() => {
  if (!compare.value) return null;
  const cur = metricVal(compare.value.current.total_tokens, compare.value.current.cost);
  const prev = metricVal(compare.value.previous.total_tokens, compare.value.previous.cost);
  const pct = prev > 0 ? ((cur - prev) / prev) * 100 : cur > 0 ? 100 : 0;
  return { cur, prev, pct };
});

const avgPerSession = computed(() => {
  const tot = data.value?.totals;
  if (!tot || tot.sessions === 0) return null;
  return {
    tokens: tot.total_tokens / tot.sessions,
    cost: tot.cost / tot.sessions,
  };
});

// --- per-project & anomalies ---
function projectName(p: string | null): string {
  return p && p.length ? p : t("projectUnknown");
}

// Largest project value (in the current metric) — scales the proportional bars.
const projectMax = computed(() => {
  let max = 0;
  for (const p of data.value?.by_project ?? []) {
    const v = metricVal(p.total_tokens, p.cost);
    if (v > max) max = v;
  }
  return max;
});

// Anomalies are detected server-side by tokens, so the "× average" multiple is
// always token-based regardless of the metric toggle.
const avgSessionTokens = computed(() => {
  const tot = data.value?.totals;
  return tot && tot.sessions > 0 ? tot.total_tokens / tot.sessions : 0;
});
function anomalyRatio(s: SessionUsage): number {
  return avgSessionTokens.value > 0 ? s.total_tokens / avgSessionTokens.value : 0;
}

// Session timestamp → numeric date+time for the active locale
// (ru "31.12.2026, 13:57" / en "12/31/2026, 01:57 PM").
function fmtWhen(iso: string): string {
  return fmtDateTime(iso, locale.value);
}

// --- data loading ---
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function openDetails() {
  try {
    await invoke("open_analytics_window");
  } catch (e) {
    console.error("open_analytics_window failed", e);
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // Kick off ingest in the background — don't block the first render on it.
    // After a schema migration that wipes cc_files (e.g. v4/v5/v6), the first
    // ingest re-parses every transcript and can take 10–30s; awaiting it here
    // would keep the flyout window focused and stop it from auto-hiding to
    // the tray. When ingest finishes, refresh the panel quietly.
    invoke("ingest_cc_usage")
      .then((n) => {
        if (typeof n === "number" && n > 0) void reload();
      })
      .catch(() => {});
    const from = isoDaysAgo(rangeDays.value);
    const to = new Date().toISOString();
    data.value = await invoke<Analytics>("get_analytics", { from, to });
    // Compare the selected window against the immediately preceding one of equal
    // length (7d→prior 7d, 30d→prior 30d), not a fixed week.
    compare.value = await invoke<PeriodCompare>("get_analytics_compare", {
      curFrom: from,
      curTo: to,
      prevFrom: isoDaysAgo(rangeDays.value * 2),
      prevTo: from,
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
  // Light refresh after a background ingest completed — re-query analytics
  // without re-triggering ingest or showing a loading spinner.
  try {
    const from = isoDaysAgo(rangeDays.value);
    const to = new Date().toISOString();
    data.value = await invoke<Analytics>("get_analytics", { from, to });
    compare.value = await invoke<PeriodCompare>("get_analytics_compare", {
      curFrom: from,
      curTo: to,
      prevFrom: isoDaysAgo(rangeDays.value * 2),
      prevTo: from,
    });
    await nextTick();
    renderCharts();
  } catch {}
}

function renderCharts() {
  const d = data.value;
  if (!d) return;
  const gridColor = "rgba(255,255,255,0.06)";
  const tickColor = "rgba(255,255,255,0.45)";

  // Time chart: single cost bar, or stacked token-type bars (per day or week).
  if (dailyCanvas.value) {
    dailyChart?.destroy();
    const pts = chartPoints.value;
    const labels = pts.map((p) => p.label);
    const isCost = metric.value === "cost";
    const datasets = isCost
      ? [
          {
            data: pts.map((p) => p.cost),
            backgroundColor: "#d97757",
            borderRadius: 3,
            maxBarThickness: 26,
          },
        ]
      : TOKEN_TYPES.filter((tt) => !hiddenTokens.value.has(tt.key)).map((tt) => ({
          label: t(TOKEN_LABEL[tt.key]),
          data: pts.map((p) => p[tt.key]),
          backgroundColor: tt.color,
          stack: "tok",
          maxBarThickness: 26,
        }));

    dailyChart = new Chart(dailyCanvas.value, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                isCost
                  ? fmtCost(ctx.parsed.y ?? 0)
                  : `${ctx.dataset.label}: ${fmtTokens(ctx.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: {
            stacked: !isCost,
            grid: { display: false },
            ticks: { color: tickColor, font: { size: 12 } },
          },
          y: {
            stacked: !isCost,
            grid: { color: gridColor },
            ticks: {
              color: tickColor,
              font: { size: 12 },
              callback: (v) => (isCost ? "$" + v : fmtTokens(Number(v))),
            },
          },
        },
      },
    });
  }

  // Model breakdown doughnut
  if (modelCanvas.value) {
    modelChart?.destroy();
    const labels = d.by_model.map((m) => modelLabel(m.model));
    modelChart = new Chart(modelCanvas.value, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: d.by_model.map((m) => metricVal(m.total_tokens, m.cost)),
            backgroundColor: labels.map(modelColor),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                `${ctx.label}: ` +
                (metric.value === "cost"
                  ? fmtCost(ctx.parsed)
                  : fmtTokens(ctx.parsed) + " tok"),
            },
          },
        },
      },
    });
  }
}

watch([metric, rangeDays], () => {
  if (props.active) load();
});
watch(
  () => props.active,
  (a) => {
    if (a) load();
  },
);
watch(granularity, () => {
  if (props.active) renderCharts();
});
watch(locale, () => {
  if (props.active) renderCharts();
});

onMounted(() => {
  if (props.active) load();
});
onUnmounted(() => {
  dailyChart?.destroy();
  modelChart?.destroy();
});
</script>

<template>
  <div class="analytics">
    <!-- Controls -->
    <div class="controls">
      <div class="seg">
        <button :class="{ on: rangeDays === 7 }" @click="rangeDays = 7">{{ t('range7d') }}</button>
        <button :class="{ on: rangeDays === 30 }" @click="rangeDays = 30">{{ t('range30d') }}</button>
      </div>
      <div class="seg">
        <button :class="{ on: metric === 'cost' }" @click="metric = 'cost'">{{ t('metricCost') }}</button>
        <button :class="{ on: metric === 'tokens' }" @click="metric = 'tokens'">{{ t('metricTokens') }}</button>
      </div>
      <button class="more-btn" @click="openDetails" :title="t('analyticsOpenDetails')">
        {{ t('analyticsMore') }}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </svg>
      </button>
    </div>

    <div v-if="error" class="empty">{{ error }}</div>
    <div v-else-if="loading && !data" class="empty">
      <div class="spinner"></div>
    </div>
    <div v-else-if="data && data.totals.messages === 0" class="empty">
      {{ t('analyticsEmpty') }}
    </div>

    <template v-else-if="data">
      <!-- Summary -->
      <div class="summary">
        <div class="stat">
          <div class="stat-val">{{ fmtMetric(data.totals.total_tokens, data.totals.cost) }}</div>
          <div class="stat-lbl">{{ t('analyticsTotal') }}</div>
        </div>
        <div class="stat" v-if="compareDelta">
          <div class="stat-val" :class="compareDelta.pct >= 0 ? 'up' : 'down'">
            {{ compareDelta.pct >= 0 ? '+' : '' }}{{ compareDelta.pct.toFixed(0) }}%
          </div>
          <div class="stat-lbl">{{ t('analyticsVsPrev') }}</div>
        </div>
        <div class="stat" v-if="avgPerSession">
          <div class="stat-val">{{ fmtMetric(avgPerSession.tokens, avgPerSession.cost) }}</div>
          <div class="stat-lbl">{{ t('analyticsPerSession') }}</div>
        </div>
      </div>

      <!-- Anomalous spend warning -->
      <div class="alert-card" v-if="data.anomalies.length">
        <div class="alert-head">
          <span class="alert-ic">!</span>
          <span>{{ t('anomalyBanner', { count: data.anomalies.length }) }}</span>
        </div>
        <div class="anomaly-list">
          <div v-for="s in data.anomalies" :key="s.session_id" class="anomaly-row">
            <span class="anomaly-when">{{ fmtWhen(s.start) }}</span>
            <span class="anomaly-proj">{{ projectName(s.project) }}</span>
            <span class="anomaly-mult">×{{ anomalyRatio(s).toFixed(1) }}</span>
            <span class="anomaly-val">{{ fmtMetric(s.total_tokens, s.cost) }}</span>
          </div>
        </div>
      </div>

      <!-- Usage over time (day / week) -->
      <div class="block">
        <div class="block-head">
          <div class="block-title">{{ t('analyticsUsage') }}</div>
          <div class="seg seg-sm">
            <button :class="{ on: granularity === 'day' }" @click="granularity = 'day'">{{ t('granDay') }}</button>
            <button :class="{ on: granularity === 'week' }" @click="granularity = 'week'">{{ t('granWeek') }}</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas ref="dailyCanvas"></canvas></div>
      </div>

      <!-- Token breakdown (tokens mode) — chips toggle their layer in the chart -->
      <div class="block" v-if="metric === 'tokens'">
        <div class="block-head">
          <div class="block-title">{{ t('tokBreakdown') }}</div>
          <div class="tok-hint">{{ t('tokToggleHint') }}</div>
        </div>
        <div class="tok-filters">
          <button
            v-for="b in tokenBreakdown"
            :key="b.key"
            type="button"
            class="tok-chip"
            :class="{ off: hiddenTokens.has(b.key) }"
            :aria-pressed="!hiddenTokens.has(b.key)"
            @click="toggleToken(b.key)"
          >
            <span
              class="tok-check"
              :style="{
                background: hiddenTokens.has(b.key) ? 'transparent' : b.color,
                borderColor: b.color,
              }"
            >
              <svg v-if="!hiddenTokens.has(b.key)" viewBox="0 0 12 12" width="11" height="11">
                <path
                  d="M2 6.2l2.6 2.6L10 3.3"
                  fill="none"
                  stroke="#fff"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="tok-name">{{ t(TOKEN_LABEL[b.key]) }}</span>
            <span class="tok-val">{{ fmtTokens(b.value) }}</span>
          </button>
        </div>
        <div class="tok-note">{{ t('tokCacheNote') }}</div>
      </div>

      <!-- Model breakdown -->
      <div class="block" v-if="data.by_model.length">
        <div class="block-title">{{ t('analyticsByModel') }}</div>
        <div class="model-row">
          <div class="donut-wrap"><canvas ref="modelCanvas"></canvas></div>
          <div class="legend">
            <div v-for="m in data.by_model" :key="m.model" class="legend-item">
              <span class="dot" :style="{ background: modelColor(modelLabel(m.model)) }"></span>
              <span class="legend-name">{{ modelLabel(m.model) }}</span>
              <span class="legend-val">{{ fmtMetric(m.total_tokens, m.cost) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- By project -->
      <div class="block" v-if="data.by_project.length">
        <div class="block-title">{{ t('analyticsByProject') }}</div>
        <div class="pbars">
          <div v-for="p in data.by_project" :key="p.project ?? '∅'" class="pbar-row">
            <div class="pbar-head">
              <span class="pbar-name">{{ projectName(p.project) }}</span>
              <span class="pbar-val">{{ fmtMetric(p.total_tokens, p.cost) }}</span>
            </div>
            <div class="pbar-track">
              <div
                class="pbar-fill"
                :style="{ width: projectMax ? (metricVal(p.total_tokens, p.cost) / projectMax) * 100 + '%' : '0%' }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Heatmap -->
      <div class="block">
        <div class="block-title">{{ t('analyticsHeatmap') }}</div>
        <div class="heatmap">
          <div v-for="(row, ri) in heatMatrix" :key="ri" class="heat-row">
            <span class="heat-day">{{ dayLabels[ri] }}</span>
            <div class="heat-cells">
              <i
                v-for="(v, hi) in row"
                :key="hi"
                class="heat-cell"
                :style="heatStyle(v)"
                :title="`${dayLabels[ri]} ${hi}:00 — ${fmtMetric(v, v)}`"
              ></i>
            </div>
          </div>
          <div class="heat-axis">
            <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.analytics {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.more-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.more-btn:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  border-color: var(--accent);
}

.seg {
  display: flex;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  padding: 7px 15px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.seg button + button {
  border-left: 1px solid var(--stroke-strong);
}
.seg button.on {
  background: var(--accent);
  color: #fff;
}

.summary {
  display: flex;
  gap: 8px;
}
.stat {
  flex: 1;
  background: var(--card-bg, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--stroke-strong);
  border-radius: 8px;
  padding: 10px 10px;
  text-align: center;
}
.stat-val {
  font-size: 19px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stat-val.up { color: #f87171; }
.stat-val.down { color: #6ccb5f; }
.stat-lbl {
  font-size: 12px;
  color: var(--text-4);
  margin-top: 3px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.block-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.seg-sm button {
  padding: 4px 10px;
  font-size: 12px;
}
.chart-wrap {
  height: 160px;
  position: relative;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.donut-wrap {
  width: 124px;
  height: 124px;
  flex-shrink: 0;
}
.legend {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
}
.legend-item .dot {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  flex-shrink: 0;
}
.legend-name {
  color: var(--text-2);
  flex: 1;
}
.legend-val {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* Clickable token-type chips that toggle their layer in the daily chart. */
.tok-hint {
  font-size: 12px;
  color: var(--text-4);
}
.tok-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tok-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 8px;
  border: 1px solid var(--stroke-strong);
  border-radius: 8px;
  background: var(--card-bg, rgba(255, 255, 255, 0.03));
  font-family: var(--segoe);
  font-size: 13px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, opacity 120ms;
}
.tok-chip:hover {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
}
.tok-chip.off {
  opacity: 0.5;
}
.tok-chip.off .tok-name {
  text-decoration: line-through;
}
.tok-check {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1.5px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 120ms;
}
.tok-name {
  color: var(--text-2);
}
.tok-val {
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
}

.tok-note {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-4);
  margin-top: 2px;
}

.heatmap {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.heat-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.heat-day {
  width: 30px;
  font-size: 12px;
  color: var(--text-4);
  flex-shrink: 0;
}
.heat-cells {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
  flex: 1;
}
.heat-cell {
  aspect-ratio: 1;
  border-radius: 2px;
}
.heat-axis {
  display: flex;
  justify-content: space-between;
  margin-left: 36px;
  font-size: 12px;
  color: var(--text-4);
}

/* Anomalous-spend warning card */
.alert-card {
  border: 1px solid rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #f87171;
}
.alert-ic {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #f87171;
  color: #1a1a1a;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 13px;
}
.anomaly-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.anomaly-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.anomaly-when {
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.anomaly-proj {
  color: var(--text-2);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.anomaly-mult {
  color: #f87171;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.anomaly-val {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* Per-project proportional bars */
.pbars {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pbar-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
  margin-bottom: 3px;
}
.pbar-name {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pbar-val {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.pbar-track {
  height: 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}
.pbar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 200ms;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4);
  font-size: 15px;
  padding: 40px 0;
}
</style>
