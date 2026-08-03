// `cli.mjs plan-guard` — PreToolUse hook on ExitPlanMode: the plan is checked
// BEFORE the user ever sees it, and a plan that is not a valid graph file is
// refused with the rules named (t#318). Since t#325 the language is required of
// every plan, not only of the texts that already looked like one — with a single
// declared exception, `discussion:`, for a plan that is not about starting work.
//
// Why a guard and not a request. The plan format is asked for twice already (the
// `enter` injection and docs/plan-format.md), and t#309 measured what asking
// buys: the format is obeyed about half the time — the model writes its own
// document and glues the required parts on the side. A refusal that names the
// broken rule is stable where a request is not, and it costs the user nothing:
// they approve a plan that already parses into the graph the tracker records.
//
// Why PreToolUse and not the existing `plan-hook exit`. Exit is PostToolUse — by
// then the plan has been shown and approved, and the only thing left is to ask
// for a rewrite of something the user already said yes to. PreToolUse fires
// before the permission prompt, so a refusal here replaces the prompt instead of
// following it. The plan text arrives in `tool_input.plan` (verified against
// seven real ExitPlanMode calls in this project's transcripts, 19–28 July).
//
// The rules are NOT re-implemented here. readDocument + validate from apply.mjs
// are the same pair `todos apply` runs, and they in turn read graph-rules.mjs —
// so the wording the guard refuses with is the wording `apply` and `todos lint`
// use. That single source is the invariant of this change: a rule stated twice
// is a rule that drifts.
//
// Wired into ~/.claude/settings.json by the tracker's installer (install_cc_hook
// in lib.rs) as a PreToolUse group with matcher ExitPlanMode. Like every hook
// here it must NEVER break a session: the decision is JSON on stdout with exit 0
// (exit 2 would discard the JSON and use stderr instead), and any unexpected
// failure is a silent exit 0, which Claude Code reads as "no opinion" and lets
// the plan through.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DSL_DOC_FIELDS, readDocument, validate } from "./apply.mjs";
import { boardPath, loadBoard, resolveTask } from "./todos.mjs";

const FORMAT_DOC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "plan-format.md",
);

export const planFormatDoc = () => FORMAT_DOC;

// --- is this text an ATTEMPT at the language? --------------------------------
//
// Until t#325 this was the guard's central judgement, and it was made cautiously:
// only a text carrying TWO distinct document keys at column 0 was judged at all,
// so prose went through untouched. That caution had a price this change cannot
// afford — it left "write the plan in the language" resting on the injected
// prompt, the same soft lever t#309 measured being obeyed about half the time.
// A rule that a guard declines to check is a rule kept by asking.
//
// So the language is now required of every plan, and the asymmetry that made
// caution right is paid for elsewhere: a plan that is NOT about starting work
// says so (`discussion:` below) and passes. The way out is one line, which is
// cheaper than any way around the guard.
//
// What is left of the old judgement is the choice of MESSAGE, not of whether to
// judge: one document key is enough to read the text as a document and answer
// with the validator's own sentences, which are more useful than the generic
// "this is not the language". A text with no key at all gets the generic one.
// The vocabulary is imported, not copied — the guard must not have its own idea
// of what the language's top-level words are.
const DOC_KEY_RE = /^([a-z][a-z-]*)[ \t]*:(?:[ \t].*)?$/;
const MIN_DISTINCT_KEYS = 1;

// A plan is markdown, so the document usually arrives inside a fence.
const FENCE_RE = /```[A-Za-z]*\n([\s\S]*?)```/g;

// Column-0 lines that name a key of the document vocabulary, with their line
// numbers. Anything indented belongs to a block scalar or to a step, so it is
// not evidence about the document's own shape.
function docKeyLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DOC_KEY_RE.exec(lines[i]);
    if (m && DSL_DOC_FIELDS.includes(m[1])) out.push({ key: m[1], at: i });
  }
  return out;
}

// Every reading of the plan text that qualifies as a document of the language,
// most specific first: each fenced block, then the whole text. Each is trimmed to
// start at its first document key, because the parser stops at the first line
// that is not `key: value` — a document introduced by a paragraph of prose would
// otherwise read as empty. Empty array = the plan never claimed to be one of
// these files. Exported for the unit tests.
export function planCandidates(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  for (const source of [...[...raw.matchAll(FENCE_RE)].map((m) => m[1]), raw]) {
    const lines = source.split("\n");
    const keys = docKeyLines(lines);
    if (new Set(keys.map((k) => k.key)).size < MIN_DISTINCT_KEYS) continue;
    out.push(lines.slice(keys[0].at).join("\n"));
  }
  return out;
}

// --- the way out: a plan that is not about starting work ---------------------
//
// Plan mode is used for two things, and only one of them ends in tasks: a session
// also enters it to think a question through with the user — "here is how I read
// this, is that right?". Requiring the graph language of THAT plan would leave it
// no way out of the mode at all, and the measurement (t#322) says it is a real
// case rather than a hypothetical one: of 5 approved plans in this project's
// transcripts, 1 created no task. The sample is 5, so the number settles that the
// case exists, not how common it is — which is exactly why the exit is explicit
// and cheap rather than a heuristic that guesses at intent.
//
// The declaration is one line at column 0: `discussion: <why this is not work>`.
// It is NOT a key of the graph language — `apply` never reads it, and a document
// carrying it records nothing.
//
// The REASON is required, and that is the whole design of this exit. A bare flag
// (`discussion: true`) costs one word, and a way out that costs one word is the
// way out of every plan, including the ones that were about work; a sentence
// naming what is being settled is worth writing only when there is something to
// settle. Boolean literals are refused for the same reason: they are the flag
// wearing a value.
export const DISCUSSION_KEY = "discussion";

const DISCUSSION_RE = /^discussion[ \t]*:(.*)$/;
const BOOLEANISH = new Set(["true", "false", "yes", "no", "y", "n", "1", "0"]);

// Short enough to be a label rather than a reason. 12 characters is two short
// words: "это разбор" (10) does not name what is being discussed, "разбираю
// причину" (17) does. The threshold is a floor against reflex, not a quality bar
// — the guard cannot judge the sentence, only that one was written.
const MIN_REASON_CHARS = 12;

// The reason as written, or "" when the key is there without one. Returns null
// when the plan never declared itself a discussion. Exported for the unit tests.
export function discussionDeclaration(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = DISCUSSION_RE.exec(lines[i]);
    if (!m) continue;
    const head = m[1].trim().replace(/^[|>][-+0-9]*$/, "");
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) break;
      if (!/^[ \t]/.test(lines[j])) break;
      body.push(lines[j].trim());
    }
    const reason = [head, ...body]
      .join(" ")
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    return { reason };
  }
  return null;
}

// Exported for the unit tests.
export const isReason = (text) => {
  const value = String(text ?? "").trim();
  return value.length >= MIN_REASON_CHARS && !BOOLEANISH.has(value.toLowerCase());
};

// --- the board, so a plan may hang off what is already recorded --------------
//
// `needs: [t#299]` pointing at a task on the board is legal (§1), and the
// validator asks the caller whether a reference resolves. When the board cannot
// be read we answer YES to everything: refusing on a check we were unable to run
// is precisely the false refusal this guard must not produce.
function boardResolver() {
  let data;
  try {
    data = loadBoard(boardPath());
  } catch {
    return () => true;
  }
  return (ref) => {
    try {
      return Boolean(resolveTask(data, ref));
    } catch {
      return true;
    }
  };
}

// --- the verdict -------------------------------------------------------------

// { attempted, errors, warnings }. `attempted: false` means the plan is not in
// the language at all and nothing was checked. Exported for the unit tests.
//
// A text can hold more than one reading — the format document's own §1 sketch
// quoted above the real plan, a fence inside a fence — and the guard refuses only
// when NO reading is a valid graph. One valid reading is proof the session
// produced the file; refusing it over a second, worse reading would be refusing
// work that was done. Otherwise the FULLEST reading (most steps) is the one
// reported, since a reading that parsed nothing would only complain that there
// are no steps.
export function inspectPlan(text, { onBoard = () => true } = {}) {
  const sources = planCandidates(text);
  if (!sources.length) return { attempted: false, errors: [], warnings: [] };
  const readings = sources.map((source) => {
    const doc = readDocument(source);
    return { steps: doc.steps.length, ...validate(doc, { onBoard }) };
  });
  const chosen =
    readings.find((r) => !r.errors.length) ||
    readings.reduce((best, r) => (r.steps > best.steps ? r : best));
  return { attempted: true, errors: chosen.errors, warnings: chosen.warnings };
}

// The refusal Claude reads. The errors are reproduced VERBATIM — the same
// sentence `todos apply` and `todos lint` print — so the session is not left
// guessing which rule the guard means. Warnings ride along because they are free
// at this point, and are labelled as not being the reason.
// Exported for the unit tests.
export function buildRefusal(errors, warnings = []) {
  const lines = [
    "PLAN REFUSED — it is not a valid graph file, so it never reached the user.",
    "",
    `${errors.length} error(s), from the validator \`todos apply\` runs:`,
    ...errors.map((e) => "  - " + e),
  ];
  if (warnings.length)
    lines.push(
      "",
      "warnings (accepted — not the reason for this refusal):",
      ...warnings.map((w) => "  - " + w),
    );
  lines.push(
    "",
    "Fix the plan itself and call ExitPlanMode again. Do not append a corrected",
    "copy next to the old one — the plan IS the file, and there is one of it.",
    "The shape, the rules and a worked example:",
    `  ${FORMAT_DOC}`,
  );
  return lines.join("\n");
}

// The refusal for a plan that is not in the language at all (t#325). It has to
// carry BOTH ways forward, or it is the false refusal this guard was built to
// avoid: rewrite it as the file, or — if this plan does not start work — say so.
// The exit is spelled out in full, because a session that cannot find it will
// dress prose up as YAML instead, which is worse than the prose.
// Exported for the unit tests.
export function buildFormatRefusal() {
  return [
    "PLAN REFUSED — it is not written in the process language, so it never reached",
    "the user. A plan is recorded as the tracker's graph file, not as prose about it.",
    "",
    "Rewrite the plan itself as the file: `change`, `vision`, `steps` with `title`",
    "(or `task: <N>` for work already on the board), `why`, `needs`, `produces`,",
    "`verify`, `kind`. A one-step plan is a file too. The shape, the rules and a",
    "worked example:",
    `  ${FORMAT_DOC}`,
    "",
    "If this plan does NOT start work — you are settling a question with the user,",
    "not opening tasks — declare that instead, on its own line at the start:",
    "",
    `  ${DISCUSSION_KEY}: <what is being settled, and why it opens no task>`,
    "",
    "Such a plan passes untouched and records nothing. The declaration needs a real",
    "reason, not a flag: `discussion: true` is refused.",
  ].join("\n");
}

// A `discussion:` with no reason behind it. Refused rather than ignored: silence
// here would teach the flag, and the flag is the exit that costs nothing.
// Exported for the unit tests.
export function buildBlankDiscussionRefusal() {
  return [
    `PLAN REFUSED — it declares \`${DISCUSSION_KEY}:\` without saying what is being`,
    "settled, so it never reached the user.",
    "",
    "Name the question in a sentence — what this plan settles, and why it opens no",
    "task:",
    "",
    `  ${DISCUSSION_KEY}: <what is being settled, and why it opens no task>`,
    "",
    "If the plan DOES start work, drop the declaration and write it as the graph",
    "file instead:",
    `  ${FORMAT_DOC}`,
  ].join("\n");
}

// A plan that declares itself a discussion AND carries steps says two things at
// once, and the two are not compatible: the declaration means nothing is
// recorded, so the steps would be dropped without a word — the failure mode
// where a session writes a graph, watches it approved, and finds no tasks. The
// declaration wins by design, so the contradiction has to be refused rather than
// resolved. Exported for the unit tests.
export function buildContradictionRefusal(steps) {
  return [
    `PLAN REFUSED — it declares \`${DISCUSSION_KEY}:\` and yet carries ${steps} step(s), so it`,
    "never reached the user. Those are two different plans:",
    "",
    `  • a discussion records NOTHING — the steps would be dropped in silence;`,
    "  • a graph file opens the tasks it declares.",
    "",
    "Drop whichever half is not this plan. If the discussion has already settled on",
    "work, it is a graph file — remove the declaration.",
  ].join("\n");
}

const deny = (reason) => ({
  hookEventName: "PreToolUse",
  permissionDecision: "deny",
  permissionDecisionReason: reason,
});

// The hookSpecificOutput payload, or null for "no opinion". Exported for the
// unit tests so the contract is pinned without spawning a process.
export function decide(input, opts = {}) {
  const tool = input && input.tool_name;
  // The matcher already scopes us, but a broadly-wired entry must not start
  // judging Bash commands as plans.
  if (typeof tool === "string" && tool && tool !== "ExitPlanMode") return null;
  const plan =
    input && input.tool_input && typeof input.tool_input.plan === "string"
      ? input.tool_input.plan
      : "";
  if (!plan.trim()) return null;
  // The exit is read BEFORE the language, so a discussion never has to also
  // parse. A declared reason ends the matter; a declared flag does not.
  const declared = discussionDeclaration(plan);
  if (declared) {
    if (!isReason(declared.reason)) return deny(buildBlankDiscussionRefusal());
    const steps = planCandidates(plan).reduce(
      (most, source) => Math.max(most, readDocument(source).steps.length),
      0,
    );
    return steps ? deny(buildContradictionRefusal(steps)) : null;
  }
  const { attempted, errors, warnings } = inspectPlan(plan, opts);
  if (!attempted) return deny(buildFormatRefusal());
  if (!errors.length) return null;
  return deny(buildRefusal(errors, warnings));
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) || {};
  } catch {
    return; // no stdin / bad JSON → nothing to judge, and silence lets it through
  }
  const decision = decide(input, { onBoard: boardResolver() });
  if (!decision) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + "\n");
}

// Entry for the unified dispatcher (`cli.mjs plan-guard`). Exit 0 always: the
// JSON is only read on exit 0, and a silent exit 0 is "no decision", which is the
// one failure mode a guard is allowed to have.
export function run() {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
