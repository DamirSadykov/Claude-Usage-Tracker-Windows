<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface UsageTier {
  percent_used: number;
  reset_at: string | null;
  is_limited: boolean;
}

interface UsageData {
  five_hour: UsageTier;
  seven_day: UsageTier;
  seven_day_opus: UsageTier | null;
}

const usage = ref<UsageData | null>(null);
const error = ref("");
let timer: ReturnType<typeof setInterval> | null = null;
let sessionKey = "";
let orgId = "";

async function loadSettings() {
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load("settings.json");
  sessionKey = (await store.get<string>("sessionKey")) ?? "";
  orgId = (await store.get<string>("orgId")) ?? "";
}

async function fetchData() {
  if (!sessionKey || !orgId) return;
  try {
    usage.value = await invoke<UsageData>("fetch_usage", {
      sessionKey,
      orgId,
    });
  } catch (e) {
    error.value = String(e);
  }
}

function tierClass(p: number) {
  if (p < 25) return "t-green";
  if (p < 50) return "t-yellow";
  if (p < 75) return "t-orange";
  return "t-red";
}

async function startDrag() {
  await getCurrentWindow().startDragging();
}

onMounted(async () => {
  await loadSettings();
  await fetchData();
  timer = setInterval(fetchData, 60000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="mini" @mousedown="startDrag">
    <template v-if="usage">
      <div class="row">
        <span class="label">5h</span>
        <div class="track"><i :class="tierClass(usage.five_hour.percent_used)" :style="{ width: Math.min(usage.five_hour.percent_used, 100) + '%' }"></i></div>
        <span class="val" :class="tierClass(usage.five_hour.percent_used)">{{ usage.five_hour.percent_used.toFixed(0) }}%</span>
      </div>
      <div class="row">
        <span class="label">7d</span>
        <div class="track"><i :class="tierClass(usage.seven_day.percent_used)" :style="{ width: Math.min(usage.seven_day.percent_used, 100) + '%' }"></i></div>
        <span class="val" :class="tierClass(usage.seven_day.percent_used)">{{ usage.seven_day.percent_used.toFixed(0) }}%</span>
      </div>
    </template>
    <div v-else class="loading">{{ error || '...' }}</div>
  </div>
</template>

<style scoped>
.mini {
  width: 100%;
  height: 100%;
  padding: 12px 14px;
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

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
  width: 20px;
  flex-shrink: 0;
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

.val {
  font-size: 12px;
  font-weight: 600;
  width: 32px;
  text-align: right;
  flex-shrink: 0;
}

.val.t-green { color: #6ccb5f; }
.val.t-yellow { color: #ffc107; }
.val.t-orange { color: #d97757; }
.val.t-red { color: #f87171; }

.loading {
  color: rgba(255, 255, 255, 0.3);
  font-size: 11px;
  text-align: center;
  pointer-events: none;
}
</style>
