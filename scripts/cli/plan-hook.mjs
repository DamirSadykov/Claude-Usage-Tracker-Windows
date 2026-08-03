// `cli.mjs plan-hook <enter|prompt|exit>` — the hooks that turn plan mode into
// the tracker's TASK-FORMING ritual (t#253), per the decision record
// «фазы → plan mode + task-граф» (2026-07-19):
//
//   • enter (PostToolUse, matcher EnterPlanMode) — inject the plan FORMAT before
//     the plan is written: plan-phrases, vision paragraph, one step = one session,
//     and the final ORDER line in arrow notation. Free prose, not slot-filling —
//     the only consumer of the structure is the model itself, which writes the plan
//     and later records it.
//   • prompt (UserPromptSubmit) — the SAME format, for the case `enter` cannot see.
//     `enter` only fires when the MODEL calls the EnterPlanMode tool; a user who
//     flips plan mode from the keyboard never triggers that tool, so the format
//     never arrived. Measured on 9 real plan-mode sessions: all 9 entered by mode,
//     only 3 also called the tool — i.e. the ritual was skipped most of the time,
//     and `match-plan` (built for this very format) was fed free-form prose instead.
//     This entry keys off `permission_mode === "plan"`, which the harness passes in
//     the hook payload, so it covers both ways in. Both paths share a one-shot
//     marker: whoever gets there first injects, the other stays quiet.
//   • exit (matcher ExitPlanMode) — the plan is FOR the writer, not a report:
//     instruct the session to record it in the tracker (a multi-session plan →
//     a change root + child tasks + dep edges from the ORDER line + the process
//     declarations of each node — kind, produces, verify, retry, budget, the
//     ?issue transition; a one-session plan → the task's `plan` field). The
//     wording of THIS instruction is the only lever the bridge measurement
//     (91 runs) found to move graph quality, so it is deliberately dense and
//     command-by-command. And — deterministically, in the hook
//     itself — run the KB's `match-plan` over the plan text so case-warnings
//     reach the session BEFORE execution starts. The match step is optional:
//     it runs only when settings.json names a CLI (`matchPlanCli`), so the
//     public tracker carries no hard dependency on a private knowledge base.
//
// Wired into ~/.claude/settings.json by the tracker's installer (install_cc_hook
// in lib.rs) as PostToolUse groups with per-tool matchers. Like every hook here,
// it must NEVER break a session: any unexpected failure is a silent no-op (the
// dispatcher maps a throw to exit 0), and the match step has its own timeout.

import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchPlanCli, roamingBase } from "./settings.mjs";
import { readDocument, applyDocument, summarize } from "./apply.mjs";
import { DISCUSSION_KEY, discussionDeclaration, isReason, planCandidates } from "./plan-guard.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// --- one-shot marker, shared by `enter` and `prompt` -------------------------
// Both can fire in one session (the model calls EnterPlanMode AND the user is in
// plan mode), and `prompt` fires on EVERY prompt while the mode is on — without a
// marker the format would be repeated. Keyed by session id; the file is trimmed so
// it cannot grow without bound. Like everything here: never throws, and a failed
// read/write degrades to "inject anyway" rather than to a broken session.
const MARKER_KEEP = 50;

function markerFile() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "plan-format-seen.json");
}

function readMarker() {
  try {
    const j = JSON.parse(readFileSync(markerFile(), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// Exported for the unit tests.
export function formatAlreadySent(session, marker = readMarker()) {
  return Boolean(session) && Object.prototype.hasOwnProperty.call(marker, session);
}

function markFormatSent(session) {
  if (!session) return;
  try {
    const marker = readMarker();
    marker[session] = new Date().toISOString();
    // Oldest-first trim: the map is small, sorting it is cheaper than any index.
    const entries = Object.entries(marker).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const kept = Object.fromEntries(entries.slice(-MARKER_KEEP));
    const file = markerFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(kept, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    // no marker written → at worst the format is injected twice, never a break
  }
}

// --- enter: the plan format, injected right after plan mode starts -----------
//
// ONE wording. There used to be a second, deliberative one behind
// PLAN_FORMAT_MODE, kept as a live A/B: the same content phrased as an
// observation with the decision left open. It is gone — on compliance the
// directive form measured better (7/8 vs 5/8), and a hook whose text depends on
// an environment variable makes every later measurement ask which wording was in
// play. One text, so what is measured is what ships.
//
// Where the format itself lives (t#314). The instruction used to CARRY the
// format — the same page of text on entering plan mode and again on every exit.
// It is now a file in the repo, and both hooks point at it: one Read per session
// instead of a re-injection per plan. The path resolves identically in the repo
// (scripts/cli → ../../docs) and in the Tauri bundle (resources/scripts/cli →
// resources/docs), because tauri.conf.json maps the file to the same shape.
const FORMAT_DOC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "plan-format.md",
);

export const planFormatDoc = () => FORMAT_DOC;

// Exported for the unit tests.
export function buildEnterContext() {
  return [
    "──────── PLAN MODE · the plan IS the graph file ────────",
    "This plan is written FOR YOU and the sessions after you, not as a report for",
    "the user, and it is RECORDED in the task tracker on ExitPlanMode. So write it",
    "as the file the tracker records — YAML, one step per task — instead of prose",
    "that then has to be translated: `change`, `vision`, `steps` with `title`,",
    "`task` (this step IS task #N already on the board), `why`, `needs`,",
    "`produces`, `verify`, `retry`, `on-issue`, `kind`, `budget`.",
    "",
    "Prose does not disappear, it moves INSIDE: `vision` is the paragraph on what",
    "should exist and why; each step's `why` is what that step rests on and where",
    "its risk shows. Those two are the parts a later session cannot reconstruct.",
    "Report sections (Контекст / Объём / Риски) address a reader this plan does not",
    "have — what matters in them belongs in `vision`.",
    "",
    "READ THE FORMAT NOW — the shape, the rules and a worked example:",
    `  ${FORMAT_DOC}`,
    "Reading it once covers this session. EVERY plan is REFUSED before the user ever",
    "sees it unless it parses as this file and breaks no rule — prose included. The",
    "format is not advice you weigh, it is the thing that gets you through.",
    "",
    "Not starting work — settling a question with the user, weighing an approach?",
    "Say so on the first line and the guard steps aside, recording nothing:",
    `  ${DISCUSSION_KEY}: <what is being settled, and why it opens no task>`,
    "The reason is required; a bare flag is refused. Declare it only when true — a",
    "plan that ends in work is a graph file, whatever it is called.",
  ].join("\n");
}

// --- exit: record the plan + surface KB warnings -----------------------------

// One warning of the kb-style `match-plan --json` contract
// ({warnings: [{id, item, cue, wanted, lesson, …}]}) as compact lines. Only the
// human-facing fields — scores/gates are the matcher's internals.
// Exported for the unit tests.
export function formatWarning(w) {
  const lines = [`- ${w.id ?? "case"} · пункт: ${String(w.item ?? "").slice(0, 140)}`];
  if (w.cue) lines.push(`  Ситуация: ${w.cue}`);
  if (w.wanted) lines.push(`  → пользователь хотел: ${w.wanted}`);
  if (w.lesson) lines.push(`  → вывод: ${w.lesson}`);
  return lines.join("\n");
}

// Deterministic match step: hand the plan text to the configured kb-style CLI
// (`<cli> match-plan --text "<plan>" --json`). argv-array spawn — no shell, no
// quoting pitfalls with plan markdown. The JSON form is what lets the hook stay
// QUIET when there is nothing to say: zero warnings → empty string → no block in
// the injected context. Empty likewise when unconfigured, on timeout, or on any
// failure/unparsable output: warnings are an extra, never a gate.
// `runner` is injectable for the unit tests.
export function runMatchPlan(planText, cliPath, runner = execFileSync) {
  if (!cliPath || !String(planText || "").trim()) return "";
  try {
    const out = runner(
      process.execPath,
      [cliPath, "match-plan", "--text", planText, "--limit", "2", "--json"],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    const warnings = JSON.parse(String(out || "")).warnings;
    if (!Array.isArray(warnings) || !warnings.length) return "";
    return warnings.map(formatWarning).join("\n");
  } catch {
    return ""; // matcher down / slow / not a kb CLI → plan recording still proceeds
  }
}

// The KB warnings block, in the one wording all three exits share: recorded,
// refused by the user, and the fallback instruction.
function kbLines(warnings) {
  const w = String(warnings || "").trim();
  if (!w) return [];
  return [
    "",
    "KB case-warnings for this plan (match-plan) — act on them BEFORE executing:",
    ...w.split("\n").map((l) => "  " + l),
    "",
    `Persist them: node "${CLI}" todos comment add <id> --text "<...>" on the change`,
    "root (or on the task), so the warnings outlive this session.",
  ];
}

// The FALLBACK instruction, for a plan the tracker could not read as a document
// of the language (t#321 records everything it can read, by itself).
// Exported for the tests.
export function buildExitContext(warnings) {
  const lines = [
    "──────── PLAN · record it in the tracker ────────",
    "The tracker records an approved plan itself, and could not read this one as a",
    "graph — so it is yours to record. Save it as <plan>.yaml (scratchpad or a temp",
    "dir, NOT the repo) exactly as approved. Do not re-plan and do not reword a",
    "title while saving: an unbound step finds its task by that phrase, VERBATIM.",
    "",
    `  1. node "${CLI}" todos apply <plan>.yaml         — checks it, prints what changes`,
    `  2. node "${CLI}" todos apply <plan>.yaml --go    — records it`,
    "",
    "A one-step plan is a file too — one step, bound with the `task` key to the",
    `task already on the board (§3 of the format: ${FORMAT_DOC}).`,
    "",
    "Re-applying the same file updates the graph instead of forking it.",
  ];
  const w = String(warnings || "").trim();
  if (w) {
    lines.push(
      "",
      "KB case-warnings for this plan (match-plan) — act on them BEFORE executing:",
      ...w.split("\n").map((l) => "  " + l),
      "",
      `Persist them: node "${CLI}" todos comment add <id> --text "<...>" on the change`,
      "root (or on the task), so the warnings outlive this session.",
    );
  }
  return lines.join("\n");
}

// --- recording the approved plan (t#321) -------------------------------------
//
// The instruction below used to ask the SESSION to save the plan and run
// `todos apply`. Asking is the lever this whole change is spending itself to get
// rid of: t#309 measured the format obeyed about half the time, and every step
// left to the model is a step that sometimes does not happen. Everything needed
// to do it here is already in the payload — the plan text, and the harness's own
// verdict on it.
//
// APPROVAL is the one thing the hook must not assume. ExitPlanMode is called
// whether or not the user says yes, and the answer arrives in `tool_response`:
// approved plans read "User has approved your plan" and carry the path the
// harness saved them to, while a refusal reads "The user doesn't want to
// proceed" (both wordings verified against this project's transcripts, 7 calls,
// 19–28 July: 5 approved, 2 rejected). Nothing is recorded without that proof —
// a rejected plan silently becoming a graph is the one failure that would cost
// the user trust in the tracker.
const APPROVED_RE = /has approved your plan/i;
const SAVED_TO_RE = /plan has been saved to:\s*(.+?)\s*$/im;

const responseText = (input) => {
  const r = input?.tool_response;
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r ?? "");
  } catch {
    return "";
  }
};

// { approved, savedTo }. Exported for the unit tests.
export function approval(input) {
  const text = responseText(input).replace(/\\+n/g, "\n");
  const m = SAVED_TO_RE.exec(text);
  return { approved: APPROVED_RE.test(text), savedTo: m ? m[1].replace(/\\\\/g, "\\") : "" };
}

// The plan is kept as the file it is, next to the board: a graph recorded from a
// document nobody can look at afterwards is a graph with no provenance.
//
// A plan declared `discussion:` is kept too, under its own suffix. It records
// nothing, so provenance is not the reason — the count is: t#322 could only say
// "1 of 5 approved plans created no task" by reading transcripts, and could not
// say which of those were discussions on purpose. Filed here, the next
// measurement reads the answer off a directory instead of inferring it.
function keepPlanFile(session, text, suffix = "") {
  try {
    const dir = path.join(roamingBase(), "com.claude-usage-tracker.app", "plans");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${String(session || "session").slice(0, 8)}${suffix}.yaml`;
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  } catch {
    return ""; // provenance is a nicety; failing to keep it must not stop the record
  }
}

// --- the exit journal (t#315) ------------------------------------------------
//
// The field-run of the language has to answer "did the ritual fire, and what did
// it do" with numbers, and a transcript can only show the branches that SPOKE.
// The exit hook has three silent ones — a plan the user turned down, a payload
// with no plan text in it, a document the tracker could not read — and from the
// outside all three look exactly like a hook that was never wired. That
// ambiguity is not academic: it is how a dead ExitPlanMode hook went unnoticed
// for days while every session still saw the ENTER injection and assumed the
// ritual was alive.
//
// So every invocation leaves one line here, whichever branch it takes. What it
// records is the hook's own view of the payload — how much plan text arrived,
// whether the harness said approved, which branch ran, what got declared — so a
// harness that changes the shape of `tool_response` tomorrow is diagnosable from
// the journal instead of from a re-run. `todos adoption` reads it.
//
// Append-only JSONL next to todos.json; one short line per plan, so it stays
// small without trimming. Like everything in a hook: never throws.
function eventsFile() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "plan-events.jsonl");
}

// Exported for the unit tests.
export function noteExit(fields) {
  try {
    const file = eventsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
  } catch {
    // a lost measurement line must never cost a session its plan
  }
}

// What a recorded plan declared, counted per step — the §18 fill rate at its
// source. Counting it HERE and not on the board is deliberate: the board mixes
// plan-borne nodes with everything typed by hand, and the question of §18 is
// about the plans.
// Exported for the unit tests.
export function declaredCounts(doc) {
  const steps = Array.isArray(doc?.steps) ? doc.steps : [];
  const has = (f) => steps.filter((s) => (Array.isArray(s[f]) ? s[f].length : String(s[f] || "").trim())).length;
  return { steps: steps.length, produces: has("produces"), verify: has("verify"), kind: has("kind") };
}

// Record it, and say what happened. Returns null when this plan is not a
// document of the language at all — then the instruction stands and the session
// records it by hand. Exported for the unit tests.
export function recordPlan(planText, { session = "", apply = applyDocument } = {}) {
  // A text can hold more than one reading: a fenced block, the whole text, and —
  // the case that matters — a quoted example of the format sitting above the
  // real plan. The guard may pass such a text on the strength of ONE valid
  // reading; recording is different, because writing the wrong reading puts
  // somebody else's example on the board. So: read them all WITHOUT writing,
  // fold away the readings that are the same document seen twice, and record
  // only when exactly one remains. Ambiguity falls back to the instruction,
  // where the session picks — a question a hook is in no position to answer.
  const readings = new Map();
  for (const source of planCandidates(planText)) {
    const doc = readDocument(source);
    if (!doc.steps.length) continue;
    const key = JSON.stringify([doc.change, doc.steps.map((s) => [s.task, s.title])]);
    if (readings.has(key)) continue;
    if (!apply(doc, { go: false }).ok) continue;
    readings.set(key, { doc, source });
  }
  if (readings.size !== 1) return null;
  const { doc, source } = [...readings.values()][0];
  const result = apply(doc, { go: true });
  if (!result.ok) return null;
  return { doc, source, result, file: keepPlanFile(session, source) };
}

// What a plan declared `discussion:` reads on the way out (t#325). The recording
// instruction would be a lie here — there is nothing to apply, and telling a
// session to save a discussion as a graph file is how a question becomes three
// tasks nobody asked for. So: say nothing was recorded, and name the one thing
// that changes that. KB warnings still ride along; they are about the thinking,
// which is what this plan was.
// Exported for the unit tests.
export function buildDiscussionContext(warnings) {
  return [
    "──────── PLAN · declared a discussion ────────",
    `This plan declared \`${DISCUSSION_KEY}:\`, so the tracker recorded nothing — no task`,
    "was created and none moved.",
    "",
    "When the discussion settles on work to do, enter plan mode again and write that",
    "plan as the graph file; it is the file that opens the tasks.",
    ...kbLines(warnings),
  ].join("\n");
}

// What the session reads instead of the recording instruction. It names the
// tasks by number, because the next thing it does is take one.
// Exported for the unit tests.
export function buildRecordedContext({ doc, result, file }, warnings) {
  const lines = [
    "──────── PLAN · recorded by the tracker ────────",
    `The approved plan was recorded for you — ${summarize(result, doc)}.`,
    "",
    ...result.plan.map((l) => "  " + l),
  ];
  // The change root is not work — it closes last, after its members. So what is
  // offered to take are the STEPS.
  const steps = result.created.filter((t) => t !== result.root);
  if (steps.length)
    lines.push(
      "",
      "new: " +
        steps.map((t) => `#${t.number}`).join(", ") +
        (result.root && result.created.includes(result.root)
          ? ` (change root #${result.root.number})`
          : "") +
        ` — take one with: node "${CLI}" todos take <N>`,
    );
  if (result.notes.length) lines.push("", ...result.notes.map((l) => "  " + l));
  if (result.warnings.length) lines.push("", "warnings:", ...result.warnings.map((w) => "  - " + w));
  if (file) lines.push("", `plan file: ${file}`);
  lines.push("", "Do not record it again — re-applying is for a CHANGED plan.");
  lines.push(...kbLines(warnings));
  return lines.join("\n");
}

// Hook contract: JSON on stdout, additionalContext under hookSpecificOutput.
// `hookEventName` must name the event that fired — PostToolUse for enter/exit,
// UserPromptSubmit for prompt.
function emit(event, context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    }) + "\n",
  );
}

function main(args) {
  const sub = args[0];
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) || {};
  } catch {
    // no stdin / bad JSON → the format/instruction is still worth injecting
  }
  if (sub === "enter") {
    const session = typeof input.session_id === "string" ? input.session_id : "";
    if (formatAlreadySent(session)) return; // `prompt` got there first
    markFormatSent(session);
    emit("PostToolUse", buildEnterContext());
    return;
  }
  if (sub === "prompt") {
    // Only while planning, and only once per session. Any other mode — including a
    // prompt sent right after leaving plan mode — is none of our business.
    if (input.permission_mode !== "plan") return;
    const session = typeof input.session_id === "string" ? input.session_id : "";
    if (formatAlreadySent(session)) return;
    markFormatSent(session);
    // Wired to more than one event on purpose. UserPromptSubmit alone only catches
    // "mode was already on when the prompt was sent"; flipping it 12 seconds LATER
    // (measured) leaves that prompt out of plan mode and there is no next prompt to
    // carry the format. The tool events cover that: whatever the session reads or
    // greps while planning arrives with permission_mode already "plan". The reply
    // must name the event that actually fired, which the payload carries.
    emit(
      typeof input.hook_event_name === "string" ? input.hook_event_name : "UserPromptSubmit",
      buildEnterContext(),
    );
    return;
  }
  if (sub === "exit") {
    const plan =
      input && input.tool_input && typeof input.tool_input.plan === "string"
        ? input.tool_input.plan
        : "";
    const warnings = runMatchPlan(plan, matchPlanCli());
    // The journal line of this invocation (see noteExit): filled in as the
    // branches decide, written once at whichever exit is taken.
    const seen = responseText(input);
    const note = {
      session: typeof input.session_id === "string" ? input.session_id : "",
      cwd: typeof input.cwd === "string" ? input.cwd : "",
      plan_chars: plan.length,
      // The keys the harness put in the payload — the field that tells a broken
      // bridge (no plan text at all) from a plan the tracker chose not to record.
      input_keys: Object.keys((input && input.tool_input) || {}),
      response_chars: seen.length,
      response_head: seen.slice(0, 80),
      // The SHAPE of the response, not its text: which keys the harness put in
      // it is what tells an approval from a refusal, and the first live line of
      // this journal showed the plan arriving here — in `tool_response` — while
      // `tool_input` came empty. Keys are structure, so logging them costs no
      // plan text.
      response_keys:
        input && input.tool_response && typeof input.tool_response === "object"
          ? Object.keys(input.tool_response)
          : [],
      warnings: warnings ? warnings.split("\n").filter((l) => l.startsWith("- ")).length : 0,
    };
    // A plan the user turned down is not a plan: the KB warnings are still worth
    // hearing, the graph is not written, and nothing asks for it to be.
    if (!approval(input).approved) {
      const w = String(warnings || "").trim();
      noteExit({ ...note, approved: false, branch: w ? "not-approved" : "silent" });
      // Nothing to record and nothing to instruct — but a case-warning about a
      // plan the user just turned down is exactly what the next attempt needs.
      if (w) emit("PostToolUse", ["──────── PLAN · not approved ────────", ...kbLines(w)].join("\n"));
      return;
    }
    note.approved = true;
    // Recording touches the board, and the board can be missing, locked or
    // mid-write. A throw here used to take the whole hook down with it (the
    // dispatcher maps it to a clean exit), and the session then got NEITHER the
    // graph NOR the instruction to record it by hand — the plan just evaporated.
    // A failure is now one more branch: journalled by name, and answered with
    // the fallback the session can act on.
    let recorded = null;
    try {
      recorded = recordPlan(plan, { session: input.session_id });
    } catch (err) {
      noteExit({ ...note, branch: "record-failed", error: String((err && err.message) || err).slice(0, 200) });
      emit("PostToolUse", buildExitContext(warnings));
      return;
    }
    // A declared discussion is not work: nothing to record, and nothing to ask
    // the session to record either. The guard already refused the declaration
    // without a reason, so what arrives here carries one.
    //
    // Read AFTER the recording attempt on purpose. The guard refuses a plan that
    // declares a discussion and still carries steps, so the two never arrive
    // together — unless the guard is not wired in at all, and then a graph that
    // parsed is worth more than a declaration about it: the steps are recorded
    // rather than dropped in silence.
    const declared = discussionDeclaration(plan);
    if (!recorded && declared && isReason(declared.reason)) {
      keepPlanFile(input.session_id, plan, "-discussion");
      noteExit({ ...note, branch: "discussion" });
      emit("PostToolUse", buildDiscussionContext(warnings));
      return;
    }
    noteExit(
      recorded
        ? { ...note, branch: "recorded", ...declaredCounts(recorded.doc) }
        : { ...note, branch: "instruction" },
    );
    emit(
      "PostToolUse",
      recorded ? buildRecordedContext(recorded, warnings) : buildExitContext(warnings),
    );
    return;
  }
  // Unknown subcommand: a hook wiring typo — stay silent, never break the session.
}

// Entry for the unified dispatcher (`cli.mjs plan-hook <enter|exit>`); the
// dispatcher already maps any throw from a hook area to a clean exit 0.
export function run(args) {
  main(Array.isArray(args) ? args : []);
}
