<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import SettingsPanel from "./components/SettingsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import MiniPanel from "./components/MiniPanel.vue";
import { DEFAULT_THRESHOLDS, normalize } from "./thresholds";

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

const { t, locale } = useI18n();

const sessionKey = ref("");
const orgId = ref("");
const refreshInterval = ref(60);
const autoStartSession = ref(false);
const projectId = ref("");
const thresholds = ref<number[]>([...DEFAULT_THRESHOLDS]);
const notificationsEnabled = ref(false);
const notifyForecastMinutes = ref(30);
const quietHoursEnabled = ref(false);
const quietHoursStart = ref("23:00");
const quietHoursEnd = ref("08:00");
const usage = ref<UsageData | null>(null);
const error = ref("");
const loading = ref(false);
const showSettings = ref(false);
const autoStartStatus = ref("");
const configured = computed(() => sessionKey.value && orgId.value);

let timer: ReturnType<typeof setInterval> | null = null;
let autoStartAttempted = false;

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
        thresholds.value = normalize(await store.get<number[]>("thresholds"));
        notificationsEnabled.value =
            (await store.get<boolean>("notificationsEnabled")) ?? false;
        notifyForecastMinutes.value =
            (await store.get<number>("notifyForecastMinutes")) ?? 30;
        quietHoursEnabled.value =
            (await store.get<boolean>("quietHoursEnabled")) ?? false;
        quietHoursStart.value =
            (await store.get<string>("quietHoursStart")) ?? "23:00";
        quietHoursEnd.value =
            (await store.get<string>("quietHoursEnd")) ?? "08:00";
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
    await store.set("thresholds", thresholds.value);
    await store.set("notificationsEnabled", notificationsEnabled.value);
    await store.set("notifyForecastMinutes", notifyForecastMinutes.value);
    await store.set("quietHoursEnabled", quietHoursEnabled.value);
    await store.set("quietHoursStart", quietHoursStart.value);
    await store.set("quietHoursEnd", quietHoursEnd.value);
    await store.set("locale", locale.value);
    await store.save();
}

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
    autoStartStatus.value = "";
    return result.uuid;
}

interface StartResult {
    conversation_id: string | null;
    project_id: string;
    skipped: boolean;
    skipped_reason: string;
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
        if (result.skipped) {
            autoStartStatus.value = t("sessionAlreadyActive");
        } else {
            autoStartStatus.value = t("sessionStarted");
        }
        setTimeout(() => {
            autoStartStatus.value = "";
        }, 5000);
    } catch (e) {
        autoStartStatus.value = t("error") + ": " + String(e);
    }
}

async function fetchUsage() {
    if (!sessionKey.value || !orgId.value) return;
    loading.value = true;
    error.value = "";
    try {
        usage.value = await invoke<UsageData>("fetch_usage", {
            sessionKey: sessionKey.value,
            orgId: orgId.value,
        });

        if (usage.value) {
            await invoke("update_tray", {
                percent: usage.value.five_hour.percent_used,
                thresholds: thresholds.value,
            }).catch(() => {});
        }

        if (notificationsEnabled.value && usage.value) {
            const { checkAlerts } = await import("./alerts");
            await checkAlerts(usage.value, {
                enabled: notificationsEnabled.value,
                thresholds: thresholds.value,
                forecastMinutes: notifyForecastMinutes.value,
                quietHoursEnabled: quietHoursEnabled.value,
                quietHoursStart: quietHoursStart.value,
                quietHoursEnd: quietHoursEnd.value,
            });
        }

        if (autoStartSession.value && usage.value) {
            const fh = usage.value.five_hour;
            const sessionActive = fh.percent_used > 0 || fh.reset_at !== null;

            if (sessionActive) {
                autoStartAttempted = false;
            } else if (!autoStartAttempted) {
                autoStartAttempted = true;
                await triggerAutoStart();
            }
        }
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

function startPolling() {
    stopPolling();
    if (configured.value) {
        fetchUsage();
        timer = setInterval(fetchUsage, refreshInterval.value * 1000);
    }
}

function stopPolling() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

async function handleSave(settings: {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    thresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    locale: string;
}) {
    const wasEnabled = notificationsEnabled.value;
    sessionKey.value = settings.sessionKey;
    orgId.value = settings.orgId;
    refreshInterval.value = settings.refreshInterval;
    autoStartSession.value = settings.autoStartSession;
    thresholds.value = normalize(settings.thresholds);
    notificationsEnabled.value = settings.notificationsEnabled;
    notifyForecastMinutes.value = settings.notifyForecastMinutes;
    quietHoursEnabled.value = settings.quietHoursEnabled;
    quietHoursStart.value = settings.quietHoursStart;
    quietHoursEnd.value = settings.quietHoursEnd;
    locale.value = settings.locale;
    await saveSettings();

    if (wasEnabled && !settings.notificationsEnabled) {
        const { resetAlertState } = await import("./alerts");
        resetAlertState();
    }

    showSettings.value = false;
    startPolling();
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
    if (!isMini) {
        const { listen } = await import("@tauri-apps/api/event");
        listen("open-settings", () => {
            showSettings.value = true;
        });
    }
    await loadSettings();
    if (configured.value) {
        startPolling();
    } else {
        showSettings.value = true;
    }
});

onUnmounted(() => {
    stopPolling();
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
                    @click="fetchUsage"
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
                    @click="showSettings = !showSettings"
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
            :thresholds="thresholds"
            :notifications-enabled="notificationsEnabled"
            :notify-forecast-minutes="notifyForecastMinutes"
            :quiet-hours-enabled="quietHoursEnabled"
            :quiet-hours-start="quietHoursStart"
            :quiet-hours-end="quietHoursEnd"
            :locale="locale"
            @save="handleSave"
        />

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
                        @click="fetchUsage"
                        style="margin-top: 10px; width: 100%"
                    >
                        {{ t("retry") }}
                    </button>
                </div>
            </div>

            <UsagePanel
                v-else-if="usage"
                :usage="usage"
                :loading="loading"
                :thresholds="thresholds"
                :auto-start-enabled="autoStartSession"
                :auto-start-status="autoStartStatus"
                @refresh="fetchUsage"
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
