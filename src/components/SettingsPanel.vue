<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { Ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  ALERT_TIER_KEYS,
  ALERT_TYPE_KEYS,
  normalizeAlertTiers,
  normalizeAlertTypes,
} from "../thresholds";
import type { AlertTiers, AlertTierKey, AlertTypes, AlertTypeKey } from "../thresholds";
import { useUpdater } from "../updater";
import { INSIGHT_KINDS } from "../insightKinds";
import {
  DASHBOARD_SECTIONS,
  reconcileSectionPrefs,
  type SectionPref,
} from "../dashboardSections";

const TIER_LABELS: Record<AlertTierKey, string> = {
  five_hour: "session5h",
  seven_day: "weekly7d",
  seven_day_opus: "opusWeekly",
  seven_day_sonnet: "sonnetWeekly",
  extra_usage: "extraUsage",
};

const TYPE_LABELS: Record<AlertTypeKey, string> = {
  threshold: "alertTypeThreshold",
  reset: "alertTypeReset",
  forecast: "alertTypeForecast",
};

const { t } = useI18n();

// Settings are grouped into topic tabs. A future iteration may promote this to
// a dedicated settings window with the same sections (see issue discussion).
type SettingsTab = "account" | "limits" | "notifications" | "budget" | "insights" | "dashboard" | "updates";
const tab = ref<SettingsTab>("account");

const {
  currentVersion,
  availableVersion,
  status: updateStatus,
  checkHours: updateCheckHours,
  checkForUpdate,
  saveUpdaterSettings,
} = useUpdater();


const props = defineProps<{
  sessionKey: string;
  orgId: string;
  refreshInterval: number;
  autoStartSession: boolean;
  sessionThresholds: number[];
  weeklyThresholds: number[];
  notificationsEnabled: boolean;
  notifyForecastMinutes: number;
  forecastWindowMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  alertTiers: AlertTiers;
  alertTypes: AlertTypes;
  ccAnalyticsEnabled: boolean;
  dailyBudgetEnabled: boolean;
  dailyBudget: number;
  suggestedBudget: number | null;
  // Efficiency goals. cost/hour is USD/hour; errorRateMax is a FRACTION 0..1
  // (matching AppConfig). The error-rate input below shows/edits a percent.
  goalCostPerHourMax: number | null;
  goalErrorRateMax: number | null;
  serviceStatusEnabled: boolean;
  serviceStatusInterval: number;
  serviceStatusNotify: boolean;
  systemInfoEnabled: boolean;
  runtimeInsightsEnabled: boolean;
  runtimeInsightKinds: string[];
  locale: string;
}>();

const emit = defineEmits<{
  save: [settings: {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    sessionThresholds: number[];
    weeklyThresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    forecastWindowMinutes: number;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    alertTiers: AlertTiers;
    alertTypes: AlertTypes;
    ccAnalyticsEnabled: boolean;
    dailyBudgetEnabled: boolean;
    dailyBudget: number;
    goalCostPerHourMax: number | null;
    goalErrorRateMax: number | null;
    serviceStatusEnabled: boolean;
    serviceStatusInterval: number;
    serviceStatusNotify: boolean;
    systemInfoEnabled: boolean;
    locale: string;
  }];
  // Runtime-insight settings save immediately (not via the Save button).
  runtimeChange: [settings: { enabled: boolean; kinds: string[] }];
}>();

const localSessionKey = ref(props.sessionKey);
const localOrgId = ref(props.orgId);
const localInterval = ref(props.refreshInterval);
const localAutoStart = ref(props.autoStartSession);
const localS1 = ref(props.sessionThresholds[0] ?? 25);
const localS2 = ref(props.sessionThresholds[1] ?? 50);
const localS3 = ref(props.sessionThresholds[2] ?? 75);
const localW1 = ref(props.weeklyThresholds[0] ?? 25);
const localW2 = ref(props.weeklyThresholds[1] ?? 50);
const localW3 = ref(props.weeklyThresholds[2] ?? 75);
const localNotify = ref(props.notificationsEnabled);
const localForecast = ref(props.notifyForecastMinutes);
const localForecastWindow = ref(props.forecastWindowMinutes);
const localQuiet = ref(props.quietHoursEnabled);
const localQuietStart = ref(props.quietHoursStart);
const localQuietEnd = ref(props.quietHoursEnd);
const localTiers = ref<AlertTiers>(normalizeAlertTiers(props.alertTiers));
const localTypes = ref<AlertTypes>(normalizeAlertTypes(props.alertTypes));
const localCc = ref(props.ccAnalyticsEnabled);
const localBudgetEnabled = ref(props.dailyBudgetEnabled);
const localBudget = ref(props.dailyBudget);
// Goals are optional: empty string = unset (null). cost/hour is edited in USD
// as stored; error-rate is stored as a fraction 0..1 but edited as a percent
// (×100 on load, ÷100 on save) so the user types "10" for 10%.
const localGoalCostPerHour = ref<number | "">(props.goalCostPerHourMax ?? "");
const localGoalErrorRatePct = ref<number | "">(
  props.goalErrorRateMax === null ? "" : props.goalErrorRateMax * 100,
);
const localSvcEnabled = ref(props.serviceStatusEnabled);
const localSvcInterval = ref(props.serviceStatusInterval);
const localSvcNotify = ref(props.serviceStatusNotify);
const localSystemInfo = ref(props.systemInfoEnabled);
const localLocale = ref(props.locale);

watch(() => props.sessionKey, (v) => (localSessionKey.value = v));
watch(() => props.orgId, (v) => (localOrgId.value = v));
watch(() => props.autoStartSession, (v) => (localAutoStart.value = v));
watch(() => props.sessionThresholds, (v) => {
  localS1.value = v[0] ?? 25;
  localS2.value = v[1] ?? 50;
  localS3.value = v[2] ?? 75;
});
watch(() => props.weeklyThresholds, (v) => {
  localW1.value = v[0] ?? 25;
  localW2.value = v[1] ?? 50;
  localW3.value = v[2] ?? 75;
});
watch(() => props.notificationsEnabled, (v) => (localNotify.value = v));
watch(() => props.notifyForecastMinutes, (v) => (localForecast.value = v));
watch(() => props.forecastWindowMinutes, (v) => (localForecastWindow.value = v));
watch(() => props.quietHoursEnabled, (v) => (localQuiet.value = v));
watch(() => props.quietHoursStart, (v) => (localQuietStart.value = v));
watch(() => props.quietHoursEnd, (v) => (localQuietEnd.value = v));
watch(() => props.alertTiers, (v) => (localTiers.value = normalizeAlertTiers(v)));
watch(() => props.alertTypes, (v) => (localTypes.value = normalizeAlertTypes(v)));
watch(() => props.ccAnalyticsEnabled, (v) => (localCc.value = v));
watch(() => props.dailyBudgetEnabled, (v) => (localBudgetEnabled.value = v));
watch(() => props.dailyBudget, (v) => (localBudget.value = v));
watch(() => props.goalCostPerHourMax, (v) => (localGoalCostPerHour.value = v ?? ""));
watch(() => props.goalErrorRateMax, (v) => (localGoalErrorRatePct.value = v === null ? "" : v * 100));
watch(() => props.serviceStatusEnabled, (v) => (localSvcEnabled.value = v));
watch(() => props.serviceStatusInterval, (v) => (localSvcInterval.value = v));
watch(() => props.serviceStatusNotify, (v) => (localSvcNotify.value = v));
watch(() => props.systemInfoEnabled, (v) => (localSystemInfo.value = v));
watch(() => props.locale, (v) => (localLocale.value = v));

// --- Insights toggles ---
// We mirror AnalyticsWindow.vue's pattern: read/write `ignoredInsights` in
// settings.json directly, without threading the array through props/save.
// The toggle in the UI is the *enabled* state — checked = visible = NOT in
// ignoredInsights.
const ignoredKinds = ref<string[]>([]);

async function loadIgnoredInsights() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const raw = await store.get<string[]>("ignoredInsights");
    if (Array.isArray(raw)) ignoredKinds.value = raw;
  } catch {}
}

async function saveIgnoredInsights() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("ignoredInsights", [...ignoredKinds.value]);
    await store.save();
  } catch {}
}

function isInsightEnabled(kind: string): boolean {
  return !ignoredKinds.value.includes(kind);
}

function toggleInsight(kind: string) {
  const i = ignoredKinds.value.indexOf(kind);
  if (i >= 0) ignoredKinds.value.splice(i, 1);
  else ignoredKinds.value.push(kind);
  saveIgnoredInsights();
}

// All insight kinds in catalog order — rendered as a Dashboard / Runtime table.
const allInsightKinds = INSIGHT_KINDS;

// --- Runtime insights (issue #46) ---
// Master opt-in + per-kind set. Both save immediately via the `runtimeChange`
// emit (the backend reconfigures on the spot), unlike the Save-button settings.
const localRuntimeEnabled = ref(props.runtimeInsightsEnabled);
const localRuntimeKinds = ref<string[]>([...props.runtimeInsightKinds]);
watch(() => props.runtimeInsightsEnabled, (v) => (localRuntimeEnabled.value = v));
watch(() => props.runtimeInsightKinds, (v) => (localRuntimeKinds.value = [...v]));

function isRuntimeOn(kind: string): boolean {
  return localRuntimeEnabled.value && localRuntimeKinds.value.includes(kind);
}

function emitRuntime() {
  emit("runtimeChange", {
    enabled: localRuntimeEnabled.value,
    kinds: [...localRuntimeKinds.value],
  });
}

function toggleRuntimeMaster() {
  localRuntimeEnabled.value = !localRuntimeEnabled.value;
  emitRuntime();
}

function toggleRuntime(kind: string) {
  if (!localRuntimeEnabled.value) return;
  const i = localRuntimeKinds.value.indexOf(kind);
  if (i >= 0) localRuntimeKinds.value.splice(i, 1);
  else localRuntimeKinds.value.push(kind);
  emitRuntime();
}

onMounted(loadIgnoredInsights);

// --- Dashboard section prefs ---
// Stored as a single `dashboardSections` array of {id, visible} preserving
// order. AnalyticsWindow reads the same key, so reorder/hide is reflected on
// the next refresh of that window. We never thread this through props/save —
// it's analytics-window-local config.
const sectionPrefs = ref<SectionPref[]>([]);

async function loadSectionPrefs() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const raw = await store.get<unknown>("dashboardSections");
    sectionPrefs.value = reconcileSectionPrefs(raw);
  } catch {
    sectionPrefs.value = reconcileSectionPrefs(null);
  }
}

async function saveSectionPrefs() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("dashboardSections", JSON.parse(JSON.stringify(sectionPrefs.value)));
    await store.save();
  } catch {}
}

function sectionLabel(id: string): string {
  const def = DASHBOARD_SECTIONS.find((s) => s.id === id);
  return def ? t(def.labelKey) : id;
}

function toggleSection(id: string) {
  const s = sectionPrefs.value.find((x) => x.id === id);
  if (!s) return;
  s.visible = !s.visible;
  saveSectionPrefs();
}

function moveSection(id: string, delta: -1 | 1) {
  const i = sectionPrefs.value.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sectionPrefs.value.length) return;
  const arr = [...sectionPrefs.value];
  [arr[i], arr[j]] = [arr[j], arr[i]];
  sectionPrefs.value = arr;
  saveSectionPrefs();
}

onMounted(loadSectionPrefs);

// Keep each threshold triple strictly ascending with a 1% gap so the colour
// bands can't overlap. Fixed slider scale (5..99) + clamping — dynamic min/max
// would make neighbouring thumbs visually drift when their range changes.
const GAP = 1;
function useAscending(t1: Ref<number>, t2: Ref<number>, t3: Ref<number>) {
  watch(t1, (v) => {
    if (v >= t2.value) t1.value = t2.value - GAP;
  });
  watch(t2, (v) => {
    if (v <= t1.value) t2.value = t1.value + GAP;
    else if (v >= t3.value) t2.value = t3.value - GAP;
  });
  watch(t3, (v) => {
    if (v <= t2.value) t3.value = t2.value + GAP;
  });
}
useAscending(localS1, localS2, localS3);
useAscending(localW1, localW2, localW3);

function applySuggestion() {
  if (props.suggestedBudget === null) return;
  // Budget is a whole number (the input only accepts integers).
  localBudget.value = Math.round(props.suggestedBudget);
}

// Empty / non-positive goal input → null (goal disabled). A goal of 0 would be
// impossible to stay under, so we treat ≤0 as "unset" too.
function goalOrNull(v: number | ""): number | null {
  if (v === "" || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
  return Number(v);
}

function handleSave() {
  const errPct = goalOrNull(localGoalErrorRatePct.value);
  emit("save", {
    sessionKey: localSessionKey.value.trim(),
    orgId: localOrgId.value.trim(),
    refreshInterval: localInterval.value,
    autoStartSession: localAutoStart.value,
    sessionThresholds: [localS1.value, localS2.value, localS3.value],
    weeklyThresholds: [localW1.value, localW2.value, localW3.value],
    notificationsEnabled: localNotify.value,
    notifyForecastMinutes: localForecast.value,
    forecastWindowMinutes: localForecastWindow.value,
    quietHoursEnabled: localQuiet.value,
    quietHoursStart: localQuietStart.value,
    quietHoursEnd: localQuietEnd.value,
    alertTiers: { ...localTiers.value },
    alertTypes: { ...localTypes.value },
    ccAnalyticsEnabled: localCc.value,
    dailyBudgetEnabled: localBudgetEnabled.value,
    dailyBudget: Math.round(localBudget.value) || 0,
    goalCostPerHourMax: goalOrNull(localGoalCostPerHour.value),
    // UI edits a percent; AppConfig stores a fraction 0..1.
    goalErrorRateMax: errPct === null ? null : errPct / 100,
    serviceStatusEnabled: localSvcEnabled.value,
    serviceStatusInterval: localSvcInterval.value,
    serviceStatusNotify: localSvcNotify.value,
    systemInfoEnabled: localSystemInfo.value,
    locale: localLocale.value,
  });
}
</script>

<template>
  <form class="settings-form" @submit.prevent="handleSave">
    <!-- Topic tabs -->
    <div class="settings-tabs">
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'account' }"
        @click="tab = 'account'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke-linecap="round" />
        </svg>
        <span>{{ t('tabAccount') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'limits' }"
        @click="tab = 'limits'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" stroke-linecap="round" />
          <line x1="2.5" y1="8" x2="13.5" y2="8" stroke-linecap="round" />
          <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" stroke-linecap="round" />
          <circle cx="5" cy="4.5" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="10.5" cy="8" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="6.5" cy="11.5" r="1.9" fill="currentColor" stroke="none" />
        </svg>
        <span>{{ t('tabLimits') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'notifications' }"
        @click="tab = 'notifications'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M4 7a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4z" stroke-linejoin="round" />
          <path d="M6.5 13a1.6 1.6 0 0 0 3 0" stroke-linecap="round" />
        </svg>
        <span>{{ t('tabAlerts') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'budget' }"
        @click="tab = 'budget'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.3v7.4M9.9 6c-.4-.7-1.1-1-1.9-1-1 0-1.8.5-1.8 1.4 0 1.9 3.7 1 3.7 2.9 0 .9-.8 1.4-1.9 1.4-.8 0-1.5-.4-1.9-1" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('tabBudget') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'insights' }"
        @click="tab = 'insights'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M8 2c-2.5 0-4.3 2-4.3 4.3 0 1.6.8 2.7 1.6 3.5.4.4.7.8.7 1.2v.5h4v-.5c0-.4.3-.8.7-1.2.8-.8 1.6-1.9 1.6-3.5C12.3 4 10.5 2 8 2z" stroke-linejoin="round" />
          <line x1="6.5" y1="13.5" x2="9.5" y2="13.5" stroke-linecap="round" />
          <line x1="7" y1="14.8" x2="9" y2="14.8" stroke-linecap="round" />
        </svg>
        <span>{{ t('tabInsights') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'dashboard' }"
        @click="tab = 'dashboard'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="2.5" y="2.5" width="5" height="6" rx="1" />
          <rect x="8.5" y="2.5" width="5" height="3" rx="1" />
          <rect x="2.5" y="9.5" width="5" height="4" rx="1" />
          <rect x="8.5" y="6.5" width="5" height="7" rx="1" />
        </svg>
        <span>{{ t('tabDashboard') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'updates' }"
        @click="tab = 'updates'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M8 2.5v7M5 6.5l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3 12.5h10" stroke-linecap="round" />
        </svg>
        <span>{{ t('tabUpdates') }}</span>
      </button>
    </div>

    <div class="cards">
      <!-- ===== Account ===== -->
      <template v-if="tab === 'account'">
      <!-- Session Key -->
      <div class="card">
        <div class="field-label">{{ t('sessionKey') }}</div>
        <input
          v-model="localSessionKey"
          type="password"
          class="field-input"
          :placeholder="t('sessionKeyPlaceholder')"
          autocomplete="off"
        />
        <div class="field-hint">{{ t('sessionKeyHint') }}</div>
      </div>

      <!-- Org ID -->
      <div class="card">
        <div class="field-label">{{ t('orgId') }}</div>
        <input
          v-model="localOrgId"
          type="text"
          class="field-input"
          :placeholder="t('orgIdPlaceholder')"
          autocomplete="off"
        />
        <div class="field-hint">{{ t('orgIdHint') }}</div>
      </div>

      <!-- Refresh interval -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('refreshInterval') }}</div>
          <span class="pct muted" style="font-size: 14px">{{ localInterval }}s</span>
        </div>
        <input
          v-model.number="localInterval"
          type="range"
          class="field-range"
          min="10"
          max="300"
          step="5"
        />
      </div>

      <!-- Language -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('language') }}</div>
          <div class="lang-switch">
            <button
              type="button"
              class="lang-btn"
              :class="{ active: localLocale === 'en' }"
              @click="localLocale = 'en'"
            >EN</button>
            <button
              type="button"
              class="lang-btn"
              :class="{ active: localLocale === 'ru' }"
              @click="localLocale = 'ru'"
            >RU</button>
          </div>
        </div>
      </div>

      <!-- Auto-start toggle -->
      <div class="card toggle-card" @click="localAutoStart = !localAutoStart">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('autoStartSession') }}</div>
          <div class="card-sub">{{ t('autoStartDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localAutoStart }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Mini panel: whole-machine CPU + RAM (compact 2×2 vs original bars) -->
      <div class="card toggle-card" @click="localSystemInfo = !localSystemInfo">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('miniSystemInfo') }}</div>
          <div class="card-sub">{{ t('miniSystemInfoDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localSystemInfo }">
          <div class="toggle-knob"></div>
        </div>
      </div>
      </template>

      <!-- ===== Limits / thresholds ===== -->
      <template v-if="tab === 'limits'">
      <!-- Session (5h) thresholds — also drive the tray icon colour -->
      <div class="card">
        <div class="field-label">{{ t('thresholdsSession') }}</div>
        <div class="thr-row">
          <span class="thr-dot tier-yellow"></span>
          <span class="thr-label">{{ t('thresholdYellow') }}</span>
          <input v-model.number="localS1" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localS1 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-orange"></span>
          <span class="thr-label">{{ t('thresholdOrange') }}</span>
          <input v-model.number="localS2" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localS2 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-red"></span>
          <span class="thr-label">{{ t('thresholdRed') }}</span>
          <input v-model.number="localS3" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localS3 }}%</span>
        </div>
        <div class="field-hint">{{ t('thresholdsSessionDesc') }}</div>
      </div>

      <!-- Weekly thresholds (7d / Opus / Sonnet / extra) -->
      <div class="card">
        <div class="field-label">{{ t('thresholdsWeekly') }}</div>
        <div class="thr-row">
          <span class="thr-dot tier-yellow"></span>
          <span class="thr-label">{{ t('thresholdYellow') }}</span>
          <input v-model.number="localW1" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localW1 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-orange"></span>
          <span class="thr-label">{{ t('thresholdOrange') }}</span>
          <input v-model.number="localW2" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localW2 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-red"></span>
          <span class="thr-label">{{ t('thresholdRed') }}</span>
          <input v-model.number="localW3" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localW3 }}%</span>
        </div>
      </div>

      <!-- Forecast averaging window (drives the usage-card ETA, not just alerts) -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('forecastWindow') }}</div>
          <span class="pct muted" style="font-size: 14px">{{ localForecastWindow }} {{ t('minutesShort') }}</span>
        </div>
        <input
          v-model.number="localForecastWindow"
          type="range"
          class="field-range"
          min="15"
          max="180"
          step="5"
        />
        <div class="field-hint">{{ t('forecastWindowDesc') }}</div>
      </div>
      </template>

      <!-- ===== Notifications ===== -->
      <template v-if="tab === 'notifications'">
      <!-- Notifications toggle -->
      <div class="card toggle-card" @click="localNotify = !localNotify">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('notifications') }}</div>
          <div class="card-sub">{{ t('notificationsDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localNotify }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Notification settings (shown when enabled) -->
      <template v-if="localNotify">
        <!-- Per-type toggles -->
        <div class="card">
          <div class="field-label">{{ t('alertTypesTitle') }}</div>
          <div
            v-for="key in ALERT_TYPE_KEYS"
            :key="key"
            class="tier-row"
            @click="localTypes[key] = !localTypes[key]"
          >
            <span class="tier-name">{{ t(TYPE_LABELS[key]) }}</span>
            <div class="toggle" :class="{ on: localTypes[key] }">
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>

        <!-- Per-tier toggles -->
        <div class="card">
          <div class="field-label">{{ t('alertTiersTitle') }}</div>
          <div
            v-for="key in ALERT_TIER_KEYS"
            :key="key"
            class="tier-row"
            @click="localTiers[key] = !localTiers[key]"
          >
            <span class="tier-name">{{ t(TIER_LABELS[key]) }}</span>
            <div class="toggle" :class="{ on: localTiers[key] }">
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>

        <!-- Forecast minutes -->
        <div class="card">
          <div class="card-row" style="align-items: center">
            <div class="field-label" style="margin-bottom: 0">{{ t('notifyForecast') }}</div>
            <span class="pct muted" style="font-size: 14px">{{ localForecast }} {{ t('minutesShort') }}</span>
          </div>
          <input
            v-model.number="localForecast"
            type="range"
            class="field-range"
            min="5"
            max="120"
            step="5"
          />
          <div class="field-hint">{{ t('notifyForecastDesc') }}</div>
        </div>

        <!-- Quiet hours toggle -->
        <div class="card toggle-card" @click="localQuiet = !localQuiet">
          <div style="flex: 1; min-width: 0">
            <div class="card-title" style="font-size: 13px">{{ t('quietHours') }}</div>
            <div class="card-sub">{{ t('quietHoursDesc') }}</div>
          </div>
          <div class="toggle" :class="{ on: localQuiet }">
            <div class="toggle-knob"></div>
          </div>
        </div>

        <!-- Quiet hours window -->
        <div v-if="localQuiet" class="card">
          <div class="card-row" style="align-items: center; gap: 12px">
            <div style="flex: 1">
              <div class="field-label">{{ t('quietHoursStart') }}</div>
              <input v-model="localQuietStart" type="time" class="field-input" />
            </div>
            <div style="flex: 1">
              <div class="field-label">{{ t('quietHoursEnd') }}</div>
              <input v-model="localQuietEnd" type="time" class="field-input" />
            </div>
          </div>
        </div>
      </template>

      <!-- Claude service status (status.claude.com) — independent of usage alerts -->
      <div class="card toggle-card" @click="localSvcEnabled = !localSvcEnabled">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('serviceStatus') }}</div>
          <div class="card-sub">{{ t('serviceStatusDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localSvcEnabled }">
          <div class="toggle-knob"></div>
        </div>
      </div>
      <template v-if="localSvcEnabled">
        <div class="card">
          <div class="card-row" style="align-items: center">
            <div class="field-label" style="margin-bottom: 0">{{ t('serviceStatusInterval') }}</div>
            <span class="pct muted" style="font-size: 14px">{{ localSvcInterval }}s</span>
          </div>
          <input
            v-model.number="localSvcInterval"
            type="range"
            class="field-range"
            min="30"
            max="600"
            step="10"
          />
        </div>
        <div class="card toggle-card" @click="localSvcNotify = !localSvcNotify">
          <div style="flex: 1; min-width: 0">
            <div class="card-title" style="font-size: 13px">{{ t('serviceStatusNotify') }}</div>
            <div class="card-sub">{{ t('serviceStatusNotifyDesc') }}</div>
          </div>
          <div class="toggle" :class="{ on: localSvcNotify }">
            <div class="toggle-knob"></div>
          </div>
        </div>
      </template>
      </template>

      <!-- ===== Budget & analytics ===== -->
      <template v-if="tab === 'budget'">
      <!-- Claude Code analytics (opt-in, off by default) -->
      <div class="card toggle-card" @click="localCc = !localCc">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('ccAnalytics') }}</div>
          <div class="card-sub">{{ t('ccAnalyticsDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localCc }">
          <div class="toggle-knob"></div>
        </div>
      </div>
      <div v-if="localCc" class="card cc-note">
        <div class="cc-note-row">{{ t('ccAnalyticsReads') }}</div>
        <div class="cc-note-row">{{ t('ccAnalyticsData') }}</div>
        <div class="cc-note-row">{{ t('ccAnalyticsLocal') }}</div>
      </div>

      <!-- Daily budget -->
      <div class="card toggle-card" @click="localBudgetEnabled = !localBudgetEnabled">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('dailyBudget') }}</div>
          <div class="card-sub">{{ t('dailyBudgetDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localBudgetEnabled }">
          <div class="toggle-knob"></div>
        </div>
      </div>
      <div v-if="localBudgetEnabled" class="card">
        <div class="field-label">
          {{ localCc ? t('dailyBudgetUnitUsd') : t('dailyBudgetUnitPct') }}
        </div>
        <input
          v-model.number="localBudget"
          type="number"
          class="field-input"
          min="0"
          step="1"
        />
        <div
          v-if="suggestedBudget !== null && localCc === ccAnalyticsEnabled"
          class="budget-suggest"
        >
          <span class="field-hint" style="margin: 0">
            {{ t('budgetSuggest', {
              value: localCc
                ? '$' + Math.round(suggestedBudget)
                : Math.round(suggestedBudget) + '%',
            }) }}
          </span>
          <button type="button" class="suggest-btn" @click="applySuggestion">
            {{ t('budgetSuggestApply') }}
          </button>
        </div>
      </div>

      <!-- Efficiency goals (optional thresholds, shown on dashboard tiles) -->
      <div class="card">
        <div class="field-label">{{ t('goalsTitle') }}</div>
        <div class="field-hint" style="margin-top: 0; margin-bottom: 10px">
          {{ t('goalsDesc') }}
        </div>
        <div class="goal-field">
          <div class="field-label" style="margin-bottom: 6px">{{ t('goalCostPerHour') }}</div>
          <input
            v-model.number="localGoalCostPerHour"
            type="number"
            class="field-input"
            min="0"
            step="1"
            :placeholder="t('goalCostPerHourPlaceholder')"
          />
        </div>
        <div class="goal-field" style="margin-top: 12px">
          <div class="field-label" style="margin-bottom: 6px">{{ t('goalErrorRate') }}</div>
          <input
            v-model.number="localGoalErrorRatePct"
            type="number"
            class="field-input"
            min="0"
            max="100"
            step="1"
            :placeholder="t('goalErrorRatePlaceholder')"
          />
        </div>
      </div>
      </template>

      <!-- ===== Insights ===== -->
      <template v-if="tab === 'insights'">
      <div class="card">
        <div class="field-label">{{ t('insightsSettingsTitle') }}</div>
        <div class="field-hint" style="margin-top: 0; margin-bottom: 4px">
          {{ t('insightsSettingsDesc') }}
        </div>
      </div>

      <!-- Runtime master opt-in -->
      <div class="card toggle-card" @click="toggleRuntimeMaster">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('runtimeInsightsTitle') }}</div>
          <div class="card-sub">{{ t('runtimeInsightsDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localRuntimeEnabled }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Metric | Dashboard | Runtime -->
      <div class="card">
        <div class="insight-row insight-head">
          <span class="insight-name"></span>
          <span class="insight-col">{{ t('insightColDashboard') }}</span>
          <span class="insight-col">{{ t('insightColRuntime') }}</span>
        </div>
        <div
          v-for="def in allInsightKinds"
          :key="def.kind"
          class="insight-row"
        >
          <span class="insight-name">{{ t(def.shortLabelKey) }}</span>
          <div class="insight-col">
            <div
              class="toggle"
              :class="{ on: isInsightEnabled(def.kind) }"
              @click="toggleInsight(def.kind)"
            >
              <div class="toggle-knob"></div>
            </div>
          </div>
          <div class="insight-col">
            <div
              v-if="def.runtimeCapable"
              class="toggle"
              :class="{ on: isRuntimeOn(def.kind), disabled: !localRuntimeEnabled }"
              @click="toggleRuntime(def.kind)"
            >
              <div class="toggle-knob"></div>
            </div>
            <span
              v-else
              class="insight-na"
              :title="t('runtimeInsightUnavailable')"
            >—</span>
          </div>
        </div>
      </div>
      </template>

      <!-- ===== Dashboard layout ===== -->
      <template v-if="tab === 'dashboard'">
      <div class="card">
        <div class="field-label">{{ t('dashboardSettingsTitle') }}</div>
        <div class="field-hint" style="margin-top: 0; margin-bottom: 4px">
          {{ t('dashboardSettingsDesc') }}
        </div>
      </div>

      <div class="card">
        <div
          v-for="(pref, idx) in sectionPrefs"
          :key="pref.id"
          class="tier-row dash-row"
        >
          <div class="dash-order">
            <button
              type="button"
              class="dash-move"
              :disabled="idx === 0"
              :title="t('moveUp')"
              @click="moveSection(pref.id, -1)"
            >▲</button>
            <button
              type="button"
              class="dash-move"
              :disabled="idx === sectionPrefs.length - 1"
              :title="t('moveDown')"
              @click="moveSection(pref.id, 1)"
            >▼</button>
          </div>
          <span class="tier-name" @click="toggleSection(pref.id)">
            {{ sectionLabel(pref.id) }}
          </span>
          <div
            class="toggle"
            :class="{ on: pref.visible }"
            @click="toggleSection(pref.id)"
          >
            <div class="toggle-knob"></div>
          </div>
        </div>
      </div>
      </template>

      <!-- ===== Updates ===== -->
      <template v-if="tab === 'updates'">
      <!-- Updates -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('updates') }}</div>
          <span class="pct muted" style="font-size: 13px">v{{ currentVersion }}</span>
        </div>
        <button
          type="button"
          class="btn-check"
          :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
          @click="checkForUpdate(false)"
        >
          {{ updateStatus === 'checking' ? t('checkingUpdates') : t('checkForUpdates') }}
        </button>
        <div v-if="updateStatus === 'uptodate'" class="field-hint">{{ t('upToDate') }}</div>
        <div v-else-if="updateStatus === 'available'" class="field-hint">
          {{ t('updateAvailable', { version: availableVersion }) }}
        </div>
        <div v-else-if="updateStatus === 'error'" class="field-hint" style="color: #f87171">
          {{ t('updateError') }}
        </div>
      </div>

      <!-- Update check interval -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('updateCheckInterval') }}</div>
          <span class="pct muted" style="font-size: 14px">{{ updateCheckHours }} {{ t('hoursShort') }}</span>
        </div>
        <input
          v-model.number="updateCheckHours"
          type="range"
          class="field-range"
          min="1"
          max="48"
          step="1"
          @change="saveUpdaterSettings()"
        />
      </div>
      </template>
    </div>

    <div style="padding: 8px 10px 12px">
      <button type="submit" class="save-btn" :disabled="!localSessionKey || !localOrgId">
        {{ t('save') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.settings-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 10px 2px;
  flex-shrink: 0;
}

.settings-tab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 7px 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 10.5px;
  font-family: var(--segoe);
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.settings-tab:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-2);
}

.settings-tab.active {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text);
}

.settings-tab svg {
  opacity: 0.8;
}

.settings-tab.active svg {
  color: var(--accent);
  opacity: 1;
}

.thr-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.thr-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.thr-dot.tier-yellow { background: #ffc107; }
.thr-dot.tier-orange { background: #d97757; }
.thr-dot.tier-red { background: #f87171; }

.thr-label {
  font-size: 12px;
  color: var(--text-3);
  width: 64px;
  flex-shrink: 0;
}

.thr-range {
  flex: 1;
  margin-top: 0;
}

.thr-val {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

.tier-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  cursor: pointer;
}
.dash-row {
  cursor: default;
}
.dash-row .tier-name {
  flex: 1;
  cursor: pointer;
}
.dash-order {
  display: inline-flex;
  flex-direction: column;
  gap: 1px;
  margin-right: 4px;
}
.dash-move {
  background: transparent;
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  color: rgba(255, 255, 255, 0.75);
  width: 22px;
  height: 14px;
  border-radius: 3px;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dash-move:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.dash-move:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.cc-note {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cc-note-row {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-4);
  padding-left: 14px;
  position: relative;
}

.cc-note-row::before {
  content: "•";
  position: absolute;
  left: 2px;
  color: var(--text-3);
}

.tier-name {
  font-size: 13px;
  color: var(--text-2);
}

/* Insights table: Metric | Dashboard | Runtime */
.insight-row {
  display: grid;
  grid-template-columns: 1fr 72px 72px;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.insight-head {
  border-bottom: 1px solid var(--stroke-strong);
  padding-bottom: 8px;
  margin-bottom: 2px;
}
.insight-name {
  font-size: 13px;
  color: var(--text-2);
}
.insight-col {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.insight-col .toggle {
  cursor: pointer;
}
.insight-col .toggle.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.insight-na {
  color: var(--text-4);
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}

.field-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--stroke-strong);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 13px;
  font-family: var(--segoe);
  outline: none;
  transition: border-color 120ms, background 120ms;
}

.field-input:focus {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
}

.field-input::placeholder {
  color: var(--text-4);
}

.field-hint {
  font-size: 13px;
  color: var(--text-4);
  margin-top: 6px;
}

.field-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  margin-top: 8px;
  height: 20px;
  background: transparent;
  cursor: pointer;
}

.field-range::-webkit-slider-runnable-track {
  height: 4px;
  background: var(--stroke-strong);
  border-radius: 2px;
}

.field-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: -5px;
  border: none;
  transition: transform 100ms;
}

.field-range::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.toggle-card {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.toggle {
  width: 40px;
  height: 20px;
  background: var(--stroke-strong);
  border-radius: 10px;
  position: relative;
  transition: background 200ms;
  flex-shrink: 0;
}

.toggle.on {
  background: var(--accent);
}

.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  background: white;
  border-radius: 50%;
  transition: transform 200ms;
}

.toggle.on .toggle-knob {
  transform: translateX(20px);
}

.lang-switch {
  display: flex;
  gap: 0;
  border: 1px solid var(--stroke-strong);
  border-radius: 4px;
  overflow: hidden;
}

.lang-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.lang-btn + .lang-btn {
  border-left: 1px solid var(--stroke-strong);
}

.lang-btn.active {
  background: var(--accent);
  color: white;
}

.save-btn {
  width: 100%;
  padding: 9px;
  border: none;
  border-radius: var(--card-radius);
  background: var(--accent);
  color: white;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--segoe);
  cursor: pointer;
  transition: filter 120ms;
}

.save-btn:hover {
  filter: brightness(1.15);
}

.save-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-check {
  width: 100%;
  margin-top: 4px;
  padding: 7px;
  border: 1px solid var(--stroke-strong);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}

.btn-check:hover:not(:disabled) {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
}

.btn-check:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.budget-suggest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
}

.suggest-btn {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms;
}

.suggest-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
