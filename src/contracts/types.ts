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

export interface ScopedTier {
    model: string;
    percent_used: number;
    reset_at: string | null;
    is_limited: boolean;
}

export interface UsageData {
    five_hour: UsageTier;
    seven_day: UsageTier;
    seven_day_opus: UsageTier | null;
    seven_day_sonnet: UsageTier | null;
    scoped_weekly: ScopedTier[];
    extra_usage: ExtraUsage | null;
    prepaid_balance: number | null;
    prepaid_currency: string | null;
}

export interface CodexLimitWindow {
    usedPercent: number;
    windowMinutes: number;
    resetsAt: number;
}

export interface CodexRateLimits {
    observedAt: string;
    limitId: string;
    planType: string | null;
    primary: CodexLimitWindow | null;
    secondary: CodexLimitWindow | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
    rateLimitReachedType: string | null;
}

export interface UsageLevels {
    five_hour: number;
    seven_day: number;
    seven_day_opus: number | null;
    seven_day_sonnet: number | null;
    scoped_weekly: number[];
    extra_usage: number | null;
}

export interface TierForecast {
    rate_per_hour: number;
    eta_minutes: number | null;
    allowed_per_hour: number | null;
    pace: "unknown" | "ok" | "warn";
    coverage_hours: number;
}

export interface ForecastData {
    five_hour: TierForecast;
    seven_day: TierForecast;
    extra_usage: TierForecast | null;
}

export interface DigestItem {
    kind: string;
    number?: number;
    id?: string;
    subject: string;
    note: string;
}

export interface TriageDigest {
    version: number;
    generated_at: string;
    project?: string | null;
    headline: string;
    summary: string;
    items: DigestItem[];
}

export interface CorrectionsTotals {
    sessions: number;
    assistant_turns: number;
    user_turns: number;
    candidate_corrections: number;
    done_claims: number;
    rework_after_done: number;
    likely_llm: number;
    ambiguous: number;
    corrections_per_session: number | null;
    rework_after_done_rate: number | null;
}

export interface CorrectionsSessionStat {
    assistant_turns: number;
    user_turns: number;
    candidate_corrections: number;
    done_claims: number;
    rework_after_done: number;
    corrections_per_session: number | null;
    rework_after_done_rate: number | null;
}

export interface CorrectionsSessionRow {
    session: string;
    project_dir?: string | null;
    project?: string | null;
    modified_at?: string | null;
    stats: CorrectionsSessionStat;
    likely_llm: number;
    ambiguous: number;
}

export interface CorrectionsMetrics {
    version: number;
    contract_version: number;
    generated_at: string;
    scope: string;
    project?: string | null;
    totals: CorrectionsTotals;
    sessions: CorrectionsSessionRow[];
}
