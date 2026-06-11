<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface UsageTier {
  percent_used: number;
  reset_at: string | null;
  is_limited: boolean;
}

interface UsageData {
  five_hour: UsageTier;
  seven_day: UsageTier;
}

interface UsageLevels {
  five_hour: number;
  seven_day: number;
}

// Whole-system resource snapshot (CPU load + RAM), emitted by the backend
// sysmon loop. Reflects the entire machine, not just this app.
interface SysStats {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
}

const usage = ref<UsageData | null>(null);
const levels = ref<UsageLevels | null>(null);
const sys = ref<SysStats | null>(null);
// Layout switch: on → compact 2×2 with CPU/RAM; off → original two-row bars.
// Seeded from the store on mount, then kept in sync via `system-info-enabled`.
const systemInfo = ref(true);
const error = ref("");
const unlisteners: Array<() => void> = [];

const MINI_CLASSES = ["t-green", "t-yellow", "t-orange", "t-red"];
function cls(level: number | null | undefined): string {
  return MINI_CLASSES[level ?? 0];
}

// System load → colour bucket. Independent of the Claude-quota thresholds: a
// busy machine is orange/red regardless of how much quota is left.
function loadCls(percent: number): string {
  if (percent >= 90) return "t-red";
  if (percent >= 80) return "t-orange";
  if (percent >= 60) return "t-yellow";
  return "t-green";
}

function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

async function startDrag() {
  await getCurrentWindow().startDragging();
}

onMounted(async () => {
  // Seed the layout flag from the store — the mini window may mount after the
  // backend's last `configure`, so we can't rely on the event alone.
  try {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("settings.json");
    systemInfo.value = (await store.get<boolean>("systemInfoEnabled")) ?? true;
  } catch {
    /* not under Tauri / first run */
  }

  // The backend polling loop emits these globally to every window; the mini
  // panel is a pure view — no fetching, timers or threshold logic of its own.
  const { listen } = await import("@tauri-apps/api/event");
  unlisteners.push(
    await listen<{ usage: UsageData; levels: UsageLevels }>("usage-updated", (e) => {
      usage.value = e.payload.usage;
      levels.value = e.payload.levels;
      error.value = "";
    }),
    await listen<{ message: string; reportable: boolean }>("usage-error", (e) => {
      error.value = String(e.payload?.message ?? e.payload);
    }),
    await listen<SysStats>("system-stats", (e) => {
      sys.value = e.payload;
    }),
    await listen<boolean>("system-info-enabled", (e) => {
      systemInfo.value = e.payload;
      // Drop stale readings so the bar layout never flashes old CPU/RAM.
      if (!e.payload) sys.value = null;
    }),
  );
});

onUnmounted(() => {
  unlisteners.forEach((u) => u());
});
</script>

<template>
  <div class="mini" @mousedown="startDrag">
    <template v-if="usage && levels">
      <!-- Compact 2×2: Claude quota + whole-machine CPU/RAM -->
      <div v-if="systemInfo" class="grid">
        <div class="cell">
          <span class="label">5h</span>
          <span class="val" :class="cls(levels.five_hour)">{{ usage.five_hour.percent_used.toFixed(0) }}%</span>
        </div>
        <div class="cell">
          <span class="label">7d</span>
          <span class="val" :class="cls(levels.seven_day)">{{ usage.seven_day.percent_used.toFixed(0) }}%</span>
        </div>
        <template v-if="sys">
          <div class="cell">
            <span class="label">CPU</span>
            <span class="val" :class="loadCls(sys.cpu_percent)">{{ sys.cpu_percent.toFixed(0) }}%</span>
          </div>
          <div class="cell" :title="`${gb(sys.mem_used_mb)} / ${gb(sys.mem_total_mb)} GB`">
            <span class="label">RAM</span>
            <span class="val" :class="loadCls(sys.mem_percent)">{{ gb(sys.mem_used_mb) }}G</span>
          </div>
        </template>
      </div>

      <!-- Original two-row bars (system info off) — rows are direct children of
           .mini so .track's flex:1 fills the full window width (a wrapper div
           collapsed the track to 0). -->
      <template v-else>
        <div class="row">
          <span class="label">5h</span>
          <div class="track"><i :class="cls(levels.five_hour)" :style="{ width: Math.min(usage.five_hour.percent_used, 100) + '%' }"></i></div>
          <span class="val" :class="cls(levels.five_hour)">{{ usage.five_hour.percent_used.toFixed(0) }}%</span>
        </div>
        <div class="row">
          <span class="label">7d</span>
          <div class="track"><i :class="cls(levels.seven_day)" :style="{ width: Math.min(usage.seven_day.percent_used, 100) + '%' }"></i></div>
          <span class="val" :class="cls(levels.seven_day)">{{ usage.seven_day.percent_used.toFixed(0) }}%</span>
        </div>
      </template>
    </template>
    <div v-else class="loading">{{ error || '...' }}</div>
  </div>
</template>

<style scoped>
.mini {
  width: 100%;
  height: 100%;
  padding: 10px 14px;
  background: rgba(20, 20, 24, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  cursor: grab;
  user-select: none;
  font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
}

/* --- Compact 2×2 layout (system info on) --- */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  pointer-events: none;
}

.cell {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.grid .label {
  width: 26px;
}

.grid .val {
  font-size: 14px;
  font-weight: 700;
  min-width: 36px;
  text-align: right;
}

/* --- Original two-row bars (system info off) --- */
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.row .label {
  width: 20px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.track {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 300ms ease;
}

.track i.t-green { background: #6ccb5f; }
.track i.t-yellow { background: #ffc107; }
.track i.t-orange { background: #d97757; }
.track i.t-red { background: #f87171; }

.row .val {
  font-size: 12px;
  font-weight: 600;
  width: 32px;
  text-align: right;
}

/* --- Shared --- */
.label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.45);
  flex-shrink: 0;
}

.val {
  flex-shrink: 0;
}

.val.t-green { color: #6ccb5f; }
.val.t-yellow { color: #ffc107; }
.val.t-orange { color: #d97757; }
.val.t-red { color: #f87171; }

.loading {
  color: rgba(255, 255, 255, 0.3);
  font-size: 12px;
  text-align: center;
  pointer-events: none;
}
</style>
