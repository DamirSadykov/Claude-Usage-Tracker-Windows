use crate::flow::{
    lang::{self, LanguageSpec},
    Spec,
};
use serde::Serialize;
use std::{collections::HashSet, fs, path::Path, process::Command};
use tree_sitter::{Node, Parser, Tree};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct Unchecked {
    pub kind: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub reason: String,
}

#[derive(Debug, Serialize, Default)]
pub struct Coverage {
    pub checked: usize,
    pub changed: usize,
    pub findings: Vec<Unchecked>,
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub coverage: Coverage,
    pub unchecked: Vec<Unchecked>,
    pub cannot: Vec<String>,
}

struct Source {
    bytes: Vec<u8>,
    tree: Tree,
    lang: &'static LanguageSpec,
}

impl Source {
    fn parse(bytes: Vec<u8>, lang: &'static LanguageSpec) -> Result<Self, String> {
        let mut parser = Parser::new();
        let language = (lang.grammar)();
        parser.set_language(&language).map_err(|e| e.to_string())?;
        let tree = parser
            .parse(&bytes, None)
            .ok_or_else(|| "could not parse source".to_string())?;
        Ok(Self { bytes, tree, lang })
    }

    fn text(&self, n: Node) -> String {
        String::from_utf8_lossy(&self.bytes[n.byte_range()])
            .split_whitespace()
            .collect()
    }

    fn methods(&self) -> Vec<Node<'_>> {
        fn visit<'a>(source: &Source, n: Node<'a>, out: &mut Vec<Node<'a>>) {
            if source.lang.method_kinds.contains(&n.kind()) {
                out.push(n);
            }
            let mut cursor = n.walk();
            for child in n.children(&mut cursor) {
                visit(source, child, out);
            }
        }
        let mut out = Vec::new();
        visit(self, self.tree.root_node(), &mut out);
        out
    }

    fn key(&self, method: Node) -> String {
        let name = method
            .child_by_field_name("name")
            .map(|n| self.text(n))
            .unwrap_or_default();
        let params = method
            .child_by_field_name("parameters")
            .map(|n| parameter_types(self, n))
            .unwrap_or_default();
        format!("{name}({params})")
    }

    fn normalized(&self, node: Node) -> String {
        fn append(source: &Source, node: Node, out: &mut String) {
            if node.kind() == source.lang.comment_kind {
                return;
            }
            if node.child_count() == 0 {
                out.extend(
                    String::from_utf8_lossy(&source.bytes[node.byte_range()])
                        .chars()
                        .filter(|c| !c.is_whitespace()),
                );
                return;
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                append(source, child, out);
            }
        }
        let mut out = String::new();
        append(self, node, &mut out);
        out
    }
}

fn parameter_types(source: &Source, parameters: Node) -> String {
    let mut cursor = parameters.walk();
    parameters
        .named_children(&mut cursor)
        .map(|parameter| {
            let raw = String::from_utf8_lossy(&source.bytes[parameter.byte_range()]);
            let mut parts: Vec<_> = raw.split_whitespace().collect();
            parts.pop();
            parts.concat()
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn spec_key(spec: &Spec) -> String {
    let params = spec
        .params
        .as_deref()
        .map(|p| p.split_whitespace().collect::<String>())
        .unwrap_or_default();
    format!("{}({params})", spec.method)
}

fn git(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn base_file(repo: &Path, base: &str, file: &str) -> Result<Vec<u8>, String> {
    git(repo, &["show", &format!("{base}:{file}")])
}

fn head_file(repo: &Path, head: Option<&str>, file: &str) -> Result<Vec<u8>, String> {
    match head {
        Some(rev) => git(repo, &["show", &format!("{rev}:{file}")]),
        None => fs::read(repo.join(file)).map_err(|e| e.to_string()),
    }
}

fn touched_base_lines(
    repo: &Path,
    base: &str,
    head: Option<&str>,
    file: &str,
) -> Result<HashSet<usize>, String> {
    let mut args = vec!["diff", "--unified=0", base];
    if let Some(rev) = head {
        args.push(rev);
    }
    args.extend(["--", file]);
    let raw = git(repo, &args)?;
    let text = String::from_utf8_lossy(&raw);
    let mut lines = HashSet::new();
    for line in text.lines().filter(|line| line.starts_with("@@")) {
        let Some(old) = line.split_whitespace().nth(1) else {
            continue;
        };
        let old = old.trim_start_matches('-');
        let mut parts = old.split(',');
        let start: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        let count: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(1);
        if count == 0 {
            lines.insert(start.max(1));
        } else {
            lines.extend(start..start + count);
        }
    }
    Ok(lines)
}

fn named(specs: &[Spec], file: &str, key: &str) -> bool {
    specs
        .iter()
        .any(|s| s.file == file && s.na.is_none() && !s.method.is_empty() && spec_key(s) == key)
}

fn na_for(specs: &[Spec], file: &str, key: Option<&str>) -> Option<String> {
    specs.iter().find_map(|s| {
        if s.file != file || s.na.is_none() {
            return None;
        }
        if s.method.is_empty() || key.is_some_and(|k| spec_key(s) == k) {
            Some(s.na.clone().unwrap())
        } else {
            None
        }
    })
}

pub fn inspect(specs: &[Spec], repo: &Path, base: &str, head: Option<&str>) -> Report {
    let mut report = Report::default();
    for spec in specs
        .iter()
        .filter(|s| s.na.is_some() && !s.method.is_empty())
    {
        let reason = spec.na.clone().unwrap();
        if reason.trim().is_empty() {
            report
                .cannot
                .push(format!("na without reason: {}::{}", spec.file, spec.method));
        }
        report.unchecked.push(Unchecked {
            kind: "method-na".into(),
            file: spec.file.clone(),
            method: Some(spec.method.clone()),
            reason: if reason.trim().is_empty() {
                "cannot".into()
            } else {
                reason
            },
        });
    }
    let mut files: HashSet<String> = specs.iter().map(|s| s.file.clone()).collect();
    let mut args = vec!["diff", "--name-only", base];
    if let Some(rev) = head {
        args.push(rev);
    }
    match git(repo, &args) {
        Ok(names) => files.extend(
            String::from_utf8_lossy(&names)
                .lines()
                .filter(|name| lang::supported_file(name))
                .map(str::to_owned),
        ),
        Err(e) => report.unchecked.push(Unchecked {
            kind: "files".into(),
            file: String::new(),
            method: None,
            reason: e,
        }),
    }
    for file in &files {
        let file = file.as_str();
        let language = match lang::for_file(file) {
            Ok(language) => language,
            Err(reason) => {
                report.cannot.push(format!("{file}: {reason}"));
                continue;
            }
        };
        if let Some(reason) = na_for(specs, file, None)
            .filter(|_| specs.iter().any(|s| s.file == file && s.method.is_empty()))
        {
            if reason.trim().is_empty() {
                report.cannot.push(format!("na without reason: {file}"));
            }
            report.unchecked.push(Unchecked {
                kind: "file-na".into(),
                file: file.to_string(),
                method: None,
                reason: if reason.trim().is_empty() {
                    "cannot".into()
                } else {
                    reason
                },
            });
            continue;
        }
        let (base_bytes, head_bytes, lines) = match (
            base_file(repo, base, file),
            head_file(repo, head, file),
            touched_base_lines(repo, base, head, file),
        ) {
            (Ok(b), Ok(h), Ok(l)) => (b, h, l),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
                report.unchecked.push(Unchecked {
                    kind: "file".into(),
                    file: file.to_string(),
                    method: None,
                    reason: e,
                });
                continue;
            }
        };
        let (base_src, head_src) = match (
            Source::parse(base_bytes, language),
            Source::parse(head_bytes, language),
        ) {
            (Ok(b), Ok(h)) => (b, h),
            (Err(e), _) | (_, Err(e)) => {
                report.unchecked.push(Unchecked {
                    kind: "file".into(),
                    file: file.to_string(),
                    method: None,
                    reason: e,
                });
                continue;
            }
        };
        for method in base_src.methods() {
            let start = method.start_position().row + 1;
            let end = method.end_position().row + 1;
            if !lines.iter().any(|line| *line >= start && *line <= end) {
                continue;
            }
            let key = base_src.key(method);
            let head_method = head_src
                .methods()
                .into_iter()
                .find(|m| head_src.key(*m) == key);
            if head_method
                .map(|head_method| base_src.normalized(method) == head_src.normalized(head_method))
                .unwrap_or(false)
            {
                continue;
            }
            report.coverage.changed += 1;
            if na_for(specs, file, Some(&key)).is_some() {
            } else if named(specs, file, &key) {
                report.coverage.checked += 1;
            } else {
                report.coverage.findings.push(Unchecked {
                    kind: "outside-delta".into(),
                    file: file.to_string(),
                    method: Some(key),
                    reason: if head_method.is_some() {
                        "changed base method is not named in delta".into()
                    } else {
                        "changed base method has no matching head method".into()
                    },
                });
            }
        }
    }
    report
}
