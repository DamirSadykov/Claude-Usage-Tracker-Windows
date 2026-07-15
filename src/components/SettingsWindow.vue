<script setup lang="ts">
// Standalone Settings window (issue #45). It is a THIN UI over SettingsPanel:
// it reads settings.json only to populate the form, and forwards saves to the
// main window via events. The main window stays the single writer of
// settings.json and the only caller of `configure`, so two windows never clobber
// each other's writes. After persisting, main emits `settings-changed` and we
// reload the form from the store.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n, type Composer } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { loadUpdaterDisplay } from "../updater";
import SettingsPanel from "./SettingsPanel.vue";
import {
    DEFAULT_THRESHOLDS,
    normalize,
    defaultAlertTiers,
    normalizeAlertTiers,
    defaultAlertTypes,
    normalizeAlertTypes,
} from "../thresholds";
import type { AlertTiers, AlertTypes } from "../thresholds";
import { applyFont, DEFAULT_FONT_ID } from "../fontSwitch";

type SettingsTab =
    | "account"
    | "limits"
    | "notifications"
    | "budget"
    | "insights"
    | "tasks"
    | "updates";

const { locale } = useI18n();

// A standalone WebView boots vue-i18n from the navigator language and never sees
// the saved locale; setting only the composer's `locale` proved unreliable here,
// so push it onto the global instance too (same fix as TodoWindow).
function applyLocale(l: string | null | undefined) {
    if (l !== "en" && l !== "ru") return;
    locale.value = l;
    (i18n.global as Composer).locale.value = l;
}

// Which tab the gear that opened us asked for (forwarded by the backend's
// `settings-open` event). Defaults to account on first paint.
const activeTab = ref<SettingsTab>("account");

// --- Settings state (mirror of App.vue; populated from settings.json) ---
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
const goalCostPerHourMax = ref<number | null>(null);
const goalErrorRateMax = ref<number | null>(null);
const serviceStatusEnabled = ref(true);
const serviceStatusInterval = ref(90);
const serviceStatusNotify = ref(true);
const memoryBloatEnabled = ref(true);
const todoNotificationsEnabled = ref(true);
const runtimeInsightsEnabled = ref(false);
const runtimeInsightKinds = ref<string[]>(["long_session", "cold_rewrites"]);
const systemInfoEnabled = ref(true);
const correctionsEnabled = ref(false);
const uiFont = ref(DEFAULT_FONT_ID);

// Budget suggestion: needs live usage, which the backend broadcasts via
// `usage-updated`. We recompute it locally (same math as App.vue) so the
// "apply suggested budget" hint works without threading it through the host.
const usageSevenDay = ref<{ percent_used: number; reset_at: string | null } | null>(null);
const suggestedBudget = ref<number | null>(null);
// Bumped whenever the main window confirms a persisted change (`settings-changed`).
// Passed to SettingsPanel so its Save button can flash "Saved ✓" on a real write.
const savedTick = ref(0);
const budgetUnit = computed<"usd" | "pct">(() => (ccAnalyticsEnabled.value ? "usd" : "pct"));
const configured = computed(() => sessionKey.value && orgId.value);

async function loadSettings() {
    try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("settings.json");
        sessionKey.value = (await store.get<string>("sessionKey")) ?? "";
        orgId.value = (await store.get<string>("orgId")) ?? "";
        refreshInterval.value = (await store.get<number>("refreshInterval")) ?? 60;
        autoStartSession.value = (await store.get<boolean>("autoStartSession")) ?? false;
        projectId.value = (await store.get<string>("projectId")) ?? "";
        const legacyThresholds = await store.get<number[]>("thresholds");
        sessionThresholds.value = normalize(
            (await store.get<number[]>("thresholdsSession")) ?? legacyThresholds,
        );
        weeklyThresholds.value = normalize(
            (await store.get<number[]>("thresholdsWeekly")) ?? legacyThresholds,
        );
        notificationsEnabled.value = (await store.get<boolean>("notificationsEnabled")) ?? false;
        notifyForecastMinutes.value = (await store.get<number>("notifyForecastMinutes")) ?? 30;
        forecastWindowMinutes.value = (await store.get<number>("forecastWindowMinutes")) ?? 60;
        alertTiers.value = normalizeAlertTiers(await store.get<Partial<AlertTiers>>("alertTiers"));
        alertTypes.value = normalizeAlertTypes(await store.get<Partial<AlertTypes>>("alertTypes"));
        quietHoursEnabled.value = (await store.get<boolean>("quietHoursEnabled")) ?? false;
        quietHoursStart.value = (await store.get<string>("quietHoursStart")) ?? "23:00";
        quietHoursEnd.value = (await store.get<string>("quietHoursEnd")) ?? "08:00";
        ccAnalyticsEnabled.value = (await store.get<boolean>("ccAnalyticsEnabled")) ?? false;
        dailyBudgetEnabled.value = (await store.get<boolean>("dailyBudgetEnabled")) ?? false;
        dailyBudget.value = (await store.get<number>("dailyBudget")) ?? 0;
        goalCostPerHourMax.value = (await store.get<number | null>("goalCostPerHourMax")) ?? null;
        goalErrorRateMax.value = (await store.get<number | null>("goalErrorRateMax")) ?? null;
        serviceStatusEnabled.value = (await store.get<boolean>("serviceStatusEnabled")) ?? true;
        serviceStatusInterval.value = (await store.get<number>("serviceStatusInterval")) ?? 90;
        serviceStatusNotify.value = (await store.get<boolean>("serviceStatusNotify")) ?? true;
        memoryBloatEnabled.value = (await store.get<boolean>("memoryBloatEnabled")) ?? true;
        todoNotificationsEnabled.value =
            (await store.get<boolean>("todoNotificationsEnabled")) ?? true;
        runtimeInsightsEnabled.value =
            (await store.get<boolean>("runtimeInsightsEnabled")) ?? false;
        {
            const rk = await store.get<string[]>("runtimeInsightKinds");
            if (Array.isArray(rk)) {
                runtimeInsightKinds.value = rk.map((k) =>
                    k === "idle_cache_gap" ? "cold_rewrites" : k,
                );
            }
        }
        systemInfoEnabled.value = (await store.get<boolean>("systemInfoEnabled")) ?? true;
        correctionsEnabled.value = (await store.get<boolean>("correctionsEnabled")) ?? false;
        applyLocale(await store.get<string>("locale"));
        uiFont.value = (await store.get<string>("uiFont")) ?? DEFAULT_FONT_ID;
        applyFont(uiFont.value);
    } catch {
        // First run — defaults stand.
    }
}

// Same extrapolation App.vue uses; recomputed whenever fresh usage arrives.
async function loadSuggestion() {
    const wk = usageSevenDay.value;
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
    if (wk.percent_used < 1) {
        suggestedBudget.value = null;
        return;
    }
    try {
        const from = new Date(end - 7 * 86400000).toISOString();
        const to = new Date().toISOString();
        const a = await invoke<{ totals: { cost: number } }>("get_analytics", { from, to });
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

// Forward a save to the main window — the single writer of settings.json and the
// only caller of `configure`. We keep the window open after saving.
async function handleSave(settings: unknown) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("settings-save", settings);
}

async function handleRuntimeChange(payload: { enabled: boolean; kinds: string[] }) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("settings-runtime-change", payload);
}

const unlisteners: Array<() => void> = [];

onMounted(async () => {
    await loadSettings();
    // The Updates tab shows app version + saved check interval; the main window's
    // initUpdater() owns periodic checking, so here we only load the display.
    void loadUpdaterDisplay();
    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
        // The gear that opened us tells which tab to show.
        await listen<string>("settings-open", (e) => {
            const tab = String(e.payload) as SettingsTab;
            activeTab.value = tab;
        }),
        // Live usage broadcast → refresh the budget suggestion.
        await listen<{ usage: { seven_day: { percent_used: number; reset_at: string | null } } }>(
            "usage-updated",
            (e) => {
                usageSevenDay.value = e.payload.usage.seven_day;
                void loadSuggestion();
            },
        ),
        // Main persisted a change (possibly ours) → reload the form so it reflects
        // the canonical on-disk state (and re-apply font/locale).
        await listen("settings-changed", () => {
            savedTick.value++;
            void loadSettings();
        }),
    );
});

onUnmounted(() => {
    unlisteners.forEach((u) => u());
});
</script>

<template>
    <div class="settings-window accent-claude">
        <SettingsPanel
            :open-tab="activeTab"
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
            :goal-cost-per-hour-max="goalCostPerHourMax"
            :goal-error-rate-max="goalErrorRateMax"
            :service-status-enabled="serviceStatusEnabled"
            :service-status-interval="serviceStatusInterval"
            :service-status-notify="serviceStatusNotify"
            :memory-bloat-enabled="memoryBloatEnabled"
            :todo-notifications-enabled="todoNotificationsEnabled"
            :system-info-enabled="systemInfoEnabled"
            :corrections-enabled="correctionsEnabled"
            :runtime-insights-enabled="runtimeInsightsEnabled"
            :runtime-insight-kinds="runtimeInsightKinds"
            :locale="locale"
            :ui-font="uiFont"
            :saved-tick="savedTick"
            @save="handleSave"
            @runtime-change="handleRuntimeChange"
        />
    </div>
</template>

<style scoped>
.settings-window {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--flyout-bg);
    color: var(--text);
}
</style>
