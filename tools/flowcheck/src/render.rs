use crate::flow::{Change, ResultRow, Spec};

fn label(step: &str) -> String {
    step.split_once(':')
        .map(|(_, value)| value)
        .unwrap_or(step)
        .replace('"', "&quot;")
}

fn matches(step: &str, name: &str) -> bool {
    let value = label(step);
    value == name || value.ends_with(&format!(".{name}"))
}

fn node(id: &str, text: &str, class: &str) -> String {
    format!("  {id}[\"{}\"]:::{class}\n", label(text))
}

fn removed(change: &Change, step: &str) -> bool {
    change
        .remove_call
        .as_ref()
        .or(change.remove_read.as_ref())
        .is_some_and(|target| matches(step, target))
}

fn insertions_at<'a>(changes: &'a [Change], step: &str, before: bool) -> Vec<&'a Change> {
    changes
        .iter()
        .filter(|change| {
            change.insert.is_some()
                && if before {
                    change
                        .before
                        .as_ref()
                        .is_some_and(|anchor| matches(step, anchor))
                } else {
                    change
                        .after
                        .as_ref()
                        .is_some_and(|anchor| matches(step, anchor))
                }
        })
        .collect()
}

fn planned_nodes(spec: &Spec, row: &ResultRow) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let base = row.base_steps.as_deref().unwrap_or(&[]);
    for step in base {
        for change in insertions_at(&spec.change, step, true) {
            out.push((change.insert.clone().unwrap(), "insert".into()));
        }
        out.push((
            step.clone(),
            if spec.change.iter().any(|c| removed(c, step)) {
                "removed"
            } else {
                "base"
            }
            .into(),
        ));
        for change in insertions_at(&spec.change, step, false) {
            out.push((change.insert.clone().unwrap(), "insert".into()));
        }
    }
    for change in &spec.change {
        if let Some(insert) = &change.insert {
            if !out.iter().any(|(text, _)| text == insert) {
                out.push((insert.clone(), "insert".into()));
            }
        }
    }
    out
}

fn plan(spec: &Spec, row: &ResultRow, prefix: &str) -> String {
    let mut graph = String::from("flowchart TD\n");
    let nodes = planned_nodes(spec, row);
    let mut previous: Option<String> = None;
    for (index, (text, class)) in nodes.iter().enumerate() {
        let id = format!("{prefix}{index}");
        let guard = spec.change.iter().find(|change| {
            change.insert.as_ref() == Some(text)
                && change.guard.as_deref().unwrap_or("none") != "none"
        });
        if let Some(change) = guard {
            graph.push_str(&format!(
                "  {id}{{\"{} ({})?\"}}:::guard\n",
                label(text),
                change.guard.as_deref().unwrap()
            ));
        } else if class == "removed" {
            graph.push_str(&format!("  {id}[\"<s>{}</s>\"]:::removed\n", label(text)));
        } else {
            graph.push_str(&node(&id, text, class));
        }
        if let Some(previous) = previous {
            graph.push_str(&format!("  {previous} --> {id}\n"));
        }
        if guard.is_some() {
            graph.push_str(&format!("  {id} -->|exit| {id}x[\"return\"]:::exit\n"));
        }
        previous = Some(id);
    }
    graph
}

fn result(row: &ResultRow, prefix: &str) -> String {
    let base = row.base_steps.as_deref().unwrap_or(&[]);
    let head = row.head_steps.as_deref().unwrap_or(&[]);
    let divergence = base
        .iter()
        .zip(head)
        .position(|(a, b)| a != b)
        .unwrap_or(base.len().min(head.len()));
    let failing = row.status == "fail";
    let mut graph = format!("flowchart LR\n  subgraph {prefix}base [\"base\"]\n");
    for (index, step) in base.iter().enumerate() {
        let class = if failing && index == divergence {
            "diverged"
        } else {
            "base"
        };
        graph.push_str(&node(&format!("{prefix}b{index}"), step, class));
        if index != 0 {
            graph.push_str(&format!("  {prefix}b{} --> {prefix}b{index}\n", index - 1));
        }
    }
    graph.push_str("  end\n");
    graph.push_str(&format!(
        "  subgraph {prefix}head [\"head ({})\"]\n",
        row.status
    ));
    for (index, step) in head.iter().enumerate() {
        let class = if failing && index == divergence {
            "diverged"
        } else {
            "head"
        };
        graph.push_str(&node(&format!("{prefix}h{index}"), step, class));
        if index != 0 {
            graph.push_str(&format!("  {prefix}h{} --> {prefix}h{index}\n", index - 1));
        }
    }
    graph.push_str("  end\n");
    graph
}

pub fn markdown(mode: &str, specs: &[Spec], rows: &[ResultRow]) -> String {
    let mut out = format!("# Flowcheck {}\n\n", mode);
    for (number, (spec, row)) in specs
        .iter()
        .filter(|spec| spec.na.is_none())
        .zip(rows)
        .enumerate()
    {
        out.push_str(&format!(
            "## {} — {}\n\n```mermaid\n",
            spec.file, spec.method
        ));
        let diagram = if mode == "plan" {
            plan(spec, row, &format!("p{number}_"))
        } else {
            result(row, &format!("r{number}_"))
        };
        out.push_str(&diagram);
        out.push_str("  classDef base fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef insert fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef guard fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef removed fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef exit fill:#fff7ed,stroke:#f97316,color:#9a3412\n  classDef head fill:#eff6ff,stroke:#60a5fa,color:#1d4ed8\n  classDef diverged fill:#fee2e2,stroke:#ef4444,color:#991b1b\n```\n\n");
    }
    out.trim_end().to_string()
}
