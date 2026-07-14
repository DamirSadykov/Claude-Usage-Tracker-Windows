// `cli.mjs stop-hook` — Claude Code Stop hook: the HANDOFF freshness guard (#59).
//
// The plan's HANDOFF.md is the ONLY carrier of context from one phase-session to
// the next (the SessionStart hook surfaces it), but it is written BY HAND — the
// nudge to write one lives at session START, and nothing ever checks it at the
// END. So a session ticks phases, ends, and the baton it should have left is
// simply missing; the next session picks the phase up blind.
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
// installer (`install_cc_hook` in lib.rs writes both SessionStart and Stop), and
// gated by the `phaseHandoffGuard` setting (SettingsPanel, default ON).
//
// Like the SessionStart hook, it must NEVER break a session: anything unexpected
// (no stdin, unreadable transcript, no plans, bad JSON) is a silent no-op.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPlansForHook } from "./phases.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// The guard's off-switch (settings.json `phaseHandoffGuard`, written by the
// tracker's SettingsPanel). Default ON. Read-only and forgiving: a missing file,
// bad JSON, or absent key falls back to on — same contract as hookContextEnabled.
function guardEnabled(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      "utf8",
    );
    const v = JSON.parse(raw).phaseHandoffGuard;
    if (typeof v === "boolean") return v;
  } catch {
    // no settings file / bad JSON / missing key → default on
  }
  return true;
}

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

// Todo statuses live in the tracker's todos.json — the same file the SessionStart
// hook reads. Returns a `number -> is done` predicate; a missing/unreadable file
// means "nothing is done", which only ever makes the guard stricter.
function doneTaskLookup(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "todos.json"),
      "utf8",
    );
    const todos = JSON.parse(raw).todos;
    if (!Array.isArray(todos)) return () => false;
    const done = new Set(
      todos
        .filter((t) => t && t.number != null && t.status === "done")
        .map((t) => t.number),
    );
    return (n) => done.has(n);
  } catch {
    return () => false;
  }
}

const hhmm = (ms) => {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getHours())}:${z(d.getMinutes())}`;
};

function reason(findings) {
  const lines = [
    `STOP blocked — this session worked a phase plan, but the HANDOFF baton it leaves behind doesn't do its job.`,
    ``,
  ];
  for (const p of findings) {
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
  lines.push(
    ``,
    `The handoff is the ONLY thing the next session inherits about this plan (the`,
    `SessionStart hook surfaces it, and nothing else about this session survives).`,
    `Write it for the person picking up the NEXT phase: what's done that they build`,
    `on, the decision or gotcha they'd otherwise re-discover, and the concrete first`,
    `move — not a summary of the phase they can already read in Phase-N.md.`,
    ``,
    ...findings.map(
      (p) =>
        `  node "${CLI}" phases handoff "<what's done; decision/gotcha; next step>" --plan ${p.slug}`,
    ),
    ``,
    `If this session's phase work genuinely needs no baton, say so and stop again —`,
    `this guard fires once per stop.`,
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
  if (!guardEnabled(appData)) return;

  const since = sessionStartMs(input.transcript_path);
  if (since == null) return; // unknown session window → stand down

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

  const findings = auditPlans(cwd, since, doneTaskLookup(appData), currentPhase);
  if (!findings.length) return;

  // Exit 2 is the Stop hook's "block": stderr goes back to Claude as the reason.
  process.stderr.write(reason(findings) + "\n");
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
