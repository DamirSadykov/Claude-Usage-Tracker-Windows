use super::LanguageSpec;
use tree_sitter::Language;

fn typescript_grammar() -> Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

fn tsx_grammar() -> Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

fn javascript_grammar() -> Language {
    tree_sitter_javascript::LANGUAGE.into()
}

const COMMON: LanguageSpec = LanguageSpec {
    extensions: &[],
    grammar: javascript_grammar,
    method_kinds: &[
        "function_declaration",
        "method_definition",
        "arrow_function",
        "function_expression",
    ],
    invocation_kind: "call_expression",
    new_expression_kind: Some("new_expression"),
    macro_invocation_kind: None,
    member_access_kind: "member_expression",
    local_kinds: &[
        "formal_parameter",
        "required_parameter",
        "variable_declarator",
    ],
    identifier_kind: "identifier",
    parenthesized_kind: "parenthesized_expression",
    prefix_unary_kind: "unary_expression",
    binary_kind: "binary_expression",
    exit_kinds: &["return_statement", "throw_statement"],
    block_kind: "statement_block",
    conditional_kind: "if_statement",
    expression_statement_kind: "expression_statement",
    await_kind: "await_expression",
    local_declaration_kind: "lexical_declaration",
    variable_declarator_kind: "variable_declarator",
    comment_kind: "comment",
    builtin_calls: &[
        "Array.*",
        "Object.*",
        "JSON.*",
        "Math.*",
        "Number.*",
        "String.*",
        "Boolean.*",
        "Date.*",
        "Promise.*",
        "console.*",
        "Reflect.*",
        "Symbol.*",
        "String",
        "Number",
        "Boolean",
    ],
    builtin_value_methods: &[
        "map", "filter", "trim", "join", "slice", "push", "includes", "some", "every", "find",
        "forEach", "toString",
    ],
};

static TYPESCRIPT: LanguageSpec = LanguageSpec {
    extensions: &["ts"],
    grammar: typescript_grammar,
    ..COMMON
};
static TSX: LanguageSpec = LanguageSpec {
    extensions: &["tsx"],
    grammar: tsx_grammar,
    ..COMMON
};
static JAVASCRIPT: LanguageSpec = LanguageSpec {
    extensions: &["js", "mjs", "cjs"],
    grammar: javascript_grammar,
    ..COMMON
};

pub(super) fn typescript_spec() -> &'static LanguageSpec {
    &TYPESCRIPT
}
pub(super) fn tsx_spec() -> &'static LanguageSpec {
    &TSX
}
pub(super) fn javascript_spec() -> &'static LanguageSpec {
    &JAVASCRIPT
}
