import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import i18n from "./i18n";
import { tierLevel, normalize } from "./thresholds";
import type { UsageData, UsageTier } from "./App.vue";

export interface AlertSettings {
  enabled: boolean;
  thresholds: number[];
  forecastMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

interface UsageDelta {
  from_timestamp: string;
  to_timestamp: string;
  five_hour_delta: number;
  seven_day_delta: number;
  opus_delta: number | null;
  sonnet_delta: number | null;
}

type TierKey =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet";

interface TierFlags {
  firedLevel: number; // highest colour level already notified (0..3), -1 = none
  firedLimit: boolean;
  prevPercent: number | null;
  prevResetAt: string | null;
}

const TIER_LABEL: Record<TierKey, string> = {
  five_hour: "session5h",
  seven_day: "weekly7d",
  seven_day_opus: "opusWeekly",
  seven_day_sonnet: "sonnetWeekly",
};

const LOOKBACK_MS = 3_600_000; // 1h window for the forecast delta
const MIN_SPAN_MIN = 10; // need at least this much history to forecast
const MIN_RATE = 0.05; // %/min — below this is noise/flat
const MAX_PENDING = 10;
const RESET_EPSILON = 1; // percent_used <= this counts as "reset"

const flags = new Map<TierKey, TierFlags>();
let firedForecast = false;
let primed = false;
let pending: { title: string; body: string }[] = [];
let permissionOk: boolean | null = null;

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {});
}

function getFlags(key: TierKey): TierFlags {
  let f = flags.get(key);
  if (!f) {
    f = { firedLevel: -1, firedLimit: false, prevPercent: null, prevResetAt: null };
    flags.set(key, f);
  }
  return f;
}

function toMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function inQuietHours(start: string, end: string, now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e; // crosses midnight
}

async function ensurePermission(): Promise<boolean> {
  if (permissionOk !== null) return permissionOk;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  permissionOk = granted;
  return granted;
}

function rawSend(title: string, body: string): void {
  if (permissionOk) sendNotification({ title, body });
}

function dispatch(title: string, body: string, s: AlertSettings): void {
  if (s.quietHoursEnabled && inQuietHours(s.quietHoursStart, s.quietHoursEnd, new Date())) {
    pending.push({ title, body });
    if (pending.length > MAX_PENDING) pending.shift();
    return;
  }
  rawSend(title, body);
}

function flushPending(s: AlertSettings): void {
  if (pending.length === 0) return;
  if (s.quietHoursEnabled && inQuietHours(s.quietHoursStart, s.quietHoursEnd, new Date())) return;

  if (pending.length === 1) {
    rawSend(pending[0].title, pending[0].body);
  } else {
    const body =
      t("alertCatchUpBody", { count: pending.length }) +
      "\n" +
      pending.map((p) => `• ${p.body}`).join("\n");
    rawSend(t("alertCatchUpTitle"), body);
  }
  pending = [];
}

function tierLabel(key: TierKey): string {
  return t(TIER_LABEL[key]);
}

function evalTier(key: TierKey, cur: UsageTier | null, s: AlertSettings): void {
  if (!cur) return;
  const f = getFlags(key);
  const level = tierLevel(cur.percent_used, s.thresholds);

  // First sighting (startup, or tier appeared) → prime, don't fire.
  if (f.prevPercent === null) {
    f.prevPercent = cur.percent_used;
    f.prevResetAt = cur.reset_at;
    f.firedLevel = level;
    if (cur.is_limited || cur.percent_used >= 100) f.firedLimit = true;
    return;
  }

  // Reset detection: was used, now fresh.
  const wasActive = f.prevPercent > 0 || f.prevResetAt !== null;
  const didReset =
    wasActive &&
    cur.percent_used <= RESET_EPSILON &&
    (f.prevPercent > RESET_EPSILON || cur.reset_at !== f.prevResetAt);

  if (didReset) {
    f.firedLevel = level;
    f.firedLimit = false;
    if (key === "five_hour") firedForecast = false;
    dispatch(t("alertResetTitle"), t("alertResetBody", { tier: tierLabel(key) }), s);
  } else if ((cur.is_limited || cur.percent_used >= 100) && !f.firedLimit) {
    // Limit takes precedence.
    f.firedLimit = true;
    f.firedLevel = 3;
    dispatch(t("alertLimitTitle"), t("alertLimitBody", { tier: tierLabel(key) }), s);
  } else if (level > f.firedLevel) {
    // Crossed up into a higher colour bucket — notify once per bucket.
    f.firedLevel = level;
    const reached = normalize(s.thresholds)[level - 1];
    dispatch(
      t("alertThresholdTitle"),
      t("alertThresholdBody", { tier: tierLabel(key), pct: reached.toFixed(0) }),
      s,
    );
  }

  f.prevPercent = cur.percent_used;
  f.prevResetAt = cur.reset_at;
}

function formatEta(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return t("unitMin", { n: m });
  return t("unitHour", { h: Math.floor(m / 60), m: m % 60 });
}

async function evalForecast(usage: UsageData, s: AlertSettings): Promise<void> {
  const fh = usage.five_hour;
  if (firedForecast || fh.is_limited || fh.percent_used >= 100) return;

  const now = Date.now();
  const fromIso = new Date(now - LOOKBACK_MS).toISOString();
  const toIso = new Date(now).toISOString();

  let delta: UsageDelta | null;
  try {
    delta = await invoke<UsageDelta | null>("get_usage_delta", { from: fromIso, to: toIso });
  } catch {
    return;
  }
  if (!delta) return;

  const spanMin =
    (Date.parse(delta.to_timestamp) - Date.parse(delta.from_timestamp)) / 60000;
  if (spanMin < MIN_SPAN_MIN) return;

  const rate = delta.five_hour_delta / spanMin; // %/min
  if (rate < MIN_RATE) return;

  const eta = (100 - fh.percent_used) / rate;
  if (eta <= s.forecastMinutes) {
    firedForecast = true;
    dispatch(t("alertForecastTitle"), t("alertForecastBody", { time: formatEta(eta) }), s);
  }
}

export async function checkAlerts(usage: UsageData, s: AlertSettings): Promise<void> {
  if (!s.enabled) return;
  if (!(await ensurePermission())) return;

  flushPending(s);

  evalTier("five_hour", usage.five_hour, s);
  evalTier("seven_day", usage.seven_day, s);
  evalTier("seven_day_opus", usage.seven_day_opus, s);
  evalTier("seven_day_sonnet", usage.seven_day_sonnet, s);

  if (!primed) {
    primed = true;
    return; // first pass only primes tier state (and forecast baseline)
  }

  await evalForecast(usage, s);
}

export function resetAlertState(): void {
  flags.clear();
  firedForecast = false;
  primed = false;
  pending = [];
  permissionOk = null;
}
