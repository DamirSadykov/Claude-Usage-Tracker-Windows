<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import SettingsPanel from "./components/SettingsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import MiniPanel from "./components/MiniPanel.vue";
import AnalyticsPanel from "./components/AnalyticsPanel.vue";
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

const isMini = window.location.hash === "#mini";

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

const { t, locale } = useI18n();

const sessionKey = ref("");
const orgId = ref("");
const refreshInterval = ref(60);
const autoStartSession = ref(false);
const projectId = ref("");
const sessionThresholds = ref<number[]>([...DEFAULT_THRESHOLDS]);
const weeklyThresholds = ref<number[]>([...DEFAULT_THRESHOLDS]);
const notificationsEnabled = ref(false);
const notifyForecastMinutes = ref(30);
const alertTiers = ref<AlertTiers>(defaultAlertTiers());
const alertTypes = ref<AlertTypes>(defaultAlertTypes());
const quietHoursEnabled = ref(false);
const quietHoursStart = ref("23:00");
const quietHoursEnd = ref("08:00");
const ccAnalyticsEnabled = ref(false);
const usage = ref<UsageData | null>(null);
const levels = ref<UsageLevels | null>(null);
const error = ref("");
const loading = ref(false);
const showSettings = ref(false);
const showAnalytics = ref(false);
const autoStartStatus = ref("");
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
        const savedLocale = await store.get<string>("locale");
        if (savedLocale) locale.value = savedLocale;
    } catch {
        // First run
    }
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
    await store.set("alertTiers", alertTiers.value);
    await store.set("alertTypes", alertTypes.value);
    await store.set("quietHoursEnabled", quietHoursEnabled.value);
    await store.set("quietHoursStart", quietHoursStart.value);
    await store.set("quietHoursEnd", quietHoursEnd.value);
    await store.set("ccAnalyticsEnabled", ccAnalyticsEnabled.value);
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
        quiet_hours_enabled: quietHoursEnabled.value,
        quiet_hours_start: quietHoursStart.value,
        quiet_hours_end: quietHoursEnd.value,
        alert_tiers: alertTiers.value,
        alert_types: alertTypes.value,
        cc_analytics_enabled: ccAnalyticsEnabled.value,
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

async function toast(a: AlertEvent) {
    if (!(await ensurePermission())) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    const { title, body } = localizeAlert(t, a);
    sendNotification({ title, body });
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

async function handleSave(settings: {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    sessionThresholds: number[];
    weeklyThresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    alertTiers: AlertTiers;
    alertTypes: AlertTypes;
    ccAnalyticsEnabled: boolean;
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
    quietHoursEnabled.value = settings.quietHoursEnabled;
    quietHoursStart.value = settings.quietHoursStart;
    quietHoursEnd.value = settings.quietHoursEnd;
    alertTiers.value = normalizeAlertTiers(settings.alertTiers);
    alertTypes.value = normalizeAlertTypes(settings.alertTypes);
    ccAnalyticsEnabled.value = settings.ccAnalyticsEnabled;
    locale.value = settings.locale;
    // The backend re-arms its alert engine on disable (see `configure`).
    await saveSettings();

    showSettings.value = false;
    // Analytics is unavailable once the opt-in is turned off.
    if (!ccAnalyticsEnabled.value) showAnalytics.value = false;
    await applyConfig();
}

function toggleAnalytics() {
    showAnalytics.value = !showAnalytics.value;
    if (showAnalytics.value) showSettings.value = false;
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

    await loadSettings();

    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
        await listen<{ usage: UsageData; levels: UsageLevels }>(
            "usage-updated",
            (e) => {
                usage.value = e.payload.usage;
                levels.value = e.payload.levels;
                error.value = "";
                loading.value = false;
            },
        ),
        await listen<string>("usage-error", (e) => {
            error.value = String(e.payload);
            loading.value = false;
        }),
        await listen<AlertEvent>("alert", (e) => {
            void toast(e.payload);
        }),
        await listen<string>("project-resolved", async (e) => {
            projectId.value = String(e.payload);
            await saveSettings();
        }),
        await listen<boolean>("auto-start-result", (e) => {
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
        await listen("open-settings", () => {
            showSettings.value = true;
        }),
    );

    if (configured.value) {
        await applyConfig();
    } else {
        showSettings.value = true;
    }
});

onUnmounted(() => {
    unlisteners.forEach((u) => u());
});
</script>

<template>
    <MiniPanel v-if="isMini" />
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
                <div class="app-status" v-if="usage && !showSettings">
                    <span class="dot"></span>
                    <span>{{ t("trackingActive") }}</span>
                </div>
            </div>
            <div class="fly-hd-right">
                <button
                    class="icon-btn"
                    @click="toggleMini"
                    title="Mini widget"
                    v-if="!showSettings && configured"
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
                    v-if="!showSettings && configured"
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
                    v-if="!showSettings && configured && ccAnalyticsEnabled"
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
                    @click="showSettings = !showSettings; showAnalytics = false"
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
            :alert-tiers="alertTiers"
            :alert-types="alertTypes"
            :quiet-hours-enabled="quietHoursEnabled"
            :quiet-hours-start="quietHoursStart"
            :quiet-hours-end="quietHoursEnd"
            :cc-analytics-enabled="ccAnalyticsEnabled"
            :locale="locale"
            @save="handleSave"
        />

        <!-- Analytics -->
        <AnalyticsPanel v-else-if="showAnalytics" :active="showAnalytics" />

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
                </div>
            </div>

            <UsagePanel
                v-else-if="usage && levels"
                :usage="usage"
                :levels="levels"
                :loading="loading"
                :auto-start-enabled="autoStartSession"
                :auto-start-status="autoStartStatus"
                @refresh="refresh"
                @manual-start="handleManualStart"
            />

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
