<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ActiveElement,
  type ChartEvent,
} from "chart.js";
import { traceSeries, typeSummary, type ToolCallType, type TracePoint, type WorkNode } from "./workTree";

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
);

const props = defineProps<{ root: WorkNode | null }>();
const emit = defineEmits<{ select: [nodeId: string] }>();
const { t } = useI18n();
const contextCanvas = ref<HTMLCanvasElement | null>(null);
const costCanvas = ref<HTMLCanvasElement | null>(null);
let contextChart: Chart | null = null;
let costChart: Chart | null = null;

function color(token: string, fallback: string): string {
  return (
    getComputedStyle(contextCanvas.value ?? document.documentElement)
      .getPropertyValue(token)
      .trim() || fallback
  );
}
function typeColor(type: ToolCallType | "text"): string {
  const colors: Record<ToolCallType | "text", [string, string]> = {
    read: ["--accent", "#4cc2ff"],
    edit: ["--ok", "#6ccb5f"],
    shell: ["--warn", "#ffc107"],
    agent: ["--high", "#d97757"],
    web: ["--accent-2", "#3aa0ff"],
    other: ["--text-3", "#9aa0aa"],
    text: ["--text-3", "#9aa0aa"],
  };
  const [token, fallback] = colors[type];
  return color(token, fallback);
}
function labels(points: readonly TracePoint[]) {
  return points.map((point) => String(point.index));
}
function series() {
  return props.root ? traceSeries(props.root) : { context: [], cacheRead: [], cost: [] };
}
function contextData() {
  const value = series();
  return {
    labels: labels(value.context),
    datasets: [
      {
        type: "bar" as const,
        label: t("workTraceContext"),
        data: value.context.map((point) => point.value),
        backgroundColor: value.context.map((point) => typeColor(point.type)),
        borderRadius: 3,
        yAxisID: "context",
      },
      {
        type: "line" as const,
        label: t("workTraceCacheRead"),
        data: value.cacheRead.map((point) => point.value),
        borderColor: color("--accent-2", "#3aa0ff"),
        backgroundColor: color("--accent-2", "#3aa0ff"),
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.2,
        yAxisID: "cache",
      },
    ],
  };
}
function costData() {
  const value = series();
  return {
    labels: labels(value.cost),
    datasets: [
      {
        label: t("metricCost"),
        data: value.cost.map((point) => point.value),
        borderColor: color("--high", "#d97757"),
        backgroundColor: color("--high", "#d97757"),
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.2,
        fill: true,
        yAxisID: "context",
      },
    ],
  };
}
function options(withCacheAxis: boolean) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index" as const, intersect: false },
    plugins: { legend: { display: true, labels: { color: color("--text-3", "#9aa0aa"), boxWidth: 8 } } },
    scales: {
      x: {
        grid: { color: color("--stroke", "rgba(128,128,128,.16)") },
        ticks: { color: color("--text-3", "#9aa0aa") },
      },
      context: {
        type: "linear" as const,
        position: "left" as const,
        beginAtZero: true,
        grid: { color: color("--stroke", "rgba(128,128,128,.16)") },
        ticks: { color: color("--text-3", "#9aa0aa") },
      },
      ...(withCacheAxis
        ? {
            cache: {
              type: "linear" as const,
              position: "right" as const,
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              ticks: { color: color("--text-3", "#9aa0aa") },
            },
          }
        : {}),
    },
    onClick: (_event: ChartEvent, elements: readonly ActiveElement[]) => {
      const bar = elements.find((element) => element.datasetIndex === 0);
      const point = series().context[bar?.index ?? -1];
      if (point) emit("select", point.nodeId);
    },
  };
}
function renderCharts() {
  if (!contextCanvas.value || !costCanvas.value) return;
  const context = contextData(),
    cost = costData();
  if (contextChart) {
    contextChart.data = context;
    contextChart.options = options(true);
    contextChart.update();
  } else contextChart = new Chart(contextCanvas.value, { type: "bar", data: context, options: options(true) });
  if (costChart) {
    costChart.data = cost;
    costChart.options = options(false);
    costChart.update();
  } else costChart = new Chart(costCanvas.value, { type: "line", data: cost, options: options(false) });
}
function formatCost(value: number) {
  return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}
function percent(value: number) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

onMounted(() => {
  void nextTick(renderCharts);
});
watch(
  () => props.root,
  () => {
    void nextTick(renderCharts);
  },
  { deep: true },
);
onBeforeUnmount(() => {
  contextChart?.destroy();
  costChart?.destroy();
  contextChart = null;
  costChart = null;
});
</script>

<template>
  <section class="work-trace-charts">
    <div class="work-trace-chart"><canvas ref="contextCanvas"></canvas></div>
    <div class="work-trace-chart"><canvas ref="costCanvas"></canvas></div>
    <table v-if="root && typeSummary(root).length" class="work-trace-summary">
      <thead>
        <tr>
          <th>{{ t("workTraceType") }}</th>
          <th>{{ t("workTraceNodes") }}</th>
          <th>{{ t("metricCost") }}</th>
          <th>{{ t("workTraceShare") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in typeSummary(root)" :key="item.type">
          <td><i :style="{ background: typeColor(item.type) }"></i>{{ t(`workTraceType_${item.type}`) }}</td>
          <td>{{ item.nodes }}</td>
          <td>{{ formatCost(item.cost) }}</td>
          <td>{{ percent(item.share) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.work-trace-charts {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(170px, 0.55fr);
}
.work-trace-chart {
  background: var(--node-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: var(--r-ctl);
  height: 180px;
  min-width: 0;
  padding: 8px;
}
.work-trace-summary {
  align-self: stretch;
  border-collapse: collapse;
  font-size: 11px;
  width: 100%;
}
.work-trace-summary th {
  color: var(--text-3);
  font-weight: 500;
  text-align: right;
}
.work-trace-summary td,
.work-trace-summary th {
  border-bottom: 1px solid var(--stroke);
  padding: 5px 4px;
}
.work-trace-summary td {
  font-family: var(--mono, monospace);
  text-align: right;
}
.work-trace-summary td:first-child,
.work-trace-summary th:first-child {
  text-align: left;
}
.work-trace-summary i {
  border-radius: 50%;
  display: inline-block;
  height: 7px;
  margin-right: 5px;
  width: 7px;
}
@media (max-width: 760px) {
  .work-trace-charts {
    grid-template-columns: 1fr;
  }
  .work-trace-summary {
    max-width: 360px;
  }
}
</style>
