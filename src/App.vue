<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import SettingsPanel from "./components/SettingsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import MiniPanel from "./components/MiniPanel.vue";
import AnalyticsPanel from "./components/AnalyticsPanel.vue";
import AnalyticsWindow from "./components/AnalyticsWindow.vue";
import FocusControls from "./components/FocusControls.vue";
import ServiceStatusBar from "./components/ServiceStatusBar.vue";
import AboutPanel from "./components/AboutPanel.vue";
import {
    DEFAULT_THRESHOLDS,
    normalize,
    defaultAlertTiers,
    normalizeAlertTiers,
    defaultAlertTypes,
    normalizeAlertTypes,
} from "./thresholds";
import type { AlertTiers, AlertTypes } from "./thresholds";
import { localizeAlert } from "./alertFormat";
import type { AlertEvent } from "./alertFormat";
import { useUpdater, initUpdater } from "./updater";

const isMini = window.location.hash === "#mini";
const isAnalytics = window.location.hash === "#analytics";

export interface UsageTier {
    percent_used: number;
    reset_at: string | null;
    is_limited: boolean;
}

export interface ExtraUsage {
    used_credits: number;
    monthly_limit: number;
    utilization: number;
    currency: string;
}

export interface UsageData {
    five_hour: UsageTier;
    seven_day: UsageTier;
    seven_day_opus: UsageTier | null;
    seven_day_sonnet: UsageTier | null;
    extra_usage: ExtraUsage | null;
    prepaid_balance: number | null;
    prepaid_currency: string | null;
}

// Colour buckets (0..3) computed by the backend, one per tier.
export interface UsageLevels {
    five_hour: number;
    seven_day: number;
    seven_day_opus: number | null;
    seven_day_sonnet: number | null;
    extra_usage: number | null;
}

// Exhaustion forecast per tier (issue #7), computed by the backend.
export interface TierForecast {
    rate_per_hour: number;
    eta_minutes: number | null;
    allowed_per_hour: number | null;
    pace: "unknown" | "ok" | "warn";
    coverage_hours: number;
}

export interface ForecastData {
    five_hour: TierForecast;
    seven_day: TierForecast;
    extra_usage: TierForecast | null;
}

const { t, locale } = useI18n();

const {
    status: updateStatus,
    availableVersion,
    progress: updateProgress,
    installUpdate,
    relaunchApp,
    dismissUpdate,
} = useUpdater();

const sessionKey = ref("");
const orgId = ref("");
const refreshInterval = ref(60);
const autoStartSession = ref(false);
const projectId = ref("");
const sessionThresholds = ref<number[]>([...DEFAULT_THRESHOLDS]);
const weeklyThresholds = ref<number[]>([...DEFAULT_THRESHOLDS]);
const notificationsEnabled = ref(false);
const notifyForecastMinutes = ref(30);
const forecastWindowMinutes = ref(60);
const alertTiers = ref<AlertTiers>(defaultAlertTiers());
const alertTypes = ref<AlertTypes>(defaultAlertTypes());
const quietHoursEnabled = ref(false);
const quietHoursStart = ref("23:00");
const quietHoursEnd = ref("08:00");
const ccAnalyticsEnabled = ref(false);
const dailyBudgetEnabled = ref(false);
const dailyBudget = ref(0);
const notificationsMutedUntil = ref<string | null>(null);
const serviceStatusEnabled = ref(true);
const serviceStatusInterval = ref(90);
const serviceStatusNotify = ref(true);
const runtimeInsightsEnabled = ref(false);
const runtimeInsightKinds = ref<string[]>(["long_session", "cold_rewrites"]);
const systemInfoEnabled = ref(true);
const todaySpent = ref<number | null>(null);
const suggestedBudget = ref<number | null>(null);
const budgetUnit = computed<"usd" | "pct">(() =>
    ccAnalyticsEnabled.value ? "usd" : "pct",
);
const usage = ref<UsageData | null>(null);
const levels = ref<UsageLevels | null>(null);
const forecast = ref<ForecastData | null>(null);
const sessionActive = computed(() => {
    const fh = usage.value?.five_hour;
    if (!fh) return false;
    return fh.percent_used > 0 || fh.reset_at !== null;
});
const error = ref("");
const errorReportable = ref(false);
const loading = ref(false);
const showSettings = ref(false);
const showAbout = ref(false);

interface DiagReport {
    kind: string;
    summary: string;
    detail: string;
    version: string;
    os: string;
    at: string;
}
// A pending diagnostic report (a crash from the previous run, or a frontend
// error this session). Surfaced as a banner offering to file a GitHub issue.
const diag = ref<DiagReport | null>(null);
const showAnalytics = ref(false);
const autoStartStatus = ref("");
let autoStartTimer: ReturnType<typeof setInterval> | null = null;
function stopAutoStartTimer() {
    if (autoStartTimer) {
        clearInterval(autoStartTimer);
        autoStartTimer = null;
    }
}
function startAutoStartCountdown(firesAtMs: number, attempt: number) {
    stopAutoStartTimer();
    const tick = () => {
        const remaining = Math.max(0, Math.ceil((firesAtMs - Date.now()) / 1000));
        if (remaining === 0) {
            stopAutoStartTimer();
            autoStartStatus.value = t("checkingSession");
            return;
        }
        const prefix =
            attempt > 1
                ? t("autoStartRetryIn", { n: attempt })
                : t("autoStartIn");
        autoStartStatus.value = `${prefix} ${remaining}${t("secondsShort")}`;
    };
    tick();
    autoStartTimer = setInterval(tick, 500);
}
const configured = computed(() => sessionKey.value && orgId.value);

const unlisteners: Array<() => void> = [];
let permissionOk: boolean | null = null;

async function loadSettings() {
    try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("settings.json");
        sessionKey.value = (await store.get<string>("sessionKey")) ?? "";
        orgId.value = (await store.get<string>("orgId")) ?? "";
        refreshInterval.value =
            (await store.get<number>("refreshInterval")) ?? 60;
        autoStartSession.value =
            (await store.get<boolean>("autoStartSession")) ?? false;
        projectId.value = (await store.get<string>("projectId")) ?? "";
        const legacyThresholds = await store.get<number[]>("thresholds");
        sessionThresholds.value = normalize(
            (await store.get<number[]>("thresholdsSession")) ?? legacyThresholds,
        );
        weeklyThresholds.value = normalize(
            (await store.get<number[]>("thresholdsWeekly")) ?? legacyThresholds,
        );
        notificationsEnabled.value =
            (await store.get<boolean>("notificationsEnabled")) ?? false;
        notifyForecastMinutes.value =
            (await store.get<number>("notifyForecastMinutes")) ?? 30;
        forecastWindowMinutes.value =
            (await store.get<number>("forecastWindowMinutes")) ?? 60;
        alertTiers.value = normalizeAlertTiers(
            await store.get<Partial<AlertTiers>>("alertTiers"),
        );
        alertTypes.value = normalizeAlertTypes(
            await store.get<Partial<AlertTypes>>("alertTypes"),
        );
        quietHoursEnabled.value =
            (await store.get<boolean>("quietHoursEnabled")) ?? false;
        quietHoursStart.value =
            (await store.get<string>("quietHoursStart")) ?? "23:00";
        quietHoursEnd.value =
            (await store.get<string>("quietHoursEnd")) ?? "08:00";
        ccAnalyticsEnabled.value =
            (await store.get<boolean>("ccAnalyticsEnabled")) ?? false;
        dailyBudgetEnabled.value =
            (await store.get<boolean>("dailyBudgetEnabled")) ?? false;
        dailyBudget.value = (await store.get<number>("dailyBudget")) ?? 0;
        notificationsMutedUntil.value =
            (await store.get<string>("notificationsMutedUntil")) ?? null;
        serviceStatusEnabled.value =
            (await store.get<boolean>("serviceStatusEnabled")) ?? true;
        serviceStatusInterval.value =
            (await store.get<number>("serviceStatusInterval")) ?? 90;
        serviceStatusNotify.value =
            (await store.get<boolean>("serviceStatusNotify")) ?? true;
        runtimeInsightsEnabled.value =
            (await store.get<boolean>("runtimeInsightsEnabled")) ?? false;
        {
            const rk = await store.get<string[]>("runtimeInsightKinds");
            // Migrate the pre-release kind name idle_cache_gap → cold_rewrites so
            // a settings.json written before the rename keeps its runtime toggle.
            if (Array.isArray(rk)) {
                runtimeInsightKinds.value = rk.map((k) =>
                    k === "idle_cache_gap" ? "cold_rewrites" : k,
                );
            }
        }
        systemInfoEnabled.value =
            (await store.get<boolean>("systemInfoEnabled")) ?? true;
        const savedLocale = await store.get<string>("locale");
        if (savedLocale) locale.value = savedLocale;
    } catch {
        // First run
    }
}

const pinned = ref(false);
async function togglePin() {
    pinned.value = !pinned.value;
    await invoke("set_pin", { pinned: pinned.value });
}

async function saveSettings() {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("settings.json");
    await store.set("sessionKey", sessionKey.value);
    await store.set("orgId", orgId.value);
    await store.set("refreshInterval", refreshInterval.value);
    await store.set("autoStartSession", autoStartSession.value);
    await store.set("projectId", projectId.value);
    await store.set("thresholdsSession", sessionThresholds.value);
    await store.set("thresholdsWeekly", weeklyThresholds.value);
    await store.set("notificationsEnabled", notificationsEnabled.value);
    await store.set("notifyForecastMinutes", notifyForecastMinutes.value);
    await store.set("forecastWindowMinutes", forecastWindowMinutes.value);
    await store.set("alertTiers", alertTiers.value);
    await store.set("alertTypes", alertTypes.value);
    await store.set("quietHoursEnabled", quietHoursEnabled.value);
    await store.set("quietHoursStart", quietHoursStart.value);
    await store.set("quietHoursEnd", quietHoursEnd.value);
    await store.set("ccAnalyticsEnabled", ccAnalyticsEnabled.value);
    await store.set("dailyBudgetEnabled", dailyBudgetEnabled.value);
    await store.set("dailyBudget", dailyBudget.value);
    await store.set("notificationsMutedUntil", notificationsMutedUntil.value);
    await store.set("serviceStatusEnabled", serviceStatusEnabled.value);
    await store.set("serviceStatusInterval", serviceStatusInterval.value);
    await store.set("serviceStatusNotify", serviceStatusNotify.value);
    await store.set("runtimeInsightsEnabled", runtimeInsightsEnabled.value);
    await store.set("runtimeInsightKinds", [...runtimeInsightKinds.value]);
    await store.set("systemInfoEnabled", systemInfoEnabled.value);
    await store.set("locale", locale.value);
    await store.save();
}

// Push the current settings to the Rust polling loop. The backend owns the
// fetch cadence, tray updates and alerting; the frontend only configures it.
function buildConfig() {
    return {
        session_key: sessionKey.value,
        org_id: orgId.value,
        refresh_interval: refreshInterval.value,
        auto_start_session: autoStartSession.value,
        project_id: projectId.value,
        session_thresholds: normalize(sessionThresholds.value),
        weekly_thresholds: normalize(weeklyThresholds.value),
        notifications_enabled: notificationsEnabled.value,
        forecast_minutes: notifyForecastMinutes.value,
        forecast_window_min: forecastWindowMinutes.value,
        quiet_hours_enabled: quietHoursEnabled.value,
        quiet_hours_start: quietHoursStart.value,
        quiet_hours_end: quietHoursEnd.value,
        alert_tiers: alertTiers.value,
        alert_types: alertTypes.value,
        cc_analytics_enabled: ccAnalyticsEnabled.value,
        daily_budget_enabled: dailyBudgetEnabled.value,
        daily_budget: dailyBudget.value,
        notifications_muted_until: notificationsMutedUntil.value,
        service_status_enabled: serviceStatusEnabled.value,
        service_status_interval: serviceStatusInterval.value,
        service_status_notify: serviceStatusNotify.value,
        runtime_insights_enabled: runtimeInsightsEnabled.value,
        runtime_insight_kinds: [...runtimeInsightKinds.value],
        system_info_enabled: systemInfoEnabled.value,
    };
}

async function applyConfig() {
    if (!configured.value) return;
    loading.value = true;
    await invoke("configure", { config: buildConfig() });
}

async function ensurePermission(): Promise<boolean> {
    if (permissionOk !== null) return permissionOk;
    const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permissionOk = granted;
    return granted;
}

async function notify(title: string, body: string) {
    if (!(await ensurePermission())) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
}

async function toast(a: AlertEvent) {
    const { title, body } = localizeAlert(t, a);
    await notify(title, body);
}

// Service-status notifications come pre-decided by the backend (status change /
// new incident); we only localize the wrapper title here.
async function serviceToast(a: { kind: string; text: string }) {
    const title =
        a.kind === "resolved"
            ? t("statusToastResolved")
            : a.kind === "incident"
              ? t("statusToastIncident")
              : t("statusToastDegraded");
    await notify(title, a.text);
}

// Consumption since local midnight, in the unit implied by ccAnalyticsEnabled
// ($ from CC analytics, else % of the weekly limit). Uses existing commands.
async function loadTodaySpent() {
    if (!dailyBudgetEnabled.value || !configured.value) {
        todaySpent.value = null;
        return;
    }
    const from = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const to = new Date().toISOString();
    try {
        if (ccAnalyticsEnabled.value) {
            const a = await invoke<{ totals: { cost: number } }>("get_analytics", {
                from,
                to,
            });
            todaySpent.value = a.totals.cost;
        } else {
            const snaps = await invoke<Array<{ seven_day_pct: number }>>(
                "get_usage_snapshots",
                { from, to },
            );
            const current = usage.value?.seven_day.percent_used ?? 0;
            const baseline = snaps.length ? snaps[0].seven_day_pct : current;
            todaySpent.value = Math.max(0, current - baseline);
        }
    } catch {
        todaySpent.value = null;
    }
}

// Exhaustion forecast for the usage cards. Recomputed each poll over the
// configured averaging window; the backend reads the latest snapshot.
async function loadForecast() {
    if (!configured.value) {
        forecast.value = null;
        return;
    }
    try {
        forecast.value = await invoke<ForecastData>("get_forecast", {
            windowMin: forecastWindowMinutes.value,
        });
    } catch {
        forecast.value = null;
    }
}

async function setMute(until: string | null) {
    notificationsMutedUntil.value = until;
    await saveSettings();
    await applyConfig();
}

// Daily budget that would spread the remaining weekly limit evenly until reset
// (instead of burning it in one day). In % mode it's the leftover weekly % over
// the days left; in $ mode we extrapolate the weekly $ ceiling from this week's
// spend vs the weekly %, then spread the remainder.
async function loadSuggestion() {
    const wk = usage.value?.seven_day;
    if (!configured.value || !wk?.reset_at) {
        suggestedBudget.value = null;
        return;
    }
    const end = new Date(wk.reset_at).getTime();
    const daysLeft = (end - Date.now()) / 86400000;
    if (daysLeft <= 0) {
        suggestedBudget.value = null;
        return;
    }
    if (budgetUnit.value === "pct") {
        suggestedBudget.value = Math.max(100 - wk.percent_used, 0) / daysLeft;
        return;
    }
    // $ mode: need enough weekly usage to extrapolate a ceiling reliably.
    if (wk.percent_used < 1) {
        suggestedBudget.value = null;
        return;
    }
    try {
        const from = new Date(end - 7 * 86400000).toISOString();
        const to = new Date().toISOString();
        const a = await invoke<{ totals: { cost: number } }>("get_analytics", {
            from,
            to,
        });
        const weekCost = a.totals.cost;
        if (weekCost <= 0) {
            suggestedBudget.value = null;
            return;
        }
        const ceiling = weekCost / (wk.percent_used / 100);
        suggestedBudget.value = Math.max(ceiling - weekCost, 0) / daysLeft;
    } catch {
        suggestedBudget.value = null;
    }
}

async function refresh() {
    if (!configured.value) return;
    loading.value = true;
    await invoke("refresh_now");
}

// Manual "Start session" button (auto-start is handled by the backend loop).
async function ensureProject(): Promise<string> {
    if (projectId.value) return projectId.value;
    autoStartStatus.value = t("creatingProject");
    const result = await invoke<{ uuid: string; name: string }>(
        "ensure_project",
        {
            sessionKey: sessionKey.value,
            orgId: orgId.value,
        },
    );
    projectId.value = result.uuid;
    await saveSettings();
    await applyConfig();
    autoStartStatus.value = "";
    return result.uuid;
}

interface StartResult {
    conversation_id: string | null;
    project_id: string;
    skipped: boolean;
    reason: string;
}

async function triggerAutoStart() {
    try {
        const pid = await ensureProject();
        autoStartStatus.value = t("checkingSession");
        const result = await invoke<StartResult>("start_session", {
            sessionKey: sessionKey.value,
            orgId: orgId.value,
            projectId: pid,
        });
        autoStartStatus.value = result.skipped
            ? t("sessionAlreadyActive")
            : t("sessionStarted");
        setTimeout(() => {
            autoStartStatus.value = "";
        }, 5000);
    } catch (e) {
        autoStartStatus.value = t("error") + ": " + String(e);
    }
}

// --- Diagnostics / "Report a problem" ---

async function reportProblem() {
    try {
        await invoke("report_issue");
    } catch (e) {
        console.error("report_issue failed", e);
    }
}

async function openLog() {
    try {
        await invoke("open_log_dir");
    } catch (e) {
        console.error("open_log_dir failed", e);
    }
}

async function dismissDiag() {
    diag.value = null;
    try {
        await invoke("dismiss_diag");
    } catch {
        /* not under Tauri */
    }
}

async function handleSave(settings: {
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
    serviceStatusEnabled: boolean;
    serviceStatusInterval: number;
    serviceStatusNotify: boolean;
    systemInfoEnabled: boolean;
    locale: string;
}) {
    sessionKey.value = settings.sessionKey;
    orgId.value = settings.orgId;
    refreshInterval.value = settings.refreshInterval;
    autoStartSession.value = settings.autoStartSession;
    sessionThresholds.value = normalize(settings.sessionThresholds);
    weeklyThresholds.value = normalize(settings.weeklyThresholds);
    notificationsEnabled.value = settings.notificationsEnabled;
    notifyForecastMinutes.value = settings.notifyForecastMinutes;
    forecastWindowMinutes.value = settings.forecastWindowMinutes;
    quietHoursEnabled.value = settings.quietHoursEnabled;
    quietHoursStart.value = settings.quietHoursStart;
    quietHoursEnd.value = settings.quietHoursEnd;
    alertTiers.value = normalizeAlertTiers(settings.alertTiers);
    alertTypes.value = normalizeAlertTypes(settings.alertTypes);
    ccAnalyticsEnabled.value = settings.ccAnalyticsEnabled;
    dailyBudgetEnabled.value = settings.dailyBudgetEnabled;
    dailyBudget.value = settings.dailyBudget;
    serviceStatusEnabled.value = settings.serviceStatusEnabled;
    serviceStatusInterval.value = settings.serviceStatusInterval;
    serviceStatusNotify.value = settings.serviceStatusNotify;
    systemInfoEnabled.value = settings.systemInfoEnabled;
    locale.value = settings.locale;
    // The backend re-arms its alert engine on disable (see `configure`).
    await saveSettings();

    showSettings.value = false;
    // Analytics is unavailable once the opt-in is turned off.
    if (!ccAnalyticsEnabled.value) showAnalytics.value = false;
    await applyConfig();
    await loadTodaySpent();
    await loadForecast();
}

// Runtime-insight settings save immediately (table checkboxes), so reconfigure
// the backend on the spot rather than waiting for the Save button.
async function handleRuntimeChange(payload: { enabled: boolean; kinds: string[] }) {
    runtimeInsightsEnabled.value = payload.enabled;
    runtimeInsightKinds.value = [...payload.kinds];
    await saveSettings();
    if (configured.value) await applyConfig();
}

function toggleAnalytics() {
    showAnalytics.value = !showAnalytics.value;
    if (showAnalytics.value) {
        showSettings.value = false;
        showAbout.value = false;
    }
}

function toggleAbout() {
    showAbout.value = !showAbout.value;
    if (showAbout.value) {
        showSettings.value = false;
        showAnalytics.value = false;
    }
}

async function handleManualStart() {
    await triggerAutoStart();
}

async function toggleMini() {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const mini = await WebviewWindow.getByLabel("mini");
    if (!mini) return;
    if (await mini.isVisible()) {
        await mini.hide();
    } else {
        await mini.show();
        await mini.setFocus();
    }
}

onMounted(async () => {
    if (isMini) return; // the mini window self-initializes via MiniPanel
    if (isAnalytics) return; // the analytics window has its own init flow

    await loadSettings();

    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
        await listen<{ usage: UsageData; levels: UsageLevels }>(
            "usage-updated",
            (e) => {
                usage.value = e.payload.usage;
                levels.value = e.payload.levels;
                error.value = "";
                errorReportable.value = false;
                loading.value = false;
                void loadTodaySpent();
                void loadSuggestion();
                void loadForecast();
            },
        ),
        await listen<{ message: string; reportable: boolean }>(
            "usage-error",
            (e) => {
                error.value = String(e.payload?.message ?? e.payload);
                errorReportable.value = e.payload?.reportable ?? false;
                loading.value = false;
            },
        ),
        await listen<AlertEvent>("alert", (e) => {
            void toast(e.payload);
        }),
        await listen<{ kind: string; indicator: string; text: string }>(
            "service-alert",
            (e) => {
                void serviceToast(e.payload);
            },
        ),
        await listen<string>("project-resolved", async (e) => {
            projectId.value = String(e.payload);
            await saveSettings();
        }),
        await listen<boolean>("auto-start-result", (e) => {
            stopAutoStartTimer();
            autoStartStatus.value = e.payload
                ? t("sessionAlreadyActive")
                : t("sessionStarted");
            setTimeout(() => {
                autoStartStatus.value = "";
            }, 5000);
        }),
        await listen<string>("auto-start-error", (e) => {
            autoStartStatus.value = t("error") + ": " + String(e.payload);
        }),
        await listen<{ fires_at_ms: number; attempt: number; countdown_secs: number }>(
            "auto-start-pending",
            (e) => {
                startAutoStartCountdown(e.payload.fires_at_ms, e.payload.attempt);
            },
        ),
        await listen<{ reason: string }>("auto-start-cancelled", (e) => {
            stopAutoStartTimer();
            if (e.payload.reason === "max-attempts") {
                autoStartStatus.value = t("autoStartGaveUp");
                setTimeout(() => {
                    autoStartStatus.value = "";
                }, 5000);
            } else {
                autoStartStatus.value = "";
            }
        }),
        await listen("open-settings", () => {
            showSettings.value = true;
        }),
    );

    if (configured.value) {
        await applyConfig();
    } else {
        showSettings.value = true;
    }

    // Surface a diagnostic report left by a crash on the previous run (or a
    // frontend error), offering to file a pre-filled GitHub issue.
    try {
        diag.value = await invoke<DiagReport | null>("get_last_diag");
    } catch {
        /* not under Tauri */
    }

    void initUpdater();
});

onUnmounted(() => {
    unlisteners.forEach((u) => u());
});
</script>

<template>
    <MiniPanel v-if="isMini" />
    <AnalyticsWindow v-else-if="isAnalytics" />
    <div v-else class="flyout accent-claude">
        <!-- Header -->
        <div class="fly-hd">
            <div class="fly-hd-left">
                <div class="app-pick">
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                    >
                        <circle cx="8" cy="8" r="6" />
                    </svg>
                    Claude Usage
                </div>
            </div>
            <div class="fly-hd-right">
                <button
                    class="icon-btn"
                    @click="toggleMini"
                    title="Mini widget"
                    v-if="!showSettings && !showAbout && configured"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="1" y="5" width="14" height="8" rx="2" stroke-linecap="round"/>
                        <line x1="5" y1="9" x2="11" y2="9" stroke-linecap="round"/>
                    </svg>
                </button>
                <button
                    class="icon-btn"
                    :class="{ spin: loading }"
                    @click="refresh"
                    :title="t('refresh')"
                    v-if="!showSettings && !showAbout && configured"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                    >
                        <path d="M14 8A6 6 0 1 1 8 2" stroke-linecap="round" />
                        <path
                            d="M8 2 L11 2 L8 5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
                <button
                    class="icon-btn"
                    :class="{ active: showAnalytics }"
                    @click="toggleAnalytics"
                    :title="t('analytics')"
                    v-if="!showSettings && !showAbout && configured && ccAnalyticsEnabled"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2 14V2" stroke-linecap="round"/>
                        <path d="M2 14h12" stroke-linecap="round"/>
                        <rect x="4" y="8" width="2.5" height="4" rx="0.5"/>
                        <rect x="7.5" y="5" width="2.5" height="7" rx="0.5"/>
                        <rect x="11" y="9" width="2.5" height="3" rx="0.5"/>
                    </svg>
                </button>
                <button
                    class="icon-btn"
                    :class="{ 'pin-on': pinned }"
                    @click="togglePin"
                    :title="pinned ? t('pinOn') : t('pin')"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 17v5" />
                        <path d="M9 10.76V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.76a2 2 0 0 0 .59 1.42l1.12 1.12A1 1 0 0 1 17 15H7a1 1 0 0 1-.71-1.7l1.12-1.12A2 2 0 0 0 9 10.76Z" />
                    </svg>
                </button>
                <button
                    class="icon-btn"
                    :class="{ active: showAbout }"
                    @click="toggleAbout"
                    :title="t('about')"
                    v-if="!showSettings"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="8" cy="8" r="6.5" />
                        <line x1="8" y1="7.3" x2="8" y2="11.5" stroke-linecap="round" />
                        <circle cx="8" cy="4.7" r="0.5" fill="currentColor" stroke="none" />
                    </svg>
                </button>
                <button
                    class="icon-btn"
                    @click="showSettings = !showSettings; showAnalytics = false; showAbout = false"
                    :title="showSettings ? t('back') : t('settings')"
                >
                    <svg
                        v-if="!showSettings"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                    >
                        <path
                            fill="#e2e8f0"
                            d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l-.38 2.65c-.03.24.18.42.43.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3-1.07-3-3.5s1.07-3.5 3-3.5 3 1.07 3 3.5-1.07 3.5-3 3.5z"
                        />
                    </svg>
                    <svg
                        v-else
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                    >
                        <path
                            d="M10 3L5 8l5 5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
            </div>
        </div>

        <div class="hr"></div>

        <!-- Status tray: Claude service health + 5h session activity -->
        <ServiceStatusBar
            v-if="usage && !showSettings && !showAbout && (serviceStatusEnabled || sessionActive)"
            :service-enabled="serviceStatusEnabled"
            :session-active="sessionActive"
        />

        <!-- Update banner -->
        <div
            v-if="updateStatus === 'available'"
            class="update-banner"
        >
            <span class="update-text">{{
                t("updateAvailable", { version: availableVersion })
            }}</span>
            <div class="update-actions">
                <button class="update-btn ghost" @click="dismissUpdate">
                    {{ t("updateLater") }}
                </button>
                <button class="update-btn" @click="installUpdate">
                    {{ t("updateNow") }}
                </button>
            </div>
        </div>
        <div
            v-else-if="updateStatus === 'downloading'"
            class="update-banner"
        >
            <span class="update-text">{{
                t("updateDownloading", { pct: updateProgress })
            }}</span>
            <div class="update-progress">
                <div
                    class="update-progress-fill"
                    :style="{ width: updateProgress + '%' }"
                ></div>
            </div>
        </div>
        <div
            v-else-if="updateStatus === 'ready'"
            class="update-banner"
        >
            <span class="update-text">{{ t("updateReady") }}</span>
            <div class="update-actions">
                <button class="update-btn" @click="relaunchApp">
                    {{ t("restartNow") }}
                </button>
            </div>
        </div>

        <!-- Diagnostic / crash report banner -->
        <div v-if="diag" class="diag-banner">
            <span class="diag-text">
                {{ diag.kind === "panic" ? t("diagCrashed") : t("diagProblem") }}
            </span>
            <div class="diag-actions">
                <button class="diag-btn ghost" @click="openLog">
                    {{ t("openLog") }}
                </button>
                <button class="diag-btn ghost" @click="dismissDiag">
                    {{ t("dismiss") }}
                </button>
                <button class="diag-btn" @click="reportProblem">
                    {{ t("reportIssue") }}
                </button>
            </div>
        </div>

        <!-- Settings -->
        <SettingsPanel
            v-if="showSettings"
            :session-key="sessionKey"
            :org-id="orgId"
            :refresh-interval="refreshInterval"
            :auto-start-session="autoStartSession"
            :session-thresholds="sessionThresholds"
            :weekly-thresholds="weeklyThresholds"
            :notifications-enabled="notificationsEnabled"
            :notify-forecast-minutes="notifyForecastMinutes"
            :forecast-window-minutes="forecastWindowMinutes"
            :alert-tiers="alertTiers"
            :alert-types="alertTypes"
            :quiet-hours-enabled="quietHoursEnabled"
            :quiet-hours-start="quietHoursStart"
            :quiet-hours-end="quietHoursEnd"
            :cc-analytics-enabled="ccAnalyticsEnabled"
            :daily-budget-enabled="dailyBudgetEnabled"
            :daily-budget="dailyBudget"
            :suggested-budget="suggestedBudget"
            :service-status-enabled="serviceStatusEnabled"
            :service-status-interval="serviceStatusInterval"
            :service-status-notify="serviceStatusNotify"
            :system-info-enabled="systemInfoEnabled"
            :runtime-insights-enabled="runtimeInsightsEnabled"
            :runtime-insight-kinds="runtimeInsightKinds"
            :locale="locale"
            @save="handleSave"
            @runtime-change="handleRuntimeChange"
        />

        <!-- Analytics -->
        <AnalyticsPanel v-else-if="showAnalytics" :active="showAnalytics" />

        <!-- About / What's new -->
        <AboutPanel v-else-if="showAbout" />

        <!-- Usage -->
        <template v-else>
            <div
                v-if="!configured"
                class="cards"
                style="padding: 32px 14px; text-align: center"
            >
                <p style="color: var(--text-3); font-size: 13px">
                    {{ t("configureClaude") }}
                </p>
                <button
                    class="btn-primary"
                    @click="showSettings = true"
                    style="margin-top: 12px"
                >
                    {{ t("configure") }}
                </button>
            </div>

            <div v-else-if="error" class="cards">
                <div
                    class="card"
                    style="border-color: rgba(248, 113, 113, 0.3)"
                >
                    <p
                        style="
                            font-size: 12px;
                            color: #f87171;
                            word-break: break-all;
                        "
                    >
                        {{ error }}
                    </p>
                    <button
                        class="btn-secondary"
                        @click="refresh"
                        style="margin-top: 10px; width: 100%"
                    >
                        {{ t("retry") }}
                    </button>
                    <button
                        v-if="errorReportable"
                        class="btn-secondary"
                        @click="reportProblem"
                        style="margin-top: 8px; width: 100%"
                    >
                        {{ t("reportIssue") }}
                    </button>
                    <button
                        v-if="errorReportable"
                        class="link-btn"
                        @click="openLog"
                        style="margin-top: 8px"
                    >
                        {{ t("openLog") }}
                    </button>
                </div>
            </div>

            <template v-else-if="usage && levels">
                <UsagePanel
                    :usage="usage"
                    :levels="levels"
                    :forecast="forecast"
                    :loading="loading"
                    :auto-start-enabled="autoStartSession"
                    :auto-start-status="autoStartStatus"
                    :daily-budget-enabled="dailyBudgetEnabled"
                    :daily-budget="dailyBudget"
                    :today-spent="todaySpent"
                    :budget-unit="budgetUnit"
                    @refresh="refresh"
                    @manual-start="handleManualStart"
                />
                <FocusControls
                    :muted-until="notificationsMutedUntil"
                    @mute="setMute"
                    @notify="notify"
                />
            </template>

            <div
                v-else
                class="cards"
                style="padding: 40px 14px; text-align: center"
            >
                <div class="spinner"></div>
                <p
                    style="
                        color: var(--text-3);
                        font-size: 13px;
                        margin-top: 12px;
                    "
                >
                    {{ t("loading") }}
                </p>
            </div>
        </template>
    </div>
</template>

<style scoped>
.update-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 12px;
    margin: 8px 10px 0;
    border: 1px solid var(--accent);
    border-radius: var(--card-radius);
    background: rgba(217, 119, 87, 0.12);
}

.update-text {
    font-size: 12px;
    color: var(--text-2);
}

.update-actions {
    display: flex;
    gap: 6px;
}

.update-btn {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: white;
    font-size: 12px;
    font-weight: 500;
    font-family: var(--segoe);
    cursor: pointer;
    transition: filter 120ms;
}

.update-btn:hover {
    filter: brightness(1.15);
}

.update-btn.ghost {
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--stroke-strong);
}

.update-progress {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--stroke-strong);
    overflow: hidden;
}

.update-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 150ms;
}

/* Diagnostic / crash report banner — red-tinted variant of the update banner. */
.diag-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 12px;
    margin: 8px 10px 0;
    border: 1px solid rgba(248, 113, 113, 0.5);
    border-radius: var(--card-radius);
    background: rgba(248, 113, 113, 0.12);
}

.diag-text {
    font-size: 12px;
    color: var(--text-2);
}

.diag-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.diag-btn {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    background: #f87171;
    color: white;
    font-size: 12px;
    font-weight: 500;
    font-family: var(--segoe);
    cursor: pointer;
    transition: filter 120ms;
}

.diag-btn:hover {
    filter: brightness(1.15);
}

.diag-btn.ghost {
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--stroke-strong);
}

.link-btn {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
    font-family: var(--segoe);
}

.link-btn:hover {
    color: var(--text-2);
}
</style>
