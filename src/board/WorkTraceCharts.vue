<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { BarController, BarElement, CategoryScale, Chart, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip, type ActiveElement, type ChartEvent } from "chart.js";
import { traceMarkers, traceSeries, type ToolCallType, type WorkNode } from "./workTree";
Chart.register(BarController, BarElement, CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip, Legend);
const props = defineProps<{ root: WorkNode | null }>();
const emit = defineEmits<{ select: [nodeId: string] }>();
const { t } = useI18n();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;
function color(token: string) { return getComputedStyle(canvas.value ?? document.documentElement).getPropertyValue(token).trim(); }
function typeColor(type: ToolCallType | "text") { return color(({ read: "--accent", edit: "--ok", shell: "--warn", agent: "--high", web: "--accent-2", other: "--text-3", text: "--text-3" } as const)[type]); }
function data() {
  const series = props.root ? traceSeries(props.root) : { context: [], cacheRead: [], cost: [] };
  return { labels: series.context.map((point) => String(point.index)), datasets: [
    { type: "bar" as const, label: t("workTraceContext"), data: series.context.map((point) => point.value), backgroundColor: series.context.map((point) => typeColor(point.type)), borderRadius: 3, yAxisID: "tokens" },
    { type: "line" as const, label: t("workTraceCacheRead"), data: series.cacheRead.map((point) => point.value), borderColor: color("--accent-2"), borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: .15, yAxisID: "tokens" },
    { type: "line" as const, label: t("workTraceCostCumulative"), data: series.cost.map((point) => point.value), borderColor: color("--high"), borderWidth: 2, pointRadius: 1.5, tension: .15, yAxisID: "cost" },
  ] };
}
const markers = { id: "trace-markers", afterDraw(current: Chart) {
  const entries = props.root ? traceMarkers(props.root) : [], { ctx, chartArea, scales } = current;
  for (const marker of entries) { const x = scales.x.getPixelForValue(marker.index - 1); ctx.save(); ctx.strokeStyle = marker.kind === "attempt" ? color("--high") : marker.kind === "compacted" ? color("--warn") : color("--text-3"); ctx.setLineDash(marker.kind === "session" ? [2, 3] : [5, 3]); ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.restore(); }
} };
function options() { return { responsive: true, maintainAspectRatio: false, interaction: { mode: "index" as const, intersect: false }, plugins: { legend: { labels: { color: color("--text-3"), boxWidth: 8 } } }, scales: {
  x: { grid: { color: color("--stroke") }, ticks: { color: color("--text-3") } }, tokens: { type: "linear" as const, position: "left" as const, beginAtZero: true, grid: { color: color("--stroke") }, ticks: { color: color("--text-3") } }, cost: { type: "linear" as const, position: "right" as const, beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: color("--text-3"), callback: (value: string | number) => `$${value}` } },
}, onClick: (_event: ChartEvent, elements: readonly ActiveElement[]) => { const element = elements.find((entry) => entry.datasetIndex === 0), node = props.root && traceSeries(props.root).context[element?.index ?? -1]; if (node) emit("select", node.nodeId); } }; }
function render() { if (!canvas.value) return; if (chart) { chart.data = data(); chart.options = options(); chart.update(); } else chart = new Chart(canvas.value, { type: "bar", data: data(), options: options(), plugins: [markers] }); }
onMounted(() => void nextTick(render)); watch(() => props.root, () => void nextTick(render), { deep: true }); onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>
<template><section class="work-trace-charts"><div class="work-trace-chart"><canvas ref="canvas" /></div></section></template>
<style scoped>.work-trace-chart { background: var(--node-bg); border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); height: 230px; padding: 8px; }</style>
