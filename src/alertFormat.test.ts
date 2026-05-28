import { describe, it, expect } from "vitest";
import { localizeAlert, formatEta } from "./alertFormat";
import type { AlertEvent, Translate } from "./alertFormat";

// Fake translator that echoes the key + interpolated params, so assertions can
// verify which i18n key and arguments each alert kind maps to.
const t: Translate = (key, params) =>
  params && Object.keys(params).length
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

describe("formatEta", () => {
  it("uses minutes under an hour", () => {
    expect(formatEta(t, 45)).toBe("unitMin(n=45)");
  });
  it("uses hours+minutes at or over an hour", () => {
    expect(formatEta(t, 90)).toBe("unitHour(h=1,m=30)");
  });
  it("clamps to at least one minute", () => {
    expect(formatEta(t, 0.2)).toBe("unitMin(n=1)");
  });
});

describe("localizeAlert", () => {
  it("threshold carries localized tier label + rounded pct", () => {
    const a: AlertEvent = { kind: "threshold", tier: "five_hour", pct: 75 };
    expect(localizeAlert(t, a)).toEqual({
      title: "alertThresholdTitle",
      body: "alertThresholdBody(tier=session5h,pct=75)",
    });
  });

  it("limit maps to the limit strings", () => {
    const a: AlertEvent = { kind: "limit", tier: "seven_day" };
    expect(localizeAlert(t, a)).toEqual({
      title: "alertLimitTitle",
      body: "alertLimitBody(tier=weekly7d)",
    });
  });

  it("reset maps to the reset strings", () => {
    const a: AlertEvent = { kind: "reset", tier: "seven_day_opus" };
    expect(localizeAlert(t, a)).toEqual({
      title: "alertResetTitle",
      body: "alertResetBody(tier=opusWeekly)",
    });
  });

  it("forecast formats the eta", () => {
    const a: AlertEvent = { kind: "forecast", eta_minutes: 90 };
    expect(localizeAlert(t, a)).toEqual({
      title: "alertForecastTitle",
      body: "alertForecastBody(time=unitHour(h=1,m=30))",
    });
  });

  it("catch_up aggregates its items' bodies", () => {
    const a: AlertEvent = {
      kind: "catch_up",
      count: 2,
      items: [
        { kind: "threshold", tier: "five_hour", pct: 50 },
        { kind: "limit", tier: "seven_day" },
      ],
    };
    const { title, body } = localizeAlert(t, a);
    expect(title).toBe("alertCatchUpTitle");
    expect(body).toContain("alertCatchUpBody(count=2)");
    expect(body).toContain("• alertThresholdBody(tier=session5h,pct=50)");
    expect(body).toContain("• alertLimitBody(tier=weekly7d)");
  });
});
