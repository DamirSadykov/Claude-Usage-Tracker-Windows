#[path = "../src/extra.rs"]
mod extra;
#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn check(base_text: &str, head_text: &str, spec_text: &str) -> flow::ResultRow {
    let repo = std::env::temp_dir().join(format!(
        "flowcheck-extra-{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    fs::create_dir_all(repo.join("src")).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap();
    let file = repo.join("src/N.cs");
    fs::write(&file, base_text).unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(&repo)
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "base",
        ])
        .current_dir(&repo)
        .status()
        .unwrap();
    let base = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&repo)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    fs::write(file, head_text).unwrap();
    let spec = serde_yaml::from_str(spec_text).unwrap();
    let row = flow::check_method(&spec, &repo, base.trim(), None, false);
    let _ = fs::remove_dir_all(repo);
    row
}

#[test]
fn reports_an_undeclared_call_without_failing_the_flow_check() {
    let row = check(
        "class N { void M() { Send(); } void Send() {} bool ValidatePhone() => true; }",
        "class N { void M() { if (!ValidatePhone()) return; ClearCache(); Send(); } void Send() {} bool ValidatePhone() => true; }",
        "file: src/N.cs\nmethod: M\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: all\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert_eq!(row.extra, vec!["call:ClearCache"]);
}

#[test]
fn extracting_a_same_file_helper_is_not_an_extra_step() {
    let row = check(
        "class N { void M() { A(); B(); } void A() {} void B() {} }",
        "class N { void M() { RunCycle(); } void RunCycle() { A(); B(); } void A() {} void B() {} }",
        "file: src/N.cs\nmethod: M\nchange: []\npreserve: all\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(row.extra.is_empty(), "{:?}", row.extra);
}

#[test]
fn an_inserted_helper_body_is_not_reported() {
    let row = check(
        "class N { void M() { Send(); } void Send() {} void Audit() {} }",
        "class N { void M() { Added(); Send(); } void Added() { Audit(); } void Send() {} void Audit() {} }",
        "file: src/N.cs\nmethod: M\nchange:\n  - insert: Added\n    before: Send\npreserve: all\n",
    );
    assert_eq!(row.status, "pass", "{:?}", row.problems);
    assert!(row.extra.is_empty(), "{:?}", row.extra);
}
