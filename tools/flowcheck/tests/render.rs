#[path = "../src/flow.rs"]
mod flow;
#[path = "../src/render.rs"]
mod render;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

fn spec() -> flow::Spec {
    serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - insert: persist\n    before: finish\npreserve: all\n",
    )
    .unwrap()
}

fn row(base: Vec<String>, head: Vec<String>, status: &str) -> flow::ResultRow {
    let top = |steps: &[String]| {
        steps
            .iter()
            .filter_map(|step| step.strip_prefix("call:"))
            .map(|key| flow::TopStep {
                kind: "call".into(),
                key: key.into(),
                line: 0,
                changed: false,
            })
            .collect()
    };
    flow::ResultRow {
        method: "finishStep".into(),
        status: status.into(),
        problems: vec![],
        extra: vec![],
        depth_limited: vec![],
        base_top: Some(top(&base)),
        head_top: Some(top(&head)),
        base_tree: None,
        head_tree: None,
        base_steps: Some(base),
        head_steps: Some(head),
    }
}

static REPOS: AtomicUsize = AtomicUsize::new(0);

fn temp_repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-render-{}-{}",
        std::process::id(),
        REPOS.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("scripts/cli/process")).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&path)
        .status()
        .unwrap();
    path
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

#[test]
fn plan_keeps_delta_and_omits_field_reads() {
    let got = render::markdown(
        "plan",
        &[spec()],
        &[row(
            vec![
                "read:state.user".into(),
                "call:start".into(),
                "call:finish".into(),
            ],
            vec![],
            "pass",
        )],
    );
    assert!(got.contains("persist"));
    assert!(got.contains("finish"));
    assert!(!got.contains("state.user"));
}

#[test]
fn result_marks_planned_calls_ok() {
    let got = render::markdown(
        "result",
        &[spec()],
        &[row(
            vec!["call:start".into(), "call:finish".into()],
            vec![
                "call:start".into(),
                "call:persist".into(),
                "call:finish".into(),
            ],
            "pass",
        )],
    );
    assert!(got.contains("persist\"]:::ok"));
    assert!(!got.contains("subgraph r0_base"));
}

#[test]
fn result_marks_missing_planned_call() {
    let got = render::markdown(
        "result",
        &[spec()],
        &[row(
            vec!["call:start".into(), "call:finish".into()],
            vec![
                "call:start".into(),
                "call:finish".into(),
                "call:persist".into(),
            ],
            "fail",
        )],
    );
    assert!(got.contains("persist\"]:::extra"));
    assert!(got.contains("persist\"]:::miss"));
}

#[test]
fn builtin_namespace_calls_are_hidden_unless_the_delta_names_them() {
    let render = |change: &str| {
        let spec: flow::Spec = serde_yaml::from_str(&format!(
            "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - {change}\npreserve: all\n"
        ))
        .unwrap();
        render::markdown(
            "result",
            &[spec],
            &[row(
                vec!["call:Array.isArray".into(), "call:JSON.stringify".into()],
                vec!["call:Array.isArray".into(), "call:JSON.stringify".into()],
                "pass",
            )],
        )
    };
    for change in [
        "insert: JSON.stringify",
        "before: JSON.stringify",
        "after: JSON.stringify",
        "remove-call: JSON.stringify",
    ] {
        let got = render(change);
        assert!(!got.contains("Array.isArray"), "{got}");
        assert!(got.contains("JSON.stringify"), "{got}");
    }
}

#[test]
fn qualified_c_sharp_builtin_calls_are_hidden() {
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.cs\nmethod: FinishStep\nchange:\n  - insert: persist\npreserve: all\n",
    )
    .unwrap();
    let got = render::markdown(
        "result",
        &[spec],
        &[row(
            vec![
                "call:System.Console.WriteLine".into(),
                "call:persist".into(),
            ],
            vec![
                "call:System.Console.WriteLine".into(),
                "call:persist".into(),
            ],
            "pass",
        )],
    );
    assert!(!got.contains("System.Console.WriteLine"), "{got}");
    assert!(got.contains("persist"), "{got}");
}

#[test]
fn long_finish_step_is_folded_below_mermaid_limit() {
    let steps: Vec<String> = (0..1536).map(|n| format!("call:helper{n}")).collect();
    let got = render::markdown("result", &[spec()], &[row(steps.clone(), steps, "pass")]);
    assert!(got.len() < 45_000, "{}", got.len());
    assert!(got.contains("… 1536 calls"));
    assert!(!got.contains("steps"));
    assert!(got.matches("[\"").count() <= 2, "too many nodes: {got}");
    assert_eq!(got.matches("```mermaid").count(), 1);
}

#[test]
fn split_parts_repeat_the_last_call_as_a_continuation() {
    let changes = (0..3_000)
        .map(|n| format!("  - insert: changed{n}\n"))
        .collect::<String>();
    let spec: flow::Spec = serde_yaml::from_str(&format!(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n{changes}preserve: all\n"
    ))
    .unwrap();
    let got = render::markdown(
        "plan",
        &[spec],
        &[row(vec!["call:start".into()], vec![], "pass")],
    );
    let parts: Vec<_> = got.split("```mermaid\n").skip(1).collect();
    assert!(parts.len() > 1);
    let first = parts[0].rsplit_once("\n```\n").unwrap().0;
    let last_id = first
        .match_indices("[\"")
        .last()
        .map(|(at, _)| {
            first[..at]
                .rsplit(|c: char| c.is_whitespace())
                .next()
                .unwrap()
        })
        .unwrap();
    let second = parts[1];
    assert!(
        second.contains(&format!("{last_id}[\"")) && second.contains("↪ continuation"),
        "{second}"
    );
}

#[test]
fn real_finish_step_is_a_small_top_level_diagram() {
    let repo = temp_repo();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture/js");
    fs::copy(
        fixture.join("finish-step.base.mjs"),
        repo.join("scripts/cli/process/run.mjs"),
    )
    .unwrap();
    let base = commit(&repo);
    fs::copy(
        fixture.join("finish-step.head.mjs"),
        repo.join("scripts/cli/process/run.mjs"),
    )
    .unwrap();
    let head = commit(&repo);
    fs::copy(
        fixture.join("finish-step.base.mjs"),
        repo.join("scripts/cli/process/run.mjs"),
    )
    .unwrap();
    let spec: flow::Spec = serde_yaml::from_str("file: scripts/cli/process/run.mjs\nmethod: finishStep\nchange:\n  - insert: recordFlowDiagram\n    before: emitRunEvent\n    nth: 2\npreserve: all\n").unwrap();
    let row = flow::check_method(&spec, &repo, &base, Some(&head), true);
    let got = render::markdown("result", &[spec], &[row]);
    assert!(got.len() < 45_000, "{}", got.len());
    assert!(got.matches("[\"").count() <= 16, "too many nodes: {got}");
    assert!(got.contains("declaredFlow(task)"), "{got}");
    assert!(got.contains("recordFlowDiagram\"]:::ok"), "{got}");
    assert!(got.matches(":::exit").count() >= 2, "{got}");
    assert!(!got.contains("steps"), "{got}");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn run_flow_gate_hides_builtin_calls() {
    let repo = temp_repo();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture/js/flow-gate.mjs");
    fs::copy(&fixture, repo.join("scripts/cli/process/flow-gate.mjs")).unwrap();
    let base = commit(&repo);
    fs::write(
        repo.join("scripts/cli/process/flow-gate.mjs"),
        fs::read_to_string(&fixture).unwrap().replace(
            "const started = Date.now();",
            "const started = Date.now() + 1;",
        ),
    )
    .unwrap();
    let head = commit(&repo);
    fs::copy(&fixture, repo.join("scripts/cli/process/flow-gate.mjs")).unwrap();
    let spec: flow::Spec = serde_yaml::from_str("file: scripts/cli/process/flow-gate.mjs\nmethod: runFlowGate\nchange:\n  - insert: started\n    before: finish\npreserve: all\n").unwrap();
    let row = flow::check_method(&spec, &repo, &base, Some(&head), true);
    let got = render::markdown("result", &[spec], &[row]);
    assert!(got.matches("[\"").count() <= 32, "too many nodes: {got}");
    assert!(!got.contains("Array.isArray"), "{got}");
    assert!(!got.contains("JSON.stringify"), "{got}");
    let _ = fs::remove_dir_all(repo);
}
