use crate::flow::{lang, Change, FlowNode, FlowTree, ResultRow, Spec, TopStep};
use lang::LanguageSpec;
use std::collections::HashSet;

const FOLD_AFTER: usize = 3;
const MAX_DIAGRAM_CHARS: usize = 45_000;

fn label(step: &str) -> String {
    step.strip_prefix("call:")
        .or_else(|| step.strip_prefix("read:"))
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

fn named_at(spec: &Spec, node: &FlowNode, occurrences: &mut [usize]) -> bool {
    let mut named = false;
    for (index, change) in spec.change.iter().enumerate() {
        let anchor = change.before.as_ref().or(change.after.as_ref());
        let is_anchor = anchor.is_some_and(|name| matches(&node.text, name));
        if is_anchor {
            occurrences[index] += 1;
            named |= change.nth.is_none_or(|nth| nth == occurrences[index]);
        }
        named |= [change.insert.as_ref(), change.remove_call.as_ref()]
            .into_iter()
            .flatten()
            .any(|name| matches(&node.text, name));
    }
    named
}

fn focus_nodes(spec: &Spec, nodes: &[FlowNode]) -> HashSet<usize> {
    fn visit(spec: &Spec, nodes: &[FlowNode], occurrences: &mut [usize], out: &mut HashSet<usize>) {
        for node in nodes {
            if node.kind == "call" && (node.changed || named_at(spec, node, occurrences)) {
                out.insert(node as *const FlowNode as usize);
            }
            for branch in &node.branches {
                visit(spec, &branch.nodes, occurrences, out);
            }
        }
    }
    let mut out = HashSet::new();
    visit(spec, nodes, &mut vec![0; spec.change.len()], &mut out);
    out
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

fn contains_focus(focuses: &HashSet<usize>, node: &FlowNode) -> bool {
    node.changed
        || focuses.contains(&(node as *const FlowNode as usize))
        || node.branches.iter().any(|branch| {
            branch
                .nodes
                .iter()
                .any(|node| contains_focus(focuses, node))
        })
}

fn closure_changed(focuses: &HashSet<usize>, nodes: &[FlowNode]) -> bool {
    nodes.iter().any(|node| contains_focus(focuses, node))
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
            let anchor = change.before.as_ref().or(change.after.as_ref());
            match anchor {
                Some(anchor) => {
                    let anchors: Vec<_> = head
                        .iter()
                        .enumerate()
                        .filter_map(|(at, call)| matches(call, anchor).then_some(at))
                        .collect();
                    let anchors = match change.nth {
                        Some(nth) => anchors
                            .get(nth.saturating_sub(1))
                            .copied()
                            .into_iter()
                            .collect(),
                        None => anchors,
                    };
                    anchors.into_iter().any(|anchor_at| {
                        let insert_at = if change.before.is_some() {
                            anchor_at.checked_sub(1)
                        } else {
                            anchor_at.checked_add(1).filter(|at| *at < head.len())
                        };
                        insert_at.is_some_and(|at| matches(&head[at], name))
                    })
                }
                None => head.iter().any(|call| matches(call, name)),
            }
        }
    })
}

fn replacements(spec: &Spec, base: &[String], head: &[String]) -> Vec<(String, String)> {
    let mut lcs = vec![vec![0usize; head.len() + 1]; base.len() + 1];
    for base_at in (0..base.len()).rev() {
        for head_at in (0..head.len()).rev() {
            lcs[base_at][head_at] = if matches(&base[base_at], &head[head_at]) {
                lcs[base_at + 1][head_at + 1] + 1
            } else {
                lcs[base_at + 1][head_at].max(lcs[base_at][head_at + 1])
            };
        }
    }
    let mut base_slots = vec![None; base.len()];
    let mut head_slots = vec![None; head.len()];
    let (mut base_at, mut head_at, mut slot) = (0, 0, 0);
    while base_at < base.len() && head_at < head.len() {
        if matches(&base[base_at], &head[head_at]) {
            base_slots[base_at] = Some(slot);
            head_slots[head_at] = Some(slot);
            base_at += 1;
            head_at += 1;
            slot += 1;
        } else if lcs[base_at + 1][head_at] >= lcs[base_at][head_at + 1] {
            base_slots[base_at] = Some(slot);
            base_at += 1;
        } else {
            head_slots[head_at] = Some(slot);
            head_at += 1;
        }
    }
    while base_at < base.len() {
        base_slots[base_at] = Some(slot);
        base_at += 1;
    }
    while head_at < head.len() {
        head_slots[head_at] = Some(slot);
        head_at += 1;
    }
    spec.change
        .iter()
        .filter_map(|change| change.insert.as_ref())
        .filter_map(|insert| {
            let new_at = head.iter().position(|call| matches(call, insert))?;
            let slot = head_slots[new_at]?;
            spec.change
                .iter()
                .filter_map(|change| change.remove_call.as_ref())
                .find(|remove| {
                    base.iter()
                        .position(|call| matches(call, remove))
                        .and_then(|at| base_slots[at])
                        == Some(slot)
                })
                .map(|remove| (remove.clone(), insert.clone()))
        })
        .collect()
}

fn structure(nodes: &[FlowNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "exit" || (node.kind == "branch" && contains_exit(node)) {
            out.push(format!("{}:{}", node.kind, node.text));
        }
        for branch in &node.branches {
            structure(&branch.nodes, out);
        }
    }
}

fn structure_changed(base: &FlowTree, head: &FlowTree) -> bool {
    let mut base_shape = Vec::new();
    let mut head_shape = Vec::new();
    structure(&base.nodes, &mut base_shape);
    structure(&head.nodes, &mut head_shape);
    base_shape != head_shape
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

fn is_returning_guard(node: &FlowNode) -> bool {
    node.kind == "branch" && contains_exit(node)
}

fn contains_exit(node: &FlowNode) -> bool {
    node.kind == "exit"
        || node
            .branches
            .iter()
            .any(|branch| branch.nodes.iter().any(contains_exit))
}

fn fold_label(count: usize) -> String {
    if count == 1 {
        "… 1 call".into()
    } else {
        format!("… {count} calls")
    }
}

fn exit_label(text: &str) -> String {
    const LIMIT: usize = 40;
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= LIMIT {
        text
    } else if let Some(open) = text.find('(').filter(|&open| open < LIMIT) {
        format!("{}(…)", &text[..open])
    } else {
        format!("{}…", text.chars().take(LIMIT - 1).collect::<String>())
    }
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
    focuses: &HashSet<usize>,
    stop_after_focus: bool,
    collapse_guards: bool,
    replacements: &[(String, String)],
) -> Option<String> {
    let mut previous = previous;
    let mut folded_calls = 0usize;
    let flush_fold = |previous: &mut Option<String>,
                      folded_calls: &mut usize,
                      serial: &mut usize,
                      graph: &mut String| {
        if *folded_calls > 0 {
            let id = result_node(
                prefix,
                serial,
                &fold_label(*folded_calls),
                "fold",
                "box",
                graph,
            );
            if let Some(last) = previous.as_ref() {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            *previous = Some(id);
            *folded_calls = 0;
        }
    };
    let mut at = 0;
    let mut rendered_focus = false;
    while at < nodes.len() {
        let current = &nodes[at];
        let focus = contains_focus(focuses, current);
        if stop_after_focus && rendered_focus && !focus && current.kind != "exit" {
            flush_fold(&mut previous, &mut folded_calls, serial, graph);
            let id = result_node(prefix, serial, "… remainder method", "fold", "box", graph);
            if let Some(last) = previous.as_ref() {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            previous = Some(id);
            break;
        }
        rendered_focus |= focus;
        if collapse_guards && !rendered_focus && !focus && is_returning_guard(current) {
            let mut guards = 1;
            while at + guards < nodes.len()
                && !contains_focus(focuses, &nodes[at + guards])
                && is_returning_guard(&nodes[at + guards])
            {
                guards += 1;
            }
            if guards > 1 {
                flush_fold(&mut previous, &mut folded_calls, serial, graph);
                let id = result_node(
                    prefix,
                    serial,
                    &format!("{} guards with return", guards),
                    "fold",
                    "box",
                    graph,
                );
                if let Some(last) = previous.as_ref() {
                    graph.push_str(&format!("  {last} --> {id}\n"));
                }
                previous = Some(id);
                at += guards;
                continue;
            }
        }
        if current.kind == "call" {
            let visible = focus
                && (!matches_builtin_call(&current.text, language)
                    || current.changed
                    || named_in_delta(spec, &current.text))
                && (!is_builtin_value_method(&current.text, language)
                    || current.changed
                    || named_in_delta(spec, &current.text));
            if !visible {
                if !current.changed && nodes.get(at + 1).is_none_or(|next| next.kind != "exit") {
                    folded_calls += 1;
                }
                at += 1;
                continue;
            }
            flush_fold(&mut previous, &mut folded_calls, serial, graph);
            let replacement = replacements
                .iter()
                .find(|(_, new)| matches(&current.text, new));
            let class = if replacement.is_some() {
                "ok"
            } else if spec
                .change
                .iter()
                .any(|change| removed(change, &current.text))
            {
                "removed"
            } else if spec
                .change
                .iter()
                .any(|c| c.insert.as_ref().is_some_and(|x| matches(&current.text, x)))
            {
                if passing || expected_at(spec, head_calls, &current.text) {
                    "ok"
                } else {
                    "extra"
                }
            } else if current.changed {
                "extra"
            } else {
                "ctx"
            };
            let text = replacement
                .map(|(old, new)| format!("{old} → {new}"))
                .unwrap_or_else(|| current.text.clone());
            let id = result_node(prefix, serial, &text, class, "box", graph);
            if let Some(last) = previous {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            previous = Some(id);
        } else if current.kind == "try" {
            for branch in &current.branches {
                previous = result_nodes(
                    spec,
                    language,
                    head_calls,
                    &branch.nodes,
                    previous,
                    prefix,
                    serial,
                    graph,
                    passing,
                    focuses,
                    false,
                    false,
                    replacements,
                );
            }
        } else if !current.branches.is_empty() {
            if !focus && collapse_guards && !contains_exit(current) {
                let mut inner = Vec::new();
                call_names(std::slice::from_ref(current), &mut inner);
                folded_calls += inner.len();
                at += 1;
                continue;
            }
            flush_fold(&mut previous, &mut folded_calls, serial, graph);
            if !focus && collapse_guards {
                let id = result_node(prefix, serial, &current.text, "fold", "diamond", graph);
                if let Some(last) = previous.as_ref() {
                    graph.push_str(&format!("  {last} --> {id}\n"));
                }
                if current
                    .branches
                    .iter()
                    .any(|branch| branch.nodes.iter().any(|node| node.kind == "exit"))
                {
                    let exit = result_node(prefix, serial, "return", "exit", "exit", graph);
                    graph.push_str(&format!("  {id} --> {exit}\n"));
                }
                previous = Some(id);
                at += 1;
                continue;
            }
            let planned = spec.change.iter().find_map(|change| {
                change
                    .insert
                    .as_ref()
                    .filter(|insert| current.changed && current.text.contains(insert.as_str()))
            });
            let class = if planned.is_some() { "extra" } else { "ctx" };
            let text = planned.unwrap_or(&current.text);
            let id = result_node(prefix, serial, text, class, "diamond", graph);
            if let Some(last) = previous.clone() {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            let mut continuation = None;
            for branch in &current.branches {
                let first_serial = *serial;
                let branch_last = result_nodes(
                    spec,
                    language,
                    head_calls,
                    &branch.nodes,
                    None,
                    prefix,
                    serial,
                    graph,
                    passing,
                    focuses,
                    false,
                    false,
                    replacements,
                );
                if let Some(last) = branch_last {
                    let first = format!("{prefix}{first_serial}");
                    graph.push_str(&format!("  {id} -->|{}| {first}\n", label(&branch.kind)));
                    let exits = branch.nodes.iter().any(contains_exit);
                    if !exits {
                        continuation = Some(last);
                    }
                }
            }
            previous = continuation.or(Some(id));
        } else if current.kind == "exit" {
            flush_fold(&mut previous, &mut folded_calls, serial, graph);
            let id = result_node(
                prefix,
                serial,
                &exit_label(&current.text),
                "exit",
                "exit",
                graph,
            );
            if let Some(last) = previous {
                graph.push_str(&format!("  {last} --> {id}\n"));
            }
            previous = Some(id);
        }
        at += 1;
    }
    flush_fold(&mut previous, &mut folded_calls, serial, graph);
    previous
}

fn result(spec: &Spec, row: &ResultRow, prefix: &str) -> String {
    let language = lang::for_file(&spec.file).expect("flow spec has a supported file");
    let tree = row.head_tree.as_ref().or(row.base_tree.as_ref());
    let mut head_calls = Vec::new();
    if let Some(tree) = row.head_tree.as_ref() {
        call_names(&tree.nodes, &mut head_calls);
        for closure in &tree.closures {
            call_names(&closure.nodes, &mut head_calls);
        }
    } else if let Some(tree) = tree {
        call_names(&tree.nodes, &mut head_calls);
    } else {
        head_calls = calls(spec, row.head_top.as_ref())
            .into_iter()
            .map(|s| s.key.clone())
            .collect();
    }
    let mut graph = String::from("flowchart TD\n");
    let mut serial = 0usize;
    let mut base_calls = Vec::new();
    if let Some(base_tree) = &row.base_tree {
        call_names(&base_tree.nodes, &mut base_calls);
        for closure in &base_tree.closures {
            call_names(&closure.nodes, &mut base_calls);
        }
    } else {
        base_calls = calls(spec, row.base_top.as_ref())
            .into_iter()
            .map(|step| step.key.clone())
            .collect();
    }
    let replacements = replacements(spec, &base_calls, &head_calls);
    if let Some(tree) = tree {
        let focuses = focus_nodes(spec, &tree.nodes);
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
            &focuses,
            true,
            true,
            &replacements,
        );
        for closure in &tree.closures {
            let closure_focuses = focus_nodes(spec, &closure.nodes);
            if closure_changed(&closure_focuses, &closure.nodes) {
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
                    &closure_focuses,
                    true,
                    true,
                    &replacements,
                );
                graph.push_str("  end\n");
            }
        }
        if let (Some(base_tree), Some(head_tree)) = (&row.base_tree, &row.head_tree) {
            if structure_changed(base_tree, head_tree) {
                graph.push_str(&format!("  subgraph {prefix}base [\"base\"]\n"));
                let base_focuses = focus_nodes(spec, &base_tree.nodes);
                result_nodes(
                    spec,
                    language,
                    &head_calls,
                    &base_tree.nodes,
                    None,
                    &format!("{prefix}base_"),
                    &mut serial,
                    &mut graph,
                    row.status == "pass",
                    &base_focuses,
                    true,
                    true,
                    &[],
                );
                graph.push_str("  end\n");
            }
        }
    } else {
        for call in head_calls.iter().filter(|call| named_in_delta(spec, call)) {
            let replacement = replacements.iter().find(|(_, new)| matches(call, new));
            let class = if replacement.is_some()
                || row.status == "pass"
                || expected_at(spec, &head_calls, call)
            {
                "ok"
            } else {
                "extra"
            };
            let text = replacement
                .map(|(old, new)| format!("{old} → {new}"))
                .unwrap_or_else(|| call.clone());
            let _ = result_node(prefix, &mut serial, &text, class, "box", &mut graph);
        }
        if !head_calls.is_empty() && serial == 0 {
            let _ = result_node(
                prefix,
                &mut serial,
                &fold_label(head_calls.len()),
                "fold",
                "box",
                &mut graph,
            );
        }
    }
    for change in &spec.change {
        if let Some(insert) = &change.insert {
            if !expected_at(spec, &head_calls, insert)
                && !replacements
                    .iter()
                    .any(|(_, replacement)| replacement == insert)
            {
                let id = result_node(prefix, &mut serial, insert, "miss", "box", &mut graph);
                if let Some(anchor) = change.before.as_ref().or(change.after.as_ref()) {
                    if let Some(anchor_id) = graph
                        .lines()
                        .filter(|line| line.contains(&format!("\"{}\"", label(anchor))))
                        .nth(change.nth.unwrap_or(1).saturating_sub(1))
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
