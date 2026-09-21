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
        let mut out = Vec::new();
        for line in text.lines() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            let mut rest = code;
            while let Some(i) = rest.find("crate::") {
                let after = &rest[i + 7..];
                let ident: String = after
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if !ident.is_empty() {
                    out.push(ident);
                }
                rest = after;
            }
        }
        out
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
            let first = parts.next().unwrap().as_os_str().to_string_lossy().to_string();
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
            assert!(!has_cycle(layer, &edges, &mut visiting), "layer cycle through {layer}: {visiting:?}");
        }
    }

    fn has_cycle(node: &str, edges: &BTreeMap<String, Vec<String>>, stack: &mut Vec<String>) -> bool {
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
