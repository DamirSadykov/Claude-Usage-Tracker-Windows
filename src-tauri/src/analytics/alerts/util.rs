//! Threshold bucketing + quiet-hours math — the single source of truth shared by
//! the tray/UI colour levels and the alert engine. Pure and deterministic.

use super::config::AppConfig;
use super::DEFAULT_THRESHOLDS;

/// Three thresholds, ascending. Falls back to defaults if fewer than three.
pub fn normalize(th: &[f64]) -> [f64; 3] {
    if th.len() < 3 {
        return DEFAULT_THRESHOLDS;
    }
    let mut s = [th[0], th[1], th[2]];
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s
}

/// 0..3 — the number of thresholds the value has reached (green/yellow/orange/red).
pub fn tier_level(pct: f64, th: &[f64]) -> u8 {
    let [a, b, c] = normalize(th);
    if pct < a {
        0
    } else if pct < b {
        1
    } else if pct < c {
        2
    } else {
        3
    }
}

/// The 5-hour session has its own thresholds; every other tier shares the weekly set.
pub(crate) fn thresholds_for_tier<'a>(key: &str, cfg: &'a AppConfig) -> &'a [f64] {
    if key == "five_hour" {
        &cfg.session_thresholds
    } else {
        &cfg.weekly_thresholds
    }
}

fn parse_hm(s: &str) -> u32 {
    let mut it = s.split(':');
    let h: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let m: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    h * 60 + m
}

/// `now_min` is minutes since local midnight. Midnight-crossing windows supported.
pub fn in_quiet_hours(start: &str, end: &str, now_min: u32) -> bool {
    let s = parse_hm(start);
    let e = parse_hm(end);
    if s == e {
        return false;
    }
    if s < e {
        now_min >= s && now_min < e
    } else {
        now_min >= s || now_min < e
    }
}
