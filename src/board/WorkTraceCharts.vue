<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { BarController, BarElement, CategoryScale, Chart, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip, type ActiveElement, type ChartEvent } from "chart.js";
import { TRACE_TYPE_COLORS, traceMarkers, traceSeries, type TraceMarker, type TraceMarkerPart, type WorkNode } from "./workTree";
Chart.register(BarController, BarElement, CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip, Legend);
const props = defineProps<{ root: WorkNode | null; selectedNodeId?: string | null }>();
const emit = defineEmits<{ select: [nodeId: string] }>();
const { t } = useI18n();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;
function color(token: string) { return getComputedStyle(canvas.value ?? document.documentElement).getPropertyValue(token).trim(); }
function typeColor(type: keyof typeof TRACE_TYPE_COLORS) {
  const value = TRACE_TYPE_COLORS[type];
  return value.startsWith("var(") ? color(value.slice(4, -1)) : value;
}
function data() {
  const series = props.root ? traceSeries(props.root) : { context: [], cacheRead: [], cost: [], restartTailOverpayment: [] };
  return { labels: series.context.map((point) => String(point.index)), datasets: [
    { type: "bar" as const, label: t("workTraceContext"), data: series.context.map((point) => point.value), backgroundColor: series.context.map((point) => typeColor(point.type)), borderColor: series.context.map((point) => point.nodeId === props.selectedNodeId ? "#fff" : "transparent"), borderWidth: series.context.map((point) => point.nodeId === props.selectedNodeId ? 1 : 0), borderRadius: 3, yAxisID: "tokens" },
    { type: "line" as const, label: t("workTraceCacheRead"), data: series.cacheRead.map((point) => point.value), borderColor: "rgba(255, 255, 255, .35)", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: .15, yAxisID: "cache" },
    { type: "line" as const, label: t("workTraceCostCumulative"), data: series.cost.map((point) => point.value), borderColor: "#e79878", borderWidth: 1.8, pointRadius: 0, tension: .15, yAxisID: "cost" },
    { type: "line" as const, label: t("workTraceRestartTailOverpayment"), data: series.context.map((point) => series.restartTailOverpayment.find((tail) => tail.index === point.index)?.value ?? null), borderColor: "#d9b74b", borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: .15, yAxisID: "cost" },
  ] };
}
function partLabel(part: TraceMarkerPart) {
  if (part.kind === "compacted") return t("workTraceMarkerCompacted");
  if (part.kind === "restart") return t("workTraceMarkerRestart");
  const attempt = part.attempt ? `${t("workTraceMarkerAttempt")}${part.attempt}` : "";
  if (part.kind === "attempt") return attempt;
  const role = t(part.role === "worker" ? "workTraceMarkerWorker" : part.role === "review" ? "workTraceMarkerReview" : "workTraceMarkerSession");
  return attempt ? `${attempt} · ${role}` : role;
}
function markerLabel(marker: TraceMarker) { return marker.parts.map(partLabel).join(" · "); }
function restartTooltip(marker: TraceMarker) {
  const restart = marker.parts.find((part) => part.kind === "restart")?.restart;
  if (!restart) return null;
  const percent = (value: number) => new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  return t("workTraceRestartTooltip", { p25: percent(restart.p25SavePct), median: percent(restart.medianSavePct), p75: percent(restart.p75SavePct), rho: percent(restart.rho) });
}
const markers = { id: "trace-markers", afterDraw(current: Chart) {
  const entries = props.root ? traceMarkers(props.root) : [], { ctx, chartArea, scales } = current;
  for (const marker of entries) { const x = scales.x.getPixelForValue(marker.index - 1); ctx.save(); ctx.strokeStyle = marker.kind === "compacted" ? "rgba(255, 255, 255, .5)" : "rgba(255, 255, 255, .35)"; ctx.fillStyle = color("--text-3"); ctx.font = "10px var(--segoe, sans-serif)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.setLineDash([]); ctx.fillText(markerLabel(marker), x + 3, chartArea.top + 10); ctx.restore(); }
  const costs = props.root ? traceSeries(props.root).cost : [];
  const cost = costs[costs.length - 1];
  if (cost) { const x = scales.x.getPixelForValue(cost.index - 1), y = scales.cost.getPixelForValue(cost.value); ctx.save(); ctx.fillStyle = "#e79878"; ctx.font = "10px var(--mono, monospace)"; ctx.textBaseline = "middle"; ctx.fillText(`$${cost.value.toFixed(2)}`, x + 4, y); ctx.restore(); }
} };
function options() { return { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 12, right: 34 } }, interaction: { mode: "index" as const, intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: (items: readonly { dataIndex: number }[]) => { const marker = props.root ? traceMarkers(props.root).find((entry) => entry.index === (items[0]?.dataIndex ?? -1) + 1) : undefined; return marker ? restartTooltip(marker) ?? "" : ""; } } } }, scales: {
  x: { grid: { color: color("--stroke") }, ticks: { color: color("--text-3") } }, tokens: { type: "linear" as const, position: "left" as const, beginAtZero: true, grid: { color: color("--stroke") }, ticks: { color: color("--text-3") } }, cache: { type: "linear" as const, display: false, beginAtZero: true }, cost: { type: "linear" as const, position: "right" as const, beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: color("--text-3"), callback: (value: string | number) => `$${value}` } },
}, onClick: (_event: ChartEvent, elements: readonly ActiveElement[]) => { const element = elements.find((entry) => entry.datasetIndex === 0), node = props.root && traceSeries(props.root).context[element?.index ?? -1]; if (node) emit("select", node.nodeId); } }; }
function render() { if (!canvas.value) return; if (chart) { chart.data = data(); chart.options = options(); chart.update(); } else chart = new Chart(canvas.value, { type: "bar", data: data(), options: options(), plugins: [markers] }); }
onMounted(() => void nextTick(render)); watch(() => [props.root, props.selectedNodeId], () => void nextTick(render), { deep: true }); onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>
<template><section class="work-trace-charts"><div class="work-trace-chart"><canvas ref="canvas" /></div></section></template>
<style scoped>.work-trace-chart { background: #161616; border: 1px solid var(--stroke); border-radius: var(--r-card); height: 118px; padding: 6px 8px; }</style>
