<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
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
import { FONT_OPTIONS, applyFont } from "../fontSwitch";
import EnrollmentPanel from "./EnrollmentPanel.vue";

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

// Settings are grouped into topic tabs. The panel now lives in a dedicated
// settings window (issue #45); each screen's gear opens it on a matching tab via
// the `openTab` prop (the window forwards the backend's `settings-open` event).
type SettingsTab = "account" | "limits" | "notifications" | "budget" | "insights" | "tasks" | "integrations" | "updates";
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
  // Which tab to show. Driven by the gear that opened the window; user clicks
  // still switch tabs freely afterwards (this only forces it on (re)open).
  openTab?: SettingsTab;
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
  memoryBloatEnabled: boolean;
  todoNotificationsEnabled: boolean;
  systemInfoEnabled: boolean;
  runtimeInsightsEnabled: boolean;
  runtimeInsightKinds: string[];
  locale: string;
  uiFont: string;
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
    memoryBloatEnabled: boolean;
    todoNotificationsEnabled: boolean;
    systemInfoEnabled: boolean;
    locale: string;
    uiFont: string;
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
const localMemBloat = ref(props.memoryBloatEnabled);
const localTodoNotify = ref(props.todoNotificationsEnabled);
const localSystemInfo = ref(props.systemInfoEnabled);
const localLocale = ref(props.locale);
const localFont = ref(props.uiFont);

// Live preview: applying on change lets the user compare fonts before saving.
// The choice only persists when the Save button calls handleSave → emit("save").
function onFontChange() {
  applyFont(localFont.value);
}

// If the panel closes without saving, revert any preview to the persisted font.
// After a successful save props.uiFont already equals the choice, so this is a
// no-op in that case.
onUnmounted(() => {
  applyFont(props.uiFont);
});

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
watch(() => props.memoryBloatEnabled, (v) => (localMemBloat.value = v));
watch(() => props.todoNotificationsEnabled, (v) => (localTodoNotify.value = v));
watch(() => props.systemInfoEnabled, (v) => (localSystemInfo.value = v));
watch(() => props.locale, (v) => (localLocale.value = v));
watch(() => props.uiFont, (v) => (localFont.value = v));

// Honour the requested tab on mount and whenever the host re-opens with a new
// one (clicking a different screen's gear). Same value won't re-fire — harmless,
// the panel is already on it.
if (props.openTab) tab.value = props.openTab;
watch(() => props.openTab, (v) => { if (v) tab.value = v; });

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

// --- cc-todos CLI + SessionStart hook installer ---
interface CcHookStatus {
  installed: boolean;
  script_path: string;
  settings_path: string;
}
const ccHookStatus = ref<CcHookStatus | null>(null);
const installCcBusy = ref(false);
const installCcMsg = ref("");

async function loadCcHookStatus() {
  try {
    ccHookStatus.value = await invoke<CcHookStatus>("cc_hook_status");
  } catch {
    ccHookStatus.value = null;
  }
}
async function doInstallCcHook() {
  installCcBusy.value = true;
  installCcMsg.value = "";
  try {
    const p = await invoke<string>("install_cc_hook");
    installCcMsg.value = t("installCcHookDone", { path: p });
    await loadCcHookStatus();
  } catch (e) {
    installCcMsg.value = String(e);
  } finally {
    installCcBusy.value = false;
  }
}
onMounted(loadCcHookStatus);

// --- Phases in tasks (issue #16) ---
// Lives in the Tasks tab. A UI-only flag stored straight in settings.json (like
// ignoredInsights above) — no backend config, so it stays out of the Save flow.
// Default ON.
const phasesEnabled = ref(true);

async function loadPhasesEnabled() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const v = await store.get<boolean>("phasesEnabled");
    if (typeof v === "boolean") phasesEnabled.value = v;
  } catch {}
}

async function togglePhasesEnabled() {
  phasesEnabled.value = !phasesEnabled.value;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("phasesEnabled", phasesEnabled.value);
    await store.save();
  } catch {}
}

onMounted(loadPhasesEnabled);

// --- Task priority in context (issue #32) ---
// The LOWEST task priority the SessionStart hook injects into a Claude Code
// session: all | low | medium | high. A UI-only flag in settings.json read
// directly by the hook (like phasesEnabled above) — no backend config. Default
// `medium`, so low/unset tasks stay out of context unless the user lowers the bar.
const TASK_CTX_LEVELS = ["all", "low", "medium", "high"] as const;
const taskCtxPrio = ref<string>("medium");

function taskCtxPrioLabel(lv: string): string {
  if (lv === "all") return t("taskCtxPrioAll");
  if (lv === "low") return t("taskCtxPrioLow");
  if (lv === "medium") return t("taskCtxPrioMedium");
  return t("taskCtxPrioHigh");
}

async function loadTaskCtxPrio() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const v = await store.get<string>("taskContextPriority");
    if (typeof v === "string" && (TASK_CTX_LEVELS as readonly string[]).includes(v))
      taskCtxPrio.value = v;
  } catch {}
}

async function setTaskCtxPrio(v: string) {
  taskCtxPrio.value = v;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("taskContextPriority", v);
    await store.save();
  } catch {}
}

onMounted(loadTaskCtxPrio);

// What a session LEADS WITH when the project is mid-plan: "phase" (the current
// phase, focused) or "tasks" (always the task board). UI-only flag in settings.json
// read by the SessionStart hook (like taskContextPriority). Default "phase".
const SESSION_CTX_MODES = ["phase", "tasks"] as const;
const sessionCtx = ref<string>("phase");

function sessionCtxLabel(m: string): string {
  return m === "tasks" ? t("sessionCtxTasks") : t("sessionCtxPhase");
}

async function loadSessionCtx() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const v = await store.get<string>("sessionContext");
    if (typeof v === "string" && (SESSION_CTX_MODES as readonly string[]).includes(v))
      sessionCtx.value = v;
  } catch {}
}

async function setSessionCtx(v: string) {
  sessionCtx.value = v;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("sessionContext", v);
    await store.save();
  } catch {}
}

onMounted(loadSessionCtx);

// --- Task context in sessions (master hook switch) ---
// A UI-only flag in settings.json read by the SessionStart hook: when OFF, the
// hook injects nothing into a session (no task board, no phase context). Default
// ON. Same store-write pattern as phasesEnabled above.
const hookContextEnabled = ref(true);

async function loadHookContext() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const v = await store.get<boolean>("hookContextEnabled");
    if (typeof v === "boolean") hookContextEnabled.value = v;
  } catch {}
}

async function toggleHookContext() {
  hookContextEnabled.value = !hookContextEnabled.value;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    await store.set("hookContextEnabled", hookContextEnabled.value);
    await store.save();
  } catch {}
}

onMounted(loadHookContext);

// --- Task audit schedule (#35) ---
// Moved here from the tasks window. The in-app scheduler runs a headless
// `claude -p` audit once a day (backend `spawn_triage_scheduler`); these controls
// just read/write its config via the same backend commands. The digest it produces
// is still shown by the tasks-window chip.
interface TriageSchedule {
  enabled: boolean;
  time: string;
  model: string;
  last_run: string | null;
  last_error: string | null;
}
const schedEnabled = ref(false);
const schedTime = ref("08:00");
const schedModel = ref("haiku");
const schedLastRun = ref<string | null>(null);
const schedLastError = ref<string | null>(null);
const triageRunning = ref(false);

async function loadTriageSchedule() {
  try {
    const s = await invoke<TriageSchedule>("get_triage_schedule");
    schedEnabled.value = s.enabled;
    schedTime.value = s.time || "08:00";
    schedModel.value = s.model || "haiku";
    schedLastRun.value = s.last_run;
    schedLastError.value = s.last_error;
  } catch {
    // not under Tauri
  }
}

// Persist the toggle/time/model; the backend validates and echoes the normalized
// values back (e.g. zero-padded time), so we reflect those.
async function saveTriageSchedule() {
  try {
    const s = await invoke<TriageSchedule>("set_triage_schedule", {
      enabled: schedEnabled.value,
      time: schedTime.value,
      model: schedModel.value,
    });
    schedTime.value = s.time;
    schedModel.value = s.model;
  } catch (e) {
    schedLastError.value = String(e);
  }
}

function toggleSched() {
  schedEnabled.value = !schedEnabled.value;
  void saveTriageSchedule();
}

// Run the audit immediately, then refresh schedule state (last_run/last_error).
async function runTriageNow() {
  if (triageRunning.value) return;
  triageRunning.value = true;
  schedLastError.value = null;
  try {
    await invoke("run_triage_now");
  } catch (e) {
    schedLastError.value = String(e);
  } finally {
    triageRunning.value = false;
    await loadTriageSchedule();
  }
}

onMounted(loadTriageSchedule);

// --- Audit prompt editor (#35) ---
// The full prompt the audit model runs is handed to settings: the backend returns
// the effective text (a custom override, else the baked default); saving writes an
// override, reset drops it. Collapsed by default — this is an advanced knob.
interface TriagePrompt {
  text: string;
  is_custom: boolean;
}
const triagePrompt = ref("");
const triagePromptCustom = ref(false);
const promptOpen = ref(false);
const promptSaved = ref(false);
let promptSavedTimer: ReturnType<typeof setTimeout> | null = null;

async function loadTriagePrompt() {
  try {
    const info = await invoke<TriagePrompt>("get_triage_prompt");
    triagePrompt.value = info.text;
    triagePromptCustom.value = info.is_custom;
  } catch {
    // not under Tauri
  }
}

async function saveTriagePrompt() {
  try {
    await invoke("set_triage_prompt", { text: triagePrompt.value });
    await loadTriagePrompt();
    promptSaved.value = true;
    if (promptSavedTimer) clearTimeout(promptSavedTimer);
    promptSavedTimer = setTimeout(() => (promptSaved.value = false), 2000);
  } catch {
    // write failed (rare) → leave the editor as-is; nothing persisted
  }
}

async function resetTriagePrompt() {
  try {
    const info = await invoke<TriagePrompt>("reset_triage_prompt");
    triagePrompt.value = info.text;
    triagePromptCustom.value = info.is_custom;
  } catch {
    // not under Tauri
  }
}

onMounted(loadTriagePrompt);

// --- Task-ref migration & backups (#63) ---
// Bare `#N` used to be treated as a task reference, but in prose it almost always
// means a GitHub PR/issue — a number collision silently linked the wrong task. The
// app now links only the explicit `t#N` form; this one-shot migration rewrites the
// genuine `#N` task refs already in stored text to `t#N` so they keep linking. It
// backs up todos.json first, and "Откатить" restores that backup.
interface BackupInfo {
  name: string;
  when_ms: number;
}
interface MigrationReport {
  refs: number;
  tasks: number;
  backup: string;
}
const migrating = ref(false);
const restoring = ref(false);
const migrateMsg = ref("");
const latestBackup = ref<BackupInfo | null>(null);

async function loadLatestBackup() {
  try {
    latestBackup.value = await invoke<BackupInfo | null>("latest_todo_backup");
  } catch {
    // not under Tauri
  }
}

function fmtBackupTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

async function runMigration() {
  if (migrating.value) return;
  migrating.value = true;
  migrateMsg.value = "";
  try {
    const r = await invoke<MigrationReport>("migrate_todo_refs");
    migrateMsg.value =
      r.refs === 0 ? t("migrateNone") : t("migrateDone", { refs: r.refs, tasks: r.tasks });
    await loadLatestBackup();
  } catch (e) {
    migrateMsg.value = String(e);
  } finally {
    migrating.value = false;
  }
}

async function runRestore() {
  if (restoring.value || !latestBackup.value) return;
  // Restoring overwrites the current board with the backup — confirm, since any
  // edits made after that backup would be lost.
  if (typeof window !== "undefined" && !window.confirm(t("migrateRestoreConfirm"))) return;
  restoring.value = true;
  try {
    await invoke("restore_todo_backup", {});
    migrateMsg.value = t("migrateRestored");
    await loadLatestBackup();
  } catch (e) {
    migrateMsg.value = String(e);
  } finally {
    restoring.value = false;
  }
}

onMounted(loadLatestBackup);

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
    memoryBloatEnabled: localMemBloat.value,
    todoNotificationsEnabled: localTodoNotify.value,
    systemInfoEnabled: localSystemInfo.value,
    locale: localLocale.value,
    uiFont: localFont.value,
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
        :class="{ active: tab === 'tasks' }"
        @click="tab = 'tasks'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M2 4l1.3 1.3L6 2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 11l1.3 1.3L6 9.5" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="8.5" y1="4" x2="14" y2="4" stroke-linecap="round"/>
          <line x1="8.5" y1="11" x2="14" y2="11" stroke-linecap="round"/>
        </svg>
        <span>{{ t('tabTasks') }}</span>
      </button>
      <button
        type="button"
        class="settings-tab"
        :class="{ active: tab === 'integrations' }"
        @click="tab = 'integrations'"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M6.5 9.5L4.8 11.2a2.4 2.4 0 0 1-3.4-3.4l2-2a2.4 2.4 0 0 1 3.4 0" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9.5 6.5l1.7-1.7a2.4 2.4 0 0 1 3.4 3.4l-2 2a2.4 2.4 0 0 1-3.4 0" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>{{ t('tabIntegrations') }}</span>
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

    <div class="settings-content">
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

      <!-- UI font -->
      <div class="card">
        <div class="field-label">{{ t('uiFont') }}</div>
        <select
          v-model="localFont"
          class="field-input"
          :style="{ fontFamily: 'var(--segoe)' }"
          @change="onFontChange"
        >
          <option v-for="f in FONT_OPTIONS" :key="f.id" :value="f.id">
            {{ f.system ? `${f.name} (${t('uiFontSystem')})` : f.name }}{{ f.mono ? ' · mono' : '' }}
          </option>
        </select>
        <div class="field-hint">{{ t('uiFontHint') }}</div>
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

      <!-- Todo status notifications — independent of the usage-alert toggle above -->
      <div class="card toggle-card" @click="localTodoNotify = !localTodoNotify">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('todoNotifications') }}</div>
          <div class="card-sub">{{ t('todoNotificationsDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localTodoNotify }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Memory-bloat watch (#33) — sudden-growth notification for the active project -->
      <div class="card toggle-card" @click="localMemBloat = !localMemBloat">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('memBloatSetting') }}</div>
          <div class="card-sub">{{ t('memBloatSettingDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localMemBloat }">
          <div class="toggle-knob"></div>
        </div>
      </div>
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

      <!-- ===== Integrations ===== -->
      <template v-if="tab === 'integrations'">
        <EnrollmentPanel />
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

      <!-- ===== Tasks ===== -->
      <template v-if="tab === 'tasks'">
      <!-- Install the cc-todos CLI + SessionStart hook into ~/.claude/settings.json -->
      <div class="card" style="display: flex; align-items: center; gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('installCcHook') }}</div>
          <div class="card-sub">{{ t('installCcHookDesc') }}</div>
          <div v-if="ccHookStatus" class="card-sub" style="margin-top: 6px">
            {{ ccHookStatus.installed ? t('installCcHookOn') : t('installCcHookOff') }}
          </div>
          <div v-if="installCcMsg" class="field-hint" style="margin-top: 4px">{{ installCcMsg }}</div>
        </div>
        <button type="button" class="suggest-btn" :disabled="installCcBusy" @click="doInstallCcHook">
          {{ ccHookStatus && ccHookStatus.installed ? t('installCcHookReinstall') : t('installCcHookBtn') }}
        </button>
      </div>

      <!-- Master switch: does the SessionStart hook inject task/phase context? -->
      <div class="card toggle-card" @click="toggleHookContext">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('hookContextSetting') }}</div>
          <div class="card-sub">{{ t('hookContextSettingDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: hookContextEnabled }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Phases in tasks (issue #16) — UI-only flag in settings.json. -->
      <div class="card toggle-card" @click="togglePhasesEnabled">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('phasesSetting') }}</div>
          <div class="card-sub">{{ t('phasesSettingDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: phasesEnabled }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Task priority in context (issue #32) — UI-only flag in settings.json,
           read by the SessionStart hook to gate which tasks reach a session. -->
      <div class="card">
        <div class="field-label">{{ t('taskCtxPrioSetting') }}</div>
        <select
          class="field-input"
          :value="taskCtxPrio"
          @change="setTaskCtxPrio(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="lv in TASK_CTX_LEVELS" :key="lv" :value="lv">{{ taskCtxPrioLabel(lv) }}</option>
        </select>
        <div class="field-hint">{{ t('taskCtxPrioDesc') }}</div>
      </div>

      <!-- Session context (phase vs tasks) — UI-only flag in settings.json, read by
           the SessionStart hook to choose what a mid-plan session leads with. -->
      <div class="card">
        <div class="field-label">{{ t('sessionCtxSetting') }}</div>
        <select
          class="field-input"
          :value="sessionCtx"
          @change="setSessionCtx(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="m in SESSION_CTX_MODES" :key="m" :value="m">{{ sessionCtxLabel(m) }}</option>
        </select>
        <div class="field-hint">{{ t('sessionCtxDesc') }}</div>
      </div>

      <!-- Task audit schedule (#35) — daily headless audit of the task board.
           Moved here from the tasks window; the digest still shows in that window. -->
      <div class="card">
        <div class="field-label">{{ t('triageSchedule') }}</div>
        <div class="tier-row" @click="toggleSched">
          <span class="tier-name">{{ t('triageScheduleEnable') }}</span>
          <div class="toggle" :class="{ on: schedEnabled }">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div
          v-if="schedEnabled"
          class="card-row"
          style="align-items: center; gap: 10px; margin-top: 8px"
        >
          <input
            type="time"
            class="field-input"
            style="flex: 0 0 auto; width: auto"
            v-model="schedTime"
            @change="saveTriageSchedule"
          />
          <select
            class="field-input"
            style="flex: 1"
            v-model="schedModel"
            @change="saveTriageSchedule"
          >
            <option value="haiku">Haiku</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </div>
        <div class="budget-suggest" style="margin-top: 10px">
          <button type="button" class="suggest-btn" :disabled="triageRunning" @click="runTriageNow">
            {{ triageRunning ? t('triageRunning') : t('triageRunNow') }}
          </button>
          <span
            v-if="schedLastRun && !schedLastError"
            class="field-hint"
            style="margin: 0"
          >{{ t('triageLastRun', { date: schedLastRun }) }}</span>
        </div>
        <div v-if="schedLastError" class="field-hint" style="color: #f87171; margin-top: 6px">
          {{ t('triageRunFailed') }}
        </div>
      </div>

      <!-- Editable audit prompt (advanced): full control over what the audit looks
           for; an empty save / reset reverts to the shipped default. -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('triagePromptTitle') }}</div>
          <button type="button" class="suggest-btn" @click="promptOpen = !promptOpen">
            {{ promptOpen ? t('triagePromptHide') : t('triagePromptEdit') }}
          </button>
        </div>
        <div class="field-hint" style="margin-top: 6px">{{ t('triagePromptDesc') }}</div>
        <template v-if="promptOpen">
          <textarea
            v-model="triagePrompt"
            class="field-input prompt-editor"
            rows="16"
            spellcheck="false"
          ></textarea>
          <div class="budget-suggest" style="margin-top: 8px">
            <span class="field-hint" style="margin: 0">
              {{ triagePromptCustom ? t('triagePromptCustom') : t('triagePromptDefault') }}<template v-if="promptSaved"> · {{ t('triagePromptSaved') }} ✓</template>
            </span>
            <span style="display: flex; gap: 8px; flex-shrink: 0">
              <button type="button" class="suggest-btn" @click="resetTriagePrompt">{{ t('triagePromptReset') }}</button>
              <button type="button" class="suggest-btn" @click="saveTriagePrompt">{{ t('save') }}</button>
            </span>
          </div>
          <div class="field-hint" style="margin-top: 6px">{{ t('triagePromptVars') }}</div>
        </template>
      </div>

      <!-- Task-ref migration (#63): rewrite bare `#N` → `t#N`, with a backup and a
           one-click restore. `#N` now reads as a PR/issue, only `t#N` links. -->
      <div class="card">
        <div class="field-label">{{ t('migrateTitle') }}</div>
        <div class="field-hint" style="margin-top: 6px">{{ t('migrateDesc') }}</div>
        <div class="budget-suggest" style="margin-top: 10px">
          <span style="display: flex; gap: 8px; flex-shrink: 0">
            <button type="button" class="suggest-btn" :disabled="migrating" @click="runMigration">
              {{ migrating ? t('migrateRunning') : t('migrateRun') }}
            </button>
            <button
              type="button"
              class="suggest-btn"
              :disabled="restoring || !latestBackup"
              @click="runRestore"
            >
              {{ restoring ? t('migrateRestoring') : t('migrateRestore') }}
            </button>
          </span>
          <span v-if="migrateMsg" class="field-hint" style="margin: 0">{{ migrateMsg }}</span>
        </div>
        <div v-if="latestBackup" class="field-hint" style="margin-top: 6px">
          {{ t('migrateBackupAt', { date: fmtBackupTime(latestBackup.when_ms) }) }}
        </div>
      </div>
      </template>
    </div>

    <div class="settings-save-bar">
      <button type="submit" class="save-btn" :disabled="!localSessionKey || !localOrgId">
        {{ t('save') }}
      </button>
    </div>
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
}

/* Right side: scrollable cards + the save bar pinned under them. */
.settings-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* Left side: a vertical tab rail. */
.settings-tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  flex-shrink: 0;
  width: 150px;
  overflow-y: auto;
  border-right: 1px solid var(--stroke-strong);
}

.settings-tab {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
  font-family: var(--segoe);
  white-space: nowrap;
  text-align: left;
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
  /* Render native controls (e.g. the <select> dropdown list) in dark theme so
     options aren't white-on-white on Windows/WebView2. */
  color-scheme: dark;
  transition: border-color 120ms, background 120ms;
}
/* Solid background fallback for the native <option> popup (the translucent
   field background would show through as white). */
.field-input option {
  background: var(--card-bg);
  color: var(--text);
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

.settings-save-bar {
  padding: 8px 10px 12px;
  flex-shrink: 0;
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

.prompt-editor {
  margin-top: 8px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  min-height: 200px;
}
</style>
