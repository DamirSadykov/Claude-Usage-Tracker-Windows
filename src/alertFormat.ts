// Maps the typed alert events emitted by the Rust backend into localized
// {title, body} strings. Kept pure (the translator `t` is injected) so it can
// be unit-tested without mounting Vue or the i18n runtime.

export type AlertEvent =
  | { kind: "threshold"; tier: string; pct: number }
  | { kind: "limit"; tier: string }
  | { kind: "reset"; tier: string }
  | { kind: "forecast"; eta_minutes: number }
  | { kind: "catch_up"; count: number; items: AlertEvent[] };

export type Translate = (key: string, params?: Record<string, unknown>) => string;

const TIER_LABEL: Record<string, string> = {
  five_hour: "session5h",
  seven_day: "weekly7d",
  seven_day_opus: "opusWeekly",
  seven_day_sonnet: "sonnetWeekly",
  extra_usage: "extraUsage",
};

function tierName(t: Translate, tier: string): string {
  return t(TIER_LABEL[tier] ?? tier);
}

export function formatEta(t: Translate, minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return t("unitMin", { n: m });
  return t("unitHour", { h: Math.floor(m / 60), m: m % 60 });
}

export function localizeAlert(t: Translate, a: AlertEvent): { title: string; body: string } {
  switch (a.kind) {
    case "threshold":
      return {
        title: t("alertThresholdTitle"),
        body: t("alertThresholdBody", { tier: tierName(t, a.tier), pct: a.pct.toFixed(0) }),
      };
    case "limit":
      return {
        title: t("alertLimitTitle"),
        body: t("alertLimitBody", { tier: tierName(t, a.tier) }),
      };
    case "reset":
      return {
        title: t("alertResetTitle"),
        body: t("alertResetBody", { tier: tierName(t, a.tier) }),
      };
    case "forecast":
      return {
        title: t("alertForecastTitle"),
        body: t("alertForecastBody", { time: formatEta(t, a.eta_minutes) }),
      };
    case "catch_up": {
      const body =
        t("alertCatchUpBody", { count: a.count }) +
        "\n" +
        a.items.map((i) => "• " + localizeAlert(t, i).body).join("\n");
      return { title: t("alertCatchUpTitle"), body };
    }
  }
}
