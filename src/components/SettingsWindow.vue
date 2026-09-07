<script setup lang="ts">
// Standalone Settings window (issue #45). It is a THIN UI over SettingsPanel:
// it reads settings.json only to populate the form, and forwards saves to the
// main window via events. The main window stays the single writer of
// settings.json and the only caller of `configure`, so two windows never clobber
// each other's writes. After persisting, main emits `settings-changed` and we
// reload the form from the store.
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useI18n, type Composer } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { loadUpdaterDisplay } from "../updater";
import { useSettings } from "../settingsStore";
import SettingsPanel from "./SettingsPanel.vue";
import { applyFont } from "../fontSwitch";

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

// All settings reads flow through the shared read-only layer: one schema, one set
// of defaults, auto-refreshed on the main window's `settings-changed`. This window
// never writes the store — saves are forwarded to the main window below.
const { settings, initSettings } = useSettings();

// Budget suggestion: needs live usage, which the backend broadcasts via
// `usage-updated`. We recompute it locally (same math as App.vue) so the
// "apply suggested budget" hint works without threading it through the host.
const usageSevenDay = ref<{ percent_used: number; reset_at: string | null } | null>(null);
const suggestedBudget = ref<number | null>(null);
// Bumped whenever the main window confirms a persisted change (`settings-changed`).
// Passed to SettingsPanel so its Save button can flash "Saved ✓" on a real write.
const savedTick = ref(0);
const budgetUnit = computed<"usd" | "pct">(() =>
    settings.value.ccAnalyticsEnabled ? "usd" : "pct",
);
const configured = computed(() => settings.value.sessionKey && settings.value.orgId);

// Side-effects that must follow the snapshot (the layer only carries data): apply
// the persisted font + locale on first load and on every `settings-changed` refresh.
watch(
    () => settings.value.uiFont,
    (f) => applyFont(f),
);
watch(
    () => settings.value.locale,
    (l) => applyLocale(l),
);

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
    await initSettings();
    // Apply the persisted font/locale once on load. The watchers above only fire on
    // a CHANGE from the previous value, so a first read that equals the default
    // wouldn't trigger them — apply explicitly here to cover that case.
    applyFont(settings.value.uiFont);
    applyLocale(settings.value.locale);
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
        // Main persisted a change (possibly ours). The shared layer refreshes the
        // snapshot on this same event; here we only tick the save-confirmation
        // signal so the panel's Save button can flash "Saved ✓".
        await listen("settings-changed", () => {
            savedTick.value++;
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
            :session-key="settings.sessionKey"
            :org-id="settings.orgId"
            :refresh-interval="settings.refreshInterval"
            :auto-start-session="settings.autoStartSession"
            :session-thresholds="settings.sessionThresholds"
            :weekly-thresholds="settings.weeklyThresholds"
            :notifications-enabled="settings.notificationsEnabled"
            :notify-forecast-minutes="settings.notifyForecastMinutes"
            :forecast-window-minutes="settings.forecastWindowMinutes"
            :alert-tiers="settings.alertTiers"
            :alert-types="settings.alertTypes"
            :quiet-hours-enabled="settings.quietHoursEnabled"
            :quiet-hours-start="settings.quietHoursStart"
            :quiet-hours-end="settings.quietHoursEnd"
            :cc-analytics-enabled="settings.ccAnalyticsEnabled"
            :daily-budget-enabled="settings.dailyBudgetEnabled"
            :daily-budget="settings.dailyBudget"
            :suggested-budget="suggestedBudget"
            :goal-cost-per-hour-max="settings.goalCostPerHourMax"
            :goal-error-rate-max="settings.goalErrorRateMax"
            :service-status-enabled="settings.serviceStatusEnabled"
            :service-status-interval="settings.serviceStatusInterval"
            :service-status-notify="settings.serviceStatusNotify"
            :memory-bloat-enabled="settings.memoryBloatEnabled"
            :todo-notifications-enabled="settings.todoNotificationsEnabled"
            :system-info-enabled="settings.systemInfoEnabled"
            :corrections-enabled="settings.correctionsEnabled"
            :runtime-insights-enabled="settings.runtimeInsightsEnabled"
            :runtime-insight-kinds="settings.runtimeInsightKinds"
            :locale="locale"
            :ui-font="settings.uiFont"
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
