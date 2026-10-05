use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    process::Command,
};
use tree_sitter::{Language, Node, Parser, Tree};

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
}
impl Source {
    fn parse(bytes: Vec<u8>) -> Result<Self, Cannot> {
        let mut parser = Parser::new();
        let language: Language = tree_sitter_c_sharp::LANGUAGE.into();
        parser
            .set_language(&language)
            .map_err(|e| Cannot(e.to_string()))?;
        let tree = parser
            .parse(&bytes, None)
            .ok_or_else(|| Cannot("could not parse C# source".into()))?;
        Ok(Self { bytes, tree })
    }
    fn text(&self, n: Node) -> String {
        String::from_utf8_lossy(&self.bytes[n.byte_range()])
            .split_whitespace()
            .collect()
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
            .filter(|n| {
                matches!(
                    n.kind(),
                    "method_declaration" | "constructor_declaration" | "local_function_statement"
                )
            })
            .collect()
    }
    fn find_method(&self, name: &str, params: Option<&str>) -> Result<Node<'_>, Cannot> {
        let found: Vec<_> = self
            .methods()
            .into_iter()
            .filter(|m| {
                m.child_by_field_name("name")
                    .map(|n| self.text(n) == name)
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
    fn callee(&self, node: Node) -> String {
        let mut t = node
            .child_by_field_name("function")
            .map(|n| self.text(n))
            .unwrap_or_default();
        if let Some(i) = t.find('<') {
            t.truncate(i);
        }
        t.strip_prefix("this.").unwrap_or(&t).to_string()
    }
    fn steps(&self, method: Node) -> Vec<Step> {
        fn visit(s: &Source, n: Node, out: &mut Vec<Step>) {
            let mut c = n.walk();
            for x in n.children(&mut c) {
                visit(s, x, out);
            }
            if n.kind() == "invocation_expression" {
                out.push(Step {
                    kind: "call",
                    key: s.callee(n),
                    line: n.start_position().row + 1,
                    node_id: n.id(),
                });
            }
            if n.kind() == "member_access_expression" {
                let p = n.parent();
                if p.map(|x| x.kind() == "member_access_expression")
                    .unwrap_or(false)
                {
                    return;
                }
                if p.map(|x| {
                    x.kind() == "invocation_expression"
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
    fn locals(&self, method: Node) -> HashSet<String> {
        let mut ns = Vec::new();
        self.walk(method, &mut ns);
        ns.into_iter()
            .filter_map(|n| match n.kind() {
                "parameter" | "variable_declarator" | "foreach_statement" | "catch_declaration" => {
                    n.child_by_field_name("name")
                        .or_else(|| n.child_by_field_name("left"))
                        .filter(|x| x.kind() == "identifier")
                        .map(|x| self.text(x))
                }
                _ => None,
            })
            .collect()
    }
    fn flow(&self, method: Node, depth: usize, seen: &mut HashSet<usize>) -> Vec<Step> {
        seen.insert(method.id());
        let local = self.locals(method);
        let mut by: HashMap<String, Vec<Node>> = HashMap::new();
        for m in self.methods() {
            if let Some(n) = m.child_by_field_name("name") {
                by.entry(self.text(n)).or_default().push(m);
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
            if let Some(n) = m.child_by_field_name("name") {
                by.entry(self.text(n)).or_default().push(m);
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
            if let Some(n) = m.child_by_field_name("name") {
                by.entry(self.text(n)).or_default().push(m);
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
    Source::parse(bytes)
}

fn is_call_to(s: &Source, n: Node, name: &str) -> bool {
    n.kind() == "invocation_expression" && matches(&s.callee(n), name)
}
fn contains_call(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> bool {
    let mut nodes = Vec::new();
    s.walk(n, &mut nodes);
    nodes.into_iter().any(|x| {
        is_call_to(s, x, name) || (x.kind() == "identifier" && aliases.contains(&s.text(x)))
    })
}
fn unwrap(n: Option<Node>) -> Option<Node> {
    let mut n = n?;
    while n.kind() == "parenthesized_expression" {
        n = n.named_child(0)?;
    }
    Some(n)
}
fn is_guard_atom(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> bool {
    is_call_to(s, n, name) || (n.kind() == "identifier" && aliases.contains(&s.text(n)))
}
fn bool_literal(s: &Source, n: Node) -> Option<bool> {
    match s.text(n).as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
fn eq_form(s: &Source, n: Node, name: &str, aliases: &HashSet<String>) -> Option<bool> {
    if n.kind() != "binary_expression" {
        return None;
    }
    let op = s.text(n.child_by_field_name("operator")?);
    let l = unwrap(n.child_by_field_name("left"))?;
    let r = unwrap(n.child_by_field_name("right"))?;
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
    let Some(n) = unwrap(n) else { return false };
    if is_guard_atom(s, n, name, aliases) {
        return true;
    }
    if n.kind() == "prefix_unary_expression" {
        return invalid_implies_true(s, n.named_child(0), name, aliases);
    }
    if let Some(v) = eq_form(s, n, name, aliases) {
        return v;
    }
    if n.kind() == "binary_expression" {
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
    let Some(n) = unwrap(n) else { return false };
    if n.kind() == "prefix_unary_expression" {
        return true_implies_valid(s, n.named_child(0), name, aliases);
    }
    if let Some(v) = eq_form(s, n, name, aliases) {
        return !v;
    }
    if n.kind() == "binary_expression" {
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
fn exits(n: Node) -> bool {
    match n.kind() {
        "return_statement" | "throw_statement" => true,
        "block" => {
            let mut c = n.walk();
            n.named_children(&mut c)
                .filter(|x| x.kind() != "comment")
                .last()
                .map(exits)
                .unwrap_or(false)
        }
        "if_statement" => {
            n.child_by_field_name("consequence")
                .map(exits)
                .unwrap_or(false)
                && n.child_by_field_name("alternative")
                    .map(exits)
                    .unwrap_or(false)
        }
        _ => false,
    }
}
fn top_level_call(s: &Source, stmt: Node, name: &str) -> bool {
    if stmt.kind() == "expression_statement" {
        let mut e = stmt.named_child(0);
        if e.map(|x| x.kind() == "await_expression").unwrap_or(false) {
            e = e.and_then(|x| x.named_child(0));
        }
        return e.map(|x| is_call_to(s, x, name)).unwrap_or(false);
    }
    stmt.kind() == "local_declaration_statement" && contains_call(s, stmt, name, &HashSet::new())
}
fn enclosing_aliases(s: &Source, node: Node, name: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut n = node;
    while let Some(p) = n.parent() {
        if matches!(
            n.kind(),
            "method_declaration" | "constructor_declaration" | "local_function_statement"
        ) {
            break;
        }
        if p.kind() == "block" {
            let mut c = p.walk();
            for stmt in p.children(&mut c) {
                if stmt == n {
                    break;
                }
                if stmt.kind() != "local_declaration_statement" {
                    continue;
                }
                let mut all = Vec::new();
                s.walk(stmt, &mut all);
                for d in all
                    .into_iter()
                    .filter(|x| x.kind() == "variable_declarator")
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
        if matches!(
            n.kind(),
            "method_declaration" | "constructor_declaration" | "local_function_statement"
        ) {
            break;
        }
        if mode == "returns-bool" && p.kind() == "if_statement" {
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
        if p.kind() == "block" {
            let a = enclosing_aliases(s, n, name);
            let mut c = p.walk();
            for stmt in p.children(&mut c) {
                if stmt == n {
                    break;
                }
                if mode == "returns-bool"
                    && stmt.kind() == "if_statement"
                    && invalid_implies_true(s, stmt.child_by_field_name("condition"), name, &a)
                    && stmt
                        .child_by_field_name("consequence")
                        .map(exits)
                        .unwrap_or(false)
                {
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
