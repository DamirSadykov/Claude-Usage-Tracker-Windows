mod coverage;
mod flow;
mod render;
use clap::Parser;
use serde::Serialize;
use std::{fs, path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(about = "Check C# method-flow changes")]
struct Args {
    #[arg(long)]
    spec: PathBuf,
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    base: String,
    #[arg(long)]
    head: Option<String>,
    #[arg(long)]
    verbose: bool,
    #[arg(long, value_parser = ["shadow", "fail"], default_value = "shadow")]
    coverage: String,
    /// Render the YAML delta and checked flow as Markdown with a Mermaid diagram.
    #[arg(long, value_parser = ["plan", "result"])]
    render: Option<String>,
    /// Include the YAML delta or checked flow as Mermaid Markdown in JSON output.
    #[arg(long, value_parser = ["plan", "result"])]
    diagram: Option<String>,
}
#[derive(Serialize)]
struct Output {
    results: Vec<flow::ResultRow>,
    coverage: coverage::Coverage,
    unchecked: Vec<coverage::Unchecked>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagram: Option<String>,
}
fn main() -> ExitCode {
    let a = Args::parse();
    let parsed: Result<serde_yaml::Value, _> =
        serde_yaml::from_str(&match fs::read_to_string(&a.spec) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("flowcheck: {e}");
                return ExitCode::from(2);
            }
        });
    let value = match parsed {
        Ok(v) => v,
        Err(e) => {
            eprintln!("flowcheck: invalid spec: {e}");
            return ExitCode::from(2);
        }
    };
    let specs: Result<Vec<flow::Spec>, _> = if value.is_sequence() {
        serde_yaml::from_value(value)
    } else {
        serde_yaml::from_value(value).map(|x| vec![x])
    };
    let specs = match specs {
        Ok(x) => x,
        Err(e) => {
            eprintln!("flowcheck: invalid spec: {e}");
            return ExitCode::from(2);
        }
    };
    let rows: Vec<_> = specs
        .iter()
        .filter(|s| s.na.is_none())
        .map(|s| {
            flow::check_method(
                s,
                &a.repo,
                &a.base,
                a.head.as_deref(),
                a.verbose || a.render.is_some() || a.diagram.is_some(),
            )
        })
        .collect();
    let report = coverage::inspect(&specs, &a.repo, &a.base, a.head.as_deref());
    let coverage_fails = a.coverage == "fail" && !report.coverage.findings.is_empty();
    let coverage::Report {
        coverage,
        mut unchecked,
        cannot,
    } = report;
    for (spec, row) in specs.iter().filter(|s| s.na.is_none()).zip(&rows) {
        unchecked.extend(row.extra.iter().map(|step| coverage::Unchecked {
            kind: "undisclosed-step".into(),
            file: spec.file.clone(),
            method: Some(spec.method.clone()),
            reason: step.clone(),
        }));
        unchecked.extend(row.depth_limited.iter().map(|call| coverage::Unchecked {
            kind: "depth-limit".into(),
            file: spec.file.clone(),
            method: Some(spec.method.clone()),
            reason: format!("expansion stopped at depth 2 before {call}"),
        }));
        unchecked.extend(
            row.problems
                .iter()
                .filter(|problem| problem.contains("found only in a callee"))
                .map(|problem| coverage::Unchecked {
                    kind: "helper-only-guard".into(),
                    file: spec.file.clone(),
                    method: Some(spec.method.clone()),
                    reason: problem.clone(),
                }),
        );
    }
    let diagram = a
        .diagram
        .as_deref()
        .map(|mode| render::markdown(mode, &specs, &rows));
    let output = Output {
        results: rows,
        coverage,
        unchecked,
        diagram,
    };
    if let Some(mode) = &a.render {
        println!("{}", render::markdown(mode, &specs, &output.results));
    } else {
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    }
    if !cannot.is_empty() || output.results.iter().any(|r| r.status == "cannot") {
        ExitCode::from(2)
    } else if coverage_fails || output.results.iter().any(|r| r.status == "fail") {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
