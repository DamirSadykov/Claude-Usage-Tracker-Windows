//! End-to-end test of the Claude Code ingest conveyor on on-disk fixtures:
//! `cc::ingest` walks `<base>/projects/**/*.jsonl`, parses assistant token usage,
//! dedups by message id and stores it; we then assert the aggregates `stats`
//! exposes. Fixtures live under `tests/fixtures/projects/`; the DB is in-memory.
//!
//! Expected fixture contents (see tests/fixtures/projects/*):
//!   msg-1  opus    in 1000  out 2000               -> cost 0.055
//!   msg-2  sonnet  in  500  out 1000               -> cost 0.0165
//!   msg-3  opus    in  100  out  100  cc 1000 cr 10000 -> cost 0.01425
//! plus a duplicate msg-1 (deduped), a user line and a <synthetic> line (skipped).

use std::path::{Path, PathBuf};

use claude_usage_tracker_lib::cc;
use claude_usage_tracker_lib::stats::StatsDb;

fn fixtures_base() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn mem_db() -> StatsDb {
    StatsDb::open(Path::new(":memory:")).unwrap()
}

// Window wide enough to cover every fixture row.
const ALL_FROM: &str = "2026-05-19T00:00:00Z";
const ALL_TO: &str = "2026-05-22T00:00:00Z";

#[test]
fn ingest_dedups_skips_noise_and_aggregates() {
    let db = mem_db();

    // 3 real assistant rows inserted; duplicate msg-1, the user line and the
    // <synthetic> line do not count.
    let inserted = cc::ingest(&fixtures_base(), &db).unwrap();
    assert_eq!(inserted, 3, "expected 3 deduped assistant rows");

    let a = db.analytics(ALL_FROM, ALL_TO).unwrap();
    let t = &a.totals;
    assert_eq!(t.messages, 3);
    assert_eq!(t.sessions, 2, "sess-A and sess-B");
    assert_eq!(t.input, 1600); // 1000 + 500 + 100
    assert_eq!(t.output, 3100); // 2000 + 1000 + 100
    assert_eq!(t.cache_create, 1000);
    assert_eq!(t.cache_read, 10000);
    assert_eq!(t.total_tokens, 15700); // 1600 + 3100 + 1000 + 10000
    assert!(
        (t.cost - 0.085_75).abs() < 1e-6,
        "total cost was {}",
        t.cost
    );

    // Per-model breakdown: opus has 2 messages (msg-1, msg-3), sonnet 1.
    let opus = a
        .by_model
        .iter()
        .find(|m| m.model.contains("opus"))
        .expect("opus row");
    assert_eq!(opus.messages, 2);
    let sonnet = a
        .by_model
        .iter()
        .find(|m| m.model.contains("sonnet"))
        .expect("sonnet row");
    assert_eq!(sonnet.messages, 1);
}

#[test]
fn second_ingest_is_incremental_noop() {
    let db = mem_db();
    assert_eq!(cc::ingest(&fixtures_base(), &db).unwrap(), 3);
    // Files are unchanged (same size + mtime), so nothing is re-inserted.
    assert_eq!(cc::ingest(&fixtures_base(), &db).unwrap(), 0);
}

#[test]
fn window_excludes_rows_outside_range() {
    let db = mem_db();
    cc::ingest(&fixtures_base(), &db).unwrap();

    // Only 2026-05-20 → msg-1 and msg-2 (both sess-A), msg-3 (05-21) excluded.
    let day = db
        .analytics("2026-05-20T00:00:00Z", "2026-05-21T00:00:00Z")
        .unwrap();
    assert_eq!(day.totals.messages, 2);
    assert_eq!(day.totals.sessions, 1);
    assert!((day.totals.cost - 0.071_5).abs() < 1e-6);

    // cost_in agrees with the analytics window.
    let cost = db
        .cost_in("2026-05-20T00:00:00Z", "2026-05-21T00:00:00Z")
        .unwrap();
    assert!((cost - 0.071_5).abs() < 1e-6, "cost_in was {cost}");
}

#[test]
fn missing_projects_dir_is_zero() {
    let db = mem_db();
    let base = fixtures_base().join("does-not-exist");
    assert_eq!(cc::ingest(&base, &db).unwrap(), 0);
}
