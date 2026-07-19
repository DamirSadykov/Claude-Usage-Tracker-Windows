//! Analytics over ingested Claude Code usage: daily series, per-model breakdown,
//! weekday×hour heatmap, period totals and the cost-in-window query.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::StatsDb;

#[derive(Debug, Serialize)]
pub struct DailyPoint {
    pub date: String, // local YYYY-MM-DD
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize)]
pub struct ModelUsage {
    pub model: String,
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
}

#[derive(Debug, Serialize)]
pub struct ProjectUsage {
    pub project: Option<String>, // working-dir basename; None = unattributed
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
    pub sessions: i64,
}

#[derive(Debug, Serialize)]
pub struct SessionUsage {
    pub session_id: String,
    pub project: Option<String>,
    pub start: String, // earliest ts in the session
    pub end: String,   // latest ts in the session
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
    /// Cache-write tokens — useful for spotting sessions that are cheap in
    /// input/output but expensive in cache (`costly_by_cache` ranking).
    #[serde(default)]
    pub cache_create: i64,
}

#[derive(Debug, Serialize)]
pub struct HeatCell {
    pub weekday: i64, // 0=Sunday .. 6=Saturday (strftime %w, localtime)
    pub hour: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize, Default)]
pub struct Totals {
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub total_tokens: i64,
    pub cost: f64,
    pub messages: i64,
    pub sessions: i64,
    /// cache_read / (input + cache_read) ∈ [0,1]. 0.0 when input+cache_read==0.
    #[serde(default)]
    pub cache_hit_ratio: f64,
    /// USD saved by the prompt cache vs. re-sending all cached context as fresh
    /// input, priced per model family. Can be negative when cache_create
    /// dominates (heavy churn). 0.0 for unknown models.
    #[serde(default)]
    pub cache_savings_usd: f64,
}

/// Service-tier split over a window. `standard` vs `non_standard` (any non-null
/// tier that isn't "standard") vs `unknown` (NULL service_tier — old rows / not
/// carried). A low standard-share is an indirect throttling indicator.
#[derive(Debug, Serialize, Default)]
pub struct TierBreakdown {
    pub standard: i64,
    pub non_standard: i64,
    pub unknown: i64,
    /// standard / (standard + non_standard) × 100, over messages with a KNOWN
    /// tier. None when no message in the window carried a tier.
    pub standard_pct: Option<f64>,
}

/// Tool-call failure stats over a window: total calls observed and how many
/// returned is_error. A friction indicator. Empty when the window predates the
/// cc_tool_result migration or nothing re-ingested yet.
#[derive(Debug, Serialize, Default)]
pub struct ToolErrorStats {
    pub total: i64,
    pub errors: i64,
    /// errors / total × 100. None when no tool results in the window.
    pub error_rate: Option<f64>,
}

/// Productivity / ROI over a window. Active time is real wall-clock turn time
/// (`turn_duration.durationMs`, capped per turn), a main-thread quantity. The
/// per-X derivatives are Option so the UI renders "—" rather than Infinity when
/// the denominator is zero (no active time / no commits / no edits).
#[derive(Debug, Serialize, Default)]
pub struct Productivity {
    /// SUM(MIN(duration_ms, MAX_TURN_MS)) over main-thread turns (is_subagent=0).
    pub active_ms: i64,
    pub active_minutes: f64,
    pub active_hours: f64,
    /// COUNT of main-thread turns in the window.
    pub turns: i64,
    pub git_commits: i64,
    pub git_pushes: i64,
    /// SUM(cc_tool_use.n) for Edit/Write/MultiEdit.
    pub edits: i64,
    pub cost_per_active_hour: Option<f64>,
    pub tokens_per_active_minute: Option<f64>,
    pub cost_per_commit: Option<f64>,
    pub cost_per_edit: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct Analytics {
    pub daily: Vec<DailyPoint>,
    pub by_model: Vec<ModelUsage>,
    pub by_project: Vec<ProjectUsage>,
    /// Sessions whose token usage is a statistical outlier vs the rest of the
    /// window (mean + 2σ), sorted by tokens descending. Empty when there's too
    /// little history to judge.
    pub anomalies: Vec<SessionUsage>,
    pub heatmap: Vec<HeatCell>,
    pub totals: Totals,
}

/// Trend headline metrics over one window, used by the period-comparison badges
/// ("better / worse than the previous window"). A deliberately small subset of
/// what the dashboard computes — just the five numbers the trend UI diffs. The
/// last two are Option so the UI shows "—" rather than a misleading 0 when there
/// were no tool calls / no measurable active time in the window.
#[derive(Debug, Serialize, Default)]
pub struct TrendMetrics {
    pub cost: f64,
    pub total_tokens: i64,
    /// cache_read / (input + cache_read) ∈ [0,1]. 0.0 when input+cache_read==0.
    pub cache_hit_ratio: f64,
    /// errors / total ∈ [0,1] (fraction, NOT percent). None when no tool results
    /// in the window. NB: `ToolErrorStats.error_rate` is a percent (0..100); this
    /// trend metric is the raw fraction so it composes with `goal_error_rate_max`.
    pub error_rate: Option<f64>,
    /// USD per hour of measured active (turn) time. None when there was no
    /// measurable active time in the window.
    pub cost_per_active_hour: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct PeriodCompare {
    pub current: Totals,
    pub previous: Totals,
    /// Trend headline metrics for the current window (for the "vs previous" badges).
    pub current_trend: TrendMetrics,
    /// Trend headline metrics for the previous window of equal length.
    pub previous_trend: TrendMetrics,
}

/// One subagent group (by `agent_name`, or "<unnamed>" when the transcript
/// didn't expose a label). Counts unique sessions and message-level spawns.
#[derive(Debug, Serialize)]
pub struct SubagentUsage {
    pub agent_name: String,
    pub messages: i64,
    pub sessions: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

/// Aggregate cost/tokens spent on subagent (sidechain) work vs the main thread,
/// for the "How much went into subagents?" insight.
#[derive(Debug, Serialize, Default)]
pub struct SubagentSummary {
    pub subagent_messages: i64,
    pub subagent_sessions: i64,
    pub subagent_tokens: i64,
    pub subagent_cost: f64,
    pub main_tokens: i64,
    pub main_cost: f64,
}

/// A short, human-readable finding the dashboard surfaces as a card. Generated
/// deterministically from the period's aggregates — no LLM call.
#[derive(Debug, Serialize)]
pub struct Insight {
    /// Stable id (`top_project`, `cache_share`, …) so the UI can pick an icon.
    pub kind: String,
    /// Localisation key the frontend resolves with `t(...)`. Params live in
    /// `params` so a single key supports every locale.
    pub label_key: String,
    pub params: serde_json::Value,
    /// `observation` = «what happened» (factual cards); `recommendation` =
    /// «what to change» (actionable, threshold-triggered). UI tabs split on it.
    pub category: &'static str,
}

/// Extended analytics bundle for the standalone dashboard window: everything
/// the popup returns, plus per-project/subagent breakdowns, costly sessions
/// (by `cost` AND by `cache_create`) and deterministic insights.
#[derive(Debug, Serialize)]
pub struct AnalyticsExt {
    pub totals: Totals,
    pub daily: Vec<DailyPoint>,
    pub by_model: Vec<ModelUsage>,
    pub by_project: Vec<ProjectUsage>,
    pub by_subagent: Vec<SubagentUsage>,
    pub subagent_summary: SubagentSummary,
    /// Sessions sorted by cost desc (top N).
    pub costly_by_cost: Vec<SessionUsage>,
    /// Sessions sorted by cache_create tokens desc (top N) — the "cheap looking
    /// but expensive in cache" cohort.
    pub costly_by_cache: Vec<SessionUsage>,
    pub anomalies: Vec<SessionUsage>,
    pub insights: Vec<Insight>,
    /// Distinct project names present in the window — feeds the UI filter.
    pub projects: Vec<String>,
    /// Tool-use breakdown over the window: how many times each tool was
    /// invoked. Empty when the period predates the tool-tracking migration or
    /// no transcripts in the window have been re-ingested yet.
    pub tool_breakdown: Vec<ToolUsage>,
    /// Service-tier split over the window (standard vs non-standard vs unknown).
    /// Indirect throttling signal.
    pub tier_breakdown: TierBreakdown,
    /// Tool-call failure stats over the window. Friction indicator.
    pub tool_error: ToolErrorStats,
    /// Productivity / ROI over the window: active time, $/active hour, $/commit,
    /// $/edit, tokens/active minute.
    pub productivity: Productivity,
}

/// Aggregate use of one tool (e.g. "Edit", "Bash", "Read") over a window:
/// total calls and the messages they were spread across.
#[derive(Debug, Serialize)]
pub struct ToolUsage {
    pub tool_name: String,
    pub calls: i64,
    pub messages: i64,
}

/// Per-turn cap on active time when summing. `turn_duration.durationMs` reaches
/// millions of ms in real data (a turn with a long Bash build/test), which would
/// distort "active operator time" — the operator wasn't watching one turn for 2h.
const MAX_TURN_MS: i64 = 30 * 60 * 1000; // 30 minutes

/// cache_read / (input + cache_read); 0.0 when the denominator is 0. The
/// denominator deliberately excludes cache_create and output — it answers "of the
/// context the model read on input, what share came from cache".
fn hit_ratio(input: i64, cache_read: i64) -> f64 {
    let den = (input + cache_read) as f64;
    if den > 0.0 {
        cache_read as f64 / den
    } else {
        0.0
    }
}

/// SQL expression mapping a raw project column to its canonical name via the
/// `project_links` merge table (issue #13), falling back to the raw value when the
/// project isn't an alias. `col` is the project column in scope — "project" for a
/// single-table query over cc_usage/cc_turn, or a qualified form like "cu.project"
/// when cc_usage is aliased. NULL (unattributed) stays NULL. The table is kept
/// single-level (see project_links.rs), so this one COALESCE fully resolves any
/// alias and can't loop. Read-time only — raw usage rows are never rewritten, so
/// dropping a link instantly restores the original per-project split.
pub(super) fn resolved_project(col: &str) -> String {
    format!("COALESCE((SELECT canonical FROM project_links WHERE alias = {col}), {col})")
}

/// Σ over models of cache savings vs. a no-cache world, priced per family:
/// savings = cache_read·pin·0.9 − cache_create·pin·0.25, scaled by 1e-6. Per-model
/// because the input price `pin` differs by family. Unknown models contribute 0
/// (no price). May be negative (heavy cache_create, little cache_read).
fn cache_savings_for(
    conn: &Connection,
    from: &str,
    to: &str,
    project: Option<&str>,
) -> Result<f64, rusqlite::Error> {
    let proj = if project.is_some() {
        format!(" AND {} = ?3", resolved_project("project"))
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT model, COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_create),0)
         FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}
         GROUP BY model"
    );
    let mut stmt = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<(String, i64, i64)> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    };
    let rows: Vec<(String, i64, i64)> = match project {
        Some(p) => stmt.query_map(params![from, to, p], map)?.collect::<Result<_, _>>()?,
        None => stmt.query_map(params![from, to], map)?.collect::<Result<_, _>>()?,
    };
    let mut savings = 0.0_f64;
    for (model, cr, cc) in rows {
        if let Some((pin, _pout)) = crate::cc::price_per_mtok(&model) {
            savings += (cr as f64 * pin * 0.9 - cc as f64 * pin * 0.25) / 1_000_000.0;
        }
    }
    Ok(savings)
}

fn totals_for(conn: &Connection, from: &str, to: &str) -> Result<Totals, rusqlite::Error> {
    let mut totals = conn.query_row(
        "SELECT COALESCE(SUM(input),0), COALESCE(SUM(output),0),
                COALESCE(SUM(cache_create),0), COALESCE(SUM(cache_read),0),
                COALESCE(SUM(cost),0.0), COUNT(*), COUNT(DISTINCT session_id)
         FROM cc_usage WHERE ts >= ?1 AND ts < ?2",
        params![from, to],
        |r| {
            let input: i64 = r.get(0)?;
            let output: i64 = r.get(1)?;
            let cc: i64 = r.get(2)?;
            let cr: i64 = r.get(3)?;
            Ok(Totals {
                input,
                output,
                cache_create: cc,
                cache_read: cr,
                total_tokens: input + output + cc + cr,
                cost: r.get(4)?,
                messages: r.get(5)?,
                sessions: r.get(6)?,
                cache_hit_ratio: hit_ratio(input, cr),
                cache_savings_usd: 0.0,
            })
        },
    )?;
    totals.cache_savings_usd = cache_savings_for(conn, from, to, None)?;
    Ok(totals)
}

/// Tool-call error fraction over `[from, to)`, window-wide (not project-scoped —
/// tool results carry no project, matching the `analytics_ext` tool_error
/// aggregate). Returns (total, errors, error_rate) where error_rate ∈ [0,1] is
/// None when no tool results fell in the window. NB: this is a FRACTION (0..1),
/// whereas `ToolErrorStats.error_rate` is a percent (0..100).
fn tool_error_fraction(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<(i64, i64, Option<f64>), rusqlite::Error> {
    let (total, errors): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(is_error), 0)
         FROM cc_tool_result WHERE ts >= ?1 AND ts < ?2",
        params![from, to],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let error_rate = if total > 0 {
        Some(errors as f64 / total as f64)
    } else {
        None
    };
    Ok((total, errors, error_rate))
}

/// The five headline trend metrics over `[from, to)`, reusing `totals_for`
/// (cost / tokens / cache-hit), `productivity_for` (cost-per-active-hour) and the
/// window-wide tool-error aggregate. Both `error_rate` and `cost_per_active_hour`
/// are None when their denominator is empty so the trend UI renders "—".
fn trend_metrics_for(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<TrendMetrics, rusqlite::Error> {
    let totals = totals_for(conn, from, to)?;
    let productivity =
        productivity_for(conn, from, to, None, totals.cost, totals.total_tokens)?;
    let (_total, _errors, error_rate) = tool_error_fraction(conn, from, to)?;
    Ok(TrendMetrics {
        cost: totals.cost,
        total_tokens: totals.total_tokens,
        cache_hit_ratio: totals.cache_hit_ratio,
        error_rate,
        cost_per_active_hour: productivity.cost_per_active_hour,
    })
}

/// Productivity / ROI aggregate over `[from, to)`, optionally scoped to a
/// project. Active time comes from `cc_turn` (main-thread only, capped per turn),
/// commits/pushes from `cc_usage`, edits from `cc_tool_use`. The per-X
/// derivatives divide the already-computed window `cost` / `total_tokens` and are
/// None when the denominator is zero. `proj_clause` must match the caller's
/// `?3` convention (" AND project = ?3" or "").
fn productivity_for(
    conn: &Connection,
    from: &str,
    to: &str,
    project: Option<&str>,
    cost: f64,
    total_tokens: i64,
) -> Result<Productivity, rusqlite::Error> {
    // Active time + turn count (main-thread only). is_subagent IS NOT 1 also
    // catches NULLs from rows stored without the flag.
    let proj = if project.is_some() {
        format!(" AND {} = ?4", resolved_project("project"))
    } else {
        String::new()
    };
    let active_sql = format!(
        "SELECT COALESCE(SUM(MIN(duration_ms, ?3)), 0), COUNT(*)
         FROM cc_turn
         WHERE ts >= ?1 AND ts < ?2 AND COALESCE(is_subagent, 0) = 0{proj}"
    );
    let (active_ms, turns): (i64, i64) = match project {
        Some(p) => conn.query_row(&active_sql, params![from, to, MAX_TURN_MS, p], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
        None => conn.query_row(&active_sql, params![from, to, MAX_TURN_MS], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
    };

    // git commits / pushes from cc_usage.
    let proj3 = if project.is_some() {
        format!(" AND {} = ?3", resolved_project("project"))
    } else {
        String::new()
    };
    let git_sql = format!(
        "SELECT COALESCE(SUM(git_commits), 0), COALESCE(SUM(git_pushes), 0)
         FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj3}"
    );
    let (git_commits, git_pushes): (i64, i64) = match project {
        Some(p) => conn.query_row(&git_sql, params![from, to, p], |r| Ok((r.get(0)?, r.get(1)?)))?,
        None => conn.query_row(&git_sql, params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?,
    };

    // Edits = Edit + Write + MultiEdit calls (project-aware via the cc_usage join).
    let proj_cu = if project.is_some() {
        format!(" AND {} = ?3", resolved_project("cu.project"))
    } else {
        String::new()
    };
    let edits_sql = format!(
        "SELECT COALESCE(SUM(tu.n), 0)
         FROM cc_tool_use tu JOIN cc_usage cu USING (message_id)
         WHERE cu.ts >= ?1 AND cu.ts < ?2
           AND tu.tool_name IN ('Edit','Write','MultiEdit'){proj_cu}"
    );
    let edits: i64 = match project {
        Some(p) => conn.query_row(&edits_sql, params![from, to, p], |r| r.get(0))?,
        None => conn.query_row(&edits_sql, params![from, to], |r| r.get(0))?,
    };

    let active_minutes = active_ms as f64 / 60_000.0;
    let active_hours = active_ms as f64 / 3_600_000.0;
    // "Has active time" floor: at least one second of measured turn time.
    let has_active = active_ms >= 1000;
    let cost_per_active_hour = if has_active && active_hours > 0.0 {
        Some(cost / active_hours)
    } else {
        None
    };
    let tokens_per_active_minute = if has_active && active_minutes > 0.0 {
        Some(total_tokens as f64 / active_minutes)
    } else {
        None
    };
    let cost_per_commit = if git_commits > 0 {
        Some(cost / git_commits as f64)
    } else {
        None
    };
    let cost_per_edit = if edits > 0 {
        Some(cost / edits as f64)
    } else {
        None
    };

    Ok(Productivity {
        active_ms,
        active_minutes,
        active_hours,
        turns,
        git_commits,
        git_pushes,
        edits,
        cost_per_active_hour,
        tokens_per_active_minute,
        cost_per_commit,
        cost_per_edit,
    })
}

/// Per-session $/active-hour, used by the `low_roi` insight to compare the window
/// rate against the typical session rate. Returns (sorted ascending) rates for
/// sessions with measurable active time AND positive cost.
fn session_roi_rates(
    conn: &Connection,
    from: &str,
    to: &str,
    project: Option<&str>,
) -> Result<Vec<f64>, rusqlite::Error> {
    let proj_t = if project.is_some() {
        format!(" AND {} = ?4", resolved_project("project"))
    } else {
        String::new()
    };
    let proj_c = if project.is_some() {
        format!(" AND {} = ?3", resolved_project("project"))
    } else {
        String::new()
    };
    // Active time per session (capped per turn, main-thread), joined with the
    // session's main-thread cost.
    let sql = format!(
        "WITH t AS (
            SELECT session_id, SUM(MIN(duration_ms, ?3)) AS ams
            FROM cc_turn
            WHERE ts >= ?1 AND ts < ?2 AND COALESCE(is_subagent,0) = 0
              AND session_id IS NOT NULL{proj_t}
            GROUP BY session_id
         ),
         c AS (
            SELECT session_id, SUM(cost) AS cost
            FROM cc_usage
            WHERE ts >= ?1 AND ts < ?2 AND is_subagent = 0
              AND session_id IS NOT NULL{proj_c}
            GROUP BY session_id
         )
         SELECT t.ams, c.cost
         FROM t JOIN c USING (session_id)
         WHERE t.ams > 0 AND c.cost > 0"
    );
    let mut stmt = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<(i64, f64)> { Ok((r.get(0)?, r.get(1)?)) };
    let rows: Vec<(i64, f64)> = match project {
        Some(p) => stmt
            .query_map(params![from, to, MAX_TURN_MS, p], map)?
            .collect::<Result<_, _>>()?,
        None => stmt
            .query_map(params![from, to, MAX_TURN_MS], map)?
            .collect::<Result<_, _>>()?,
    };
    let mut rates: Vec<f64> = rows
        .into_iter()
        .map(|(ams, cost)| cost / (ams as f64 / 3_600_000.0))
        .collect();
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Ok(rates)
}

/// Sessions in `[from, to)`, optionally restricted to a project. Used by the
/// popup (`analytics`) and by the dashboard (`analytics_ext`); kept here so the
/// SELECT and the `SessionUsage` field list stay in one place.
fn sessions_in(
    conn: &Connection,
    from: &str,
    to: &str,
    project: Option<&str>,
) -> Result<Vec<SessionUsage>, rusqlite::Error> {
    let rp = resolved_project("project");
    let where_proj = if project.is_some() {
        format!(" AND {rp} = ?3")
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT session_id, MAX({rp}), MIN(ts), MAX(ts),
                SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*),
                SUM(cache_create)
         FROM cc_usage
         WHERE ts >= ?1 AND ts < ?2 AND session_id IS NOT NULL{where_proj}
         GROUP BY session_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let map_row = |r: &rusqlite::Row| {
        Ok(SessionUsage {
            session_id: r.get(0)?,
            project: r.get(1)?,
            start: r.get(2)?,
            end: r.get(3)?,
            total_tokens: r.get(4)?,
            cost: r.get(5)?,
            messages: r.get(6)?,
            cache_create: r.get(7)?,
        })
    };
    let rows = match project {
        Some(p) => stmt
            .query_map(params![from, to, p], map_row)?
            .collect::<Result<Vec<_>, _>>()?,
        None => stmt
            .query_map(params![from, to], map_row)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

/// Flag sessions whose token usage is a statistical outlier (mean + 2σ) versus
/// the rest of the window, returned sorted by tokens descending. Needs at least
/// `MIN_SESSIONS` to have a meaningful baseline; below that, returns empty so a
/// couple of large early sessions don't all read as "anomalies".
fn flag_anomalies(sessions: &[SessionUsage]) -> Vec<SessionUsage> {
    const MIN_SESSIONS: usize = 5;
    let n = sessions.len();
    if n < MIN_SESSIONS {
        return Vec::new();
    }
    let toks: Vec<f64> = sessions.iter().map(|s| s.total_tokens as f64).collect();
    let mean = toks.iter().sum::<f64>() / n as f64;
    let var = toks.iter().map(|t| (t - mean).powi(2)).sum::<f64>() / n as f64;
    let threshold = mean + 2.0 * var.sqrt();
    let mut out: Vec<SessionUsage> = sessions
        .iter()
        .filter(|s| (s.total_tokens as f64) > threshold)
        .cloned()
        .collect();
    out.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    out
}

impl StatsDb {
    /// Every session on record, no time window — the tokens-per-task join
    /// (task_cost.rs, t#87) attributes arbitrarily old sessions. ISO timestamps
    /// compare lexicographically, so "0" and "A" bracket them all.
    pub fn sessions_all(&self) -> Result<Vec<SessionUsage>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        sessions_in(&conn, "0", "A", None)
    }

    /// Total Claude Code cost (USD) recorded in `[from, to)`. Drives the daily
    /// budget when CC analytics is enabled.
    pub fn cost_in(&self, from: &str, to: &str) -> Result<f64, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        Ok(totals_for(&conn, from, to)?.cost)
    }

    /// Bundle of analytics over [from, to): daily series, per-model breakdown,
    /// weekday×hour heatmap and totals. Day/heatmap buckets use local time.
    pub fn analytics(&self, from: &str, to: &str) -> Result<Analytics, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        let daily = {
            let mut stmt = conn.prepare(
                "SELECT date(ts,'localtime') d, SUM(input), SUM(output),
                        SUM(cache_create), SUM(cache_read), SUM(cost)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY d ORDER BY d",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    let input: i64 = r.get(1)?;
                    let output: i64 = r.get(2)?;
                    let cc: i64 = r.get(3)?;
                    let cr: i64 = r.get(4)?;
                    Ok(DailyPoint {
                        date: r.get(0)?,
                        input,
                        output,
                        cache_create: cc,
                        cache_read: cr,
                        total_tokens: input + output + cc + cr,
                        cost: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let by_model = {
            let mut stmt = conn.prepare(
                "SELECT model, SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY model ORDER BY 2 DESC",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(ModelUsage {
                        model: r.get(0)?,
                        total_tokens: r.get(1)?,
                        cost: r.get(2)?,
                        messages: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let heatmap = {
            let mut stmt = conn.prepare(
                "SELECT CAST(strftime('%w',ts,'localtime') AS INTEGER) w,
                        CAST(strftime('%H',ts,'localtime') AS INTEGER) h,
                        SUM(input+output+cache_create+cache_read), SUM(cost)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY w, h",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(HeatCell {
                        weekday: r.get(0)?,
                        hour: r.get(1)?,
                        total_tokens: r.get(2)?,
                        cost: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let by_project = {
            let rp = resolved_project("project");
            let sql = format!(
                "SELECT {rp}, SUM(input+output+cache_create+cache_read), SUM(cost),
                        COUNT(*), COUNT(DISTINCT session_id)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY {rp} ORDER BY 2 DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(ProjectUsage {
                        project: r.get(0)?,
                        total_tokens: r.get(1)?,
                        cost: r.get(2)?,
                        messages: r.get(3)?,
                        sessions: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let sessions = sessions_in(&conn, from, to, None)?;
        let anomalies = flag_anomalies(&sessions);

        let totals = totals_for(&conn, from, to)?;
        Ok(Analytics {
            daily,
            by_model,
            by_project,
            anomalies,
            heatmap,
            totals,
        })
    }

    pub fn analytics_compare(
        &self,
        cur_from: &str,
        cur_to: &str,
        prev_from: &str,
        prev_to: &str,
    ) -> Result<PeriodCompare, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        Ok(PeriodCompare {
            current: totals_for(&conn, cur_from, cur_to)?,
            previous: totals_for(&conn, prev_from, prev_to)?,
            current_trend: trend_metrics_for(&conn, cur_from, cur_to)?,
            previous_trend: trend_metrics_for(&conn, prev_from, prev_to)?,
        })
    }

    /// Everything the standalone dashboard needs over `[from, to)`, optionally
    /// scoped to a single `project`. `top_n` caps the "costly sessions" lists
    /// (each ordered by its own metric: cost vs cache_create).
    pub fn analytics_ext(
        &self,
        from: &str,
        to: &str,
        project: Option<&str>,
        top_n: usize,
    ) -> Result<AnalyticsExt, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let proj_clause = if project.is_some() {
            format!(" AND {} = ?3", resolved_project("project"))
        } else {
            String::new()
        };
        let prepare_proj = |sql_tmpl: String| -> Result<rusqlite::Statement<'_>, rusqlite::Error> {
            conn.prepare(&sql_tmpl.replace("{proj}", &proj_clause))
        };

        // --- totals (project-aware) ---
        let totals = {
            let mut stmt = prepare_proj(
                "SELECT COALESCE(SUM(input),0), COALESCE(SUM(output),0),
                        COALESCE(SUM(cache_create),0), COALESCE(SUM(cache_read),0),
                        COALESCE(SUM(cost),0.0), COUNT(*), COUNT(DISTINCT session_id)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                let input: i64 = r.get(0)?;
                let output: i64 = r.get(1)?;
                let cc: i64 = r.get(2)?;
                let cr: i64 = r.get(3)?;
                Ok(Totals {
                    input,
                    output,
                    cache_create: cc,
                    cache_read: cr,
                    total_tokens: input + output + cc + cr,
                    cost: r.get(4)?,
                    messages: r.get(5)?,
                    sessions: r.get(6)?,
                    cache_hit_ratio: hit_ratio(input, cr),
                    cache_savings_usd: 0.0,
                })
            };
            let mut t = match project {
                Some(p) => stmt.query_row(params![from, to, p], map_row)?,
                None => stmt.query_row(params![from, to], map_row)?,
            };
            t.cache_savings_usd = cache_savings_for(&conn, from, to, project)?;
            t
        };

        // --- daily series ---
        let daily = {
            let mut stmt = prepare_proj(
                "SELECT date(ts,'localtime') d, SUM(input), SUM(output),
                        SUM(cache_create), SUM(cache_read), SUM(cost)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}
                 GROUP BY d ORDER BY d"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                let input: i64 = r.get(1)?;
                let output: i64 = r.get(2)?;
                let cc: i64 = r.get(3)?;
                let cr: i64 = r.get(4)?;
                Ok(DailyPoint {
                    date: r.get(0)?,
                    input,
                    output,
                    cache_create: cc,
                    cache_read: cr,
                    total_tokens: input + output + cc + cr,
                    cost: r.get(5)?,
                })
            };
            match project {
                Some(p) => stmt
                    .query_map(params![from, to, p], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![from, to], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            }
        };

        // --- by_model / by_project (always over the full window when no proj filter) ---
        let by_model = {
            let mut stmt = prepare_proj(
                "SELECT model, SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}
                 GROUP BY model ORDER BY 2 DESC"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                Ok(ModelUsage {
                    model: r.get(0)?,
                    total_tokens: r.get(1)?,
                    cost: r.get(2)?,
                    messages: r.get(3)?,
                })
            };
            match project {
                Some(p) => stmt
                    .query_map(params![from, to, p], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![from, to], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            }
        };

        let by_project = {
            let rp = resolved_project("project");
            let sql = format!(
                "SELECT {rp}, SUM(input+output+cache_create+cache_read), SUM(cost),
                        COUNT(*), COUNT(DISTINCT session_id)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY {rp} ORDER BY 2 DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![from, to], |r| {
                    Ok(ProjectUsage {
                        project: r.get(0)?,
                        total_tokens: r.get(1)?,
                        cost: r.get(2)?,
                        messages: r.get(3)?,
                        sessions: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        // --- subagents ---
        let by_subagent = {
            let mut stmt = prepare_proj(
                "SELECT COALESCE(agent_name,'<unnamed>'),
                        COUNT(*), COUNT(DISTINCT session_id),
                        SUM(input+output+cache_create+cache_read), SUM(cost)
                 FROM cc_usage
                 WHERE ts >= ?1 AND ts < ?2 AND is_subagent = 1{proj}
                 GROUP BY agent_name ORDER BY 5 DESC"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                Ok(SubagentUsage {
                    agent_name: r.get(0)?,
                    messages: r.get(1)?,
                    sessions: r.get(2)?,
                    total_tokens: r.get(3)?,
                    cost: r.get(4)?,
                })
            };
            match project {
                Some(p) => stmt
                    .query_map(params![from, to, p], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![from, to], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            }
        };
        let subagent_summary = {
            let mut stmt = prepare_proj(
                "SELECT
                    SUM(CASE WHEN is_subagent = 1 THEN 1 ELSE 0 END),
                    COUNT(DISTINCT CASE WHEN is_subagent = 1 THEN session_id END),
                    COALESCE(SUM(CASE WHEN is_subagent = 1
                        THEN input+output+cache_create+cache_read END),0),
                    COALESCE(SUM(CASE WHEN is_subagent = 1 THEN cost END),0.0),
                    COALESCE(SUM(CASE WHEN is_subagent = 0
                        THEN input+output+cache_create+cache_read END),0),
                    COALESCE(SUM(CASE WHEN is_subagent = 0 THEN cost END),0.0)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                Ok(SubagentSummary {
                    subagent_messages: r.get(0).unwrap_or(0),
                    subagent_sessions: r.get(1).unwrap_or(0),
                    subagent_tokens: r.get(2)?,
                    subagent_cost: r.get(3)?,
                    main_tokens: r.get(4)?,
                    main_cost: r.get(5)?,
                })
            };
            match project {
                Some(p) => stmt.query_row(params![from, to, p], map_row)?,
                None => stmt.query_row(params![from, to], map_row)?,
            }
        };

        // --- sessions: rank for costly + anomalies ---
        let sessions = sessions_in(&conn, from, to, project)?;
        let mut by_cost = sessions.clone();
        by_cost.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
        by_cost.truncate(top_n);
        let mut by_cache = sessions.clone();
        by_cache.sort_by(|a, b| b.cache_create.cmp(&a.cache_create));
        by_cache.truncate(top_n);
        let anomalies = flag_anomalies(&sessions);

        // --- distinct project list (for the UI filter) ---
        let projects = {
            let rp = resolved_project("project");
            let sql = format!(
                "SELECT DISTINCT {rp} FROM cc_usage
                 WHERE ts >= ?1 AND ts < ?2 AND project IS NOT NULL
                 ORDER BY 1"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![from, to], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        // --- cold cache rewrites inside sessions (classified by cause) ---
        // A "cold rewrite" is a mid-session turn that reused almost nothing from
        // cache (cache_read < 5K) yet rewrote a large prefix (cache_create ≥ 50K),
        // re-paying input at 1.25×. The session's first turn is naturally cold, so
        // we exclude it (prev_ts IS NOT NULL) — every counted turn is a genuine
        // mid-session rebuild. Each is classified against its predecessor:
        //   • model_switch — the model changed (each model keeps its own cache)
        //   • idle         — same model, gap > 15 min (the cache TTL ~1 h expired)
        //   • compaction   — same model, small gap (auto-compaction rewrote history)
        // Empirically (local transcripts) the three form clean populations: gap≈0
        // compactions, gap≥~19 min idle expiries (the 5–18 min band is dead), and
        // a rare model switch. Thresholds (5K / 50K / 15 min) match the runtime
        // engine so this dashboard breakdown and the live toast agree on what
        // counts as a cold rewrite.
        let cold_rewrites = {
            let mut stmt = prepare_proj(
                "WITH g AS (
                    SELECT session_id, project, ts, cost, cache_read, cache_create, model,
                           LAG(ts)    OVER (PARTITION BY session_id ORDER BY ts) AS prev_ts,
                           LAG(model) OVER (PARTITION BY session_id ORDER BY ts) AS prev_model
                    FROM cc_usage
                    WHERE ts >= ?1 AND ts < ?2 AND is_subagent = 0 AND session_id IS NOT NULL{proj}
                 )
                 SELECT session_id, project, cost,
                        CASE
                          WHEN model IS NOT prev_model THEN 'model_switch'
                          WHEN (julianday(ts) - julianday(prev_ts)) * 86400.0 > 900.0 THEN 'idle'
                          ELSE 'compaction'
                        END AS cause
                 FROM g
                 WHERE prev_ts IS NOT NULL
                   AND cache_read < 5000
                   AND cache_create >= 50000"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| -> Result<(String, Option<String>, f64, String), rusqlite::Error> {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            };
            let rows: Vec<(String, Option<String>, f64, String)> = match project {
                Some(p) => stmt
                    .query_map(params![from, to, p], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![from, to], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            };
            rows
        };

        // --- tool-use breakdown over the window (project-aware) ---
        let tool_breakdown = {
            let mut stmt = prepare_proj(
                "SELECT tu.tool_name,
                        COALESCE(SUM(tu.n), 0) AS calls,
                        COUNT(DISTINCT tu.message_id) AS messages
                 FROM cc_tool_use tu
                 JOIN cc_usage cu USING (message_id)
                 WHERE cu.ts >= ?1 AND cu.ts < ?2{proj}
                 GROUP BY tu.tool_name
                 ORDER BY calls DESC"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| {
                Ok(ToolUsage {
                    tool_name: r.get(0)?,
                    calls: r.get(1)?,
                    messages: r.get(2)?,
                })
            };
            match project {
                Some(p) => stmt
                    .query_map(params![from, to, p], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![from, to], map_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            }
        };

        // --- service-tier breakdown (project-aware) ---
        let tier_breakdown = {
            let mut stmt = prepare_proj(
                "SELECT
                    COALESCE(SUM(CASE WHEN service_tier = 'standard' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN service_tier IS NOT NULL AND service_tier <> 'standard' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN service_tier IS NULL THEN 1 ELSE 0 END), 0)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2{proj}"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| -> rusqlite::Result<(i64, i64, i64)> {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            };
            let (standard, non_standard, unknown) = match project {
                Some(p) => stmt.query_row(params![from, to, p], map_row)?,
                None => stmt.query_row(params![from, to], map_row)?,
            };
            let known = standard + non_standard;
            let standard_pct = if known > 0 {
                Some(standard as f64 / known as f64 * 100.0)
            } else {
                None
            };
            TierBreakdown {
                standard,
                non_standard,
                unknown,
                standard_pct,
            }
        };

        // --- tool error rate (window-wide; not project-filtered — tool_use_id is
        // not attributed to a project, only via session_id, deliberately deferred) ---
        let tool_error = {
            let (total, errors, frac) = tool_error_fraction(&conn, from, to)?;
            ToolErrorStats {
                total,
                errors,
                // ToolErrorStats exposes the rate as a percent (0..100).
                error_rate: frac.map(|f| f * 100.0),
            }
        };

        // --- productivity / ROI (project-aware) ---
        let productivity =
            productivity_for(&conn, from, to, project, totals.cost, totals.total_tokens)?;
        let session_rates = session_roi_rates(&conn, from, to, project)?;

        let efficacy = subagent_efficacy(&conn, from, to, project)?;
        let insights = build_insights(
            &totals,
            &by_subagent,
            &subagent_summary,
            &by_model,
            &sessions,
            efficacy.as_ref(),
            &cold_rewrites,
            &tool_breakdown,
            &tool_error,
            &productivity,
            &session_rates,
        );

        Ok(AnalyticsExt {
            totals,
            daily,
            by_model,
            by_project,
            by_subagent,
            subagent_summary,
            costly_by_cost: by_cost,
            costly_by_cache: by_cache,
            anomalies,
            insights,
            projects,
            tool_breakdown,
            tier_breakdown,
            tool_error,
            productivity,
        })
    }
}

impl Clone for SessionUsage {
    fn clone(&self) -> Self {
        Self {
            session_id: self.session_id.clone(),
            project: self.project.clone(),
            start: self.start.clone(),
            end: self.end.clone(),
            total_tokens: self.total_tokens,
            cost: self.cost,
            messages: self.messages,
            cache_create: self.cache_create,
        }
    }
}

/// Per-session-class spend numbers for the "do subagents pay off?" insight.
/// Both halves count only MAIN-loop messages (`is_subagent = 0`) so we compare
/// like-with-like: how much the operator paid on the main thread when they
/// also ran subagents in that session vs when they didn't.
struct EfficacyBucket {
    sessions: i64,
    main_msgs: i64,
    main_cost: f64,
}
struct SubagentEfficacy {
    with_sub: EfficacyBucket,
    without_sub: EfficacyBucket,
}

/// Bucket sessions by "ran a subagent at least once" and compute main-loop
/// cost-per-message in each bucket. Returns None when either bucket is too
/// small for a fair comparison (< 3 sessions).
fn subagent_efficacy(
    conn: &Connection,
    from: &str,
    to: &str,
    project: Option<&str>,
) -> Result<Option<SubagentEfficacy>, rusqlite::Error> {
    let proj_clause = if project.is_some() {
        format!(" AND {} = ?3", resolved_project("project"))
    } else {
        String::new()
    };
    let sql = format!(
        "WITH sess_class AS (
            SELECT session_id, MAX(is_subagent) AS has_sub
            FROM cc_usage
            WHERE ts >= ?1 AND ts < ?2 AND session_id IS NOT NULL{proj}
            GROUP BY session_id
         )
         SELECT sc.has_sub,
                COUNT(DISTINCT cu.session_id),
                SUM(CASE WHEN cu.is_subagent = 0 THEN 1 ELSE 0 END),
                COALESCE(SUM(CASE WHEN cu.is_subagent = 0 THEN cu.cost END), 0.0)
         FROM cc_usage cu
         JOIN sess_class sc USING (session_id)
         WHERE cu.ts >= ?1 AND cu.ts < ?2 AND cu.session_id IS NOT NULL{proj}
         GROUP BY sc.has_sub",
        proj = proj_clause
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut with_sub = EfficacyBucket { sessions: 0, main_msgs: 0, main_cost: 0.0 };
    let mut without_sub = EfficacyBucket { sessions: 0, main_msgs: 0, main_cost: 0.0 };
    let mut handle_row = |r: &rusqlite::Row| -> Result<(), rusqlite::Error> {
        let has_sub: i64 = r.get(0)?;
        let bucket = if has_sub == 1 { &mut with_sub } else { &mut without_sub };
        bucket.sessions = r.get(1)?;
        bucket.main_msgs = r.get(2)?;
        bucket.main_cost = r.get(3)?;
        Ok(())
    };
    match project {
        Some(p) => {
            let mut rows = stmt.query(params![from, to, p])?;
            while let Some(row) = rows.next()? { handle_row(row)?; }
        }
        None => {
            let mut rows = stmt.query(params![from, to])?;
            while let Some(row) = rows.next()? { handle_row(row)?; }
        }
    };
    // Need a fair denominator on both sides — otherwise a single mixed session
    // would dictate the verdict.
    if with_sub.sessions < 3 || without_sub.sessions < 3 {
        return Ok(None);
    }
    Ok(Some(SubagentEfficacy { with_sub, without_sub }))
}

/// Deterministic insight builder. Each rule is a small if-let on aggregates;
/// keys point at i18n entries so the same insight reads fluently in en/ru.
#[allow(clippy::too_many_arguments)]
fn build_insights(
    totals: &Totals,
    by_subagent: &[SubagentUsage],
    subagent: &SubagentSummary,
    by_model: &[ModelUsage],
    sessions: &[SessionUsage],
    efficacy: Option<&SubagentEfficacy>,
    cold_rewrites: &[(String, Option<String>, f64, String)],
    tool_breakdown: &[ToolUsage],
    tool_error: &ToolErrorStats,
    productivity: &Productivity,
    session_rates: &[f64],
) -> Vec<Insight> {
    use serde_json::json;
    let mut out = Vec::new();

    // --- low cache hit ratio (cache underused) ---
    // With enough context volume, a low read-from-cache ratio means the prefix is
    // being rebuilt instead of reused — idle TTL expiry, compaction, or model
    // switching. Distinct from cache_churn (which counts write share): this fires
    // on the aggregate "cache isn't paying off" symptom. Below ~1M tokens the
    // ratio is statistically noisy, so we require volume first.
    const LOW_CACHE_HIT_RATIO: f64 = 0.50;
    const LOW_CACHE_HIT_MIN_TOKENS: i64 = 1_000_000;
    let read_input = totals.input + totals.cache_read;
    if read_input > LOW_CACHE_HIT_MIN_TOKENS && totals.cache_hit_ratio < LOW_CACHE_HIT_RATIO {
        out.push(Insight {
            kind: "low_cache_hit".into(),
            label_key: "insightLowCacheHit".into(),
            params: json!({
                "hit_pct": totals.cache_hit_ratio * 100.0,
                "savings": totals.cache_savings_usd,
            }),
            category: "recommendation",
        });
    }

    // --- tool-mix rules ---
    // Surface the existing tool_breakdown aggregate: short sessions are noisy,
    // so require ≥50 total calls before flagging anything. Edit/Write/MultiEdit
    // dominating means the operator is barreling through changes without
    // re-reading.
    let total_calls: i64 = tool_breakdown.iter().map(|t| t.calls).sum();
    if total_calls >= 50 {
        let writes: i64 = tool_breakdown
            .iter()
            .filter(|t| matches!(t.tool_name.as_str(), "Edit" | "Write" | "MultiEdit"))
            .map(|t| t.calls)
            .sum();
        let writes_pct = writes as f64 / total_calls as f64 * 100.0;
        if writes_pct >= 60.0 {
            out.push(Insight {
                kind: "tool_heavy_writes".into(),
                label_key: "insightToolHeavyWrites".into(),
                params: json!({ "pct": writes_pct, "total_calls": total_calls }),
                category: "recommendation",
            });
        }
    }

    // --- subagent attribution ---
    // The by-subagent breakdown groups anonymously-spawned agents under
    // "<unnamed>". When that bucket dominates, the breakdown stops being
    // actionable — operator should pass `description` so groups are nameable.
    if subagent.subagent_cost > 0.0 {
        if let Some(unnamed) = by_subagent.iter().find(|s| s.agent_name == "<unnamed>") {
            let share = unnamed.cost / subagent.subagent_cost * 100.0;
            if share >= 50.0 {
                out.push(Insight {
                    kind: "subagent_no_attribution".into(),
                    label_key: "insightSubagentNoAttribution".into(),
                    params: json!({ "pct": share, "cost": unnamed.cost }),
                    category: "recommendation",
                });
            }
        }
    }

    // --- cache churn ---
    // Cache writes are 12.5× more expensive than reads. When >15% of all cached
    // input was written (not just read), the operator is invalidating the
    // prefix often — usually by editing files mid-chat or switching system
    // prompts. The fix is shorter chats, not "be more careful with edits".
    let cache_total = totals.cache_create + totals.cache_read;
    if cache_total > 100_000 {
        let churn = totals.cache_create as f64 / cache_total as f64 * 100.0;
        if churn >= 15.0 {
            // Attribute to the sessions that wrote the most into the cache.
            let mut top: Vec<&SessionUsage> = sessions.iter().filter(|s| s.cache_create > 0).collect();
            top.sort_by(|a, b| b.cache_create.cmp(&a.cache_create));
            out.push(Insight {
                kind: "cache_churn".into(),
                label_key: "insightCacheChurn".into(),
                params: json!({
                    "churn_pct": churn,
                    "affected": affected_json(&top, 5),
                }),
                category: "recommendation",
            });
        }
    }

    // --- bloated sessions: avg context per message > 150K ---
    // Each turn reads the full conversation context out of cache. A session
    // whose average per-turn context is in the >150K zone is exponentially
    // expensive to continue — a fresh chat would be cheaper.
    let mut bloated: Vec<&SessionUsage> = sessions
        .iter()
        .filter(|s| s.messages > 5 && (s.total_tokens / s.messages.max(1)) > 150_000)
        .collect();
    bloated.sort_by(|a, b| {
        let aa = a.total_tokens / a.messages.max(1);
        let bb = b.total_tokens / b.messages.max(1);
        bb.cmp(&aa)
    });
    if let Some(top) = bloated.first() {
        let avg_ctx = top.total_tokens / top.messages.max(1);
        out.push(Insight {
            kind: "bloated_session".into(),
            label_key: "insightBloatedSession".into(),
            params: json!({
                "session": top.session_id.chars().take(8).collect::<String>(),
                "avg_ctx": avg_ctx,
                "cost": top.cost,
                "affected": affected_json(&bloated, 5),
            }),
            category: "recommendation",
        });
    }

    // --- long sessions: > 8h span OR > 300 messages ---
    // Long sessions accumulate context and pay tail cost on every turn. List
    // up to 5 worst offenders so the user can pick where to split.
    let mut long_pairs: Vec<(&SessionUsage, i64)> = sessions
        .iter()
        .filter_map(|s| {
            let hours = parse_duration_hours(&s.start, &s.end).unwrap_or(0);
            if hours >= 8 || s.messages >= 300 { Some((s, hours)) } else { None }
        })
        .collect();
    long_pairs.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.messages.cmp(&a.0.messages)));
    if let Some((top_s, top_h)) = long_pairs.first().copied() {
        let affected: Vec<&SessionUsage> = long_pairs.iter().map(|(s, _)| *s).collect();
        out.push(Insight {
            kind: "long_session".into(),
            label_key: "insightLongSession".into(),
            params: json!({
                "session": top_s.session_id.chars().take(8).collect::<String>(),
                "hours": top_h,
                "messages": top_s.messages,
                "cost": top_s.cost,
                "affected": affected_json(&affected, 5),
            }),
            category: "recommendation",
        });
    }

    // --- mixed models (Opus only — switching opus-4-6 ↔ opus-4-7 is a real
    // operator choice; sonnet/opus split is intentional plan-vs-execute). ---
    let opus_versions: Vec<&str> = by_model
        .iter()
        .filter(|m| m.model.to_ascii_lowercase().contains("opus") && m.cost > 0.0)
        .map(|m| m.model.as_str())
        .collect();
    if opus_versions.len() >= 2 {
        // No per-session model attribution in this struct — fall back to top
        // sessions by cost so the user has somewhere to start digging.
        let mut top: Vec<&SessionUsage> = sessions.iter().collect();
        top.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
        out.push(Insight {
            kind: "mixed_models".into(),
            label_key: "insightMixedModels".into(),
            params: json!({
                "models": opus_versions.join(", "),
                "count": opus_versions.len(),
                "affected": affected_json(&top, 5),
            }),
            category: "recommendation",
        });
    }

    // --- cold cache rewrites, split by cause ---
    // One card aggregating every mid-session cold rewrite (see the classified
    // query above), broken into the three things that drop the cache:
    // compaction rewriting history, the prompt-cache TTL (~1 h) expiring over an
    // idle gap, and a model switch. The frontend renders the per-cause lines;
    // here we tally count + cost per cause, the grand total, and the costliest
    // sessions. A $1 floor keeps trivial rewrites off the board.
    if !cold_rewrites.is_empty() {
        let total_cost: f64 = cold_rewrites.iter().map(|(_, _, c, _)| c).sum();
        if total_cost >= 1.0 {
            // Per-cause tally, in the fixed order we want to read them.
            let mut causes: Vec<serde_json::Value> = Vec::new();
            for cause in ["compaction", "idle", "model_switch"] {
                let n = cold_rewrites.iter().filter(|(_, _, _, k)| k == cause).count();
                if n == 0 {
                    continue;
                }
                let cost: f64 = cold_rewrites
                    .iter()
                    .filter(|(_, _, _, k)| k == cause)
                    .map(|(_, _, c, _)| c)
                    .sum();
                causes.push(json!({ "cause": cause, "n": n, "cost": cost }));
            }

            // Costliest sessions across all causes (top 5) for the affected list.
            let mut by_session: Vec<(String, Option<String>, f64)> = Vec::new();
            for (sid, proj, cost, _) in cold_rewrites {
                match by_session.iter_mut().find(|(s, _, _)| s == sid) {
                    Some(e) => e.2 += cost,
                    None => by_session.push((sid.clone(), proj.clone(), *cost)),
                }
            }
            by_session.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
            let affected: Vec<serde_json::Value> = by_session
                .iter()
                .take(5)
                .map(|(sid, proj, cost)| json!({ "session_id": sid, "project": proj, "cost": cost }))
                .collect();

            out.push(Insight {
                kind: "cold_rewrites".into(),
                label_key: "insightColdRewrites".into(),
                params: json!({
                    "events": cold_rewrites.len(),
                    "cost": total_cost,
                    "causes": serde_json::Value::Array(causes),
                    "affected": serde_json::Value::Array(affected),
                }),
                category: "recommendation",
            });
        }
    }

    // --- subagent efficacy ---
    // "Does spawning a subagent pay off?" — compare main-loop cost-per-message
    // in sessions that ran ≥1 subagent vs sessions that didn't. Report only
    // when the delta is meaningful (≥20% one way or the other).
    if let Some(eff) = efficacy {
        let with_rate = if eff.with_sub.main_msgs > 0 {
            eff.with_sub.main_cost / eff.with_sub.main_msgs as f64
        } else {
            0.0
        };
        let without_rate = if eff.without_sub.main_msgs > 0 {
            eff.without_sub.main_cost / eff.without_sub.main_msgs as f64
        } else {
            0.0
        };
        if with_rate > 0.0 && without_rate > 0.0 {
            let delta_pct = (with_rate - without_rate) / without_rate * 100.0;
            if delta_pct.abs() >= 20.0 {
                // Negative delta = subagents reduced main-loop cost/msg → "help".
                let label_key = if delta_pct < 0.0 {
                    "insightSubagentEfficacyHelp"
                } else {
                    "insightSubagentEfficacyHurt"
                };
                // The "affected" list here surfaces the priciest sessions in
                // the period regardless of bucket — the user can cross-reference
                // them with the by-subagent table to see which had subagents.
                let mut top: Vec<&SessionUsage> = sessions.iter().collect();
                top.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
                out.push(Insight {
                    kind: "subagent_efficacy".into(),
                    label_key: label_key.into(),
                    params: json!({
                        "delta_pct": delta_pct.abs(),
                        "with_rate": with_rate,
                        "without_rate": without_rate,
                        "with_sessions": eff.with_sub.sessions,
                        "without_sessions": eff.without_sub.sessions,
                        "affected": affected_json(&top, 5),
                    }),
                    category: "recommendation",
                });
            }
        }
    }

    // --- tool friction ---
    // A high tool-error rate means the model keeps hitting the environment:
    // missing paths, failing commands, flaky shells. ≥15% over ≥30 calls is
    // notable friction; below those thresholds it's normal iterative noise.
    const TOOL_ERROR_PCT: f64 = 15.0;
    const TOOL_ERROR_MIN: i64 = 30;
    if let Some(rate) = tool_error.error_rate {
        if tool_error.total >= TOOL_ERROR_MIN && rate >= TOOL_ERROR_PCT {
            out.push(Insight {
                kind: "tool_error_rate".into(),
                label_key: "insightToolErrorRate".into(),
                params: json!({
                    "rate": rate,
                    "errors": tool_error.errors,
                    "total": tool_error.total,
                }),
                category: "recommendation",
            });
        }
    }

    // --- low ROI vs. the typical session ---
    // Catches low return on active work: a window that burned much more per active
    // hour than this operator's typical session. Relative (median of per-session
    // $/active-hour) so it doesn't assume an absolute "normal" rate. Needs ≥5
    // sessions with measurable active time for a trustworthy median, plus an
    // absolute floor so tiny periods don't fire.
    const MIN_SESSIONS_FOR_ROI: usize = 5;
    const LOW_ROI_FACTOR: f64 = 2.0;
    const LOW_ROI_MIN_COST: f64 = 5.0;
    const LOW_ROI_MIN_HOURS: f64 = 0.25;
    if session_rates.len() >= MIN_SESSIONS_FOR_ROI {
        if let Some(per_h) = productivity.cost_per_active_hour {
            let median = median_sorted(session_rates);
            if median > 0.0
                && totals.cost >= LOW_ROI_MIN_COST
                && productivity.active_hours >= LOW_ROI_MIN_HOURS
                && per_h >= LOW_ROI_FACTOR * median
            {
                out.push(Insight {
                    kind: "low_roi".into(),
                    label_key: "insightLowRoi".into(),
                    params: json!({
                        "cost": totals.cost,
                        "active_h": productivity.active_hours,
                        "per_h": per_h,
                        "median_h": median,
                    }),
                    category: "recommendation",
                });
            }
        }
    }

    out
}

/// Median of an already-ascending-sorted slice. 0.0 for empty.
fn median_sorted(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// Compact JSON list of sessions for the UI to render under a recommendation
/// ("which sessions caused this?"). Capped at `n` and includes only the fields
/// the dashboard actually displays: session_id, project, cost.
fn affected_json(sessions: &[&SessionUsage], n: usize) -> serde_json::Value {
    use serde_json::json;
    let arr: Vec<serde_json::Value> = sessions
        .iter()
        .take(n)
        .map(|s| json!({
            "session_id": s.session_id,
            "project": s.project,
            "cost": s.cost,
        }))
        .collect();
    serde_json::Value::Array(arr)
}

/// Hours between two RFC3339 timestamps, integer-truncated. None on parse error.
fn parse_duration_hours(start: &str, end: &str) -> Option<i64> {
    let s = chrono::DateTime::parse_from_rfc3339(start).ok()?;
    let e = chrono::DateTime::parse_from_rfc3339(end).ok()?;
    let secs = (e - s).num_seconds();
    if secs < 0 { return Some(0); }
    Some(secs / 3600)
}
