use serde::Serialize;

use crate::analytics::work_tree::WorkTurn;
use crate::analytics::{cc, codex};

pub const MODEL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartProvider {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RestartPointParams {
    pub h: i64,
    pub r: i64,
    pub rhos: Vec<f64>,
}

impl Default for RestartPointParams {
    fn default() -> Self {
        Self {
            h: 300,
            r: 3,
            rhos: vec![0.25, 0.38, 0.64],
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestartPoint {
    pub observed: RestartObserved,
    pub scenarios: Vec<RestartScenario>,
    pub model_version: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestartObserved {
    pub calls: usize,
    pub ctx: Vec<i64>,
    pub cached: Vec<i64>,
    pub first_edit_call: Option<usize>,
    pub ctx_at_first_edit: Option<i64>,
    pub first_cached_share: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestartScenario {
    pub rho: f64,
    pub k: Option<usize>,
    pub save_usd: f64,
    pub save_pct: f64,
    pub last_positive_k: Option<usize>,
}

pub fn calculate_restart_point(
    turns: &[WorkTurn],
    provider: RestartProvider,
    params: &RestartPointParams,
) -> RestartPoint {
    let ctx: Vec<i64> = turns.iter().map(context_tokens).collect();
    let cached: Vec<i64> = turns.iter().map(cached_tokens).collect();
    let first_edit_call = turns.iter().position(has_edit).map(|index| index + 1);
    let ctx_at_first_edit = first_edit_call.map(|call| ctx[call - 1]);
    let first_cached_share = ctx
        .first()
        .and_then(|first| (*first > 0).then(|| cached[0] as f64 / *first as f64));
    let observed = RestartObserved {
        calls: turns.len(),
        ctx,
        cached,
        first_edit_call,
        ctx_at_first_edit,
        first_cached_share,
    };

    let scenarios = params
        .rhos
        .iter()
        .copied()
        .map(|rho| scenario(&observed, turns, provider, params, rho))
        .collect();
    RestartPoint {
        observed,
        scenarios,
        model_version: MODEL_VERSION,
    }
}

fn context_tokens(turn: &WorkTurn) -> i64 {
    turn.input_tokens + cached_tokens(turn)
}

fn cached_tokens(turn: &WorkTurn) -> i64 {
    turn.cache_read_tokens + turn.cache_creation_tokens
}

fn has_edit(turn: &WorkTurn) -> bool {
    turn.calls.iter().any(|call| {
        matches!(
            call.name.trim().to_ascii_lowercase().as_str(),
            "write" | "edit" | "notebookedit" | "apply_patch"
        )
    })
}

fn scenario(
    observed: &RestartObserved,
    turns: &[WorkTurn],
    provider: RestartProvider,
    params: &RestartPointParams,
    rho: f64,
) -> RestartScenario {
    let Some(first_edit) = observed.first_edit_call else {
        return empty_scenario(rho);
    };
    if observed.calls < 2 || !rho.is_finite() || !(0.0..=1.0).contains(&rho) {
        return empty_scenario(rho);
    }
    let input_cost = turns
        .iter()
        .map(|turn| input_cost(provider, turn))
        .sum::<f64>();
    if input_cost == 0.0 {
        return empty_scenario(rho);
    }
    let c0 = observed.ctx[0] as f64;
    let h = params.h as f64;
    let big_h = c0 + h;
    let first_share = observed.first_cached_share.unwrap_or(0.0);
    let mut best: Option<(usize, f64)> = None;
    let mut last_positive_k = None;

    for k in first_edit..observed.calls {
        let delta = (observed.ctx[k - 1] as f64 - c0).max(0.0);
        let continued = tail_saving(&turns[k..], provider, delta, rho, h);
        let (p_in, p_read) = rates(provider, &turns[k].model);
        let p_first = first_share * p_read + (1.0 - first_share) * p_in;
        let restart = big_h * p_first
            + rho * delta * p_in
            + params.r as f64 * (big_h + rho * delta / 2.0) * p_read;
        let saving = continued - restart;
        if saving > 0.0 {
            last_positive_k = Some(k);
            if best.as_ref().map_or(true, |(_, current)| saving > *current) {
                best = Some((k, saving));
            }
        }
    }
    let (k, save_usd) = best.map_or((None, 0.0), |(k, saving)| (Some(k), saving));
    RestartScenario {
        rho,
        k,
        save_usd,
        save_pct: save_usd / input_cost * 100.0,
        last_positive_k,
    }
}

fn tail_saving(tail: &[WorkTurn], provider: RestartProvider, delta: f64, rho: f64, h: f64) -> f64 {
    tail.iter()
        .map(|turn| ((1.0 - rho) * delta - h) * rates(provider, &turn.model).1)
        .sum()
}

fn empty_scenario(rho: f64) -> RestartScenario {
    RestartScenario {
        rho,
        k: None,
        save_usd: 0.0,
        save_pct: 0.0,
        last_positive_k: None,
    }
}

fn rates(provider: RestartProvider, model: &str) -> (f64, f64) {
    const MTOK: i64 = 1_000_000;
    match provider {
        RestartProvider::OpenAi => (
            codex::cost_for(model, MTOK, 0, 0, 0) / MTOK as f64,
            codex::cost_for(model, 0, 0, 0, MTOK) / MTOK as f64,
        ),
        RestartProvider::Anthropic => (
            cc::cost_for(model, MTOK, 0, 0, 0) / MTOK as f64,
            cc::cost_for(model, 0, 0, 0, MTOK) / MTOK as f64,
        ),
    }
}

fn input_cost(provider: RestartProvider, turn: &WorkTurn) -> f64 {
    match provider {
        RestartProvider::OpenAi => codex::cost_for(
            &turn.model,
            context_tokens(turn),
            0,
            turn.cache_creation_tokens,
            turn.cache_read_tokens,
        ),
        RestartProvider::Anthropic => cc::cost_for(
            &turn.model,
            turn.input_tokens,
            0,
            turn.cache_creation_tokens,
            turn.cache_read_tokens,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::work_tree::WorkToolCall;
    use serde_json::Value;

    fn turn(index: usize, ctx: i64, edit: bool) -> WorkTurn {
        let cached = (ctx * 61 / 100).max(1);
        WorkTurn {
            id: index.to_string(),
            parent_uuid: None,
            timestamp: String::new(),
            model: "gpt-5.6-terra".to_string(),
            input_tokens: ctx - cached,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: cached,
            cost: 0.0,
            calls: edit
                .then(|| WorkToolCall {
                    id: "e".to_string(),
                    name: "apply_patch".to_string(),
                    input: Value::Null,
                    result: None,
                    subagent: None,
                })
                .into_iter()
                .collect(),
        }
    }

    fn linear(calls: usize, from: i64, to: i64, edit_at: usize) -> Vec<WorkTurn> {
        (0..calls)
            .map(|i| {
                turn(
                    i,
                    from + i as i64 * (to - from) / (calls as i64 - 1),
                    i == edit_at,
                )
            })
            .collect()
    }

    #[test]
    fn records_context_cache_and_first_edit() {
        let point = calculate_restart_point(
            &[turn(1, 19_000, false), turn(2, 21_000, true)],
            RestartProvider::OpenAi,
            &RestartPointParams::default(),
        );
        assert_eq!(point.observed.ctx, vec![19_000, 21_000]);
        assert_eq!(point.observed.cached, vec![11_590, 12_810]);
        assert_eq!(point.observed.first_edit_call, Some(2));
        assert!((point.observed.first_cached_share.unwrap() - 0.61).abs() < 1e-9);
    }

    #[test]
    fn rejects_short_session_at_median_rho() {
        let point = calculate_restart_point(
            &linear(27, 19_000, 38_000, 9),
            RestartProvider::OpenAi,
            &RestartPointParams::default(),
        );
        assert_eq!(point.scenarios[1].rho, 0.38);
        assert_eq!(point.scenarios[1].k, None);
    }

    #[test]
    fn finds_a_restart_in_the_long_codex_synthetic() {
        let point = calculate_restart_point(
            &linear(38, 19_000, 94_000, 2),
            RestartProvider::OpenAi,
            &RestartPointParams::default(),
        );
        let low = &point.scenarios[0];
        let median = &point.scenarios[1];
        assert!((13..=19).contains(&median.k.unwrap()), "k = {:?}", median.k);
        assert!(median.save_usd > 0.0);
        assert!(low.save_usd > median.save_usd);
        assert_eq!(point.scenarios[2].k, None);
    }

    #[test]
    fn never_restarts_before_the_first_edit() {
        let point = calculate_restart_point(
            &linear(38, 19_000, 94_000, 30),
            RestartProvider::OpenAi,
            &RestartPointParams::default(),
        );
        assert!(point.scenarios.iter().all(|s| s.k.map_or(true, |k| k >= 31)));
        let none = calculate_restart_point(
            &linear(38, 19_000, 94_000, 99),
            RestartProvider::OpenAi,
            &RestartPointParams::default(),
        );
        assert!(none.scenarios.iter().all(|s| s.k.is_none()));
    }

    #[test]
    fn prices_each_avoided_call_at_its_own_model_rate() {
        let mut tail = vec![turn(2, 20, false), turn(3, 30, false)];
        tail[0].model = "gpt-5.6-luna".to_string();
        let saving = tail_saving(&tail, RestartProvider::OpenAi, 10.0, 0.0, 0.0);
        let luna = rates(RestartProvider::OpenAi, "gpt-5.6-luna").1;
        let terra = rates(RestartProvider::OpenAi, "gpt-5.6-terra").1;
        assert!(luna != terra);
        assert!((saving - 10.0 * (luna + terra)).abs() < 1e-15);
    }
}
