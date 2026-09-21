// Threshold config types + normalization for the settings UI. The actual
// bucketing (which colour level a percent falls into) now lives in Rust
// (`src-tauri/src/alerts.rs::tier_level`); the backend emits per-tier levels
// with every `usage-updated` event, so the frontend never buckets itself.

export type Thresholds = [number, number, number];

export const DEFAULT_THRESHOLDS: Thresholds = [25, 50, 75];

export function normalize(th: number[] | null | undefined): Thresholds {
  if (!th || th.length < 3) return [...DEFAULT_THRESHOLDS];
  const s = [th[0], th[1], th[2]].sort((a, b) => a - b);
  return [s[0], s[1], s[2]];
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
