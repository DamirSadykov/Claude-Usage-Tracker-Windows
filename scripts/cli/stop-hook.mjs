// `cli.mjs stop-hook` — Claude Code Stop hook: the HANDOFF guard (#59).
//
// A TASK's `handoff` is the ONLY carrier of context out of a session — it flows
// to whatever DEPENDS ON that task (todos.rs, #141). It is written BY HAND, and
// the nudge to write one lives at session START — nothing ever checked it at the
// END. So a session finishes a task, ends, and the baton it should have left is
// simply missing; the next session picks the work up blind.
// (The guard's plan/phases half was removed with the phases entity, t#254.)
//
// This guard closes that leak, on two levels:
//   • FRESHNESS — the baton's own stamp (`handoff_at`), not `updated_at`: a baton
//     written before this session belongs to older work.
//   • SUBSTANCE — freshness alone only proves SOMETHING was written, and the agent
//     writing the baton is the one being disciplined: `handoff "task done"`
//     would clear a freshness check while carrying nothing. So a fresh baton must
//     also look like a baton — long enough, pointing forward, naming something
//     concrete, and not just parroting the task's own subject (batonComplaints).
//     Whether it's TRUE is beyond any cheap check; a receipt is not.
//
// Blocking = exit 2 with the reason on stderr (Claude reads it and continues).
// It fires at most ONCE per stop cycle: when Claude is already continuing because
// of a stop hook, Claude Code sets `stop_hook_active`, and we stand down — so a
// session that genuinely needs no baton can just stop again.
//
// Wired as a global Stop hook in ~/.claude/settings.json by the tracker's
// installer (`install_cc_hook` in lib.rs writes both SessionStart and Stop). The
// switch in settings.json (SettingsPanel): `taskHandoffGuard`
// (off|submitted|unfinished|both, default both).
//
// Like the SessionStart hook, it must NEVER break a session: anything unexpected
// (no stdin, unreadable transcript, bad JSON) is a silent no-op.

import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskHandoffGuard, specDeltaGuard } from "./settings.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// The task-guard mode (`taskHandoffGuard`) is read via ./settings.mjs — the
// shared settings layer that owns the file path + each forgiving default.

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

// --- which tasks did THIS session actually MOVE? (transcript attribution) ------
//
// The task guard's hard question is "did THIS session transition this task?", NOT
// "was it touched in this window" (#219). A timestamp can't tell them apart — a
// metadata edit, another session's move, or a hand-edit all bump `updated_at`, and
// two sessions on one project share the same time window. The transcript can: it
// is THIS session's own record, and every `todos set status <ref> <status>` it ran
// is a Bash tool_use whose command string we read back. A task another session
// moved, or one this session merely mentioned (t#N in prose) or re-prioritized,
// never appears here — so none of them can be dragged into this session's stop-gate.
//
// Returns Map<ref, Set<status>>: the ref (id|number, a leading '#' stripped) the
// command named → the statuses it was set to. The caller matches a todo by BOTH
// its id and its number, and only gates it if the session set it to the status it
// NOW has (we made that transition, not just some earlier one).

// A status move inside a command already known to invoke the CLI. BOTH spellings:
// the command is `todos set status <ref> <status>` since t#310, and transcripts
// older than that carry the `set-status <ref> <status>` it replaced.
const SET_STATUS_RE =
  /\bset[- ]status\s+#?([\w-]+)\s+(backlog|queue|in_progress|review|done)\b/g;

// Pure parser over the raw JSONL transcript text — exported for the unit tests.
export function parseSessionMoves(raw) {
  const moved = new Map();
  for (const line of String(raw || "").split("\n")) {
    if (!/set[- ]status/.test(line)) continue; // cheap prefilter before JSON.parse
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // header / truncated line
    }
    const content = rec && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || item.type !== "tool_use" || item.name !== "Bash") continue;
      const cmd = item.input && item.input.command;
      // Require the command to actually invoke the tracker CLI, so a stray echo of
      // the string "set-status …" can't be read as a real transition.
      if (typeof cmd !== "string" || !/cli\.mjs|cc-todos/.test(cmd)) continue;
      SET_STATUS_RE.lastIndex = 0;
      let m;
      while ((m = SET_STATUS_RE.exec(cmd))) {
        let set = moved.get(m[1]);
        if (!set) moved.set(m[1], (set = new Set()));
        set.add(m[2]);
      }
    }
  }
  return moved;
}

// Read the session's transcript and derive its moves. Empty Map on any trouble
// (no/unreadable transcript) — the guard then attributes nothing and stands down,
// which keeps the "never break a session" contract.
function sessionMovedTasks(transcriptPath) {
  if (!transcriptPath) return new Map();
  try {
    return parseSessionMoves(readFileSync(transcriptPath, "utf8"));
  } catch {
    return new Map();
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
// Deliberately NOT checked: "is this byte-for-byte the previous baton" — the
// freshness axis (`handoff_at` vs session start) already covers a stale rewrite.

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
    "\\b\\d+\\.\\d+\\b", // a dotted locator/version (2.3)
    "\\w+\\(\\)", // a function
  ].join("|"),
);

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
// Letters/digits only, lowercased — for comparing a baton against the task text
// it might just be parroting.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// What's WRONG with this baton, as a list of complaints (empty = it's a baton).
// `own` is the task's own text ({title, desc}) or null — a baton that merely
// parrots it carries nothing a dependent can't already read from the board.
// Exported for the unit tests.
export function batonComplaints(body, own) {
  const text = squash(body);
  const out = [];
  if (!text) return ["it is empty"];
  if (text.length < MIN_CHARS)
    out.push(`it is ${text.length} chars — a receipt, not a baton (min ${MIN_CHARS})`);
  if (!NEXT_RE.test(text))
    out.push("no next step — say what the next session should DO first");
  if (!ANCHOR_RE.test(text))
    out.push(
      "nothing concrete — name a file, a `symbol` or a task (t#N)",
    );
  if (own) {
    const ownText = norm(`${own.title} ${own.desc || ""}`);
    const baton = norm(text);
    if (baton && (baton === norm(own.title) || ownText.includes(baton)))
      out.push(
        "it restates the task's own subject/description — the next session already reads those from the board",
      );
  }
  return out;
}

// --- which tasks owe a baton ---------------------------------------------------
//
// A task hands its baton to whatever depends on it (todos.rs `handoff`, surfaced
// when a dependent moves to in_progress). Written by hand, nudged only at session
// start. So a session finishes a task, moves it to review, and the next task
// starts blind.
//
// Which tasks owe a baton is the user's call (`taskHandoffGuard` in settings.json):
//   "off"        — don't guard tasks at all
//   "submitted"  — a task this session moved to review/done
//   "unfinished" — a task this session worked and LEFT in_progress
//   "both"       — either (default)
//
// "This session moved it" is read from the transcript, NOT `updated_at` (#219):
// `movedBy` (a Map<ref, Set<status>> from parseSessionMoves) says which tasks this
// session ran set-status on and into what. A task is in scope only if this session
// set it to the status it NOW has — so another session's move, or a mere metadata
// touch/mention, never counts. Whether the baton is fresh is a separate axis,
// `handoff_at` vs the session start: an edit of any kind bumps updated_at, so
// without the dedicated stamp a year-old handoff on a task touched today would read
// as freshly written. The mode itself (`taskHandoffGuard`) is read via ./settings.mjs.

const wants = (mode, kind) => mode === "both" || mode === kind;

// Did THIS session set `t` to the status it currently has? Matches the transcript
// refs by BOTH id and number — set-status accepts either (id|N|#N, the '#' already
// stripped in the map).
function movedIntoCurrentStatus(movedBy, t) {
  const into =
    movedBy.get(t.id) || (t.number != null && movedBy.get(String(t.number)));
  return !!(into && into.has(t.status));
}

// The tasks of THIS project that owe a baton and haven't left one. Same two-level
// judgement as for phases: is it there (fresh), and is it a baton at all.
// `todos` is todos.json's array; `project` the cwd basename; `movedBy` this
// session's transcript-derived moves. Exported for the tests.
export function auditTasks(todos, project, sinceMs, movedBy, mode = "both") {
  if (mode === "off" || !Array.isArray(todos)) return [];
  const moved = movedBy instanceof Map ? movedBy : new Map();
  const out = [];
  for (const t of todos) {
    if (!t || (t.project && t.project !== project)) continue;
    // Only tasks THIS session transitioned into their current status — the
    // authoritative signal that this is the session's own work (#219).
    if (!movedIntoCurrentStatus(moved, t)) continue;

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
        status: t.status,
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
        status: t.status,
        stale: false,
        hadBaton: true,
        complaints,
      });
  }
  return out;
}

// --- the SPEC-DELTA guard (t#341) ---------------------------------------------
//
// The genre died of silent drift: code moved, the section stayed put, and
// nobody noticed for two weeks (t#338). docs/specs/README.md §8 puts the check
// at the CLOSE of a task rather than at a PR, because over the audited period
// there were 33 closed tasks and zero PRs — a guard on PRs would never have run.
//
// What it demands is an ANSWER, not a file change: `spec answer <task>
// unchanged|updated --text "…"`. Two reasons it is the answer and not the diff:
//
//   • the failure being guarded against was a spot edit made WITHOUT rereading
//     the section — §9 of the old spec was patched in place while two
//     neighbouring bullets went on lying. So the guard prints the addressed
//     section WHOLE and asks about it;
//   • the answer must be structural. This session watched the sibling handoff
//     guard block a perfectly good baton because its next step was worded
//     "ПЕРВЫЙ ХОД" and not one of NEXT_RE's words — a phrase-matching gate
//     teaches you to reword, not to think. So there is no prose to match: the
//     record exists only if the command was run.
//
// Scope is CLOSING (review/done), same transcript attribution as the baton
// guard, and the addresses are the same ones the in_progress injection showed
// (own `spec`, else the change root's) — you are asked about what you were given.

const answersOf = (t) => (Array.isArray(t.spec_answers) ? t.spec_answers.filter(Boolean) : []);

// The floor an answer has to clear: the moment THIS work cycle was shown the
// section. Anything older was written about a different state of the work, even
// inside the same session — without a floor the bar is only "some time this
// session", which lets a session close five tasks and file one batch of answers
// at the end: the template answer §9 is about, arriving through the timing.
//
// The anchor is the BASELINE (`spec_seen[address].at`), recorded at the
// in_progress injection, because it means exactly the thing being asked —
// "answered about the text this work saw". The first shape of this measured
// from the transition into the CURRENT status instead, and that re-armed the
// guard on every subsequent move: answer, → review, answer again, → done,
// answer again, all about text that never moved. Three identical answers in one
// session, which is precisely the rot §9 names — manufactured by the guard.
//
// Re-opening a task records a new baseline, so an answer from the previous
// cycle goes stale by itself, which is the case the strict version was after.
// Without a baseline: the last entry into in_progress, else the session window.
function answerFloorMs(t, address, sinceMs) {
  const seen = (Array.isArray(t.spec_seen) ? t.spec_seen : []).find(
    (x) => x && x.address === address,
  );
  const baseline = seen ? Date.parse(seen.at) : NaN;
  if (Number.isFinite(baseline)) return baseline;
  const history = Array.isArray(t.status_history) ? t.status_history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.status !== "in_progress") continue;
    const ms = Date.parse(h.at);
    if (Number.isFinite(ms)) return ms;
    break;
  }
  return sinceMs;
}

// Which addressed sections of a closing task have no answer from THIS session.
// `addressesFor(todo)` is injected so this stays a pure function over the board
// (production passes a closure over todos.mjs's up-walk; the tests pass a stub).
// An answer from an earlier session is `stale`, not missing: the section was
// judged against work that is not this session's.
export function auditSpecAnswers(todos, project, sinceMs, movedBy, addressesFor, mode = "on") {
  if (mode === "off" || !Array.isArray(todos) || typeof addressesFor !== "function") return [];
  const moved = movedBy instanceof Map ? movedBy : new Map();
  const out = [];
  for (const t of todos) {
    if (!t || (t.project && t.project !== project)) continue;
    if (t.status !== "review" && t.status !== "done") continue;
    if (!movedIntoCurrentStatus(moved, t)) continue;
    let addresses;
    try {
      addresses = addressesFor(t) || [];
    } catch {
      continue; // the board's shape surprised us → never block on a guess
    }
    if (!addresses.length) continue;
    const answers = answersOf(t);
    const owed = [];
    for (const address of addresses) {
      // Per address, not per task: two linked sections can be shown at
      // different moments, and one of them being fresh says nothing about the
      // other.
      const after = answerFloorMs(t, address, sinceMs);
      const a = answers.find((x) => x.address === address);
      const at = a ? Date.parse(a.at) : NaN;
      if (!a) owed.push({ address, state: "missing" });
      else if (!(Number.isFinite(at) && at >= after))
        owed.push({ address, state: "stale", verdict: a.verdict });
    }
    if (owed.length)
      out.push({ number: t.number, id: t.id, subject: t.subject, status: t.status, owed });
  }
  return out;
}

// The addressed sections printed in full, as §8 requires — but a stop message
// is read in a terminal, so past a few sections the rest are named by address
// and the cap is stated rather than applied in silence.
const SECTION_PRINT_CAP = 3;

function specReason(tasks, { blocks = [], omitted = 0, lint = [] } = {}) {
  const lines = [
    `STOP blocked — a task closed on a spec link left the section unanswered.`,
    ``,
  ];
  for (const t of tasks) {
    lines.push(`  · task #${t.number} "${t.subject}" (${t.status}):`);
    for (const o of t.owed)
      lines.push(
        `      – ${o.address}: ${o.state === "missing" ? "нет ответа" : `ответ "${o.verdict}" записан ДО того, как задача сюда перешла`}`,
      );
  }
  lines.push(
    ``,
    `The spec is the long-lived state; the task was the delta. Read the section`,
    `BELOW IN FULL — not the line you happen to remember — and say which it is:`,
    ``,
  );
  for (const t of tasks) {
    for (const o of t.owed) {
      lines.push(
        `  node "${CLI}" spec answer ${t.number} unchanged --text "<почему раздел всё ещё верен после этой работы>" --address ${o.address}`,
        `  node "${CLI}" spec answer ${t.number} updated   --text "<что в разделе разошлось и как поправлено>" --address ${o.address}`,
      );
    }
  }
  lines.push(
    ``,
    `\`updated\` expects the section itself to be edited first — the command only`,
    `stamps its provenance (updated/change). Answering per section is deliberate:`,
    `one sentence covering two sections is the template answer README §9 calls rot.`,
    ``,
  );
  if (lint.length) {
    lines.push(
      `Реестр вдобавок жалуется на эти же разделы — почини заодно, ты уже здесь:`,
      ``,
      ...lint.map((f) => `  ✗ ${f.message}`),
      ``,
    );
  }
  for (const s of blocks) {
    lines.push(`──────── ${s.address} ────────`, s.text, ``);
  }
  if (omitted)
    lines.push(
      `(${omitted} more addressed section(s) not printed here — read them with \`spec show <адрес>\`)`,
      ``,
    );
  return lines.join("\n");
}

// The tracker's todos.json — the same file the SessionStart hook reads. Returns
// the array, or [] when it's missing/unreadable (the guard then only sees plans).
function readChanges(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "todos.json"),
      "utf8",
    );
    const changes = JSON.parse(raw).changes;
    return Array.isArray(changes) ? changes : [];
  } catch {
    return [];
  }
}

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

// The block message: what's missing, per task, then how to fix it.
function reason(tasks) {
  const lines = [
    `STOP blocked — this session's work leaves no usable HANDOFF behind.`,
    ``,
  ];

  for (const t of tasks) {
    const what =
      t.kind === "submitted"
        ? `you moved it to ${t.status || "review/done"}`
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
    `A handoff is the one channel a DEPENDENT task gets automatically: it is`,
    `surfaced the moment that task moves to in_progress, without anyone going`,
    `looking. Write for whoever picks the work up next — what's done that they`,
    `build on, the decision or gotcha they'd otherwise re-discover, and the`,
    `concrete first move. Not a summary of the task they can already read.`,
    ``,
  );
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

// The spec side needs the board's up-walk (a task inherits its change root's
// `spec`) and the registry's reader. Both are heavy relative to a hook that
// runs on EVERY stop, so they are pulled in only once a closing task is in
// scope — and a failure to load them stands the spec guard down rather than
// breaking the session.
async function specGuardParts(cwd, appData) {
  try {
    const [todosMod, specMod] = await Promise.all([
      import("./todos.mjs"),
      import("./spec.mjs"),
    ]);
    const root = specMod.resolveRoot(cwd, appData);
    return {
      addressesFor: (data) => (t) =>
        todosMod.specAddressesFor(t, todosMod.changeRootsFor(data, t)).addresses,
      render: (address) => {
        const res = specMod.showSection(address, root, appData);
        if (!res.ok) return `— ${address}: ${res.reason}`;
        if (res.remote && !res.available)
          return `— ${address}: ${res.unavailable}` + (res.stub ? `\n\n${res.stub}` : "");
        return res.text || `— ${address}: (раздел пуст)`;
      },
      // Registry errors on the sections being asked about. Scoped to those on
      // purpose: the guard is already interrupting for this task, and a session
      // told about an unrelated domain's problems learns to skim the whole
      // message. Run only when the guard fires, so a clean stop pays nothing.
      lintFor: (addresses) => {
        try {
          const wanted = new Set(addresses);
          return specMod
            .validateRegistry(root, cwd)
            .filter((f) => f.severity === "error" && wanted.has(f.address));
        } catch {
          return [];
        }
      },
    };
  } catch {
    return null;
  }
}

async function main() {
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
  const taskMode = taskHandoffGuard(appData);
  const specMode = specDeltaGuard(appData);
  if (taskMode === "off" && specMode === "off") return; // both switched off

  const since = sessionStartMs(input.transcript_path);
  if (since == null) return; // unknown session window → stand down

  const todos = readTodos(appData);
  const project = path.basename(String(cwd).replace(/[\\/]+$/, ""));
  // Which tasks THIS session actually moved (its transcript) — the guard scopes to
  // those, never to another session's or a merely-touched task (#219).
  const movedBy = sessionMovedTasks(input.transcript_path);
  const tasks = auditTasks(todos, project, since, movedBy, taskMode);

  // BOTH guards are judged in one pass and reported together, on purpose: the
  // hook fires once per stop cycle (`stop_hook_active`), so a session blocked
  // for a missing baton would sail past a missing spec answer on its next stop.
  let specTasks = [];
  let sections = { blocks: [], omitted: 0 };
  if (specMode !== "off") {
    const parts = await specGuardParts(cwd, appData);
    if (parts) {
      const board = { todos, changes: readChanges(appData) };
      specTasks = auditSpecAnswers(
        todos,
        project,
        since,
        movedBy,
        parts.addressesFor(board),
        specMode,
      );
      const wanted = [];
      for (const t of specTasks) for (const o of t.owed) if (!wanted.includes(o.address)) wanted.push(o.address);
      sections = {
        blocks: wanted.slice(0, SECTION_PRINT_CAP).map((address) => ({
          address,
          text: parts.render(address),
        })),
        omitted: Math.max(0, wanted.length - SECTION_PRINT_CAP),
        lint: wanted.length ? parts.lintFor(wanted) : [],
      };
    }
  }

  if (!tasks.length && !specTasks.length) return;

  const parts = [];
  if (tasks.length) parts.push(reason(tasks));
  if (specTasks.length) parts.push(specReason(specTasks, sections));

  // Exit 2 is the Stop hook's "block": stderr goes back to Claude as the reason.
  process.stderr.write(parts.join("\n") + "\n");
  process.exit(2);
}

// Entry for the unified dispatcher: `cli.mjs stop-hook`. Any unexpected failure
// must leave the session alone — exit 0, no output, no block.
export async function run() {
  try {
    await main();
  } catch {
    process.exit(0);
  }
}
