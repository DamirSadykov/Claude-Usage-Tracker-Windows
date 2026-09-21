// Maps the typed alert events emitted by the Rust backend into localized
// {title, body} strings. Kept pure (the translator `t` is injected) so it can
// be unit-tested without mounting Vue or the i18n runtime.

export type AlertEvent =
  | { kind: "threshold"; tier: string; pct: number }
  | { kind: "limit"; tier: string }
  | { kind: "reset"; tier: string }
  | { kind: "forecast"; eta_minutes: number }
  | { kind: "budget"; spent: number; budget: number; unit: string }
  | { kind: "catch_up"; count: number; items: AlertEvent[] }
  | { kind: "insight"; name: string; params: Record<string, unknown> };

function fmtBudgetValue(value: number, unit: string): string {
  return unit === "usd" ? "$" + value.toFixed(2) : value.toFixed(1) + "%";
}

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

function fmtTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

// Localizes a runtime optimization tip. `project` is the working-dir basename or
// null; falls back to a generic label so we never read transcript content.
function localizeInsight(
  t: Translate,
  name: string,
  params: Record<string, unknown>,
): { title: string; body: string } {
  const project = (params.project as string | null) ?? t("insightProjectFallback");
  switch (name) {
    case "long_session":
      return {
        title: t("alertInsightLongSessionTitle"),
        body: t("alertInsightLongSessionBody", {
          project,
          messages: Number(params.messages ?? 0),
        }),
      };
    case "cold_rewrites": {
      const idle = params.cause !== "compact";
      return {
        title: t("alertInsightColdRewriteTitle"),
        body: t(
          idle ? "alertInsightColdRewriteIdleBody" : "alertInsightColdRewriteCompactBody",
          {
            project,
            minutes: Math.round(Number(params.gap_minutes ?? 0)),
            tokens: fmtTokens(Number(params.tokens ?? 0)),
            cost: "$" + Number(params.cost_usd ?? 0).toFixed(2),
          },
        ),
      };
    }
    default:
      return { title: t("alertInsightLongSessionTitle"), body: name };
  }
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
    case "budget":
      return {
        title: t("alertBudgetTitle"),
        body: t("alertBudgetBody", {
          spent: fmtBudgetValue(a.spent, a.unit),
          budget: fmtBudgetValue(a.budget, a.unit),
        }),
      };
    case "catch_up": {
      const body =
        t("alertCatchUpBody", { count: a.count }) +
        "\n" +
        a.items.map((i) => "• " + localizeAlert(t, i).body).join("\n");
      return { title: t("alertCatchUpTitle"), body };
    }
    case "insight":
      return localizeInsight(t, a.name, a.params);
  }
}
