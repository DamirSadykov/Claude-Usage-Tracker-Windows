#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn temp_repo() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "flowcheck-fixture-{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    fs::create_dir_all(p.join("src")).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&p)
        .status()
        .unwrap();
    p
}
fn put(repo: &Path, fixture: &str) {
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixture")
            .join(fixture),
        repo.join("src/Notifier.cs"),
    )
    .unwrap();
}
fn commit(repo: &Path) -> String {
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
fn spec() -> flow::Spec {
    serde_yaml::from_str("file: src/Notifier.cs\nmethod: SendSms\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: all\n").unwrap()
}

fn fixture_result(file: &str) -> flow::ResultRow {
    let repo = temp_repo();
    put(&repo, "Notifier.base.cs");
    let base = commit(&repo);
    put(&repo, file);
    let got = flow::check_method(&spec(), &repo, &base, None, false);
    let _ = fs::remove_dir_all(repo);
    got
}

macro_rules! fixture_case {
    ($name:ident, $file:literal, $status:literal) => {
        fixture_case!($name, $file, $status, []);
    };
    ($name:ident, $file:literal, $status:literal, [$($extra:literal),*]) => {
        #[test]
        fn $name() {
            let result = fixture_result($file);
            assert_eq!(result.status, $status, $file);
            if $status == "pass" {
                let expected: Vec<String> = vec![$($extra.to_string()),*];
                assert_eq!(result.extra, expected, $file);
            }
        }
    };
}

fixture_case!(fixture_good, "Notifier.good.cs", "pass");
fixture_case!(fixture_m1_no_getphone, "Notifier.m1_no_getphone.cs", "fail");
fixture_case!(fixture_m2_one_branch, "Notifier.m2_one_branch.cs", "fail");
fixture_case!(
    fixture_m3_result_dropped,
    "Notifier.m3_result_dropped.cs",
    "fail"
);
fixture_case!(fixture_m4_after_send, "Notifier.m4_after_send.cs", "fail");
fixture_case!(
    fixture_m5_partial_exit,
    "Notifier.m5_partial_exit.cs",
    "fail"
);
fixture_case!(fixture_m6_and_cond, "Notifier.m6_and_cond.cs", "fail");
fixture_case!(fixture_m7_or_enter, "Notifier.m7_or_enter.cs", "fail");
fixture_case!(fixture_m8_wrong_else, "Notifier.m8_wrong_else.cs", "fail");
fixture_case!(fixture_ok_alias, "Notifier.ok_alias.cs", "pass");
fixture_case!(fixture_ok_eq_false, "Notifier.ok_eq_false.cs", "pass");
fixture_case!(
    fixture_ok_log_block,
    "Notifier.ok_log_block.cs",
    "pass",
    ["call:System.Console.WriteLine"]
);
fixture_case!(
    fixture_ok_or_cond,
    "Notifier.ok_or_cond.cs",
    "pass",
    ["call:string.IsNullOrEmpty"]
);
fixture_case!(fixture_ok_positive_if, "Notifier.ok_positive_if.cs", "pass");
fixture_case!(
    fixture_ok_ternary_guard,
    "Notifier.ok_ternary_guard.cs",
    "pass"
);
fixture_case!(fixture_ok_throw, "Notifier.ok_throw.cs", "pass");

fn check_text(base_text: &str, head_text: &str, spec_text: &str) -> flow::ResultRow {
    let repo = temp_repo();
    fs::write(repo.join("src/Notifier.cs"), base_text).unwrap();
    let base = commit(&repo);
    fs::write(repo.join("src/Notifier.cs"), head_text).unwrap();
    let spec = serde_yaml::from_str(spec_text).unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    result
}

#[test]
fn preserve_defaults_to_all() {
    let r = check_text(
        "class N { void M() { GetPhone(); Send(); } void GetPhone() {} void Send() {} }",
        "class N { void M() { Send(); } void GetPhone() {} void Send() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange: []\n",
    );
    assert_eq!(r.status, "fail");
    assert!(r.problems.iter().any(|p| p.contains("GetPhone")));
}

#[test]
fn discarded_result_is_detected_on_the_call_node() {
    let r = check_text(
        "class N { void M() { Send(); } bool ValidatePhone() => true; void Send() {} }",
        "class N { void M() { this.ValidatePhone(); Send(); } bool ValidatePhone() => true; void Send() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: none\n",
    );
    assert_eq!(r.status, "fail");
    assert!(r
        .problems
        .iter()
        .any(|p| p.contains("result of ValidatePhone dropped")));
}

#[test]
fn comment_after_return_still_exits() {
    let r = check_text(
        "class N { void M() { Send(); } bool ValidatePhone() => true; void Send() {} }",
        "class N { void M() { if (!ValidatePhone()) { return; // invalid\n } Send(); } bool ValidatePhone() => true; void Send() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: none\n",
    );
    assert_eq!(r.status, "pass", "{:?}", r.problems);
}

#[test]
fn local_declaration_is_an_after_anchor() {
    let r = check_text(
        "class N { void M() { Audit(); } string GetPhone() => \"\"; void Audit() {} }",
        "class N { void M() { var phone = GetPhone(); Audit(); } string GetPhone() => \"\"; void Audit() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange:\n  - insert: Audit\n    after: GetPhone\npreserve: none\n",
    );
    assert_eq!(r.status, "pass", "{:?}", r.problems);
}

#[test]
fn flow_expands_each_sibling_branch() {
    let r = check_text(
        "class N { void M() { Helper(); Helper(); } void Helper() { A(); } void A() {} }",
        "class N { void M() { Helper(); Helper(); } void Helper() { A(); } void A() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange: []\npreserve: all\n",
    );
    assert_eq!(
        r.base_steps.unwrap(),
        vec!["call:Helper", "call:A", "call:Helper", "call:A"]
    );
}

#[test]
fn same_line_calls_are_checked_individually() {
    let r = check_text(
        "class N { void M() { Send(); } bool ValidatePhone() => true; void Send() {} }",
        "class N { void M() { var valid = ValidatePhone(); ValidatePhone(); Send(); } bool ValidatePhone() => true; void Send() {} }",
        "file: src/Notifier.cs\nmethod: M\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: none\n",
    );
    assert_eq!(r.status, "fail");
    assert!(r
        .problems
        .iter()
        .any(|p| p.contains("result of ValidatePhone dropped")));
}

#[test]
fn overload_without_params_is_cannot_not_an_arbitrary_method() {
    let repo = temp_repo();
    fs::write(
        repo.join("src/Notifier.cs"),
        "class X { void M(int x) {} void M(string x) {} }",
    )
    .unwrap();
    let base = commit(&repo);
    let spec: flow::Spec =
        serde_yaml::from_str("file: src/Notifier.cs\nmethod: M\nchange: []\n").unwrap();
    let r = flow::check_method(&spec, &repo, &base, None, false);
    assert_eq!(r.status, "cannot");
    assert!(r.problems[0].contains("overloads"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn expansion_cut_by_depth_is_reported() {
    let code = "class N { void M() { A(); } void A() { B(); } void B() { C(); } void C() { D(); } void D() {} }";
    let r = check_text(code, code, "file: src/Notifier.cs\nmethod: M\nchange: []\n");
    assert_eq!(r.status, "pass", "{:?}", r.problems);
    assert_eq!(r.depth_limited, vec!["C".to_string()]);
}

#[test]
fn shallow_expansion_reports_no_depth_limit() {
    let code = "class N { void M() { A(); } void A() { B(); } void B() {} }";
    let r = check_text(code, code, "file: src/Notifier.cs\nmethod: M\nchange: []\n");
    assert!(r.depth_limited.is_empty(), "{:?}", r.depth_limited);
}
