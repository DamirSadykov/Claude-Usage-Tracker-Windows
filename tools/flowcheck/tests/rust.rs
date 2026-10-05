#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-rust-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    fs::create_dir_all(path.join("src")).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&path)
        .status()
        .unwrap();
    path
}
fn copy(repo: &PathBuf, name: &str) {
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixture/rust")
            .join(name),
        repo.join("src/Notifier.rs"),
    )
    .unwrap();
}
fn commit(repo: &PathBuf) -> String {
    Command::new("git")
        .args(["add", "."])
        .current_dir(repo)
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
        .current_dir(repo)
        .status()
        .unwrap();
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .into()
}
fn check(name: &str, guard: &str) -> flow::ResultRow {
    let repo = repo();
    copy(&repo, "Notifier.base.rs");
    let base = commit(&repo);
    copy(&repo, name);
    let spec: flow::Spec = serde_yaml::from_str(&format!("file: src/Notifier.rs\nmethod: send_sms\nchange:\n  - insert: validate_phone\n    before: send\n    guard: {guard}\npreserve: all\n")).unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, false);
    let _ = fs::remove_dir_all(repo);
    result
}

fn csharp_status(name: &str) -> String {
    let repo = repo();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    fs::copy(
        fixtures.join("Notifier.base.cs"),
        repo.join("src/Notifier.cs"),
    )
    .unwrap();
    let base = commit(&repo);
    fs::copy(fixtures.join(name), repo.join("src/Notifier.cs")).unwrap();
    let spec: flow::Spec = serde_yaml::from_str("file: src/Notifier.cs\nmethod: SendSms\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: all\n").unwrap();
    let status = flow::check_method(&spec, &repo, &base, None, false).status;
    let _ = fs::remove_dir_all(repo);
    status
}

macro_rules! cases { ($($test:ident: $file:literal => $status:literal),+ $(,)?) => { $(
    #[test] fn $test() { let result = check($file, "returns-bool"); assert_eq!(result.status, $status, "{}: {:?}", $file, result.problems); }
)+ } }
cases!(
    good: "Notifier.good.rs" => "pass", m1: "Notifier.m1_no_getphone.rs" => "fail",
    m2: "Notifier.m2_one_branch.rs" => "fail", m3: "Notifier.m3_result_dropped.rs" => "fail",
    m4: "Notifier.m4_after_send.rs" => "fail", m5: "Notifier.m5_partial_exit.rs" => "fail",
    m6: "Notifier.m6_and_cond.rs" => "fail", m7: "Notifier.m7_or_enter.rs" => "fail",
    m8: "Notifier.m8_wrong_else.rs" => "fail", alias: "Notifier.ok_alias.rs" => "pass",
    eq_false: "Notifier.ok_eq_false.rs" => "pass", log: "Notifier.ok_log_block.rs" => "pass",
    or_cond: "Notifier.ok_or_cond.rs" => "pass", positive: "Notifier.ok_positive_if.rs" => "pass",
    ternary: "Notifier.ok_ternary_guard.rs" => "pass", throwing: "Notifier.ok_throw.rs" => "pass",
);

#[test]
fn translated_variants_match_csharp_statuses() {
    for name in [
        "good",
        "m1_no_getphone",
        "m2_one_branch",
        "m3_result_dropped",
        "m4_after_send",
        "m5_partial_exit",
        "m6_and_cond",
        "m7_or_enter",
        "m8_wrong_else",
        "ok_alias",
        "ok_eq_false",
        "ok_log_block",
        "ok_or_cond",
        "ok_positive_if",
        "ok_ternary_guard",
        "ok_throw",
    ] {
        assert_eq!(
            check(&format!("Notifier.{name}.rs"), "returns-bool").status,
            csharp_status(&format!("Notifier.{name}.cs")),
            "{name}"
        );
    }
}

#[test]
fn result_guards_and_rust_forms_are_accepted() {
    for file in [
        "Notifier.ok_question.rs",
        "Notifier.ok_is_err.rs",
        "Notifier.ok_let_else.rs",
        "Notifier.ok_match.rs",
    ] {
        assert_eq!(check(file, "returns-result").status, "pass", "{file}");
    }
}

#[test]
fn guard_in_closure_does_not_guard_the_method() {
    assert_eq!(
        check("Notifier.fail_closure_guard.rs", "returns-result").status,
        "fail"
    );
}

#[test]
fn trait_and_impl_methods_and_macros_are_steps() {
    let repo = repo();
    copy(&repo, "Notifier.trait_base.rs");
    let base = commit(&repo);
    copy(&repo, "Notifier.trait.rs");
    let spec: flow::Spec = serde_yaml::from_str("file: src/Notifier.rs\nmethod: Notifier::send_sms\nchange:\n  - insert: validate_phone\n    before: send\n    guard: returns-result\npreserve: all\n").unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    assert_eq!(result.status, "pass", "{:?}", result.problems);
}
