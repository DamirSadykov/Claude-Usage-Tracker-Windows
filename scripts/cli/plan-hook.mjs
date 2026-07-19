// `cli.mjs plan-hook <enter|exit>` — the two PostToolUse hooks that turn plan
// mode into the tracker's TASK-FORMING ritual (t#253), per the decision record
// «фазы → plan mode + task-граф» (2026-07-19):
//
//   • enter (matcher EnterPlanMode) — inject the plan FORMAT before the plan is
//     written: plan-phrases, vision paragraph, one step = one session, and the
//     final ORDER line in arrow notation. Free prose, not slot-filling — the only
//     consumer of the structure is the model itself, which writes the plan and
//     later records it.
//   • exit (matcher ExitPlanMode) — the plan is FOR the writer, not a report:
//     instruct the session to record it in the tracker (a multi-session plan →
//     a theme root + child tasks + dep edges from the ORDER line; a one-session
//     plan → the task's `plan` field), and — deterministically, in the hook
//     itself — run the KB's `match-plan` over the plan text so case-warnings
//     reach the session BEFORE execution starts. The match step is optional:
//     it runs only when settings.json names a CLI (`matchPlanCli`), so the
//     public tracker carries no hard dependency on a private knowledge base.
//
// Wired into ~/.claude/settings.json by the tracker's installer (install_cc_hook
// in lib.rs) as PostToolUse groups with per-tool matchers. Like every hook here,
// it must NEVER break a session: any unexpected failure is a silent no-op (the
// dispatcher maps a throw to exit 0), and the match step has its own timeout.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchPlanCli } from "./settings.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// --- enter: the plan format, injected right after plan mode starts -----------
// Exported for the unit tests.
export function buildEnterContext() {
  return [
    "──────── PLAN MODE · write the plan as tasks-to-be (tracker ritual) ────────",
    "This plan is written FOR YOU and the sessions after you, not as a report for",
    "the user. On ExitPlanMode you will RECORD it in the task tracker, so shape it",
    "to map 1:1 onto tasks:",
    "",
    "1. VISION — one opening paragraph: what should exist when the whole plan is",
    "   done, what was decided and why (\"должно X, решили Y, потому что Z\"). For a",
    "   multi-session plan this paragraph becomes the theme root's description.",
    "2. STEPS — a numbered list. ONE STEP = ONE SESSION of work; a plan that fits",
    "   a single session is a single step. Each step is a plan-phrase: first",
    "   person, the action plus what it is grounded on, free prose — not slots.",
    "3. ORDER — one final line in arrow notation over the step numbers, e.g.:",
    "     Порядок: 1 -> 2 -> 3 -> 4; 2 -> 5",
    "   An arrow states a REAL blocker only (the right step cannot start before",
    "   the left is done); steps that merely read nicely in sequence get NO arrow —",
    "   parallelism shows itself in the task graph. Each arrow becomes a `dep add`.",
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

// The recording instruction (+ optional warnings block). Exported for the tests.
export function buildExitContext(warnings) {
  const lines = [
    "──────── PLAN accepted · now record it in the tracker (plan is for YOU) ────────",
    "If the user REJECTED the plan, skip this block. Otherwise write the plan to",
    `the tracker with <cli> = node "${CLI}" — do not re-plan, just transcribe:`,
    "",
    "Plan of SEVERAL steps (a theme):",
    '  1. Root:      <cli> todos add "ТЕМА: <name>" --theme --description "<the VISION paragraph>"',
    '  2. Children:  <cli> todos add "<step\'s plan-phrase>"     (one task per step, in step order)',
    "  3. Edges:     <cli> todos dep add <root> <child>          (the root depends on EVERY child)",
    "                and the ORDER line arrow by arrow: `1 -> 2` ⇒ <cli> todos dep add <task-of-2> <task-of-1>",
    '  4. Full plan: <cli> todos set-plan <root> --text "<the plan markdown>"',
    "",
    "Plan of ONE step: no theme — write it onto the task you are working on (or",
    'create one):  <cli> todos set-plan <id> --text "<the plan markdown>"',
    "",
    "One step = one task; subjects are the step phrases themselves. Do not invent",
    "extra tasks the plan does not contain.",
  ];
  const w = String(warnings || "").trim();
  if (w) {
    lines.push(
      "",
      "KB case-warnings for this plan (match-plan, read BEFORE executing):",
      ...w.split("\n").map((l) => "  " + l),
      "",
      "Persist them: add this block as a comment on the theme root (or the task)",
      'via <cli> todos comment add <id> --text "..." so the warnings outlive this session.',
    );
  }
  return lines.join("\n");
}

// PostToolUse contract: JSON on stdout, additionalContext under hookSpecificOutput.
function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
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
    emit(buildEnterContext());
    return;
  }
  if (sub === "exit") {
    const plan =
      input && input.tool_input && typeof input.tool_input.plan === "string"
        ? input.tool_input.plan
        : "";
    emit(buildExitContext(runMatchPlan(plan, matchPlanCli())));
    return;
  }
  // Unknown subcommand: a hook wiring typo — stay silent, never break the session.
}

// Entry for the unified dispatcher (`cli.mjs plan-hook <enter|exit>`); the
// dispatcher already maps any throw from a hook area to a clean exit 0.
export function run(args) {
  main(Array.isArray(args) ? args : []);
}
