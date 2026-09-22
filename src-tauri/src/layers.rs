#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    const ALLOWED: &[(&str, &[&str])] = &[
        ("kernel", &["kernel"]),
        ("contracts", &[]),
        ("analytics", &["kernel", "contracts"]),
        ("board", &["kernel", "contracts"]),
        ("task_cost", &["kernel", "contracts", "board", "analytics"]),
        ("spec", &["kernel"]),
        ("triage", &["kernel", "board"]),
        ("external", &["kernel"]),
    ];

    fn src_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    fn crate_refs(text: &str) -> Vec<String> {
        let code: String = text
            .lines()
            .map(|line| line.split_once("//").map_or(line, |(code, _)| code))
            .collect::<Vec<_>>()
            .join("
");
        let mut out = Vec::new();
        let mut rest = code.as_str();
        while let Some(i) = rest.find("crate::") {
            let after = &rest[i + 7..];
            if after.trim_start().starts_with('{') {
                out.extend(group_refs(after));
            } else if let Some(ident) = path_head(after) {
                out.push(ident);
            }
            rest = after;
        }
        out
    }

    fn path_head(path: &str) -> Option<String> {
        let ident: String = path
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        (!ident.is_empty()).then_some(ident)
    }

    /// Returns the first path component of each entry in a `use` group.
    fn group_refs(group: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut depth = 0;
        let mut entry_start = false;
        let chars: Vec<char> = group.trim_start().chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '{' => {
                    depth += 1;
                    if depth == 1 {
                        entry_start = true;
                    }
                    i += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    i += 1;
                }
                ',' if depth == 1 => {
                    entry_start = true;
                    i += 1;
                }
                c if depth == 1 && entry_start && (c.is_ascii_alphanumeric() || c == '_') => {
                    let start = i;
                    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                        i += 1;
                    }
                    let entry: String = chars[start..i].iter().collect();
                    if entry != "self" {
                        out.push(entry);
                    }
                    entry_start = false;
                }
                _ => i += 1,
            }
        }
        out
    }

    fn has_super_super_ref(text: &str) -> bool {
        text.lines().any(|line| {
            let code = line.split_once("//").map_or(line, |(code, _)| code);
            code.contains("super::super::")
        })
    }

    fn allowed(layer: &str) -> Option<&'static [&'static str]> {
        ALLOWED.iter().find(|(l, _)| *l == layer).map(|(_, a)| *a)
    }

    #[test]
    fn every_module_sits_in_a_layer_and_imports_only_allowed_layers() {
        let root = src_root();
        let mut files = Vec::new();
        walk(&root, &mut files);
        let mut stray = Vec::new();
        let mut bad = Vec::new();
        let mut edges: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for file in files {
            let rel = file.strip_prefix(&root).unwrap();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let mut parts = rel.components();
            let first = parts
                .next()
                .unwrap()
                .as_os_str()
                .to_string_lossy()
                .to_string();
            if rel.components().count() == 1 {
                if !matches!(first.as_str(), "lib.rs" | "main.rs" | "layers.rs") {
                    stray.push(rel_str);
                }
                continue;
            }
            let Some(allow) = allowed(&first) else {
                stray.push(rel_str);
                continue;
            };
            let text = fs::read_to_string(&file).unwrap();
            if has_super_super_ref(&text) {
                bad.push(format!("{rel_str} -> super::super"));
            }
            for target in crate_refs(&text) {
                if target == first {
                    continue;
                }
                if allowed(&target).is_none() {
                    bad.push(format!("{rel_str} -> crate::{target} (not a layer path)"));
                    continue;
                }
                if !allow.contains(&target.as_str()) {
                    bad.push(format!("{rel_str} -> crate::{target}"));
                }
                edges.entry(first.clone()).or_default().push(target);
            }
        }
        assert!(stray.is_empty(), "files outside a layer: {stray:?}");
        assert!(bad.is_empty(), "layer violations:\n{}", bad.join("\n"));
        let mut visiting = Vec::new();
        for layer in edges.keys() {
            assert!(
                !has_cycle(layer, &edges, &mut visiting),
                "layer cycle through {layer}: {visiting:?}"
            );
        }
    }

    #[test]
    fn grouped_crate_imports_are_checked_as_layer_references() {
        let refs = crate_refs("use crate::{board::model::Board, analytics::{Event, Report}};");
        assert_eq!(refs, vec!["board", "analytics"]);
        assert!(!allowed("analytics").unwrap().contains(&"board"));
    }

    #[test]
    fn multiline_grouped_crate_imports_are_checked_as_layer_references() {
        let refs = crate_refs("use crate::{
    board::model::Board,
    // kernel::x,
    analytics::{
        Event,
    },
};");
        assert_eq!(refs, vec!["board", "analytics"]);
    }

    #[test]
    fn grandparent_module_imports_are_forbidden() {
        assert!(has_super_super_ref("use super::super::kernel::Clock;"));
        assert!(!has_super_super_ref(
            "use super::kernel::Clock; // super::super is forbidden"
        ));
    }

    fn has_cycle(
        node: &str,
        edges: &BTreeMap<String, Vec<String>>,
        stack: &mut Vec<String>,
    ) -> bool {
        if stack.iter().any(|s| s == node) {
            stack.push(node.to_string());
            return true;
        }
        stack.push(node.to_string());
        for next in edges.get(node).into_iter().flatten() {
            if next != node && has_cycle(next, edges, stack) {
                return true;
            }
        }
        stack.pop();
        false
    }
}
