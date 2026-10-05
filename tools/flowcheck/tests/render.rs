#[path = "../src/flow.rs"]
mod flow;
#[path = "../src/render.rs"]
mod render;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn temp_repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-render-{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        std::process::id(),
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

fn row(head: &[&str], status: &str) -> flow::ResultRow {
    flow::ResultRow {
        method: "SendSms".into(),
        status: status.into(),
        problems: vec![],
        extra: vec![],
        depth_limited: vec![],
        base_steps: Some(vec!["call:GetPhone".into(), "call:_client.Send".into()]),
        head_steps: Some(head.iter().map(|s| s.to_string()).collect()),
    }
}

#[test]
fn plan_snapshot_for_good_fixture() {
    let got = render::markdown(
        "plan",
        &[spec()],
        &[row(
            &["call:GetPhone", "call:ValidatePhone", "call:_client.Send"],
            "pass",
        )],
    );
    assert_eq!(
        got,
        r#"# Flowcheck plan

## src/Notifier.cs — SendSms

```mermaid
flowchart TD
  p0_0["GetPhone"]:::base
  p0_1{"ValidatePhone (returns-bool)?"}:::guard
  p0_0 --> p0_1
  p0_1 -->|exit| p0_1x["return"]:::exit
  p0_2["_client.Send"]:::base
  p0_1 --> p0_2
  classDef base fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  classDef insert fill:#dcfce7,stroke:#22c55e,color:#166534
  classDef guard fill:#dcfce7,stroke:#22c55e,color:#166534
  classDef removed fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  classDef exit fill:#fff7ed,stroke:#f97316,color:#9a3412
  classDef head fill:#eff6ff,stroke:#60a5fa,color:#1d4ed8
  classDef diverged fill:#fee2e2,stroke:#ef4444,color:#991b1b
```"#
    );
}

#[test]
fn result_snapshot_marks_m4_after_send_divergence() {
    let got = render::markdown(
        "result",
        &[spec()],
        &[row(
            &["call:GetPhone", "call:_client.Send", "call:ValidatePhone"],
            "fail",
        )],
    );
    assert_eq!(
        got,
        r#"# Flowcheck result

## src/Notifier.cs — SendSms

```mermaid
flowchart LR
  subgraph r0_base ["base"]
  r0_b0["GetPhone"]:::base
  r0_b1["_client.Send"]:::base
  r0_b0 --> r0_b1
  end
  subgraph r0_head ["head (fail)"]
  r0_h0["GetPhone"]:::head
  r0_h1["_client.Send"]:::head
  r0_h0 --> r0_h1
  r0_h2["ValidatePhone"]:::diverged
  r0_h1 --> r0_h2
  end
  classDef base fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  classDef insert fill:#dcfce7,stroke:#22c55e,color:#166534
  classDef guard fill:#dcfce7,stroke:#22c55e,color:#166534
  classDef removed fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  classDef exit fill:#fff7ed,stroke:#f97316,color:#9a3412
  classDef head fill:#eff6ff,stroke:#60a5fa,color:#1d4ed8
  classDef diverged fill:#fee2e2,stroke:#ef4444,color:#991b1b
```"#
    );
}

#[test]
fn diagram_is_mermaid_markdown_in_json_and_is_omitted_by_default() {
    let repo = temp_repo();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    fs::copy(
        fixture.join("Notifier.base.cs"),
        repo.join("src/Notifier.cs"),
    )
    .unwrap();
    let base = commit(&repo);
    fs::copy(
        fixture.join("Notifier.good.cs"),
        repo.join("src/Notifier.cs"),
    )
    .unwrap();
    let spec = repo.join("flow.yaml");
    fs::write(
        &spec,
        "file: src/Notifier.cs\nmethod: SendSms\nchange:\n  - insert: ValidatePhone\n    before: Send\n    guard: returns-bool\npreserve: all\n",
    )
    .unwrap();

    let run = |diagram: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_flowcheck"));
        command
            .args(["--spec"])
            .arg(&spec)
            .args(["--repo"])
            .arg(&repo)
            .args(["--base", &base]);
        if diagram {
            command.args(["--diagram", "plan"]);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };

    let with_diagram = run(true);
    assert!(with_diagram["diagram"]
        .as_str()
        .is_some_and(|markdown| markdown.contains("```mermaid")));
    assert!(run(false).get("diagram").is_none());
    let _ = fs::remove_dir_all(repo);
}
