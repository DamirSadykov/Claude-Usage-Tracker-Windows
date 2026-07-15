// `cli.mjs stop-hook` — Claude Code Stop hook: the HANDOFF guard (#59).
//
// A handoff is the ONLY carrier of context out of a session, in BOTH flows the
// tracker runs:
//   • a PLAN's HANDOFF.md → the next phase-session (SessionStart surfaces it),
//   • a TASK's `handoff`  → whatever DEPENDS ON that task (todos.rs, #141).
// Both are written BY HAND, and the nudge to write one lives at session START —
// nothing ever checked them at the END. So a session ticks phases or finishes a
// task, ends, and the baton it should have left is simply missing; the next
// session picks the work up blind.
//
// This guard closes that leak, on two levels:
//   • FRESHNESS — file facts, not a digest of the turn: if the session touched a
//     plan's Phase-*.md and HANDOFF.md is older than that mutation, block. Going
//     by mtime (rather than "did the last few turns look like a phase closing")
//     catches a caveat that surfaced N turns before the phase was ticked done.
//   • SUBSTANCE — freshness alone only proves SOMETHING was written, and the agent
//     writing the baton is the one being disciplined: `handoff "phase 2 done"`
//     would clear an mtime check while carrying nothing. So a fresh baton must
//     also look like a baton — long enough, pointing forward, naming something
//     concrete, and not just parroting the phase's own title (batonComplaints).
//     Whether it's TRUE is beyond any cheap check; a receipt is not.
//
// Blocking = exit 2 with the reason on stderr (Claude reads it and continues).
// It fires at most ONCE per stop cycle: when Claude is already continuing because
// of a stop hook, Claude Code sets `stop_hook_active`, and we stand down — so a
// session that genuinely needs no baton can just stop again.
//
// Wired as a global Stop hook in ~/.claude/settings.json by the tracker's
// installer (`install_cc_hook` in lib.rs writes both SessionStart and Stop). Two
// independent switches in settings.json (SettingsPanel): `phaseHandoffGuard`
// (bool, default ON) for plans, `taskHandoffGuard` (off|submitted|unfinished|both,
// default both) for tasks.
//
// Like the SessionStart hook, it must NEVER break a session: anything unexpected
// (no stdin, unreadable transcript, no plans, bad JSON) is a silent no-op.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPlansForHook } from "./phases.mjs";
import { phaseHandoffGuard, taskHandoffGuard } from "./settings.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// The guard's off-switch (`phaseHandoffGuard`) and the task-guard mode
// (`taskHandoffGuard`) are read via ./settings.mjs — the shared settings layer
// that owns the file path + each forgiving default. See the imports above.

// When did THIS session start? The transcript is a JSONL log whose first records
// carry an ISO `timestamp`; the earliest one is the session's start. We only need
// the head of the file, so read a single 64 KiB chunk instead of the whole log
// (a long session's transcript is megabytes). Null when it can't be determined —
// the caller then stands down rather than guessing a window.
//
// Caveat: on `--resume` Claude Code keeps writing to the SAME transcript, so this
// reports the ORIGINAL start — the window widens and an older mutation can look
// like this session's. That errs toward asking for a baton, never toward missing one.
function sessionStartMs(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // header records, or a truncated tail line of the chunk
      }
      const ms = Date.parse(rec && rec.timestamp);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // no transcript / unreadable → unknown window
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
  return null;
}

function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0; // missing file → epoch, i.e. "older than any mutation"
  }
}

// --- is this text a baton, or just a receipt? --------------------------------
//
// mtime alone only proves SOMETHING was written — and the agent that writes the
// baton is the same one the guard is disciplining, so `handoff "phase 2 done"`
// would satisfy a freshness-only check while carrying nothing. These checks are
// the cheap, deterministic half of "is it a baton": they can't tell whether the
// content is TRUE (nothing cheap can), but they do catch a receipt, a restatement
// of the phase's own title, and a note with nothing concrete in it.
//
// Deliberately NOT checked: "is this byte-for-byte the previous baton". The only
// cheap source for the old text is git HEAD — and the normal flow (close phase →
// write handoff → commit → stop) leaves the file identical to HEAD, so such a
// check would fire on exactly the honest case.

// A minimum that no one-word receipt clears, but a real one-line baton does.
const MIN_CHARS = 40;

// Does it point FORWARD? A baton's job is the next session's first move.
const NEXT_RE = /(\bnext\b|след(ующ|.\s*шаг)|дальше|далее|остал(о|ся|ись)|продолж|\bTODO\b)/i;

// Does it name anything CONCRETE — a file, a `symbol`, a task, a phase locator?
// Without one, "made progress, some issues remain" passes every other check.
const ANCHOR_RE = new RegExp(
  [
    "[\\w./-]+\\.(mjs|cjs|js|ts|tsx|vue|rs|json|md|py|toml|ya?ml|sh|ps1)\\b", // a file
    "`[^`]+`", // an inline-code span
    "\\bt#\\d+\\b", // a tracker task
    "#\\d+\\b", // a PR/issue
    "\\b\\d+\\.\\d+\\b", // a phase/subphase locator (2.3)
    "\\w+\\(\\)", // a function
  ].join("|"),
);

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
// Letters/digits only, lowercased — for comparing a baton against the phase text
// it might just be parroting.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// What's WRONG with this baton, as a list of complaints (empty = it's a baton).
// `phase` is the plan's current phase (title/desc) or null when the plan just
// finished — there's then nothing to parrot, so that check is skipped.
// Exported for the unit tests.
export function batonComplaints(body, phase) {
  const text = squash(body);
  const out = [];
  if (!text) return ["it is empty"];
  if (text.length < MIN_CHARS)
    out.push(`it is ${text.length} chars — a receipt, not a baton (min ${MIN_CHARS})`);
  if (!NEXT_RE.test(text))
    out.push("no next step — say what the next session should DO first");
  if (!ANCHOR_RE.test(text))
    out.push(
      "nothing concrete — name a file, a `symbol`, a task (t#N) or a phase locator (2.3)",
    );
  if (phase) {
    const phaseText = norm(`${phase.title} ${phase.desc || ""}`);
    const baton = norm(text);
    if (baton && (baton === norm(phase.title) || phaseText.includes(baton)))
      out.push(
        "it restates the phase's own title/description — the next session already reads that from Phase-N.md",
      );
  }
  return out;
}

// The plans this session TOUCHED whose baton is missing the mark, as findings:
//   kind "stale" — a Phase-*.md was written after the session started and
//                  HANDOFF.md is older than that write (no HANDOFF.md = always stale).
//   kind "weak"  — the baton IS fresh, but it doesn't carry anything (see above).
//
// `isTaskDone(n)` skips plans whose tracker task is done: that work is finished
// (no next session to hand off to), AND the SessionStart hook itself rewrites
// such a plan's phase files (markPlanDoneForDoneTasks) — without this, the hook's
// own write would look like session work and demand a baton for closed work.
//
// `phaseOf(slug)` yields the plan's current phase (title/desc) for the parroting
// check; the caller wires it to phases.mjs. Pure read; exported for the tests.
export function auditPlans(cwd, sinceMs, isTaskDone = () => false, phaseOf = () => null) {
  const phasesDir = path.join(cwd, ".claude", "phases");
  let dirents;
  try {
    dirents = readdirSync(phasesDir, { withFileTypes: true });
  } catch {
    return []; // no plans in this project → nothing to guard
  }
  const out = [];
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(phasesDir, ent.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const phaseFiles = files.filter((f) => /^Phase-\d+\.md$/.test(f));
    if (!phaseFiles.length) continue;

    const touched = phaseFiles
      .map((f) => ({ file: f, ms: mtimeMs(path.join(dir, f)) }))
      .filter((x) => x.ms > sinceMs)
      .sort((a, b) => b.ms - a.ms);
    if (!touched.length) continue; // this session never touched the plan

    let task = null;
    try {
      const m = readFileSync(path.join(dir, "README.md"), "utf8").match(
        /CC-task:\s*#?(\d+)/i,
      );
      if (m) task = Number(m[1]);
    } catch {
      // no README → treat as unlinked, still guard it
    }
    if (task != null && isTaskDone(task)) continue;

    const lastMut = touched[0];
    const handoffMs = mtimeMs(path.join(dir, "HANDOFF.md"));
    const base = {
      slug: ent.name,
      task,
      file: lastMut.file,
      mutatedAt: lastMut.ms,
      handoffAt: handoffMs || null,
    };
    if (handoffMs < lastMut.ms) {
      out.push({ ...base, kind: "stale", complaints: [] });
      continue;
    }
    // Fresh — now: does it actually carry anything?
    let body = "";
    try {
      // Stored as "# Handoff (date)\n\n<baton>" — drop the heading, keep the body.
      body = readFileSync(path.join(dir, "HANDOFF.md"), "utf8").replace(/^#[^\n]*\n?/, "");
    } catch {
      // unreadable right after we statted it → treat as stale rather than guess
      out.push({ ...base, kind: "stale", complaints: [] });
      continue;
    }
    const complaints = batonComplaints(body, phaseOf(ent.name));
    if (complaints.length) out.push({ ...base, kind: "weak", complaints });
  }
  return out;
}

// --- the SAME leak, one level up: tasks ---------------------------------------
//
// A task hands its baton to whatever depends on it (todos.rs `handoff`, surfaced
// when a dependent moves to in_progress). It leaks exactly like a phase's: written
// by hand, nudged only at session start. So a session finishes a task, moves it to
// review, and the next task starts blind.
//
// Which tasks owe a baton is the user's call (`taskHandoffGuard` in settings.json):
//   "off"        — don't guard tasks at all
//   "submitted"  — a task this session moved to review/done
//   "unfinished" — a task this session worked and LEFT in_progress
//   "both"       — either (default)
//
// "This session worked it" = `updated_at` after the session start. Whether the
// baton is fresh is `handoff_at`, NOT updated_at — an edit of any kind bumps the
// latter, so without the dedicated stamp a year-old handoff on a task touched
// today would read as freshly written. The mode itself (`taskHandoffGuard`) is
// read via ./settings.mjs.

const wants = (mode, kind) => mode === "both" || mode === kind;

// The tasks of THIS project that owe a baton and haven't left one. Same two-level
// judgement as for phases: is it there (fresh), and is it a baton at all.
// `todos` is todos.json's array; `project` the cwd basename. Exported for the tests.
export function auditTasks(todos, project, sinceMs, mode = "both") {
  if (mode === "off" || !Array.isArray(todos)) return [];
  const out = [];
  for (const t of todos) {
    if (!t || (t.project && t.project !== project)) continue;
    const touchedAt = Date.parse(t.updated_at);
    if (!Number.isFinite(touchedAt) || touchedAt <= sinceMs) continue; // untouched this session

    const kind =
      t.status === "review" || t.status === "done"
        ? "submitted"
        : t.status === "in_progress"
          ? "unfinished"
          : null;
    if (!kind || !wants(mode, kind)) continue;

    // A baton written BEFORE this session belongs to older work — the session's
    // own findings never made it in.
    const handoffAt = Date.parse(t.handoff_at);
    const fresh = Number.isFinite(handoffAt) && handoffAt > sinceMs;
    if (!fresh) {
      out.push({
        number: t.number,
        id: t.id,
        subject: t.subject,
        kind,
        stale: true,
        hadBaton: !!String(t.handoff || "").trim(),
        complaints: [],
      });
      continue;
    }
    // Fresh — but is it a baton, or a receipt? Parroting is measured against the
    // task's own subject/description: a dependent reads those from the board.
    const complaints = batonComplaints(t.handoff, {
      title: t.subject,
      desc: t.description,
    });
    if (complaints.length)
      out.push({
        number: t.number,
        id: t.id,
        subject: t.subject,
        kind,
        stale: false,
        hadBaton: true,
        complaints,
      });
  }
  return out;
}

// The tracker's todos.json — the same file the SessionStart hook reads. Returns
// the array, or [] when it's missing/unreadable (the guard then only sees plans).
function readTodos(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "todos.json"),
      "utf8",
    );
    const todos = JSON.parse(raw).todos;
    return Array.isArray(todos) ? todos : [];
  } catch {
    return [];
  }
}

const hhmm = (ms) => {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getHours())}:${z(d.getMinutes())}`;
};

// The block message: what's missing, per plan and per task, then how to fix it.
// Only the sections with findings are rendered.
function reason(plans, tasks) {
  const lines = [
    `STOP blocked — this session's work leaves no usable HANDOFF behind.`,
    ``,
  ];

  for (const p of plans) {
    if (p.kind === "stale") {
      const when = p.handoffAt
        ? `HANDOFF.md last written ${hhmm(p.handoffAt)} — BEFORE that`
        : `HANDOFF.md does not exist`;
      lines.push(`  · plan "${p.slug}": ${p.file} written ${hhmm(p.mutatedAt)}, ${when}.`);
    } else {
      lines.push(`  · plan "${p.slug}": the handoff is fresh, but it isn't a baton —`);
      for (const c of p.complaints) lines.push(`      – ${c}`);
    }
  }
  for (const t of tasks) {
    const what =
      t.kind === "submitted"
        ? "you moved it to review/done"
        : "you worked it and left it in_progress";
    if (t.stale) {
      lines.push(
        `  · task #${t.number} "${t.subject}": ${what}, but ${
          t.hadBaton ? "its handoff is from an earlier session" : "it has no handoff"
        }.`,
      );
    } else {
      lines.push(`  · task #${t.number} "${t.subject}": the handoff isn't a baton —`);
      for (const c of t.complaints) lines.push(`      – ${c}`);
    }
  }

  lines.push(
    ``,
    `A handoff is the ONLY thing that survives this session: the SessionStart hook`,
    `surfaces a plan's baton to the next phase, and a task's baton to whatever`,
    `DEPENDS ON it. Write for whoever picks the work up next — what's done that they`,
    `build on, the decision or gotcha they'd otherwise re-discover, and the concrete`,
    `first move. Not a summary of the phase/task they can already read.`,
    ``,
  );
  for (const p of plans) {
    lines.push(
      `  node "${CLI}" phases handoff "<what's done; decision/gotcha; next step>" --plan ${p.slug}`,
    );
  }
  for (const t of tasks) {
    lines.push(
      `  node "${CLI}" todos handoff set ${t.number} --text "<what's done; decision/gotcha; next step>"`,
    );
  }
  lines.push(
    ``,
    `If this work genuinely needs no baton, say so and stop again — this guard fires`,
    `once per stop.`,
  );
  return lines.join("\n");
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) || {};
  } catch {
    return; // no stdin / bad JSON → nothing to judge
  }
  // Already continuing because a stop hook blocked → never block twice (that's an
  // infinite loop). The guard is a nudge, not a wall.
  if (input.stop_hook_active) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  const phaseGuard = phaseHandoffGuard(appData);
  const taskMode = taskHandoffGuard(appData);
  if (!phaseGuard && taskMode === "off") return; // both halves switched off

  const since = sessionStartMs(input.transcript_path);
  if (since == null) return; // unknown session window → stand down

  const todos = readTodos(appData);
  const doneTask = (() => {
    const done = new Set(
      todos.filter((t) => t && t.number != null && t.status === "done").map((t) => t.number),
    );
    return (n) => done.has(n);
  })();

  // The plan's CURRENT phase (title/desc) — a baton that merely parrots it carries
  // nothing the next session can't already read. readPlansForHook is the same
  // reader the SessionStart hook uses, so both see one grammar.
  let currentPhase = () => null;
  try {
    const byPlan = new Map(readPlansForHook(cwd).map((p) => [p.slug, p.current]));
    currentPhase = (slug) => byPlan.get(slug) || null;
  } catch {
    // unreadable plans → skip the parroting check, keep the rest
  }

  const plans = phaseGuard ? auditPlans(cwd, since, doneTask, currentPhase) : [];
  const project = path.basename(String(cwd).replace(/[\\/]+$/, ""));
  const tasks = auditTasks(todos, project, since, taskMode);
  if (!plans.length && !tasks.length) return;

  // Exit 2 is the Stop hook's "block": stderr goes back to Claude as the reason.
  process.stderr.write(reason(plans, tasks) + "\n");
  process.exit(2);
}

// Entry for the unified dispatcher: `cli.mjs stop-hook`. Any unexpected failure
// must leave the session alone — exit 0, no output, no block.
export function run() {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
