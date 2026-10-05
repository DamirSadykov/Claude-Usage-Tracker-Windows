use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    process::Command,
};
use tree_sitter::{Node, Parser, Tree};

#[path = "lang.rs"]
pub mod lang;

use lang::LanguageSpec;

#[path = "extra.rs"]
mod extra;

#[derive(Debug)]
pub struct Cannot(pub String);

#[derive(Debug, Deserialize, Clone)]
pub struct Spec {
    pub file: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub na: Option<String>,
    pub params: Option<String>,
    #[serde(default)]
    pub change: Vec<Change>,
    #[serde(default)]
    pub preserve: Preserve,
    #[serde(default)]
    pub keep: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Change {
    pub insert: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub nth: Option<usize>,
    pub guard: Option<String>,
    #[serde(rename = "remove-call")]
    pub remove_call: Option<String>,
    #[serde(rename = "remove-read")]
    pub remove_read: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum Preserve {
    Word(String),
}
impl Default for Preserve {
    fn default() -> Self {
        Self::Word("all".into())
    }
}
impl Preserve {
    fn all(&self) -> bool {
        matches!(self, Self::Word(s) if s == "all")
    }
}

#[derive(Debug, Serialize)]
pub struct ResultRow {
    pub method: String,
    pub status: String,
    pub problems: Vec<String>,
    pub extra: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub depth_limited: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_steps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_steps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_top: Option<Vec<TopStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_top: Option<Vec<TopStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_tree: Option<FlowTree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_tree: Option<FlowTree>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopStep {
    pub kind: String,
    pub key: String,
    pub line: usize,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowTree {
    pub nodes: Vec<FlowNode>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub closures: Vec<ClosureTree>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowNode {
    pub kind: String,
    pub text: String,
    pub line: usize,
    pub changed: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub branches: Vec<FlowBranch>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowBranch {
    pub kind: String,
    pub nodes: Vec<FlowNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosureTree {
    pub name: String,
    pub nodes: Vec<FlowNode>,
}

#[derive(Clone, Debug)]
struct Step {
    kind: &'static str,
    key: String,
    line: usize,
    node_id: usize,
}

struct Source {
    bytes: Vec<u8>,
    tree: Tree,
    lang: &'static LanguageSpec,
}
impl Source {
    fn parse(bytes: Vec<u8>, lang: &'static LanguageSpec) -> Result<Self, Cannot> {
        let mut parser = Parser::new();
        let language = (lang.grammar)();
        parser
            .set_language(&language)
            .map_err(|e| Cannot(e.to_string()))?;
        let tree = parser
            .parse(&bytes, None)
            .ok_or_else(|| Cannot("could not parse source".into()))?;
        Ok(Self { bytes, tree, lang })
    }
    fn text(&self, n: Node) -> String {
        String::from_utf8_lossy(&self.bytes[n.byte_range()])
            .split_whitespace()
            .collect()
    }
    fn display_text(&self, n: Node) -> String {
        String::from_utf8_lossy(&self.bytes[n.byte_range()])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn walk<'a>(&self, node: Node<'a>, out: &mut Vec<Node<'a>>) {
        out.push(node);
        let mut c = node.walk();
        for n in node.children(&mut c) {
            self.walk(n, out);
        }
    }
    fn methods(&self) -> Vec<Node<'_>> {
        let mut v = Vec::new();
        self.walk(self.tree.root_node(), &mut v);
        v.into_iter()
            .filter(|n| self.lang.method_kinds.contains(&n.kind()))
            .collect()
    }
    fn find_method(&self, name: &str, params: Option<&str>) -> Result<Node<'_>, Cannot> {
        let found: Vec<_> = self
            .methods()
            .into_iter()
            .filter(|m| {
                self.method_name(*m)
                    .map(|method_name| {
                        method_name == name
                            || (!name.contains(['.', ':'])
                                && method_name.rsplit(['.', ':']).next() == Some(name))
                    })
                    .unwrap_or(false)
                    && params
                        .map(|p| {
                            m.child_by_field_name("parameters")
                                .map(|n| {
                                    self.text(n)
                                        == format!("({})", p.split_whitespace().collect::<String>())
                                })
                                .unwrap_or(false)
                        })
                        .unwrap_or(true)
            })
            .collect();
        if found.is_empty() {
            return Err(Cannot(format!("method not found: {name}")));
        }
        if found.len() > 1 {
            return Err(Cannot(format!(
                "method {name} has {} overloads, set params",
                found.len()
            )));
        }
        let method = found[0];
        let mut nodes = Vec::new();
        self.walk(method, &mut nodes);
        if nodes.iter().any(|n| n.kind() == "ERROR" || n.is_missing()) {
            return Err(Cannot(format!("parse error inside {name}")));
        }
        Ok(method)
    }
    fn method_name(&self, method: Node) -> Option<String> {
        let name = method.child_by_field_name("name");
        let bare = name.map(|n| self.text(n));
        if self
            .lang
            .extensions
            .iter()
            .any(|x| ["ts", "tsx", "js", "mjs", "cjs"].contains(x))
        {
            let bare = bare.or_else(|| {
                let parent = method.parent()?;
                if parent.kind() == "variable_declarator"
                    && parent.child_by_field_name("value") == Some(method)
                {
                    parent.child_by_field_name("name").map(|n| self.text(n))
                } else if parent.kind() == "pair"
                    && parent.child_by_field_name("value") == Some(method)
                {
                    parent.child_by_field_name("key").map(|n| self.text(n))
                } else {
                    None
                }
            })?;
            if method.kind() == "method_definition" {
                let mut node = method;
                while let Some(parent) = node.parent() {
                    if parent.kind() == "class_declaration" {
                        if let Some(class) = parent.child_by_field_name("name") {
                            return Some(format!("{}.{}", self.text(class), bare));
                        }
                    }
                    node = parent;
                }
            }
            return Some(bare);
        }
        let bare = bare?;
        if !self.lang.extensions.contains(&"rs") {
            return Some(bare);
        }
        let mut node = method;
        while let Some(parent) = node.parent() {
            if parent.kind() == "impl_item" {
                if let Some(ty) = parent.child_by_field_name("type") {
                    return Some(format!("{}::{bare}", self.text(ty)));
                }
            }
            if parent.kind() == "trait_item" {
                if let Some(ty) = parent.child_by_field_name("name") {
                    return Some(format!("{}::{bare}", self.text(ty)));
                }
            }
            node = parent;
        }
        Some(bare)
    }
    fn callee(&self, node: Node) -> String {
        if self.lang.new_expression_kind == Some(node.kind()) {
            return node
                .child_by_field_name("constructor")
                .map(|n| format!("new:{}", self.text(n)))
                .unwrap_or_default();
        }
        if self.lang.macro_invocation_kind == Some(node.kind()) {
            return node
                .child_by_field_name("macro")
                .map(|n| format!("{}!", self.text(n)))
                .unwrap_or_default();
        }
        let Some(function) = node.child_by_field_name("function") else {
            return String::new();
        };
        let receiver = self.text(function);
        lang::callee_name(&receiver)
    }
    fn steps(&self, method: Node) -> Vec<Step> {
        fn visit(s: &Source, n: Node, out: &mut Vec<Step>) {
            let mut c = n.walk();
            for x in n.children(&mut c) {
                visit(s, x, out);
            }
            if n.kind() == s.lang.invocation_kind
                || s.lang.macro_invocation_kind == Some(n.kind())
                || s.lang.new_expression_kind == Some(n.kind())
            {
                out.push(Step {
                    kind: "call",
                    key: s.callee(n),
                    line: n.start_position().row + 1,
                    node_id: n.id(),
                });
            }
            if n.kind() == s.lang.member_access_kind {
                let p = n.parent();
                if p.map(|x| x.kind() == s.lang.member_access_kind)
                    .unwrap_or(false)
                {
                    return;
                }
                if p.map(|x| {
                    (x.kind() == s.lang.invocation_kind
                        || s.lang.macro_invocation_kind == Some(x.kind())
                        || s.lang.new_expression_kind == Some(x.kind()))
                        && x.child_by_field_name("function") == Some(n)
                })
                .unwrap_or(false)
                {
                    return;
                }
                let key = s.text(n);
                out.push(Step {
                    kind: "read",
                    key: key.strip_prefix("this.").unwrap_or(&key).to_string(),
                    line: n.start_position().row + 1,
                    node_id: n.id(),
                });
            }
        }
        let mut out = Vec::new();
        visit(
            self,
            method.child_by_field_name("body").unwrap_or(method),
            &mut out,
        );
        out
    }
    fn tree(&self, method: Node, changed: &HashSet<usize>) -> FlowTree {
        fn body<'a>(n: Node<'a>) -> Node<'a> {
            n.child_by_field_name("body").unwrap_or(n)
        }
        fn branch_body<'a>(n: Node<'a>, names: &[&str]) -> Option<Node<'a>> {
            names.iter().find_map(|name| n.child_by_field_name(name))
        }
        fn closure_name(s: &Source, n: Node) -> String {
            let mut at = n;
            while let Some(parent) = at.parent() {
                if parent.kind() == s.lang.variable_declarator_kind {
                    if let Some(name) = parent.child_by_field_name("name") {
                        return s.text(name);
                    }
                    if let Some(name) = parent.child_by_field_name("left") {
                        return s.text(name);
                    }
                }
                if parent.kind() == "assignment_expression" {
                    if let Some(name) = parent.child_by_field_name("left") {
                        return s.text(name);
                    }
                }
                at = parent;
            }
            "<closure>".into()
        }
        fn visit(
            s: &Source,
            n: Node,
            changed: &HashSet<usize>,
            closures: &mut Vec<ClosureTree>,
        ) -> Vec<FlowNode> {
            if s.lang.closure_kinds.contains(&n.kind()) {
                let nodes = visit(s, body(n), changed, closures);
                closures.push(ClosureTree {
                    name: closure_name(s, n),
                    nodes,
                });
                return Vec::new();
            }
            let line = n.start_position().row + 1;
            let node = |kind: &str, text: String, branches: Vec<FlowBranch>| FlowNode {
                kind: kind.into(),
                text,
                line,
                changed: changed.contains(&line),
                branches,
            };
            if n.kind() == s.lang.invocation_kind
                || s.lang.macro_invocation_kind == Some(n.kind())
                || s.lang.new_expression_kind == Some(n.kind())
            {
                let mut out = Vec::new();
                let mut cursor = n.walk();
                for child in n.named_children(&mut cursor) {
                    out.extend(visit(s, child, changed, closures));
                }
                out.push(node("call", s.callee(n), Vec::new()));
                return out;
            }
            if s.lang.exit_kinds.contains(&n.kind()) {
                let mut out = Vec::new();
                let mut cursor = n.walk();
                for child in n.named_children(&mut cursor) {
                    out.extend(visit(s, child, changed, closures));
                }
                out.push(node("exit", s.display_text(n), Vec::new()));
                return out;
            }
            if s.lang.branch_kinds.contains(&n.kind()) {
                let text = branch_body(n, &["condition", "value"])
                    .map(|x| s.display_text(x))
                    .unwrap_or_else(|| s.display_text(n));
                let mut branches = Vec::new();
                if n.kind().contains("switch") || n.kind().contains("match") {
                    fn cases<'a>(s: &Source, n: Node<'a>, out: &mut Vec<Node<'a>>) {
                        let mut cursor = n.walk();
                        for child in n.named_children(&mut cursor) {
                            if s.lang.case_kinds.contains(&child.kind()) {
                                out.push(child);
                            } else if !s.lang.branch_kinds.contains(&child.kind())
                                && !s.lang.closure_kinds.contains(&child.kind())
                            {
                                cases(s, child, out);
                            }
                        }
                    }
                    let mut direct_cases = Vec::new();
                    cases(s, n, &mut direct_cases);
                    for case in direct_cases {
                        branches.push(FlowBranch {
                            kind: s.text(case.child_by_field_name("value").unwrap_or(case)),
                            nodes: visit(s, case, changed, closures),
                        });
                    }
                } else {
                    if let Some(then) = branch_body(n, &["consequence", "body"]) {
                        branches.push(FlowBranch {
                            kind: "then".into(),
                            nodes: visit(s, then, changed, closures),
                        });
                    }
                    if let Some(otherwise) = n.child_by_field_name("alternative") {
                        branches.push(FlowBranch {
                            kind: "else".into(),
                            nodes: visit(s, otherwise, changed, closures),
                        });
                    }
                }
                return vec![node("branch", text, branches)];
            }
            if s.lang.loop_kinds.contains(&n.kind()) {
                let text = branch_body(n, &["condition", "value"])
                    .map(|x| s.display_text(x))
                    .unwrap_or_else(|| s.display_text(n));
                let nodes = branch_body(n, &["body", "consequence"])
                    .map(|x| visit(s, x, changed, closures))
                    .unwrap_or_default();
                return vec![node(
                    "loop",
                    text,
                    vec![FlowBranch {
                        kind: "body".into(),
                        nodes,
                    }],
                )];
            }
            if s.lang.try_kinds.contains(&n.kind()) {
                let mut branches = Vec::new();
                let mut cursor = n.walk();
                for child in n.named_children(&mut cursor) {
                    let kind = match child.kind() {
                        "catch_clause" | "catch_block" => Some("catch"),
                        "finally_clause" | "finally_block" => Some("finally"),
                        _ if child.kind() == s.lang.block_kind => Some("try"),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        branches.push(FlowBranch {
                            kind: kind.into(),
                            nodes: visit(s, child, changed, closures),
                        });
                    }
                }
                return vec![node("try", "try".into(), branches)];
            }
            let mut out = Vec::new();
            let mut cursor = n.walk();
            for child in n.named_children(&mut cursor) {
                out.extend(visit(s, child, changed, closures));
            }
            out
        }
        let mut closures = Vec::new();
        let nodes = visit(
            self,
            method.child_by_field_name("body").unwrap_or(method),
            changed,
            &mut closures,
        );
        FlowTree { nodes, closures }
    }
    fn locals(&self, method: Node) -> HashSet<String> {
        let mut ns = Vec::new();
        self.walk(method, &mut ns);
        ns.into_iter()
            .filter_map(|n| {
                if self.lang.local_kinds.contains(&n.kind()) {
                    n.child_by_field_name("name")
                        .or_else(|| n.child_by_field_name("left"))
                        .filter(|x| x.kind() == self.lang.identifier_kind)
                        .map(|x| self.text(x))
                } else {
                    None
                }
            })
            .collect()
    }
    fn flow(&self, method: Node, depth: usize, seen: &mut HashSet<usize>) -> Vec<Step> {
        seen.insert(method.id());
        let local = self.locals(method);
        let mut by: HashMap<String, Vec<Node>> = HashMap::new();
        for m in self.methods() {
            if let Some(n) = self.method_name(m) {
                by.entry(n).or_default().push(m);
            }
        }
        let mut out = Vec::new();
        for mut step in self.steps(method) {
            let root = step.key.split('.').next().unwrap_or("");
            if local.contains(root) && step.key.contains('.') {
                if step.kind == "read" {
                    continue;
                }
                step.key = format!("*.{}", step.key.rsplit('.').next().unwrap());
            }
            let target = by
                .get(&step.key)
                .and_then(|v| if v.len() == 1 { Some(v[0]) } else { None });
            let call = step.kind == "call" && !step.key.contains('.');
            out.push(step);
            if call && depth > 0 {
                if let Some(t) = target {
                    if !seen.contains(&t.id()) {
                        let mut branch_seen = seen.clone();
                        out.extend(self.flow(t, depth - 1, &mut branch_seen));
                    }
                }
            }
        }
        out
    }
    fn depth_limited(&self, method: Node, depth: usize, seen: &mut HashSet<usize>) -> Vec<String> {
        seen.insert(method.id());
        let local = self.locals(method);
        let mut by: HashMap<String, Vec<Node>> = HashMap::new();
        for m in self.methods() {
            if let Some(n) = self.method_name(m) {
                by.entry(n).or_default().push(m);
            }
        }
        let mut out = Vec::new();
        for step in self.steps(method) {
            let root = step.key.split('.').next().unwrap_or("");
            if step.kind != "call" || step.key.contains('.') || local.contains(root) {
                continue;
            }
            let Some(t) = by
                .get(&step.key)
                .and_then(|v| if v.len() == 1 { Some(v[0]) } else { None })
            else {
                continue;
            };
            if seen.contains(&t.id()) {
                continue;
            }
            if depth == 0 {
                out.push(step.key.clone());
            } else {
                let mut branch_seen = seen.clone();
                out.extend(self.depth_limited(t, depth - 1, &mut branch_seen));
            }
        }
        out
    }
    fn extra_flow(
        &self,
        method: Node,
        depth: usize,
        seen: &mut HashSet<usize>,
        inserted: &HashSet<String>,
    ) -> Vec<Step> {
        seen.insert(method.id());
        let local = self.locals(method);
        let mut by: HashMap<String, Vec<Node>> = HashMap::new();
        for m in self.methods() {
            if let Some(n) = self.method_name(m) {
                by.entry(n).or_default().push(m);
            }
        }
        let mut out = Vec::new();
        for mut step in self.steps(method) {
            let root = step.key.split('.').next().unwrap_or("");
            if local.contains(root) && step.key.contains('.') {
                if step.kind == "read" {
                    continue;
                }
                step.key = format!("*.{}", step.key.rsplit('.').next().unwrap());
            }
            let target = by
                .get(&step.key)
                .and_then(|v| if v.len() == 1 { Some(v[0]) } else { None });
            let internal_call = step.kind == "call" && !step.key.contains('.') && target.is_some();
            if !internal_call
                && !(step.kind == "call" && inserted.iter().any(|x| matches(&step.key, x)))
            {
                out.push(step.clone());
            }
            if internal_call && depth > 0 && !inserted.iter().any(|x| matches(&step.key, x)) {
                let t = target.unwrap();
                if !seen.contains(&t.id()) {
                    let mut branch_seen = seen.clone();
                    out.extend(self.extra_flow(t, depth - 1, &mut branch_seen, inserted));
                }
            }
        }
        out
    }
}

fn matches(key: &str, name: &str) -> bool {
    key == name || key.ends_with(&format!(".{name}"))
}
fn key(s: &Step) -> String {
    format!("{}:{}", s.kind, s.key)
}
fn load_source(repo: &Path, rev: Option<&str>, file: &str) -> Result<Source, Cannot> {
    let lang = lang::for_file(file).map_err(Cannot)?;
    let bytes = match rev {
        None => {
            fs::read(repo.join(file)).map_err(|_| Cannot(format!("head: file not found {file}")))?
        }
        Some(r) => {
            let o = Command::new("git")
                .args([
                    "-C",
                    &repo.display().to_string(),
                    "show",
                    &format!("{r}:{file}"),
                ])
                .output()
                .map_err(|e| Cannot(e.to_string()))?;
            if !o.status.success() {
                return Err(Cannot(format!("{r}: file not found {file}")));
            }
            o.stdout
        }
    };
    Source::parse(bytes, lang)
}

fn is_call_to(s: &Source, n: Node, name: &str) -> bool {
    (n.kind() == s.lang.invocation_kind
        || s.lang.macro_invocation_kind == Some(n.kind())
        || s.lang.new_expression_kind == Some(n.kind()))
        && matches(&s.callee(n), name)
}
fn contains_call(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> bool {
    let mut nodes = Vec::new();
    s.walk(n, &mut nodes);
    nodes.into_iter().any(|x| {
        is_call_to(s, x, name)
            || (x.kind() == s.lang.identifier_kind && aliases.contains(&s.text(x)))
    })
}
fn unwrap<'a>(s: &Source, n: Option<Node<'a>>) -> Option<Node<'a>> {
    let mut n = n?;
    while n.kind() == s.lang.parenthesized_kind {
        n = n.named_child(0)?;
    }
    Some(n)
}
fn is_guard_atom(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> bool {
    is_call_to(s, n, name) || (n.kind() == s.lang.identifier_kind && aliases.contains(&s.text(n)))
}
fn bool_literal(s: &Source, n: Node) -> Option<bool> {
    match s.text(n).as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
fn eq_form(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> Option<bool> {
    if n.kind() != s.lang.binary_kind {
        return None;
    }
    let op = s.text(n.child_by_field_name("operator")?);
    let l = unwrap(s, n.child_by_field_name("left"))?;
    let r = unwrap(s, n.child_by_field_name("right"))?;
    for (a, b) in [(l, r), (r, l)] {
        if let Some(lit) = bool_literal(s, b) {
            if is_guard_atom(s, a, name, aliases) {
                return Some((lit && op == "==") || (!lit && op == "!="));
            }
        }
    }
    None
}
fn true_implies_valid(s: &Source, n: Option<Node>, name: &str, aliases: &HashSet<String>) -> bool {
    let Some(n) = unwrap(s, n) else { return false };
    if is_guard_atom(s, n, name, aliases) {
        return true;
    }
    if n.kind() == s.lang.prefix_unary_kind {
        return invalid_implies_true(s, n.named_child(0), name, aliases);
    }
    if let Some(v) = eq_form(s, n, name, aliases) {
        return v;
    }
    if n.kind() == s.lang.binary_kind {
        let l = n.child_by_field_name("left");
        let r = n.child_by_field_name("right");
        return match s.text(n.child_by_field_name("operator").unwrap()).as_str() {
            "&&" => {
                true_implies_valid(s, l, name, aliases) || true_implies_valid(s, r, name, aliases)
            }
            "||" => {
                true_implies_valid(s, l, name, aliases) && true_implies_valid(s, r, name, aliases)
            }
            _ => false,
        };
    }
    false
}
fn invalid_implies_true(
    s: &Source,
    n: Option<Node>,
    name: &str,
    aliases: &HashSet<String>,
) -> bool {
    let Some(n) = unwrap(s, n) else { return false };
    if n.kind() == s.lang.prefix_unary_kind {
        return true_implies_valid(s, n.named_child(0), name, aliases);
    }
    if let Some(v) = eq_form(s, n, name, aliases) {
        return !v;
    }
    if n.kind() == s.lang.binary_kind {
        let l = n.child_by_field_name("left");
        let r = n.child_by_field_name("right");
        return match s.text(n.child_by_field_name("operator").unwrap()).as_str() {
            "||" => {
                invalid_implies_true(s, l, name, aliases)
                    || invalid_implies_true(s, r, name, aliases)
            }
            "&&" => {
                invalid_implies_true(s, l, name, aliases)
                    && invalid_implies_true(s, r, name, aliases)
            }
            _ => false,
        };
    }
    false
}
fn exits(s: &Source, n: Node) -> bool {
    match n.kind() {
        kind if s.lang.exit_kinds.contains(&kind) => true,
        kind if kind == s.lang.block_kind => {
            let mut c = n.walk();
            n.named_children(&mut c)
                .filter(|x| x.kind() != s.lang.comment_kind)
                .last()
                .map(|node| exits(s, node))
                .unwrap_or(false)
        }
        kind if kind == s.lang.conditional_kind => {
            n.child_by_field_name("consequence")
                .map(|node| exits(s, node))
                .unwrap_or(false)
                && n.child_by_field_name("alternative")
                    .map(|node| exits(s, node))
                    .unwrap_or(false)
        }
        _ if s.lang.macro_invocation_kind == Some(n.kind()) => {
            matches!(s.callee(n).as_str(), "panic!" | "unreachable!" | "todo!")
        }
        _ if n.kind() == s.lang.expression_statement_kind => n
            .named_child(0)
            .map(|child| exits(s, child))
            .unwrap_or(false),
        _ => false,
    }
}
fn top_level_call(s: &Source, stmt: Node, name: &str) -> bool {
    if stmt.kind() == s.lang.expression_statement_kind {
        let mut e = stmt.named_child(0);
        if e.map(|x| x.kind() == s.lang.await_kind).unwrap_or(false) {
            e = e.and_then(|x| x.named_child(0));
        }
        return e.map(|x| is_call_to(s, x, name)).unwrap_or(false);
    }
    stmt.kind() == s.lang.local_declaration_kind && contains_call(s, stmt, name, &HashSet::new())
}
fn bare_call(s: &Source, stmt: Node, name: &str) -> bool {
    if stmt.kind() != s.lang.expression_statement_kind {
        return false;
    }
    let mut e = stmt.named_child(0);
    if e.map(|x| x.kind() == s.lang.await_kind).unwrap_or(false) {
        e = e.and_then(|x| x.named_child(0));
    }
    e.map(|x| is_call_to(s, x, name)).unwrap_or(false)
}

fn call_in_single_statement_try(s: &Source, stmt: Node, name: &str, mode: &str) -> bool {
    if stmt.kind() != "try_statement" || !matches!(mode, "none" | "throws") {
        return false;
    }
    let body = stmt
        .child_by_field_name("body")
        .or_else(|| stmt.named_child(0));
    let Some(body) = body else {
        return false;
    };
    let mut cursor = body.walk();
    let statements: Vec<_> = body.named_children(&mut cursor).collect();
    if statements.len() != 1 {
        return false;
    }
    if mode == "throws" {
        bare_call(s, statements[0], name)
    } else {
        top_level_call(s, statements[0], name)
    }
}

fn previous_named_sibling<'a>(block: Node<'a>, node: Node<'a>) -> Option<Node<'a>> {
    let mut cursor = block.walk();
    let mut previous = None;
    for sibling in block.named_children(&mut cursor) {
        if sibling == node {
            return previous;
        }
        previous = Some(sibling);
    }
    None
}

fn enclosing_aliases(s: &Source, node: Node, name: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut n = node;
    while let Some(p) = n.parent() {
        if s.lang.method_kinds.contains(&n.kind()) {
            break;
        }
        if p.kind() == s.lang.block_kind {
            let mut c = p.walk();
            for stmt in p.children(&mut c) {
                if stmt == n {
                    break;
                }
                if stmt.kind() != s.lang.local_declaration_kind {
                    continue;
                }
                let mut all = Vec::new();
                s.walk(stmt, &mut all);
                for d in all
                    .into_iter()
                    .filter(|x| x.kind() == s.lang.variable_declarator_kind)
                {
                    if contains_call(s, d, name, &HashSet::new()) {
                        if let Some(x) = d.child_by_field_name("name").or_else(|| d.named_child(0))
                        {
                            names.insert(s.text(x));
                        }
                    }
                }
            }
        }
        n = p;
    }
    names
}
fn guarded(s: &Source, target: Node, name: &str, mode: &str) -> bool {
    let mut n = target;
    while let Some(p) = n.parent() {
        if s.lang.method_kinds.contains(&n.kind()) {
            break;
        }
        if mode == "returns-bool" && p.kind() == s.lang.conditional_kind {
            let a = enclosing_aliases(s, p, name);
            if p.child_by_field_name("consequence") == Some(n)
                && true_implies_valid(s, p.child_by_field_name("condition"), name, &a)
            {
                return true;
            }
            if p.child_by_field_name("alternative") == Some(n)
                && invalid_implies_true(s, p.child_by_field_name("condition"), name, &a)
            {
                return true;
            }
        }
        if p.kind() == s.lang.block_kind {
            let a = enclosing_aliases(s, n, name);
            if previous_named_sibling(p, n)
                .map(|stmt| call_in_single_statement_try(s, stmt, name, mode))
                .unwrap_or(false)
            {
                return true;
            }
            let mut rust_alias = false;
            let mut c = p.walk();
            for stmt in p.children(&mut c) {
                if stmt == n {
                    break;
                }
                if s.lang.extensions == ["rs"]
                    && s.text(stmt).contains(&format!("{name}("))
                    && s.text(stmt).starts_with("let")
                {
                    rust_alias = true;
                }
                if mode == "returns-bool"
                    && stmt.kind() == s.lang.conditional_kind
                    && invalid_implies_true(s, stmt.child_by_field_name("condition"), name, &a)
                    && stmt
                        .child_by_field_name("consequence")
                        .map(|node| exits(s, node))
                        .unwrap_or(false)
                {
                    return true;
                }
                if mode == "returns-bool" && rust_bool_guard(s, stmt, name, rust_alias) {
                    return true;
                }
                if mode == "returns-result" && rust_result_guard(s, stmt, name) {
                    return true;
                }
                if mode == "throws" && bare_call(s, stmt, name) {
                    return true;
                }
                if mode == "none" && top_level_call(s, stmt, name) {
                    return true;
                }
            }
        }
        n = p;
    }
    false
}

fn rust_bool_guard(s: &Source, stmt: Node, name: &str, alias: bool) -> bool {
    if s.lang.extensions != ["rs"] {
        return false;
    }
    let text = s.text(stmt);
    text.starts_with("if")
        && !text.contains("&&")
        && text.matches("if").count() == 1
        && (text.contains(&format!("!self.{name}("))
            || (text.contains(&format!("{name}(")) && text.contains("==false"))
            || (alias && text.starts_with("if!")))
        && (text.contains("return") || text.contains("panic!"))
}

fn rust_result_guard(s: &Source, stmt: Node, name: &str) -> bool {
    if s.lang.extensions != ["rs"] {
        return false;
    }
    let text = s.text(stmt);
    let called = text.contains(&format!("{name}(")) || text.contains(&format!("::{name}("));
    let conditional = if stmt.kind() == s.lang.expression_statement_kind {
        stmt.named_child(0).unwrap_or(stmt)
    } else {
        stmt
    };
    called
        && ((text.ends_with("?;") || text.contains("else{return"))
            || (text.starts_with("if")
                && text.contains(".is_err()")
                && conditional
                    .child_by_field_name("consequence")
                    .map(|branch| exits(s, branch))
                    .unwrap_or(false))
            || (text.starts_with("match") && text.contains("Err(") && text.contains("return")))
}

fn subsequence_missing(need: &[String], have: &[String]) -> Vec<String> {
    let mut index = 0;
    let mut missing = Vec::new();
    for wanted in need {
        let mut probe = index;
        while probe < have.len() && have[probe] != *wanted {
            probe += 1;
        }
        if probe == have.len() {
            missing.push(wanted.clone());
        } else {
            index = probe + 1;
        }
    }
    missing
}

fn changed_lines(
    repo: &Path,
    base: &str,
    head: Option<&str>,
    file: &str,
) -> (HashSet<usize>, HashSet<usize>) {
    let mut command = Command::new("git");
    command.args(["diff", "--unified=0", base]);
    if let Some(head) = head {
        command.arg(head);
    }
    let output = command.args(["--", file]).current_dir(repo).output();
    let Ok(output) = output else {
        return (HashSet::new(), HashSet::new());
    };
    let mut base_lines = HashSet::new();
    let mut head_lines = HashSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(hunk) = line.strip_prefix("@@ ") else {
            continue;
        };
        let Some((ranges, _)) = hunk.split_once(" @@") else {
            continue;
        };
        let mut ranges = ranges.split_whitespace();
        let range = |value: Option<&str>| -> Option<(usize, usize)> {
            let value = value?.strip_prefix(['-', '+'])?;
            let (start, count) = value.split_once(',').unwrap_or((value, "1"));
            Some((start.parse().ok()?, count.parse().ok()?))
        };
        let Some((base_start, base_count)) = range(ranges.next()) else {
            continue;
        };
        let Some((head_start, head_count)) = range(ranges.next()) else {
            continue;
        };
        base_lines.extend(base_start..base_start + base_count);
        head_lines.extend(head_start..head_start + head_count);
    }
    (base_lines, head_lines)
}

fn top_steps(steps: Vec<Step>, changed: &HashSet<usize>) -> Vec<TopStep> {
    steps
        .into_iter()
        .map(|step| TopStep {
            kind: step.kind.into(),
            key: step.key,
            line: step.line,
            changed: changed.contains(&step.line),
        })
        .collect()
}

pub fn check_method(
    spec: &Spec,
    repo: &Path,
    base: &str,
    head: Option<&str>,
    verbose: bool,
) -> ResultRow {
    let answer = (|| -> Result<ResultRow, Cannot> {
        let bt = load_source(repo, Some(base), &spec.file)?;
        let ht = load_source(repo, head, &spec.file)?;
        let bm = bt.find_method(&spec.method, spec.params.as_deref())?;
        let hm = ht.find_method(&spec.method, spec.params.as_deref())?;
        let (base_changed, head_changed) = changed_lines(repo, base, head, &spec.file);
        let btop = bt.steps(bm);
        let htop = ht.steps(hm);
        let hsteps = ht.steps(hm);
        let bsteps = bt.flow(bm, 2, &mut HashSet::new());
        let hflow = ht.flow(hm, 2, &mut HashSet::new());
        let inserted: HashSet<String> = spec
            .change
            .iter()
            .filter_map(|c| c.insert.clone())
            .collect();
        let bextra = bt.extra_flow(bm, 2, &mut HashSet::new(), &HashSet::new());
        let hextra = ht.extra_flow(hm, 2, &mut HashSet::new(), &inserted);
        let mut problems = Vec::new();
        let mut removed = Vec::new();
        for ch in &spec.change {
            if let Some(target) = ch.remove_call.as_ref().or(ch.remove_read.as_ref()) {
                let kind = if ch.remove_call.is_some() {
                    "call"
                } else {
                    "read"
                };
                removed.push((kind, target.as_str()));
                if hflow
                    .iter()
                    .any(|x| x.kind == kind && matches(&x.key, target))
                {
                    problems.push(format!("{kind} {target} still present"));
                }
                if !bsteps
                    .iter()
                    .any(|x| x.kind == kind && matches(&x.key, target))
                {
                    problems.push(format!(
                        "{kind} {target} absent in base: spec does not match code"
                    ));
                }
            } else if let Some(insert) = &ch.insert {
                let calls: Vec<_> = hsteps
                    .iter()
                    .filter(|x| x.kind == "call" && matches(&x.key, insert))
                    .collect();
                if calls.is_empty() {
                    let ix = hflow
                        .iter()
                        .position(|x| x.kind == "call" && matches(&x.key, insert));
                    if ix.is_none() {
                        problems.push(format!("call {insert} not inserted"));
                        continue;
                    }
                    if ch.guard.as_deref().unwrap_or("none") != "none" {
                        problems.push(format!(
                            "{insert} found only in a callee, guard {} not checkable there",
                            ch.guard.as_deref().unwrap()
                        ));
                    } else if let Some(anchor) = ch.after.as_ref().or(ch.before.as_ref()) {
                        let ai = hflow
                            .iter()
                            .position(|x| x.kind == "call" && matches(&x.key, anchor));
                        let ok = ai
                            .map(|a| {
                                if ch.after.is_some() {
                                    a < ix.unwrap()
                                } else {
                                    ix.unwrap() < a
                                }
                            })
                            .unwrap_or(false);
                        if !ok {
                            problems.push(format!(
                                "{insert} (in callee) out of order relative to {anchor}"
                            ));
                        }
                    }
                    continue;
                }
                if ch.guard.as_deref() == Some("returns-bool") {
                    for c in &calls {
                        let node = find_node_by_id(&ht, hm, c.node_id).unwrap();
                        if node
                            .parent()
                            .map(|x| x.kind() == "expression_statement")
                            .unwrap_or(false)
                        {
                            problems.push(format!("result of {insert} dropped at L{}", c.line));
                        }
                    }
                }
                if let Some(after) = &ch.after {
                    for c in &calls {
                        let node = find_node_by_id(&ht, hm, c.node_id).unwrap();
                        if !guarded(&ht, node, after, "none") {
                            problems.push(format!(
                                "{insert} at L{} not preceded by {after} on every path",
                                c.line
                            ));
                        }
                    }
                }
                if let Some(before) = &ch.before {
                    let targets: Vec<_> = hsteps
                        .iter()
                        .filter(|x| x.kind == "call" && matches(&x.key, before))
                        .collect();
                    if targets.is_empty() {
                        problems.push(format!("call {before} not found in head"));
                    }
                    let targets = if let Some(nth) = ch.nth {
                        if nth == 0 || nth > targets.len() {
                            problems
                                .push(format!("call {before} occurrence {nth} not found in head"));
                            Vec::new()
                        } else {
                            vec![targets[nth - 1]]
                        }
                    } else {
                        targets
                    };
                    for t in targets {
                        let node = find_node_by_id(&ht, hm, t.node_id).unwrap();
                        if !guarded(&ht, node, insert, ch.guard.as_deref().unwrap_or("none")) {
                            problems.push(format!(
                                "{before} at L{} not preceded by {insert} ({}) on every path",
                                t.line,
                                ch.guard.as_deref().unwrap_or("none")
                            ));
                        }
                    }
                }
            } else {
                return Err(Cannot(format!("unknown change: {:?}", ch)));
            }
        }
        if spec.preserve.all() {
            let need: Vec<_> = bsteps
                .iter()
                .filter(|x| {
                    !removed
                        .iter()
                        .any(|(k, t)| x.kind == *k && matches(&x.key, t))
                })
                .map(key)
                .collect();
            let have: Vec<_> = hflow.iter().map(key).collect();
            for wanted in subsequence_missing(&need, &have) {
                problems.push(format!("base step lost or reordered: {wanted}"));
            }
        }
        for kept in &spec.keep {
            if !hflow.iter().any(|x| matches(&x.key, kept)) {
                problems.push(format!("kept step {kept} missing"));
            }
        }
        Ok(ResultRow {
            method: spec.method.clone(),
            status: if problems.is_empty() {
                "pass".into()
            } else {
                "fail".into()
            },
            problems,
            extra: extra::undisclosed(
                &hextra.iter().map(key).collect::<Vec<_>>(),
                &bextra.iter().map(key).collect::<Vec<_>>(),
                &spec
                    .change
                    .iter()
                    .filter_map(|c| c.insert.as_ref().map(|x| format!("call:{x}")))
                    .collect::<Vec<_>>(),
            ),
            depth_limited: ht.depth_limited(hm, 2, &mut HashSet::new()),
            base_steps: verbose.then(|| bsteps.iter().map(key).collect()),
            head_steps: verbose.then(|| hflow.iter().map(key).collect()),
            base_top: verbose.then(|| top_steps(btop, &base_changed)),
            head_top: verbose.then(|| top_steps(htop, &head_changed)),
            base_tree: verbose.then(|| bt.tree(bm, &base_changed)),
            head_tree: verbose.then(|| ht.tree(hm, &head_changed)),
        })
    })();
    answer.unwrap_or_else(|e| ResultRow {
        method: spec.method.clone(),
        status: "cannot".into(),
        problems: vec![e.0],
        extra: Vec::new(),
        depth_limited: Vec::new(),
        base_steps: None,
        head_steps: None,
        base_top: None,
        head_top: None,
        base_tree: None,
        head_tree: None,
    })
}
fn find_node_by_id<'a>(s: &'a Source, method: Node<'a>, node_id: usize) -> Option<Node<'a>> {
    let mut all = Vec::new();
    s.walk(method, &mut all);
    all.into_iter().find(|n| n.id() == node_id)
}

#[cfg(test)]
mod tests {
    use super::subsequence_missing;

    #[test]
    fn subsequence_missing_resumes_after_unmatched_step() {
        let need: Vec<String> = ["A", "C", "B"].iter().map(|s| s.to_string()).collect();
        let have: Vec<String> = ["A", "B"].iter().map(|s| s.to_string()).collect();
        assert_eq!(subsequence_missing(&need, &have), vec!["C".to_string()]);
    }
}
