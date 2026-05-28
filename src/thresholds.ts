// Single source of truth for usage colour buckets. Three thresholds define
// four levels (0=green, 1=yellow, 2=orange, 3=red). The same thresholds drive
// the tray icon, the mini panel, the usage panel, and notification alerts.

export type Thresholds = [number, number, number];

export const DEFAULT_THRESHOLDS: Thresholds = [25, 50, 75];

export function normalize(th: number[] | null | undefined): Thresholds {
  if (!th || th.length < 3) return [...DEFAULT_THRESHOLDS];
  const s = [th[0], th[1], th[2]].sort((a, b) => a - b);
  return [s[0], s[1], s[2]];
}

/** Returns 0..3 — the number of thresholds the value has reached. */
export function tierLevel(pct: number, th: number[]): number {
  const [a, b, c] = normalize(th);
  if (pct < a) return 0;
  if (pct < b) return 1;
  if (pct < c) return 2;
  return 3;
}

// Tiers that can raise alerts, and per-tier enable flags.
export const ALERT_TIER_KEYS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "extra_usage",
] as const;

export type AlertTierKey = (typeof ALERT_TIER_KEYS)[number];

export type AlertTiers = Record<AlertTierKey, boolean>;

export function defaultAlertTiers(): AlertTiers {
  return {
    five_hour: true,
    seven_day: true,
    seven_day_opus: true,
    seven_day_sonnet: true,
    extra_usage: true,
  };
}

export function normalizeAlertTiers(v: Partial<AlertTiers> | null | undefined): AlertTiers {
  const d = defaultAlertTiers();
  if (!v) return d;
  for (const k of ALERT_TIER_KEYS) {
    if (typeof v[k] === "boolean") d[k] = v[k] as boolean;
  }
  return d;
}

// The 5-hour session has its own thresholds; every other (weekly-ish) tier
// shares the weekly set. The tray icon follows the session thresholds.
export function thresholdsForTier(
  key: AlertTierKey,
  session: number[],
  weekly: number[],
): number[] {
  return key === "five_hour" ? session : weekly;
}

// Per-notification-type toggles (independent of the per-tier toggles).
export const ALERT_TYPE_KEYS = ["threshold", "reset", "forecast"] as const;

export type AlertTypeKey = (typeof ALERT_TYPE_KEYS)[number];

export type AlertTypes = Record<AlertTypeKey, boolean>;

export function defaultAlertTypes(): AlertTypes {
  return { threshold: true, reset: true, forecast: true };
}

export function normalizeAlertTypes(v: Partial<AlertTypes> | null | undefined): AlertTypes {
  const d = defaultAlertTypes();
  if (!v) return d;
  for (const k of ALERT_TYPE_KEYS) {
    if (typeof v[k] === "boolean") d[k] = v[k] as boolean;
  }
  return d;
}
