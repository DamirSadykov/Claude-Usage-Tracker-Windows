use crate::flow::{lang, Change, FlowNode, ResultRow, Spec, TopStep};
use lang::LanguageSpec;

const FOLD_AFTER: usize = 3;
const MAX_DIAGRAM_CHARS: usize = 45_000;

fn label(step: &str) -> String {
    step.split_once(':')
        .map(|(_, value)| value)
        .unwrap_or(step)
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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

fn contains_focus(spec: &Spec, node: &FlowNode) -> bool {
    (node.kind == "call" && (node.changed || named_in_delta(spec, &node.text)))
        || node
            .branches
            .iter()
            .any(|branch| branch.nodes.iter().any(|node| contains_focus(spec, node)))
}

fn call_names(nodes: &[FlowNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "call" {
            out.push(node.text.clone());
        }
        for branch in &node.branches {
            call_names(&branch.nodes, out);
        }
    }
}

fn expected_at(spec: &Spec, head: &[String], name: &str) -> bool {
    spec.change.iter().any(|change| {
        change.insert.as_deref() == Some(name) && {
            let at = head.iter().position(|call| matches(call, name));
            let anchor = change.before.as_ref().or(change.after.as_ref());
            match (at, anchor) {
                (Some(at), Some(anchor)) => head.iter().enumerate().any(|(a, call)| {
                    matches(call, anchor)
                        && if change.before.is_some() {
                            at + 1 == a
                        } else {
                            a + 1 == at
                        }
                }),
                (Some(_), None) => true,
                _ => false,
            }
        }
    })
}

fn result_node(
    prefix: &str,
    serial: &mut usize,
    text: &str,
    class: &str,
    shape: &str,
    graph: &mut String,
) -> String {
    let id = format!("{prefix}{serial}");
    *serial += 1;
    match shape {
        "diamond" => graph.push_str(&format!("  {id}{{\"{}\"}}:::{class}\n", label(text))),
        "exit" => graph.push_str(&format!("  {id}([\"{}\"]):::{class}\n", label(text))),
        _ => graph.push_str(&node(&id, text, class)),
    }
    id
}

fn result_nodes(
    spec: &Spec,
    language: &LanguageSpec,
    head_calls: &[String],
    nodes: &[FlowNode],
    previous: Option<String>,
    prefix: &str,
    serial: &mut usize,
    graph: &mut String,
    passing: bool,
) -> Option<String> {
    let mut previous = previous;
    for current in nodes {
        let focus = contains_focus(spec, current);
        if current.kind == "call" {
            let visible = focus
                && (!matches_builtin_call(&current.text, language)
                    || current.changed
                    || named_in_delta(spec, &current.text))
                && (!is_builtin_value_method(&current.text, language)
                    || current.changed
                    || named_in_delta(spec, &current.text));
            if !visible {
                continue;
            }
            let class = if spec
                .change
                .iter()
                .any(|c| c.insert.as_ref().is_some_and(|x| matches(&current.text, x)))
            {
                if passing || expected_at(spec, head_calls, &current.text) {
                    "ok"
                } else {
                    "extra"
                }
            } else if focus {
                "ctx"
            } else {
                "fold"
            };
            let id = result_node(prefix, serial, &current.text, class, "box", graph);
            if let Some(last) = previous {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            previous = Some(id);
        } else if !current.branches.is_empty() {
            if !focus {
                continue;
            }
            let id = result_node(
                prefix,
                serial,
                &current.text,
                if focus { "ctx" } else { "fold" },
                "diamond",
                graph,
            );
            if let Some(last) = previous.clone() {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            for branch in &current.branches {
                let branch_last = result_nodes(
                    spec,
                    language,
                    head_calls,
                    &branch.nodes,
                    Some(id.clone()),
                    prefix,
                    serial,
                    graph,
                    passing,
                );
                if let Some(last) = branch_last {
                    if branch.nodes.iter().any(|n| n.kind == "exit") {
                        graph.push_str(&format!("  {id} -->|{}| {last}\n", label(&branch.kind)));
                    }
                }
            }
            previous = Some(id);
        } else if current.kind == "exit" {
            let id = result_node(prefix, serial, &current.text, "exit", "exit", graph);
            if let Some(last) = previous {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            previous = Some(id);
        }
    }
    previous
}

fn result(spec: &Spec, row: &ResultRow, prefix: &str) -> String {
    let language = lang::for_file(&spec.file).expect("flow spec has a supported file");
    let tree = row.head_tree.as_ref().or(row.base_tree.as_ref());
    let mut head_calls = Vec::new();
    if let Some(tree) = tree {
        call_names(&tree.nodes, &mut head_calls);
    } else {
        head_calls = calls(spec, row.head_top.as_ref())
            .into_iter()
            .map(|s| s.key.clone())
            .collect();
    }
    let mut graph = String::from("flowchart TD\n");
    let mut serial = 0usize;
    if let Some(tree) = tree {
        result_nodes(
            spec,
            language,
            &head_calls,
            &tree.nodes,
            None,
            prefix,
            &mut serial,
            &mut graph,
            row.status == "pass",
        );
        for closure in &tree.closures {
            if closure.nodes.iter().any(|node| contains_focus(spec, node)) {
                graph.push_str(&format!(
                    "  subgraph {prefix}closure{serial} [\"{}\"]\n",
                    label(&closure.name)
                ));
                result_nodes(
                    spec,
                    language,
                    &head_calls,
                    &closure.nodes,
                    None,
                    prefix,
                    &mut serial,
                    &mut graph,
                    row.status == "pass",
                );
                graph.push_str("  end\n");
            }
        }
        let exits = graph.matches(":::exit").count();
        for _ in exits..2 {
            let _ = result_node(prefix, &mut serial, "return", "exit", "exit", &mut graph);
        }
    } else {
        for call in head_calls.iter().filter(|call| named_in_delta(spec, call)) {
            let class = if row.status == "pass" || expected_at(spec, &head_calls, call) {
                "ok"
            } else {
                "extra"
            };
            let _ = result_node(prefix, &mut serial, call, class, "box", &mut graph);
        }
        if !head_calls.is_empty() && serial == 0 {
            let _ = result_node(
                prefix,
                &mut serial,
                &format!("… {} calls", head_calls.len()),
                "fold",
                "box",
                &mut graph,
            );
        }
    }
    for change in &spec.change {
        if let Some(insert) = &change.insert {
            if !expected_at(spec, &head_calls, insert) {
                let id = result_node(prefix, &mut serial, insert, "miss", "box", &mut graph);
                if let Some(anchor) = change.before.as_ref().or(change.after.as_ref()) {
                    if let Some(anchor_id) = graph
                        .lines()
                        .find(|line| line.contains(&format!("\"{}\"", label(anchor))))
                        .and_then(|line| line.split_whitespace().next())
                    {
                        graph.push_str(&format!("  {id} -.-> {anchor_id}\n"));
                    }
                }
            }
        }
    }
    graph
}

fn classes() -> &'static str {
    "  classDef base fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef fold fill:#f9fafb,stroke:#d1d5db,color:#6b7280,stroke-dasharray: 4 3\n  classDef insert fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef guard fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef removed fill:#f3f4f6,stroke:#9ca3af,color:#6b7280\n  classDef ok fill:#dcfce7,stroke:#22c55e,color:#166534\n  classDef miss fill:#fee2e2,stroke:#ef4444,color:#991b1b,stroke-dasharray: 4 3\n  classDef extra fill:#fef3c7,stroke:#f59e0b,color:#92400e\n  classDef ctx fill:#eff6ff,stroke:#60a5fa,color:#1d4ed8\n  classDef exit fill:#fff7ed,stroke:#f97316,color:#9a3412\n"
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
