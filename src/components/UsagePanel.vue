<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import type { UsageData } from "../App.vue";

const { t, locale } = useI18n();

const props = defineProps<{
  usage: UsageData;
  loading: boolean;
  autoStartEnabled: boolean;
  autoStartStatus: string;
}>();

defineEmits<{
  refresh: [];
  "manual-start": [];
}>();

const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
});

function formatRelative(diff: number): string {
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);

  if (locale.value === "ru") {
    if (d > 0) return `${d}д ${h}ч`;
    if (h > 0) return `${h}ч ${m}м`;
    if (m > 0) return `${m}м ${s}с`;
    return `${s}с`;
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatReset(resetAt: string | null): string {
  if (!resetAt) return t("noActiveSession");
  const target = new Date(resetAt);
  const diff = target.getTime() - now.value;
  if (diff <= 0) return t("resetDone");

  const time = formatRelative(diff);

  const todayStart = new Date(now.value);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const loc = locale.value === "ru" ? "ru-RU" : "en-US";
  const clock = target.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  let date: string;
  if (target >= todayStart && target < tomorrowStart) {
    date = `${t("today")} ${clock}`;
  } else {
    const day = target.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" });
    date = `${day}, ${clock}`;
  }

  return t("resetsIn", { time, date });
}

function tierClass(percent: number): string {
  if (percent < 25) return "tier-green";
  if (percent < 50) return "tier-yellow";
  if (percent < 75) return "tier-orange";
  return "tier-red";
}

const fiveHour = computed(() => props.usage.five_hour);
const sevenDay = computed(() => props.usage.seven_day);
const opusDay = computed(() => props.usage.seven_day_opus);
const sonnetDay = computed(() => props.usage.seven_day_sonnet);
const sessionActive = computed(
  () => fiveHour.value.percent_used > 0 || fiveHour.value.reset_at !== null
);

const extraUsage = computed(() => props.usage.extra_usage);
const prepaidBalance = computed(() => props.usage.prepaid_balance);
</script>

<template>
  <div class="cards">
    <!-- 5-hour session -->
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">
            {{ t('session5h') }}
            <span v-if="fiveHour.is_limited" class="badge" style="color: #f87171">{{ t('limit') }}</span>
          </div>
          <div class="card-sub">{{ formatReset(fiveHour.reset_at) }}</div>
        </div>
        <div class="pct" :class="tierClass(fiveHour.percent_used)">
          {{ fiveHour.percent_used.toFixed(1) }}%
        </div>
      </div>
      <div class="bar" :class="tierClass(fiveHour.percent_used)">
        <i :style="{ width: Math.min(fiveHour.percent_used, 100) + '%' }"></i>
      </div>
    </div>

    <!-- 7-day weekly -->
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">
            {{ t('weekly7d') }}
            <span v-if="sevenDay.is_limited" class="badge" style="color: #f87171">{{ t('limit') }}</span>
          </div>
          <div class="card-sub">{{ formatReset(sevenDay.reset_at) }}</div>
        </div>
        <div class="pct" :class="tierClass(sevenDay.percent_used)">
          {{ sevenDay.percent_used.toFixed(1) }}%
        </div>
      </div>
      <div class="bar" :class="tierClass(sevenDay.percent_used)">
        <i :style="{ width: Math.min(sevenDay.percent_used, 100) + '%' }"></i>
      </div>
    </div>

    <!-- Opus 7-day -->
    <div v-if="opusDay" class="card">
      <div class="card-row">
        <div>
          <div class="card-title">
            {{ t('opusWeekly') }}
            <span v-if="opusDay.is_limited" class="badge" style="color: #f87171">{{ t('limit') }}</span>
          </div>
          <div class="card-sub">{{ formatReset(opusDay.reset_at) }}</div>
        </div>
        <div class="pct" :class="tierClass(opusDay.percent_used)">
          {{ opusDay.percent_used.toFixed(1) }}%
        </div>
      </div>
      <div class="bar" :class="tierClass(opusDay.percent_used)">
        <i :style="{ width: Math.min(opusDay.percent_used, 100) + '%' }"></i>
      </div>
    </div>

    <!-- Sonnet 7-day -->
    <div v-if="sonnetDay" class="card">
      <div class="card-row">
        <div>
          <div class="card-title">
            {{ t('sonnetWeekly') }}
            <span v-if="sonnetDay.is_limited" class="badge" style="color: #f87171">{{ t('limit') }}</span>
          </div>
          <div class="card-sub">{{ formatReset(sonnetDay.reset_at) }}</div>
        </div>
        <div class="pct" :class="tierClass(sonnetDay.percent_used)">
          {{ sonnetDay.percent_used.toFixed(1) }}%
        </div>
      </div>
      <div class="bar" :class="tierClass(sonnetDay.percent_used)">
        <i :style="{ width: Math.min(sonnetDay.percent_used, 100) + '%' }"></i>
      </div>
    </div>

    <!-- Extra usage (overage credits) -->
    <div v-if="extraUsage" class="card">
      <div class="card-row">
        <div>
          <div class="card-title">{{ t('extraUsage') }}</div>
          <div class="card-sub">
            {{ extraUsage.used_credits.toFixed(2) }} / {{ extraUsage.monthly_limit.toFixed(2) }} {{ extraUsage.currency }}
          </div>
        </div>
        <div class="pct" :class="tierClass(extraUsage.utilization)">
          {{ extraUsage.utilization.toFixed(1) }}%
        </div>
      </div>
      <div class="bar" :class="tierClass(extraUsage.utilization)">
        <i :style="{ width: Math.min(extraUsage.utilization, 100) + '%' }"></i>
      </div>
    </div>

    <!-- Prepaid credit balance -->
    <div v-if="prepaidBalance !== null" class="card">
      <div class="card-row">
        <div>
          <div class="card-title">{{ t('creditBalance') }}</div>
        </div>
        <div class="pct muted">
          {{ prepaidBalance.toFixed(2) }} {{ usage.prepaid_currency }}
        </div>
      </div>
    </div>

    <!-- Auto-start -->
    <div v-if="autoStartEnabled" class="auto-start-card">
      <span v-if="autoStartStatus" class="auto-status">{{ autoStartStatus }}</span>
      <span v-else-if="sessionActive" class="auto-status active">
        <span class="dot"></span> {{ t('sessionActive') }}
      </span>
      <button v-else class="auto-btn" @click="$emit('manual-start')" :disabled="loading">
        {{ t('startSession') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.auto-start-card {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 14px;
}

.auto-status {
  font-size: 12px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.auto-status.active {
  color: var(--success);
}

.auto-btn {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--card-radius);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms;
}

.auto-btn:hover {
  background: var(--card-bg-hover);
}

.auto-btn:disabled {
  opacity: 0.4;
}
</style>
