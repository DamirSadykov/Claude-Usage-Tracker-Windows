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
fn flag_anomalies(sessions: Vec<SessionUsage>) -> Vec<SessionUsage> {
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
        .into_iter()
        .filter(|s| (s.total_tokens as f64) > threshold)
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
        let anomalies = flag_anomalies(sessions);

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
        let anomalies = flag_anomalies(sessions);

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

        let insights = build_insights(&totals, &by_project, &by_subagent, &subagent_summary, &daily);

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

/// Deterministic insight builder. Each rule is a small if-let on aggregates;
/// keys point at i18n entries so the same insight reads fluently in en/ru.
fn build_insights(
    totals: &Totals,
    by_project: &[ProjectUsage],
    by_subagent: &[SubagentUsage],
    subagent: &SubagentSummary,
    daily: &[DailyPoint],
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
            });
        }
    }

    if let Some(peak) = daily.iter().max_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(std::cmp::Ordering::Equal)) {
        if peak.cost > 0.0 {
            out.push(Insight {
                kind: "peak_day".into(),
                label_key: "insightPeakDay".into(),
                params: json!({ "date": peak.date, "cost": peak.cost }),
            });
        }
    }

    out
}

fn pct(part: f64, total: f64) -> f64 {
    if total > 0.0 { part / total * 100.0 } else { 0.0 }
}
