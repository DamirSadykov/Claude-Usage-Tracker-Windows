<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { CodexLimitWindow, CodexRateLimits } from "../App.vue";

const props = defineProps<{ limits: CodexRateLimits }>();
const { t, locale } = useI18n();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const windows = computed(() => [
  props.limits.primary ? { key: "primary", title: t("codexSession5h"), value: props.limits.primary } : null,
  props.limits.secondary ? { key: "secondary", title: t("codexWeekly"), value: props.limits.secondary } : null,
].filter((item): item is { key: string; title: string; value: CodexLimitWindow } => item !== null));

function currentPercent(window: CodexLimitWindow): number {
  return window.resetsAt * 1000 <= now.value ? 0 : Math.max(0, Math.min(window.usedPercent, 100));
}

function level(percent: number): string {
  if (percent >= 90) return "tier-red";
  if (percent >= 75) return "tier-orange";
  if (percent >= 50) return "tier-yellow";
  return "tier-green";
}

function formatRelative(diff: number): string {
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  if (locale.value === "ru") {
    if (days > 0) return `${days}д ${hours}ч`;
    if (hours > 0) return `${hours}ч ${minutes}м`;
    if (minutes > 0) return `${minutes}м ${seconds}с`;
    return `${seconds}с`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatClock(timestamp: number): string {
  const target = new Date(timestamp);
  const todayStart = new Date(now.value);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const loc = locale.value === "ru" ? "ru-RU" : "en-US";
  const clock = target.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  if (target >= todayStart && target < tomorrowStart) return `${t("today")} ${clock}`;
  const day = target.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" });
  return `${day}, ${clock}`;
}

function resetLabel(window: CodexLimitWindow): string {
  const resetMs = window.resetsAt * 1000;
  const diff = resetMs - now.value;
  if (diff <= 0) return t("resetDone");
  return t("resetsIn", { time: formatRelative(diff), date: formatClock(resetMs) });
}

function isLimited(window: CodexLimitWindow): boolean {
  return window.resetsAt * 1000 > now.value &&
    (window.usedPercent >= 100 || props.limits.rateLimitReachedType !== null);
}
</script>

<template>
  <div v-for="window in windows" :key="window.key" class="card codex-card">
    <div class="card-row">
      <div>
        <div class="card-title">
          {{ window.title }}
          <span v-if="limits.planType" class="codex-plan">{{ limits.planType }}</span>
          <span v-if="isLimited(window.value)" class="badge codex-limit">{{ t('limit') }}</span>
        </div>
        <div class="card-sub">
          {{ t('codexRemaining', { percent: (100 - currentPercent(window.value)).toFixed(1) }) }} ·
          {{ resetLabel(window.value) }}
        </div>
      </div>
      <div class="pct" :class="level(currentPercent(window.value))">
        {{ currentPercent(window.value).toFixed(1) }}%
      </div>
    </div>
    <div class="bar" :class="level(currentPercent(window.value))">
      <i :style="{ width: currentPercent(window.value) + '%' }"></i>
      <template v-if="window.value.windowMinutes >= 10080">
        <span v-for="day in 6" :key="day" class="day-seg" :style="{ left: (day / 7 * 100) + '%' }"></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.codex-card { border-left: 2px solid #10b981; }
.codex-plan {
  padding: 1px 5px;
  border: 1px solid rgba(16, 185, 129, 0.45);
  border-radius: 999px;
  color: #34d399;
  font: 600 9px ui-monospace, Consolas, monospace;
  text-transform: uppercase;
}
.codex-limit { color: #f87171; }
</style>
