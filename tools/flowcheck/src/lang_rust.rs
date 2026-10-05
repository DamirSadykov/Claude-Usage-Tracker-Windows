use super::LanguageSpec;
use tree_sitter::Language;

fn rust_grammar() -> Language {
    tree_sitter_rust::LANGUAGE.into()
}

static RUST: LanguageSpec = LanguageSpec {
    extensions: &["rs"],
    grammar: rust_grammar,
    method_kinds: &["function_item", "function_signature_item"],
    invocation_kind: "call_expression",
    new_expression_kind: None,
    macro_invocation_kind: Some("macro_invocation"),
    member_access_kind: "field_expression",
    local_kinds: &["parameter", "let_declaration", "closure_parameters"],
    identifier_kind: "identifier",
    parenthesized_kind: "parenthesized_expression",
    prefix_unary_kind: "unary_expression",
    binary_kind: "binary_expression",
    exit_kinds: &["return_expression"],
    block_kind: "block",
    conditional_kind: "if_expression",
    expression_statement_kind: "expression_statement",
    await_kind: "await_expression",
    local_declaration_kind: "let_declaration",
    variable_declarator_kind: "let_declaration",
    comment_kind: "line_comment",
    builtin_calls: &[
        "Some",
        "Ok",
        "Err",
        "Box::new",
        "Vec::new",
        "String::from",
        "format!",
        "vec!",
        "println!",
        "eprintln!",
        "write!",
        "matches!",
        "assert!",
    ],
    builtin_value_methods: &[
        "clone",
        "to_string",
        "unwrap",
        "iter",
        "map",
        "collect",
        "as_ref",
        "into",
    ],
};

pub(super) fn spec() -> &'static LanguageSpec {
    &RUST
}
