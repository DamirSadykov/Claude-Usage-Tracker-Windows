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

fn mermaid_nodes(diagram: &str) -> usize {
    diagram
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            line.contains("[\"") || line.contains("{\"") || line.contains("([\"")
        })
        .count()
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
fn plan_strikes_a_standalone_removed_call() {
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - remove-call: old\npreserve: all\n",
    )
    .unwrap();
    let got = render::markdown(
        "plan",
        &[spec],
        &[row(vec!["call:old".into()], vec![], "pass")],
    );
    assert!(got.contains("<s>old</s>"), "{got}");
}

#[test]
fn plan_counts_nth_across_the_method_and_closures() {
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - insert: added\n    before: anchor\n    nth: 2\npreserve: all\n",
    )
    .unwrap();
    let mut rendered = row(vec![], vec![], "pass");
    rendered.base_tree = Some(flow::FlowTree {
        nodes: vec![flow::FlowNode {
            kind: "call".into(),
            text: "anchor".into(),
            line: 1,
            changed: false,
            branches: vec![],
        }],
        closures: vec![flow::ClosureTree {
            name: "later".into(),
            nodes: vec![flow::FlowNode {
                kind: "call".into(),
                text: "anchor".into(),
                line: 2,
                changed: false,
                branches: vec![],
            }],
        }],
    });
    let got = render::markdown("plan", &[spec], &[rendered]);
    assert_eq!(got.matches("added").count(), 1, "{got}");
    assert!(got.contains("subgraph p0_closure"), "{got}");
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
fn result_respects_nth_when_marking_an_out_of_place_call() {
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - insert: persist\n    before: finish\n    nth: 2\npreserve: all\n",
    )
    .unwrap();
    let got = render::markdown(
        "result",
        &[spec],
        &[row(
            vec!["call:finish".into(), "call:finish".into()],
            vec![
                "call:persist".into(),
                "call:finish".into(),
                "call:finish".into(),
            ],
            "fail",
        )],
    );
    assert!(got.contains("persist\"]:::extra"), "{got}");
    assert!(got.contains("persist\"]:::miss"), "{got}");
}

#[test]
fn result_keeps_replacement_when_other_calls_shift_its_index() {
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - remove-call: old\n  - insert: new\npreserve: none\n",
    )
    .unwrap();
    let got = render::markdown(
        "result",
        &[spec],
        &[row(
            vec!["call:old".into(), "call:tail".into()],
            vec![
                "call:unrelated".into(),
                "call:new".into(),
                "call:tail".into(),
            ],
            "fail",
        )],
    );
    assert!(got.contains("old → new\"]:::ok"), "{got}");
    assert!(!got.contains("new\"]:::extra"), "{got}");
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
    assert!(mermaid_nodes(&got) <= 2, "too many nodes: {got}");
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
    let plan = render::markdown(
        "plan",
        std::slice::from_ref(&spec),
        std::slice::from_ref(&row),
    );
    assert_eq!(plan.matches("recordFlowDiagram").count(), 1, "{plan}");
    let declared = plan
        .find("declaredFlow(task)")
        .expect("declared flow guard");
    let record = plan.find("recordFlowDiagram").expect("planned call");
    assert!(declared < record, "{plan}");
    let declared_id = plan[..declared]
        .rsplit('\n')
        .next()
        .and_then(|line| line.split_whitespace().next())
        .and_then(|node| node.split('{').next())
        .expect("declared flow node id");
    let then_edge = plan
        .find(&format!("{declared_id} -->|then|"))
        .expect("declared flow then edge");
    assert!(record < then_edge, "{plan}");
    let got = render::markdown("result", &[spec], &[row]);
    assert!(got.len() < 45_000, "{}", got.len());
    assert!(mermaid_nodes(&got) <= 32, "too many nodes: {got}");
    assert!(got.contains("declaredFlow(task)"), "{got}");
    assert!(got.contains("recordFlowDiagram\"]:::ok"), "{got}");
    assert!(got.matches(":::exit").count() >= 2, "{got}");
    assert!(!got.contains("steps"), "{got}");
    let order = [
        "declaredFlow(task)",
        "recordFlowDiagram",
        "flow.status === &quot;cannot&quot;",
        "flow.status !== &quot;pass&quot;",
    ];
    let mut at = 0;
    for text in order {
        at = got[at..]
            .find(text)
            .map(|next| at + next)
            .expect("ordered node");
        at += text.len();
    }
    assert!(got.matches("finishAttempt").count() >= 2, "{got}");
    assert!(!got.contains("{\"try") && !got.contains("[\"try"), "{got}");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn run_flow_gate_shows_replaced_call_and_hides_builtins() {
    let repo = temp_repo();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture/js/flow-gate.mjs");
    fs::write(
        repo.join("scripts/cli/process/flow-gate.mjs"),
        fs::read_to_string(&fixture)
            .unwrap()
            .replace("unsupportedProduces", "nonCsProduces"),
    )
    .unwrap();
    let base = commit(&repo);
    fs::copy(&fixture, repo.join("scripts/cli/process/flow-gate.mjs")).unwrap();
    let head = commit(&repo);
    let spec: flow::Spec = serde_yaml::from_str("file: scripts/cli/process/flow-gate.mjs\nmethod: runFlowGate\nchange:\n  - remove-call: nonCsProduces\n  - insert: unsupportedProduces\n    before: finish\npreserve: all\n").unwrap();
    let row = flow::check_method(&spec, &repo, &base, Some(&head), true);
    let got = render::markdown("result", &[spec], &[row]);
    assert!(mermaid_nodes(&got) <= 32, "too many nodes: {got}");
    assert!(!got.contains("JSON.stringify"), "{got}");
    let closure_start = got.find("  subgraph r0_closure").expect("finish closure");
    let closure_end = closure_start
        + got[closure_start..]
            .find("\n  end\n")
            .expect("finish closure end");
    let closure = &got[closure_start..closure_end];
    assert!(closure.contains("[\"finish\"]"), "{got}");
    assert!(
        closure.contains("nonCsProduces → unsupportedProduces\"]:::ok"),
        "{got}"
    );
    assert!(!got.contains("unsupportedProduces\"]:::extra"), "{got}");
    assert!(!got[..closure_start].contains("Date.now"), "{got}");
    assert!(got.contains(" --> "), "{got}");
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn notifier_after_send_results_keep_the_guard_and_send_for_csharp_and_js() {
    for (source, base_name, head_name, method, validate, send) in [
        (
            "Notifier.cs",
            "Notifier.base.cs",
            "Notifier.m4_after_send.cs",
            "SendSms",
            "ValidatePhone",
            "Send",
        ),
        (
            "Notifier.js",
            "js/Notifier.base.js",
            "js/Notifier.m4_after_send.js",
            "Notifier.sendSms",
            "validatePhone",
            "send",
        ),
    ] {
        let repo = temp_repo();
        fs::create_dir_all(repo.join("src")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
        fs::copy(fixture.join(base_name), repo.join("src").join(source)).unwrap();
        let base = commit(&repo);
        fs::copy(fixture.join(head_name), repo.join("src").join(source)).unwrap();
        let head = commit(&repo);
        fs::copy(fixture.join(base_name), repo.join("src").join(source)).unwrap();
        let spec: flow::Spec = serde_yaml::from_str(&format!(
            "file: src/{source}\nmethod: {method}\nchange:\n  - insert: {validate}\n    before: {send}\n    guard: returns-bool\npreserve: all\n"
        ))
        .unwrap();
        let row = flow::check_method(&spec, &repo, &base, Some(&head), true);
        if source == "Notifier.cs" {
            let plan = render::markdown(
                "plan",
                std::slice::from_ref(&spec),
                std::slice::from_ref(&row),
            );
            let guard = plan
                .find("ValidatePhone (returns-bool)?")
                .expect("guard diamond");
            let send_at = plan.rfind("Send").expect("send");
            assert!(guard < send_at, "{plan}");
            assert!(plan.contains(":::exit"), "{plan}");
        }
        let got = render::markdown("result", &[spec], &[row]);
        assert!(got.contains(validate), "{got}");
        assert!(got.contains(send), "{got}");
        assert!(got.contains(&format!("{validate}\"]:::miss")), "{got}");
        assert!(got.contains(&format!("{validate}\"}}:::extra")), "{got}");
        assert!(got.contains(":::exit"), "{got}");
        let _ = fs::remove_dir_all(repo);
    }
}

#[test]
fn base_side_is_only_rendered_for_changed_exits() {
    let make_tree = |branch: bool, exit: bool| flow::FlowTree {
        nodes: vec![flow::FlowNode {
            kind: if branch { "branch" } else { "call" }.into(),
            text: if branch { "valid" } else { "send" }.into(),
            line: 1,
            changed: branch,
            branches: if branch {
                vec![flow::FlowBranch {
                    kind: "true".into(),
                    nodes: vec![flow::FlowNode {
                        kind: if exit { "exit" } else { "call" }.into(),
                        text: if exit { "return" } else { "continue" }.into(),
                        line: 2,
                        changed: true,
                        branches: vec![],
                    }],
                }]
            } else {
                vec![]
            },
        }],
        closures: vec![],
    };
    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - insert: persist\n    before: send\npreserve: all\n",
    )
    .unwrap();
    let mut changed = row(vec!["call:send".into()], vec!["call:send".into()], "fail");
    changed.base_tree = Some(make_tree(false, false));
    changed.head_tree = Some(make_tree(true, true));
    assert!(render::markdown("result", &[spec], &[changed]).contains("subgraph r0_base"));

    let spec: flow::Spec = serde_yaml::from_str(
        "file: src/sample.mjs\nmethod: finishStep\nchange:\n  - insert: persist\n    before: send\npreserve: all\n",
    )
    .unwrap();
    let mut unchanged = row(vec!["call:send".into()], vec!["call:send".into()], "fail");
    unchanged.base_tree = Some(make_tree(false, false));
    unchanged.head_tree = Some(make_tree(false, false));
    assert!(!render::markdown("result", &[spec.clone()], &[unchanged]).contains("subgraph r0_base"));

    let mut branch_only = row(vec!["call:send".into()], vec!["call:send".into()], "fail");
    branch_only.base_tree = Some(make_tree(false, false));
    branch_only.head_tree = Some(make_tree(true, false));
    assert!(!render::markdown("result", &[spec], &[branch_only]).contains("subgraph r0_base"));
}
