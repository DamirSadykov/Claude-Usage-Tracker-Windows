// `cli.mjs stop-hook` — Claude Code Stop hook: the HANDOFF freshness guard (#59).
//
// The plan's HANDOFF.md is the ONLY carrier of context from one phase-session to
// the next (the SessionStart hook surfaces it), but it is written BY HAND — the
// nudge to write one lives at session START, and nothing ever checks it at the
// END. So a session ticks phases, ends, and the baton it should have left is
// simply missing; the next session picks the phase up blind.
//
// This guard closes that leak. On Stop it compares FILE FACTS, not a digest of
// the turn: if the session touched a plan's Phase-*.md and HANDOFF.md is older
// than that mutation, the stop is BLOCKED with a nudge to write the baton. Going
// by mtime (rather than "did the last few turns look like a phase closing") is
// what catches a caveat that surfaced N turns before the phase was ticked done.
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

// The plans this session TOUCHED whose baton is STALE. A plan qualifies when a
// Phase-*.md was written after the session started and HANDOFF.md is older than
// that write (missing HANDOFF.md = mtime 0 = always stale).
//
// `isTaskDone(n)` skips plans whose tracker task is done: that work is finished
// (no next session to hand off to), AND the SessionStart hook itself rewrites
// such a plan's phase files (markPlanDoneForDoneTasks) — without this, the hook's
// own write would look like session work and demand a baton for closed work.
//
// Exported for the unit tests; pure read, throws nothing the caller must handle.
export function stalePlans(cwd, sinceMs, isTaskDone = () => false) {
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
    if (handoffMs >= lastMut.ms) continue; // baton is newer than the work → fresh

    out.push({
      slug: ent.name,
      task,
      file: lastMut.file,
      mutatedAt: lastMut.ms,
      handoffAt: handoffMs || null,
    });
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

function reason(stale) {
  const lines = [
    `STOP blocked — this session worked a phase plan, but its HANDOFF baton is stale.`,
  ];
  for (const p of stale) {
    const when = p.handoffAt
      ? `HANDOFF.md last written ${hhmm(p.handoffAt)}`
      : `HANDOFF.md does not exist`;
    lines.push(
      `  · plan "${p.slug}": ${p.file} written ${hhmm(p.mutatedAt)}, ${when}.`,
    );
  }
  lines.push(
    ``,
    `The handoff is the ONLY thing the next session inherits about this plan (the`,
    `SessionStart hook surfaces it). Write it before you stop — what's done, any`,
    `decision or gotcha, the concrete next step:`,
    ``,
    ...stale.map(
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

  const stale = stalePlans(cwd, since, doneTaskLookup(appData));
  if (!stale.length) return;

  // Exit 2 is the Stop hook's "block": stderr goes back to Claude as the reason.
  process.stderr.write(reason(stale) + "\n");
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
