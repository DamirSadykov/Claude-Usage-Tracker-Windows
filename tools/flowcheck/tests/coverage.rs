#[path = "../src/coverage.rs"]
mod coverage;
#[path = "../src/flow.rs"]
mod flow;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "flowcheck-coverage-{}-{}-{}",
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

fn write(repo: &Path, text: &str) {
    fs::write(repo.join("src/A.cs"), text).unwrap();
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
    .to_owned()
}

fn spec(text: &str) -> Vec<flow::Spec> {
    serde_yaml::from_str(text).unwrap()
}

const BASE: &str = "class A { void Named() { One(); } void Neighbor() { Two(); } }\n";

#[test]
fn neighboring_method_is_a_shadow_finding() {
    let repo = repo();
    write(&repo, BASE);
    let base = commit(&repo);
    write(
        &repo,
        "class A { void Named() { One(); } void Neighbor() { Three(); } }\n",
    );
    let report = coverage::inspect(
        &spec("- file: src/A.cs\n  method: Named\n"),
        &repo,
        &base,
        None,
    );
    assert_eq!(report.coverage.changed, 1);
    assert_eq!(report.coverage.checked, 0);
    assert_eq!(report.coverage.findings.len(), 1);
    assert_eq!(
        report.coverage.findings[0].method.as_deref(),
        Some("Neighbor()")
    );
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn changed_file_omitted_from_spec_is_a_finding() {
    let repo = repo();
    write(&repo, BASE);
    fs::write(
        repo.join("src/Other.cs"),
        "class Other { void M() { Old(); } }\n",
    )
    .unwrap();
    let base = commit(&repo);
    fs::write(
        repo.join("src/Other.cs"),
        "class Other { void M() { New(); } }\n",
    )
    .unwrap();
    let report = coverage::inspect(
        &spec("- file: src/A.cs\n  method: Named\n"),
        &repo,
        &base,
        None,
    );
    assert!(report.coverage.findings.iter().any(|finding| {
        finding.file == "src/Other.cs" && finding.method.as_deref() == Some("M()")
    }));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn declared_overload_does_not_cover_another_overload() {
    let repo = repo();
    write(
        &repo,
        "class A { void Foo(int value) { Old(); } void Foo(string value) { Old(); } }\n",
    );
    let base = commit(&repo);
    write(
        &repo,
        "class A { void Foo(int value) { Old(); } void Foo(string value) { New(); } }\n",
    );
    let report = coverage::inspect(
        &spec("- file: src/A.cs\n  method: Foo\n  params: int\n"),
        &repo,
        &base,
        None,
    );
    assert_eq!(report.coverage.checked, 0);
    assert_eq!(
        report.coverage.findings[0].method.as_deref(),
        Some("Foo(string)")
    );
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn renamed_base_method_is_outside_delta() {
    let repo = repo();
    write(&repo, "class A { void Foo() { Old(); } }\n");
    let base = commit(&repo);
    write(&repo, "class A { void Bar() { New(); } }\n");
    let report = coverage::inspect(&[], &repo, &base, None);
    assert_eq!(report.coverage.changed, 1);
    assert_eq!(report.coverage.findings[0].method.as_deref(), Some("Foo()"));
    assert!(report.coverage.findings[0]
        .reason
        .contains("no matching head method"));
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn whitespace_and_comments_do_not_create_a_finding() {
    let repo = repo();
    write(&repo, BASE);
    let base = commit(&repo);
    write(
        &repo,
        "class A { void Named() { /* format */ One( ); } void Neighbor() { Two(); } }\n",
    );
    let report = coverage::inspect(
        &spec("- file: src/A.cs\n  method: Named\n"),
        &repo,
        &base,
        None,
    );
    assert_eq!(report.coverage.changed, 0);
    assert!(report.coverage.findings.is_empty());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn method_na_is_unchecked_and_empty_reason_is_cannot() {
    let repo = repo();
    write(&repo, BASE);
    let base = commit(&repo);
    write(
        &repo,
        "class A { void Named() { One(); } void Neighbor() { Three(); } }\n",
    );
    let report = coverage::inspect(
        &spec("- file: src/A.cs\n  method: Neighbor\n  na: ''\n"),
        &repo,
        &base,
        None,
    );
    assert_eq!(report.unchecked.len(), 1);
    assert_eq!(report.unchecked[0].kind, "method-na");
    assert_eq!(report.cannot.len(), 1);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn file_na_is_reported_without_reading_the_file() {
    let repo = repo();
    write(&repo, BASE);
    let base = commit(&repo);
    let report = coverage::inspect(
        &spec("- file: src/Missing.cs\n  na: generator owns it\n"),
        &repo,
        &base,
        None,
    );
    assert_eq!(report.unchecked[0].kind, "file-na");
    assert_eq!(report.unchecked[0].reason, "generator owns it");
    let _ = fs::remove_dir_all(repo);
}
