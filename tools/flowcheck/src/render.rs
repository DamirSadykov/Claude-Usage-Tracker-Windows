use crate::flow::{lang, Change, ResultRow, Spec, TopStep};
use lang::LanguageSpec;

const FOLD_AFTER: usize = 3;
const MAX_DIAGRAM_CHARS: usize = 45_000;

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

fn matches_builtin_call(step: &str, language: &LanguageSpec) -> bool {
    language.builtin_calls.iter().any(|builtin| {
        builtin.strip_suffix(".*").is_some_and(|namespace| {
            step.starts_with(&format!("{namespace}.")) || step.contains(&format!(".{namespace}."))
        }) || *builtin == step
    })
}

fn is_builtin_value_method(step: &str, language: &LanguageSpec) -> bool {
    language
        .builtin_value_methods
        .iter()
        .any(|method| step == *method || step.ends_with(&format!(".{method}")))
}

fn named_in_delta(spec: &Spec, step: &str) -> bool {
    spec.change.iter().any(|change| {
        [
            change.insert.as_ref(),
            change.before.as_ref(),
            change.after.as_ref(),
            change.remove_call.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|name| matches(step, name))
    })
}

fn calls<'a>(spec: &Spec, steps: Option<&'a Vec<TopStep>>) -> Vec<&'a TopStep> {
    let language = lang::for_file(&spec.file).expect("flow spec has a supported file");
    steps
        .into_iter()
        .flatten()
        .filter(|step| {
            step.kind == "call"
                && (!matches_builtin_call(&step.key, language)
                    || step.changed
                    || named_in_delta(spec, &step.key))
        })
        .collect()
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
    for step in calls(spec, row.base_top.as_ref()) {
        for change in insertions_at(&spec.change, &step.key, true) {
            out.push((change.insert.clone().unwrap(), "insert".into()));
        }
        out.push((
            step.key.clone(),
            if spec.change.iter().any(|c| removed(c, &step.key)) {
                "removed"
            } else {
                "base"
            }
            .into(),
        ));
        for change in insertions_at(&spec.change, &step.key, false) {
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

fn fold(nodes: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut folded = Vec::new();
    let mut plain = Vec::new();
    let flush = |plain: &mut Vec<(String, String)>, folded: &mut Vec<(String, String)>| {
        if plain.len() > FOLD_AFTER {
            folded.push((format!("… {} steps", plain.len()), "fold".into()));
        } else {
            folded.append(plain);
        }
    };
    for node in nodes {
        if node.1 == "base" {
            plain.push(node);
        } else {
            flush(&mut plain, &mut folded);
            folded.push(node);
        }
    }
    flush(&mut plain, &mut folded);
    folded
}

fn chain(nodes: Vec<(String, String)>, prefix: &str) -> String {
    let mut graph = String::new();
    let mut previous = None;
    for (index, (text, class)) in fold(nodes).iter().enumerate() {
        let id = format!("{prefix}{index}");
        graph.push_str(&node(&id, text, class));
        if let Some(previous) = previous {
            graph.push_str(&format!("  {previous} --> {id}\n"));
        }
        previous = Some(id);
    }
    graph
}

fn plan(spec: &Spec, row: &ResultRow, prefix: &str) -> String {
    let mut graph = String::from("flowchart TD\n");
    let nodes = planned_nodes(spec, row);
    let mut previous: Option<String> = None;
    for (index, (text, class)) in fold(nodes).iter().enumerate() {
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

fn changed_range(base: &[&TopStep], head: &[&TopStep]) -> (usize, usize) {
    let start = base
        .iter()
        .zip(head)
        .take_while(|(a, b)| a.key == b.key)
        .count();
    let mut end = head.len();
    while end > start && base.len() > start + (head.len() - end) {
        if base[base.len() - (head.len() - end) - 1].key != head[end - 1].key {
            break;
        }
        end -= 1;
    }
    (start, end)
}

fn result(spec: &Spec, row: &ResultRow, prefix: &str) -> String {
    let language = lang::for_file(&spec.file).expect("flow spec has a supported file");
    let base = calls(spec, row.base_top.as_ref());
    let head = calls(spec, row.head_top.as_ref());
    let (start, end) = changed_range(&base, &head);
    let failing = row.status == "fail";
    let mut graph = format!("flowchart LR\n  subgraph {prefix}base [\"base\"]\n");
    graph.push_str(&chain(
        base.iter()
            .map(|step| {
                (
                    step.key.clone(),
                    if step.changed { "head" } else { "base" }.into(),
                )
            })
            .collect(),
        &format!("{prefix}b"),
    ));
    graph.push_str("  end\n");
    graph.push_str(&format!(
        "  subgraph {prefix}head [\"head ({})\"]\n",
        row.status
    ));
    let head_nodes = head
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let anchored = spec.change.iter().any(|change| {
                change
                    .insert
                    .as_ref()
                    .is_some_and(|name| matches(&step.key, name))
                    || change
                        .before
                        .as_ref()
                        .is_some_and(|name| matches(&step.key, name))
                    || change
                        .after
                        .as_ref()
                        .is_some_and(|name| matches(&step.key, name))
            });
            let inserted = spec.change.iter().any(|change| {
                change
                    .insert
                    .as_ref()
                    .is_some_and(|name| matches(&step.key, name))
            });
            let class = if failing && index == start {
                "diverged"
            } else if inserted {
                "insert"
            } else if anchored || step.changed {
                "head"
            } else if is_builtin_value_method(&step.key, language) {
                "base"
            } else if (start..end).contains(&index) {
                "head"
            } else {
                "base"
            };
            (step.key.clone(), class.into())
        })
        .collect();
    graph.push_str(&chain(head_nodes, &format!("{prefix}h")));
    graph.push_str("  end\n");
    graph
}

fn classes() -> &'static str {
    "  classDef base fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef fold fill:#f9fafb,stroke:#d1d5db,color:#6b7280,stroke-dasharray: 4 3\n  classDef insert fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef guard fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef removed fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef exit fill:#fff7ed,stroke:#f97316,color:#9a3412\n  classDef head fill:#eff6ff,stroke:#60a5fa,color:#1d4ed8\n  classDef diverged fill:#fee2e2,stroke:#ef4444,color:#991b1b\n"
}

fn diagram_parts(diagram: String) -> Vec<String> {
    if diagram.len() + classes().len() <= MAX_DIAGRAM_CHARS {
        return vec![diagram];
    }
    let node_lines: Vec<_> = diagram
        .lines()
        .filter(|line| line.contains("[\"") || line.contains("{\""))
        .collect();
    let mut groups: Vec<Vec<&str>> = Vec::new();
    let mut group = Vec::new();
    let reserve = classes().len() + 128;
    for line in node_lines {
        let next_size = group
            .iter()
            .map(|line: &&str| line.len() + 32)
            .sum::<usize>()
            + line.len();
        if !group.is_empty() && next_size + reserve > MAX_DIAGRAM_CHARS {
            groups.push(group);
            group = Vec::new();
        }
        group.push(line);
    }
    if !group.is_empty() {
        groups.push(group);
    }
    let mut parts = Vec::new();
    let mut previous: Option<&str> = None;
    for group in groups {
        let mut current = String::from("flowchart TD\n");
        let mut ids: Vec<String> = Vec::new();
        if let Some(last) = previous {
            let id = last.split_whitespace().next().unwrap();
            let continuation = last.replacen("\"]", " ↪ continuation\"]", 1).replacen(
                "\"}",
                " ↪ continuation\"}",
                1,
            );
            current.push_str(&continuation);
            current.push('\n');
            ids.push(id.to_string());
        }
        for line in &group {
            let id = line.split_whitespace().next().unwrap();
            current.push_str(line);
            current.push('\n');
            ids.push(id.to_string());
        }
        for pair in ids.windows(2) {
            current.push_str(&format!("  {} --> {}\n", pair[0], pair[1]));
        }
        previous = group.last().copied();
        parts.push(current);
    }
    parts
}

pub fn markdown(mode: &str, specs: &[Spec], rows: &[ResultRow]) -> String {
    let mut out = format!("# Flowcheck {}\n\n", mode);
    for (number, (spec, row)) in specs
        .iter()
        .filter(|spec| spec.na.is_none())
        .zip(rows)
        .enumerate()
    {
        let diagram = if mode == "plan" {
            plan(spec, row, &format!("p{number}_"))
        } else {
            result(spec, row, &format!("r{number}_"))
        };
        let parts = diagram_parts(diagram);
        for (part, diagram) in parts.iter().enumerate() {
            let suffix = if parts.len() > 1 {
                format!(" — part {}/{}", part + 1, parts.len())
            } else {
                String::new()
            };
            out.push_str(&format!(
                "## {} — {}{}\n\n```mermaid\n{}{}\n```\n\n",
                spec.file,
                spec.method,
                suffix,
                diagram,
                classes()
            ));
        }
    }
    out.trim_end().to_string()
}
