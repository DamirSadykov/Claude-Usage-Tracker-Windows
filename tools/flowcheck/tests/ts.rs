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
        "flowcheck-ts-{}-{}",
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

fn fixture(ext: &str, name: &str) -> flow::ResultRow {
    let repo = repo();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixture")
        .join(ext);
    fs::copy(
        root.join(format!("Notifier.base.{ext}")),
        repo.join(format!("src/Notifier.{ext}")),
    )
    .unwrap();
    let base = commit(&repo);
    fs::copy(
        root.join(format!("Notifier.{name}.{ext}")),
        repo.join(format!("src/Notifier.{ext}")),
    )
    .unwrap();
    let spec: flow::Spec = serde_yaml::from_str(&format!(
        "file: src/Notifier.{ext}\nmethod: Notifier.sendSms\nchange:\n  - insert: validatePhone\n    before: send\n    guard: returns-bool\npreserve: all\n"
    )).unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, false);
    let _ = fs::remove_dir_all(repo);
    result
}

#[test]
fn translated_variants_have_csharp_statuses_in_ts_and_js() {
    for (name, status) in [
        ("good", "pass"),
        ("m1_no_getphone", "fail"),
        ("m2_one_branch", "fail"),
        ("m3_result_dropped", "fail"),
        ("m4_after_send", "fail"),
        ("m5_partial_exit", "fail"),
        ("m6_and_cond", "fail"),
        ("m7_or_enter", "fail"),
        ("m8_wrong_else", "fail"),
        ("ok_alias", "pass"),
        ("ok_eq_false", "pass"),
        ("ok_log_block", "pass"),
        ("ok_or_cond", "pass"),
        ("ok_positive_if", "pass"),
        ("ok_ternary_guard", "pass"),
        ("ok_throw", "pass"),
    ] {
        for ext in ["ts", "js"] {
            let result = fixture(ext, name);
            assert_eq!(result.status, status, "{ext}/{name}: {:?}", result.problems);
        }
    }
}

fn check_text(
    ext: &str,
    base_text: &str,
    head_text: &str,
    method: &str,
    guard: &str,
) -> flow::ResultRow {
    let repo = repo();
    let file = repo.join(format!("src/Notifier.{ext}"));
    fs::write(&file, base_text).unwrap();
    let base = commit(&repo);
    fs::write(&file, head_text).unwrap();
    let spec: flow::Spec = serde_yaml::from_str(&format!(
        "file: src/Notifier.{ext}\nmethod: {method}\nchange:\n  - insert: validate\n    before: send\n    guard: {guard}\npreserve: none\n"
    )).unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    result
}

fn check_text_with_spec(
    ext: &str,
    base_text: &str,
    head_text: &str,
    spec_text: &str,
) -> flow::ResultRow {
    let repo = repo();
    let file = repo.join(format!("src/Notifier.{ext}"));
    fs::write(&file, base_text).unwrap();
    let base = commit(&repo);
    fs::write(&file, head_text).unwrap();
    let spec: flow::Spec = serde_yaml::from_str(&format!(
        "file: src/Notifier.{ext}\nmethod: N.run\nchange:\n{spec_text}\npreserve: none\n"
    ))
    .unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    result
}

#[test]
fn nth_checks_only_the_requested_anchor_occurrence() {
    let base = "class N { run() { emitRunEvent(); emitRunEvent(); emitRunEvent(); } emitRunEvent() {} recordFlowDiagram() {} }";
    let head = "class N { run() { emitRunEvent(); recordFlowDiagram(); emitRunEvent(); emitRunEvent(); } emitRunEvent() {} recordFlowDiagram() {} }";
    let result = check_text_with_spec(
        "ts",
        base,
        head,
        "  - insert: recordFlowDiagram\n    before: emitRunEvent\n    nth: 2\n    guard: none",
    );
    assert_eq!(result.status, "pass", "{:?}", result.problems);
}

#[test]
fn none_and_throws_accept_a_call_as_the_only_try_statement() {
    let base = "class N { run() { send(); } send() {} validate() {} }";
    let head = "class N { run() { try { validate(); } catch {} send(); } send() {} validate() {} }";
    for guard in ["none", "throws"] {
        let result = check_text_with_spec(
            "ts",
            base,
            head,
            &format!("  - insert: validate\n    before: send\n    guard: {guard}"),
        );
        assert_eq!(result.status, "pass", "{guard}: {:?}", result.problems);
    }
}

#[test]
fn try_guard_must_be_directly_before_the_anchor() {
    let base = "class N { run() { send(); } send() {} validate() {} audit() {} }";
    let head = "class N { run() { try { validate(); } catch {} audit(); send(); } send() {} validate() {} audit() {} }";
    for guard in ["none", "throws"] {
        let result = check_text_with_spec(
            "ts",
            base,
            head,
            &format!("  - insert: validate\n    before: send\n    guard: {guard}"),
        );
        assert_eq!(result.status, "fail", "{guard}: {:?}", result.problems);
    }
}

#[test]
fn await_and_optional_calls_are_calls_and_none_guard_accepts_await() {
    let base =
        "class N { async sendSms() { await this.send(); } async send() {} async validate() {} }";
    let head = "class N { async sendSms() { await this.validate(); await this.send?.(); } async send() {} async validate() {} }";
    let result = check_text("ts", base, head, "N.sendSms", "none");
    assert_eq!(result.status, "pass", "{:?}", result.problems);
    assert!(result
        .head_steps
        .unwrap()
        .iter()
        .any(|step| step == "call:send"));
}

#[test]
fn throws_guard_requires_a_bare_call_before_the_anchor() {
    let base = "class N { async sendSms() { send(); } async send() {} async validate() {} }";
    for head in [
        "class N { async sendSms() { validate(); send(); } async send() {} async validate() {} }",
        "class N { async sendSms() { await validate(); send(); } async send() {} async validate() {} }",
    ] {
        let result = check_text("ts", base, head, "N.sendSms", "throws");
        assert_eq!(result.status, "pass", "{:?}", result.problems);
    }
    let result = check_text(
        "ts",
        base,
        "class N { async sendSms() { const valid = validate(); send(); } async send() {} async validate() {} }",
        "N.sendSms",
        "throws",
    );
    assert_eq!(result.status, "fail", "{:?}", result.problems);
}

#[test]
fn arrow_function_object_property_and_new_expression_are_named_steps() {
    let base = "const worker = { sendSms: () => { send(); }, make: () => new Client() }; function send() {}";
    let head = "const worker = { sendSms: () => { validate(); send(); }, make: () => new Client() }; const validate = () => true; function send() {}";
    let result = check_text("js", base, head, "sendSms", "none");
    assert_eq!(result.status, "pass", "{:?}", result.problems);
    let make = check_text("js", head, head, "make", "none");
    assert!(make
        .head_steps
        .unwrap()
        .iter()
        .any(|step| step == "call:new:Client"));
}

#[test]
fn guard_inside_then_callback_does_not_guard_outer_flow() {
    let base =
        "function sendSms() { send(); } function send() {} function validate() { return true; }";
    let head = "function sendSms() { validate().then(ok => { if (!ok) throw new Error(); }); send(); } function send() {} function validate() { return true; }";
    let result = check_text("mjs", base, head, "sendSms", "returns-bool");
    assert_eq!(result.status, "fail", "{:?}", result.problems);
}

#[test]
fn tsx_cjs_and_js_extensions_select_the_javascript_family() {
    let base =
        "function sendSms() { send(); } function send() {} function validate() { return true; }";
    let head = "function sendSms() { validate(); send(); } function send() {} function validate() { return true; }";
    for ext in ["tsx", "cjs", "mjs"] {
        let result = check_text(ext, base, head, "sendSms", "none");
        assert_eq!(result.status, "pass", "{ext}: {:?}", result.problems);
    }
}

#[test]
fn changing_an_argument_in_a_chain_preserves_its_steps() {
    let repo = repo();
    let file = repo.join("src/Notifier.ts");
    fs::write(
        &file,
        "function sendSms(task: { produces?: string[] }) { return (Array.isArray(task?.produces) ? task.produces : []).map(value => normalize(value)).filter(value => value.length > 0); } function normalize(value: string) { return value; }",
    )
    .unwrap();
    let base = commit(&repo);
    fs::write(
        &file,
        "function sendSms(task: { produces?: string[] }) { return (Array.isArray(task?.produces) ? task.produces : []).map(value => normalize(value, task)).filter(value => value.length > 0); } function normalize(value: string, task?: unknown) { return value; }",
    )
    .unwrap();
    let spec: flow::Spec =
        serde_yaml::from_str("file: src/Notifier.ts\nmethod: sendSms\nchange: []\npreserve: all\n")
            .unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    assert_eq!(result.status, "pass", "{:?}", result.problems);
    assert!(result
        .head_steps
        .unwrap()
        .iter()
        .any(|step| step == "call:filter"));
}
