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

#[derive(Debug, Serialize)]
pub struct PeriodCompare {
    pub current: Totals,
    pub previous: Totals,
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
}

/// Aggregate use of one tool (e.g. "Edit", "Bash", "Read") over a window:
/// total calls and the messages they were spread across.
#[derive(Debug, Serialize)]
pub struct ToolUsage {
    pub tool_name: String,
    pub calls: i64,
    pub messages: i64,
}

fn totals_for(conn: &Connection, from: &str, to: &str) -> Result<Totals, rusqlite::Error> {
    conn.query_row(
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
            })
        },
    )
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
    let sql = if project.is_some() {
        "SELECT session_id, MAX(project), MIN(ts), MAX(ts),
                SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*),
                SUM(cache_create)
         FROM cc_usage
         WHERE ts >= ?1 AND ts < ?2 AND session_id IS NOT NULL AND project = ?3
         GROUP BY session_id"
    } else {
        "SELECT session_id, MAX(project), MIN(ts), MAX(ts),
                SUM(input+output+cache_create+cache_read), SUM(cost), COUNT(*),
                SUM(cache_create)
         FROM cc_usage
         WHERE ts >= ?1 AND ts < ?2 AND session_id IS NOT NULL
         GROUP BY session_id"
    };
    let mut stmt = conn.prepare(sql)?;
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
            let mut stmt = conn.prepare(
                "SELECT project, SUM(input+output+cache_create+cache_read), SUM(cost),
                        COUNT(*), COUNT(DISTINCT session_id)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY project ORDER BY 2 DESC",
            )?;
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
        let proj_clause = if project.is_some() { " AND project = ?3" } else { "" };
        let prepare_proj = |sql_tmpl: String| -> Result<rusqlite::Statement<'_>, rusqlite::Error> {
            conn.prepare(&sql_tmpl.replace("{proj}", proj_clause))
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
                })
            };
            match project {
                Some(p) => stmt.query_row(params![from, to, p], map_row)?,
                None => stmt.query_row(params![from, to], map_row)?,
            }
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
            let mut stmt = conn.prepare(
                "SELECT project, SUM(input+output+cache_create+cache_read), SUM(cost),
                        COUNT(*), COUNT(DISTINCT session_id)
                 FROM cc_usage WHERE ts >= ?1 AND ts < ?2 GROUP BY project ORDER BY 2 DESC",
            )?;
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
            let mut stmt = conn.prepare(
                "SELECT DISTINCT project FROM cc_usage
                 WHERE ts >= ?1 AND ts < ?2 AND project IS NOT NULL
                 ORDER BY project",
            )?;
            let rows = stmt
                .query_map(params![from, to], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        // --- cold restarts inside sessions (compact / model switch fingerprint) ---
        // A "cold turn" has cache_read=0 + meaningful cache_create. The first
        // turn of any session is naturally cold, so a session with ≥2 cold
        // turns has at least one mid-session restart (auto-compaction or a
        // model switch). "cold_cost" sums what was paid to rebuild the cache
        // on those mid-session restarts — that's the avoidable spend.
        //
        // Threshold (cache_create > 10_000) is empirical: scanning all local
        // transcripts gives post-compact cache_create at median 24K, p25 ~20K,
        // p10 ~2K (essentially noise). First-turn cache_create medians 15K.
        // 10K sits between p10 (noise) and p25 (real compactions) and is
        // smaller than typical first-turn writes, so the ≥2-count filter
        // reliably excludes "just a normal session start".
        let cold_restarts = {
            let mut stmt = prepare_proj(
                "WITH cold AS (
                    SELECT session_id, project, COUNT(*) AS n_cold, SUM(cost) AS cold_cost
                    FROM cc_usage
                    WHERE ts >= ?1 AND ts < ?2 AND session_id IS NOT NULL
                      AND cache_read = 0 AND cache_create > 10000{proj}
                    GROUP BY session_id
                    HAVING n_cold >= 2
                 )
                 SELECT session_id, project, n_cold, cold_cost
                 FROM cold
                 ORDER BY cold_cost DESC"
                    .to_string(),
            )?;
            let map_row = |r: &rusqlite::Row| -> Result<(String, Option<String>, i64, f64), rusqlite::Error> {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            };
            let rows: Vec<(String, Option<String>, i64, f64)> = match project {
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

        let efficacy = subagent_efficacy(&conn, from, to, project)?;
        let insights = build_insights(
            &totals,
            &by_project,
            &by_subagent,
            &subagent_summary,
            &daily,
            &by_model,
            &sessions,
            efficacy.as_ref(),
            &cold_restarts,
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
    let proj_clause = if project.is_some() { " AND project = ?3" } else { "" };
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
fn build_insights(
    totals: &Totals,
    by_project: &[ProjectUsage],
    by_subagent: &[SubagentUsage],
    subagent: &SubagentSummary,
    daily: &[DailyPoint],
    by_model: &[ModelUsage],
    sessions: &[SessionUsage],
    efficacy: Option<&SubagentEfficacy>,
    cold_restarts: &[(String, Option<String>, i64, f64)],
) -> Vec<Insight> {
    use serde_json::json;
    let mut out = Vec::new();

    if let Some(top) = by_project.iter().filter(|p| p.cost > 0.0).next() {
        out.push(Insight {
            kind: "top_project".into(),
            label_key: "insightTopProject".into(),
            params: json!({
                "project": top.project.clone().unwrap_or_else(|| "—".into()),
                "cost": top.cost,
                "share_pct": pct(top.cost, totals.cost),
            }),
            category: "observation",
        });
    }

    let cache_tokens = totals.cache_create + totals.cache_read;
    if totals.total_tokens > 0 {
        let share = (cache_tokens as f64) / (totals.total_tokens as f64) * 100.0;
        if share >= 60.0 {
            out.push(Insight {
                kind: "cache_share".into(),
                label_key: "insightCacheShare".into(),
                params: json!({ "pct": share }),
                category: "observation",
            });
        }
    }

    let total_cost = subagent.subagent_cost + subagent.main_cost;
    if total_cost > 0.0 && subagent.subagent_cost > 0.0 {
        out.push(Insight {
            kind: "subagent_share".into(),
            label_key: "insightSubagentShare".into(),
            params: json!({
                "pct": subagent.subagent_cost / total_cost * 100.0,
                "messages": subagent.subagent_messages,
                "sessions": subagent.subagent_sessions,
            }),
            category: "observation",
        });
    }
    if let Some(top_agent) = by_subagent.iter().next() {
        if top_agent.cost > 0.0 {
            out.push(Insight {
                kind: "top_subagent".into(),
                label_key: "insightTopSubagent".into(),
                params: json!({
                    "name": top_agent.agent_name,
                    "cost": top_agent.cost,
                }),
                category: "observation",
            });
        }
    }

    if let Some(peak) = daily.iter().max_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(std::cmp::Ordering::Equal)) {
        if peak.cost > 0.0 {
            out.push(Insight {
                kind: "peak_day".into(),
                label_key: "insightPeakDay".into(),
                params: json!({ "date": peak.date, "cost": peak.cost }),
                category: "observation",
            });
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

    // --- cold restarts inside sessions ---
    // A session's first turn is naturally cold; ≥2 cold turns mean at least
    // one mid-session restart (auto-compaction or model switch). Sum the cost
    // of those cold turns — that's the avoidable spend.
    if !cold_restarts.is_empty() {
        let total_cold_cost: f64 = cold_restarts.iter().map(|(_, _, _, c)| c).sum();
        let total_restarts: i64 = cold_restarts
            .iter()
            .map(|(_, _, n, _)| n.saturating_sub(1))
            .sum();
        if total_restarts > 0 {
            let affected: Vec<serde_json::Value> = cold_restarts
                .iter()
                .take(5)
                .map(|(sid, proj, _, cost)| {
                    json!({
                        "session_id": sid,
                        "project": proj,
                        "cost": cost,
                    })
                })
                .collect();
            out.push(Insight {
                kind: "cold_restarts".into(),
                label_key: "insightColdRestarts".into(),
                params: json!({
                    "restarts": total_restarts,
                    "sessions": cold_restarts.len(),
                    "cost": total_cold_cost,
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

    out
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

fn pct(part: f64, total: f64) -> f64 {
    if total > 0.0 { part / total * 100.0 } else { 0.0 }
}
