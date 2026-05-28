<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
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

const MODEL_COLORS: Record<string, string> = {
  Opus: "#d97757",
  Sonnet: "#6ccb5f",
  Haiku: "#5b9bd5",
};
function modelColor(label: string): string {
  const fam = label.split(" ")[0];
  return MODEL_COLORS[fam] ?? "#9aa0a6";
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

// --- data loading ---
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // Pull in any new transcript data first (no-op if disabled or unchanged).
    await invoke("ingest_cc_usage").catch(() => {});
    const from = isoDaysAgo(rangeDays.value);
    const to = new Date().toISOString();
    data.value = await invoke<Analytics>("get_analytics", { from, to });
    compare.value = await invoke<PeriodCompare>("get_analytics_compare", {
      curFrom: isoDaysAgo(7),
      curTo: to,
      prevFrom: isoDaysAgo(14),
      prevTo: isoDaysAgo(7),
    });
    await nextTick();
    renderCharts();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function renderCharts() {
  const d = data.value;
  if (!d) return;
  const gridColor = "rgba(255,255,255,0.06)";
  const tickColor = "rgba(255,255,255,0.45)";

  // Daily chart: single cost bar, or stacked token-type bars.
  if (dailyCanvas.value) {
    dailyChart?.destroy();
    const labels = d.daily.map((p) => p.date.slice(5)); // MM-DD
    const isCost = metric.value === "cost";
    const datasets = isCost
      ? [
          {
            data: d.daily.map((p) => p.cost),
            backgroundColor: "#d97757",
            borderRadius: 3,
            maxBarThickness: 26,
          },
        ]
      : TOKEN_TYPES.filter((tt) => !hiddenTokens.value.has(tt.key)).map((tt) => ({
          label: t(TOKEN_LABEL[tt.key]),
          data: d.daily.map((p) => p[tt.key]),
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
            ticks: { color: tickColor, font: { size: 11 } },
          },
          y: {
            stacked: !isCost,
            grid: { color: gridColor },
            ticks: {
              color: tickColor,
              font: { size: 11 },
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

      <!-- Daily chart -->
      <div class="block">
        <div class="block-title">{{ t('analyticsDaily') }}</div>
        <div class="chart-wrap"><canvas ref="dailyCanvas"></canvas></div>
      </div>

      <!-- Token breakdown (tokens mode) — rows toggle their layer in the chart -->
      <div class="block" v-if="metric === 'tokens'">
        <div class="block-title">{{ t('tokBreakdown') }}</div>
        <div class="legend">
          <button
            v-for="b in tokenBreakdown"
            :key="b.key"
            type="button"
            class="legend-item legend-toggle"
            :class="{ off: hiddenTokens.has(b.key) }"
            @click="toggleToken(b.key)"
          >
            <span class="dot" :style="{ background: b.color }"></span>
            <span class="legend-name">{{ t(TOKEN_LABEL[b.key]) }}</span>
            <span class="legend-val">{{ fmtTokens(b.value) }}</span>
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
  gap: 8px;
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
  font-size: 11.5px;
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

/* Clickable token-type rows that toggle their layer in the daily chart. */
.legend-toggle {
  background: none;
  border: none;
  padding: 2px 0;
  font-family: var(--segoe);
  text-align: left;
  cursor: pointer;
  transition: opacity 120ms;
}
.legend-toggle:hover {
  opacity: 0.85;
}
.legend-toggle.off {
  opacity: 0.4;
}
.legend-toggle.off .legend-name {
  text-decoration: line-through;
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
  font-size: 11.5px;
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
  font-size: 10.5px;
  color: var(--text-4);
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
