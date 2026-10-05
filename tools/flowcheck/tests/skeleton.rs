#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    path::Path,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-skeleton-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(path.join("src")).unwrap();
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

fn row(fixture: &str, file: &str, method: &str) -> flow::ResultRow {
    let repo = repo();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixture")
            .join(fixture),
        repo.join(file),
    )
    .unwrap();
    let base = commit(&repo);
    let spec: flow::Spec =
        serde_yaml::from_str(&format!("file: {file}\nmethod: {method}\nchange: []\n")).unwrap();
    let result = flow::check_method(&spec, &repo, &base, None, true);
    let _ = fs::remove_dir_all(repo);
    result
}

fn all<'a>(nodes: &'a [flow::FlowNode], out: &mut Vec<&'a flow::FlowNode>) {
    for node in nodes {
        out.push(node);
        for branch in &node.branches {
            all(&branch.nodes, out);
        }
    }
}

fn matching<'a>(nodes: &'a [flow::FlowNode], kind: &str, text: &str) -> Vec<&'a flow::FlowNode> {
    let mut flat = Vec::new();
    all(nodes, &mut flat);
    flat.into_iter()
        .filter(|node| node.kind == kind && node.text.contains(text))
        .collect()
}

#[test]
fn calls_and_exits_remain_in_their_branch() {
    let row = row(
        "js/finish-step.head.mjs",
        "src/finish-step.mjs",
        "finishStep",
    );
    let tree = row.head_tree.unwrap();
    let branch = tree
        .nodes
        .iter()
        .find(|node| node.kind == "branch" && node.text.contains("declaredFlow(task)"))
        .unwrap();
    let then = branch
        .branches
        .iter()
        .find(|branch| branch.kind == "then")
        .unwrap();
    assert_eq!(matching(&then.nodes, "call", "recordFlowDiagram").len(), 1);
    assert_eq!(matching(&then.nodes, "exit", "").len(), 2);
}

#[test]
fn closures_are_not_part_of_the_main_flow() {
    let row = row("js/flow-gate.mjs", "src/flow-gate.mjs", "runFlowGate");
    let tree = row.head_tree.unwrap();
    let main_now: Vec<usize> = matching(&tree.nodes, "call", "Date.now")
        .iter()
        .map(|node| node.line)
        .collect();
    assert_eq!(main_now, vec![27]);
    let finish = tree
        .closures
        .iter()
        .find(|closure| closure.name == "finish")
        .unwrap();
    assert_eq!(
        matching(&finish.nodes, "call", "unsupportedProduces").len(),
        1
    );
}

#[test]
fn notifier_exit_branches_are_present_for_every_language() {
    for (fixture, file, method, condition) in [
        (
            "Notifier.m4_after_send.cs",
            "src/Notifier.cs",
            "SendSms",
            "ValidatePhone",
        ),
        (
            "js/Notifier.m4_after_send.js",
            "src/Notifier.js",
            "Notifier.sendSms",
            "validatePhone",
        ),
        (
            "ts/Notifier.m4_after_send.ts",
            "src/Notifier.ts",
            "Notifier.sendSms",
            "validatePhone",
        ),
        (
            "rust/Notifier.m4_after_send.rs",
            "src/Notifier.rs",
            "Notifier::send_sms",
            "validate_phone",
        ),
    ] {
        let tree = row(fixture, file, method).head_tree.unwrap();
        assert_eq!(matching(&tree.nodes, "branch", "").len(), 1, "{fixture}");
        assert_eq!(
            matching(&tree.nodes, "branch", condition).len(),
            1,
            "{fixture}"
        );
        assert_eq!(matching(&tree.nodes, "exit", "").len(), 1, "{fixture}");
    }
}
