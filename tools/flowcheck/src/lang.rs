use std::path::Path;
use tree_sitter::Language;
#[path = "lang_rust.rs"]
mod lang_rust;
#[path = "lang_ts.rs"]
mod lang_ts;

pub struct LanguageSpec {
    pub extensions: &'static [&'static str],
    pub grammar: fn() -> Language,
    pub method_kinds: &'static [&'static str],
    pub invocation_kind: &'static str,
    pub new_expression_kind: Option<&'static str>,
    pub macro_invocation_kind: Option<&'static str>,
    pub member_access_kind: &'static str,
    pub local_kinds: &'static [&'static str],
    pub identifier_kind: &'static str,
    pub parenthesized_kind: &'static str,
    pub prefix_unary_kind: &'static str,
    pub binary_kind: &'static str,
    pub exit_kinds: &'static [&'static str],
    pub block_kind: &'static str,
    pub conditional_kind: &'static str,
    pub expression_statement_kind: &'static str,
    pub await_kind: &'static str,
    pub local_declaration_kind: &'static str,
    pub variable_declarator_kind: &'static str,
    pub comment_kind: &'static str,
}

fn c_sharp_grammar() -> Language {
    tree_sitter_c_sharp::LANGUAGE.into()
}

static C_SHARP: LanguageSpec = LanguageSpec {
    extensions: &["cs"],
    grammar: c_sharp_grammar,
    method_kinds: &[
        "method_declaration",
        "constructor_declaration",
        "local_function_statement",
    ],
    invocation_kind: "invocation_expression",
    new_expression_kind: None,
    macro_invocation_kind: None,
    member_access_kind: "member_access_expression",
    local_kinds: &[
        "parameter",
        "variable_declarator",
        "foreach_statement",
        "catch_declaration",
    ],
    identifier_kind: "identifier",
    parenthesized_kind: "parenthesized_expression",
    prefix_unary_kind: "prefix_unary_expression",
    binary_kind: "binary_expression",
    exit_kinds: &["return_statement", "throw_statement"],
    block_kind: "block",
    conditional_kind: "if_statement",
    expression_statement_kind: "expression_statement",
    await_kind: "await_expression",
    local_declaration_kind: "local_declaration_statement",
    variable_declarator_kind: "variable_declarator",
    comment_kind: "comment",
};

pub fn for_file(file: &str) -> Result<&'static LanguageSpec, String> {
    let extension = Path::new(file)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_else(|| "(none)".into());
    [
        &C_SHARP,
        lang_rust::spec(),
        lang_ts::typescript_spec(),
        lang_ts::tsx_spec(),
        lang_ts::javascript_spec(),
    ]
    .into_iter()
    .find(|language| {
        language
            .extensions
            .iter()
            .any(|known| extension == format!(".{known}"))
    })
    .ok_or_else(|| format!("unsupported file extension: {extension}"))
}

pub fn supported_file(file: &str) -> bool {
    for_file(file).is_ok()
}

pub fn callee_name(text: &str) -> String {
    let mut name = text.to_string();
    if let Some(index) = name.find('<') {
        name.truncate(index);
    }
    name.strip_prefix("this.").unwrap_or(&name).to_string()
}
