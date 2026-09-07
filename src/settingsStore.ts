import { ref } from "vue";
import type { Ref } from "vue";
import {
    normalize,
    normalizeAlertTiers,
    normalizeAlertTypes,
} from "./thresholds";
import type { AlertTiers, AlertTypes } from "./thresholds";
import { DEFAULT_FONT_ID } from "./fontSwitch";

// Single read-only access layer for settings.json (issue: unify settings reads).
//
// Why this exists: every window (App, Settings, Todos, Analytics, Mini, …) is its
// own WebView with its own JS heap, and each one used to re-implement the same
// ~30 `store.get(key) ?? default` reads plus the same normalization. That drifted
// (a default fixed in one window, missed in another) and a plain in-process event
// bus can't help — it doesn't cross WebViews. The cross-window signal is Tauri's
// `settings-changed` event, already emitted by the single writer (the main window)
// after every persisted change.
//
// So this module centralizes the SCHEMA (keys, defaults, normalization, one-shot
// migrations) in `readSettingsSnapshot()`, and layers a reactive singleton on top
// (`useSettings()`) that reads once and refreshes on `settings-changed`. It is
// read-only by contract: it exposes no setter. Writes still go through the main
// window (it stays the sole caller of `configure` and the sole writer of the
// store), so two windows never clobber each other.

export interface SettingsSnapshot {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    projectId: string;
    sessionThresholds: number[];
    weeklyThresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    forecastWindowMinutes: number;
    alertTiers: AlertTiers;
    alertTypes: AlertTypes;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    ccAnalyticsEnabled: boolean;
    dailyBudgetEnabled: boolean;
    dailyBudget: number;
    goalCostPerHourMax: number | null;
    goalErrorRateMax: number | null;
    notificationsMutedUntil: string | null;
    serviceStatusEnabled: boolean;
    serviceStatusInterval: number;
    serviceStatusNotify: boolean;
    memoryBloatEnabled: boolean;
    todoNotificationsEnabled: boolean;
    runtimeInsightsEnabled: boolean;
    runtimeInsightKinds: string[];
    systemInfoEnabled: boolean;
    correctionsEnabled: boolean;
    // Raw persisted locale — null when unset. Callers decide whether to apply it
    // (validating "en"/"ru"); an unset value must NOT clobber the running locale.
    locale: string | null;
    uiFont: string;
}

// The values a settings.json that has never been written yields. Kept in one place
// so App (writer) and every consumer window agree on defaults byte-for-byte.
export function defaultSettings(): SettingsSnapshot {
    return {
        sessionKey: "",
        orgId: "",
        refreshInterval: 60,
        autoStartSession: false,
        projectId: "",
        sessionThresholds: normalize(undefined),
        weeklyThresholds: normalize(undefined),
        notificationsEnabled: false,
        notifyForecastMinutes: 30,
        forecastWindowMinutes: 60,
        alertTiers: normalizeAlertTiers(undefined),
        alertTypes: normalizeAlertTypes(undefined),
        quietHoursEnabled: false,
        quietHoursStart: "23:00",
        quietHoursEnd: "08:00",
        ccAnalyticsEnabled: false,
        dailyBudgetEnabled: false,
        dailyBudget: 0,
        goalCostPerHourMax: null,
        goalErrorRateMax: null,
        notificationsMutedUntil: null,
        serviceStatusEnabled: true,
        serviceStatusInterval: 90,
        serviceStatusNotify: true,
        memoryBloatEnabled: true,
        todoNotificationsEnabled: true,
        runtimeInsightsEnabled: false,
        runtimeInsightKinds: ["long_session", "cold_rewrites"],
        systemInfoEnabled: true,
        correctionsEnabled: false,
        locale: null,
        uiFont: DEFAULT_FONT_ID,
    };
}

// One-shot read of settings.json → a fully-defaulted, normalized snapshot. This is
// the single definition of "how a setting is read": consumers that only need a
// value now (e.g. the writer seeding its editable refs) call this directly.
export async function readSettingsSnapshot(): Promise<SettingsSnapshot> {
    const s = defaultSettings();
    try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("settings.json");
        const get = <T>(key: string) => store.get<T>(key);

        s.sessionKey = (await get<string>("sessionKey")) ?? s.sessionKey;
        s.orgId = (await get<string>("orgId")) ?? s.orgId;
        s.refreshInterval = (await get<number>("refreshInterval")) ?? s.refreshInterval;
        s.autoStartSession = (await get<boolean>("autoStartSession")) ?? s.autoStartSession;
        s.projectId = (await get<string>("projectId")) ?? s.projectId;

        // `thresholds` is the pre-split legacy key; each of session/weekly falls
        // back to it, then normalize() fills any remaining gap with defaults.
        const legacy = await get<number[]>("thresholds");
        s.sessionThresholds = normalize((await get<number[]>("thresholdsSession")) ?? legacy);
        s.weeklyThresholds = normalize((await get<number[]>("thresholdsWeekly")) ?? legacy);

        s.notificationsEnabled = (await get<boolean>("notificationsEnabled")) ?? s.notificationsEnabled;
        s.notifyForecastMinutes = (await get<number>("notifyForecastMinutes")) ?? s.notifyForecastMinutes;
        s.forecastWindowMinutes = (await get<number>("forecastWindowMinutes")) ?? s.forecastWindowMinutes;
        s.alertTiers = normalizeAlertTiers(await get<Partial<AlertTiers>>("alertTiers"));
        s.alertTypes = normalizeAlertTypes(await get<Partial<AlertTypes>>("alertTypes"));
        s.quietHoursEnabled = (await get<boolean>("quietHoursEnabled")) ?? s.quietHoursEnabled;
        s.quietHoursStart = (await get<string>("quietHoursStart")) ?? s.quietHoursStart;
        s.quietHoursEnd = (await get<string>("quietHoursEnd")) ?? s.quietHoursEnd;
        s.ccAnalyticsEnabled = (await get<boolean>("ccAnalyticsEnabled")) ?? s.ccAnalyticsEnabled;
        s.dailyBudgetEnabled = (await get<boolean>("dailyBudgetEnabled")) ?? s.dailyBudgetEnabled;
        s.dailyBudget = (await get<number>("dailyBudget")) ?? s.dailyBudget;
        s.goalCostPerHourMax = (await get<number | null>("goalCostPerHourMax")) ?? null;
        s.goalErrorRateMax = (await get<number | null>("goalErrorRateMax")) ?? null;
        s.notificationsMutedUntil = (await get<string>("notificationsMutedUntil")) ?? null;
        s.serviceStatusEnabled = (await get<boolean>("serviceStatusEnabled")) ?? s.serviceStatusEnabled;
        s.serviceStatusInterval = (await get<number>("serviceStatusInterval")) ?? s.serviceStatusInterval;
        s.serviceStatusNotify = (await get<boolean>("serviceStatusNotify")) ?? s.serviceStatusNotify;
        s.memoryBloatEnabled = (await get<boolean>("memoryBloatEnabled")) ?? s.memoryBloatEnabled;
        s.todoNotificationsEnabled = (await get<boolean>("todoNotificationsEnabled")) ?? s.todoNotificationsEnabled;
        s.runtimeInsightsEnabled = (await get<boolean>("runtimeInsightsEnabled")) ?? s.runtimeInsightsEnabled;

        const rk = await get<string[]>("runtimeInsightKinds");
        // Migrate the pre-release kind name idle_cache_gap → cold_rewrites so a
        // settings.json written before the rename keeps its runtime toggle.
        if (Array.isArray(rk)) {
            s.runtimeInsightKinds = rk.map((k) => (k === "idle_cache_gap" ? "cold_rewrites" : k));
        }

        s.systemInfoEnabled = (await get<boolean>("systemInfoEnabled")) ?? s.systemInfoEnabled;
        s.correctionsEnabled = (await get<boolean>("correctionsEnabled")) ?? s.correctionsEnabled;
        s.locale = (await get<string>("locale")) ?? null;
        s.uiFont = (await get<string>("uiFont")) ?? s.uiFont;
    } catch {
        // First run / not under Tauri — defaults stand.
    }
    return s;
}

// --- Reactive singleton (module-scoped so every importer in a window shares it) ---
const snapshot = ref<SettingsSnapshot>(defaultSettings());
let initialized = false;
const unlisteners: Array<() => void> = [];

async function refresh(): Promise<void> {
    snapshot.value = await readSettingsSnapshot();
}

// Read settings once and keep them fresh: the single writer emits `settings-changed`
// after every persist, and we reload on it. Idempotent — safe to call from every
// window's onMounted; only the first call wires the listener.
export async function initSettings(): Promise<void> {
    if (initialized) return;
    initialized = true;
    await refresh();
    try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisteners.push(
            await listen("settings-changed", () => {
                void refresh();
            }),
        );
    } catch {
        // not under Tauri — the initial defaults stand, no live refresh
    }
}

// The shared read-only view. `settings` is reactive; `refresh` forces a re-read
// (rarely needed — the listener handles it). No setter is exposed on purpose:
// writes go through the main window.
export function useSettings(): {
    settings: Ref<SettingsSnapshot>;
    initSettings: () => Promise<void>;
    refresh: () => Promise<void>;
} {
    return { settings: snapshot, initSettings, refresh };
}
