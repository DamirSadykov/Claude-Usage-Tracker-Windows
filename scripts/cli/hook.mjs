// `cli.mjs hook` — Claude Code SessionStart hook for the Claude Usage Tracker.
//
// Surfaces the QUEUE — the tasks the user has lined up (status queue or
// in_progress) that are a CURRENT ROOT of the dependency graph (every task in
// `depends_on` is done; no deps = root). The backlog, blocked, and review tasks
// are held back to keep the context lean. Titles only (clipped), capped at 10.
// The CLI contract prints FIRST (above the list) so a truncated injection never
// loses the how-to-edit instructions. An in_progress task also carries its CHANGE
// VISION (t#252): the description of the nearest change root up the dep graph.
// (Phase mode was removed with the phases entity, t#254 — a big task is a
// change on the graph now, renamed from `theme` at t#345; see
// docs/task-pipeline.md.)
// It reads todos.json only; its single write is the session<->task binding it
// appends to the task-sessions journal when exactly one task is in_progress
// (t#296), so the session's token cost can be attributed to that task. It MUST
// never disrupt a session: a missing/unreadable file, no matching todos, or any
// error is a silent no-op (exit 0, no output).
//
// Wired as a global SessionStart hook in ~/.claude/settings.json (the tracker's
// installer writes `node "<cli.mjs>" hook`) so it fires in every project; it
// filters todos by the current cwd's project basename (plus any project-less
// todos). See todos.rs / TodoWindow.vue for the schema.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeRootsFor,
  specAddressesFor,
  formatSpecSections,
  currentSessionId,
  appendTaskSessionEvent,
  lastTaskSessionEvent,
  STATUSES,
  setFieldNames,
} from "./todos.mjs";
import { taskContextMinRank, hookContextEnabled } from "./settings.mjs";
import { resolveRoot } from "./spec.mjs";

// The unified CLI is this module's grandparent-relative entry (scripts/cli.mjs);
// resolve its absolute path so the contract below can hand Claude exact,
// copy-pasteable commands (`cli.mjs todos <cmd> …`).
const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "cli.mjs",
);
// The absolute `node "<…>/cli.mjs"` invocation is long; spell it ONCE per block
// as `<cli>` and reference that short alias in every command, like the other
// `<id>` / `<N.k>` placeholders — keeps the injected context from drowning in the
// repeated path.
const CLI_NOTE = `<cli> = node "${CLI}"`;

// Priority ranks, shared with todos.rs::PRIORITIES / the cc-todos CLI. Unset = 0.
const PRANK = { high: 3, medium: 2, low: 1 };
const prank = (t) => (t && PRANK[t.priority]) || 0;

// Settings reads (taskContextPriority, hookContextEnabled) live in ./settings.mjs —
// one place that owns the file path + each forgiving default, shared with the Stop
// hook. See the imports above.

// Local calendar date as YYYY-MM-DD — "today" is the USER's day, not UTC (a
// scheduled_for date is a plain local date). Used to surface due/overdue tasks.
function localToday() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// Title only, whitespace-collapsed, clipped to SUBJECT_MAX (ellipsis if cut).
const SUBJECT_MAX = 100;
const clip = (s, max = SUBJECT_MAX) => {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

// Session <-> task binding (t#296). The journal is what lets the tracker split a
// task's cost into BLOCKS (task × session × interval), so a session that never
// ran `todos take` still needs a binding — but only when it is unambiguous:
// exactly one task of this project is in_progress. Two or more: don't guess, ask.
// None: stay silent. Returns the line to inject (or "" for nothing to say);
// writing the binding is a side effect, and any failure is a silent no-op.
export function bindSessionToTask(session, tasks) {
  try {
    if (!session) return "";
    const running = (Array.isArray(tasks) ? tasks : []).filter(
      (t) => t && t.status === "in_progress",
    );
    if (!running.length) return "";
    if (running.length > 1) {
      const refs = running
        .map((t) => (t.number ? `t#${t.number}` : String(t.id)))
        .join(", ");
      return (
        `Session ↔ task: ${running.length} tasks are in_progress (${refs}) — this session was NOT bound to any of them. ` +
        `Bind it with \`<cli> todos take <N>\` so its token cost lands on the right task.`
      );
    }
    const todo = running[0];
    const last = lastTaskSessionEvent(session);
    // An EXPLICIT binding (`take` / `set status`) outranks this guess for the rest
    // of the session: SessionStart fires again on resume/compact, and re-guessing
    // there would silently overwrite a task the session deliberately took.
    if (last && last.event === "start" && last.source !== "auto" && last.task !== todo.id) {
      const held = (Array.isArray(tasks) ? tasks : []).find((t) => t && t.id === last.task);
      const heldRef = held && held.number ? `t#${held.number}` : String(last.task);
      return (
        `Session ↔ task: this session stays bound to ${heldRef} — it was bound explicitly, ` +
        `so the in_progress guess does not override it. Rebind with \`<cli> todos take <N>\`.`
      );
    }
    if (!(last && last.task === todo.id && last.event === "start")) {
      appendTaskSessionEvent({
        session,
        task: todo.id,
        event: "start",
        source: "auto",
        project: todo.project || null,
      });
    }
    const ref = todo.number ? `t#${todo.number}` : String(todo.id);
    return (
      `Session ↔ task: this session is bound to ${ref} "${clip(todo.subject, 60)}" (the only in_progress task) — its token cost is attributed there. ` +
      `Working on a different task? Rebind with \`<cli> todos take <N>\`.`
    );
  } catch {
    return "";
  }
}

function main() {
  // SessionStart hooks receive a JSON payload on stdin (session_id, cwd,
  // source, …). Fall back to process.cwd() if it's absent or unparseable.
  let cwd = process.cwd();
  let session = "";
  try {
    const raw = readFileSync(0, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.cwd === "string" && j.cwd) cwd = j.cwd;
    if (j && typeof j.session_id === "string") session = j.session_id.trim();
  } catch {
    // no stdin / bad JSON → keep process.cwd()
  }
  if (!session) session = currentSessionId();

  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  // Master off-switch: the user turned off task-context INJECTION — nothing is
  // printed below it. The binding write is not context, so it still happens
  // (cost attribution must not depend on how chatty the hook is).
  const contextOn = hookContextEnabled(appData);
  const file = path.join(appData, "com.claude-usage-tracker.app", "todos.json");

  let data = null;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Tracker never run / file missing → treat as an empty list. We still want
    // to surface that the tracker + CLI exist (the CLI creates the file on its
    // first write), so don't bail here — always tell the session it's available.
  }
  const todos = Array.isArray(data && data.todos) ? data.todos : [];
  const changes = Array.isArray(data && data.changes) ? data.changes : [];

  const project = path.basename(String(cwd).replace(/[\\/]+$/, ""));
  // General cross-project note (issue #13): tasks aren't limited to the current
  // project. The hook itself stays group-agnostic — Claude discovers associations
  // on demand via `cli.mjs todos related`.
  const crossProjectNote =
    `Cross-project: \`--project <name>\` on add files a task against another project ` +
    `("${project}" is saved as its "from"). \`<cli> todos related ${project}\` lists associated projects.`;
  // Kanban columns the tracker recognizes. Legacy `pending` (written before the
  // columns existed) is shown as `backlog`, matching the tracker's own load-time
  // migration, so Claude only ever sees a real column.
  const COLUMNS = ["backlog", "queue", "in_progress", "review", "done"];
  const col = (s) => (COLUMNS.includes(s) ? s : "backlog");
  // Show todos tied to this project, plus project-less (global) ones; only
  // those still open (anything but `done`).
  const active = todos.filter(
    (t) =>
      t &&
      col(t.status) !== "done" &&
      (!t.project || t.project === project),
  );

  const bindNote = bindSessionToTask(session, active);
  if (!contextOn) return;

  if (active.length) {
    // NEW SELECTION (startup-context bloat + relevance): surface only the tasks
    // worth acting on THIS session, in two layers —
    //   1. DUE (#36): tasks scheduled for today or earlier, surfaced FIRST (they're
    //      time-sensitive), whatever their column or block state.
    //   2. QUEUE ROOTS: tasks the user has lined up (status queue or in_progress)
    //      that are a CURRENT ROOT of the dependency graph — every task in their
    //      `depends_on` is done (no deps = trivially a root).
    // The QUEUE-ROOTS layer is gated by the "task priority in context" setting
    // (default medium); the DUE layer bypasses it — a passed deadline matters
    // regardless of priority. Blocked, backlog and non-due review tasks are held
    // back; the full board stays one `<cli> todos list` away. Titles only, capped —
    // descriptions bloated the context and pushed the CLI contract past the cutoff.
    const CAP = 10;
    const WORKABLE = new Set(["queue", "in_progress"]);
    // Resolve depends_on ids → tasks to test the root condition. A dep id that no
    // longer resolves (task deleted) can't block, so it counts as satisfied.
    const byId = new Map(todos.filter((t) => t && t.id).map((t) => [t.id, t]));
    const isRoot = (t) =>
      (Array.isArray(t.depends_on) ? t.depends_on : []).every((id) => {
        const dep = byId.get(id);
        return !dep || col(dep.status) === "done";
      });

    const today = localToday();
    const isDue = (t) =>
      !!t.scheduled_for && String(t.scheduled_for).slice(0, 10) <= today;
    // Priority threshold for the queue-roots layer (settings.json taskContextPriority
    // → min rank, default medium; `all` shows every priority). Due tasks bypass it.
    const minRank = taskContextMinRank(appData);
    const meets = (t) => prank(t) >= minRank;

    // Layer 1: everything due today/overdue — any column, any block state, ANY
    // priority (a passed deadline isn't gated by the threshold).
    const dueTasks = active.filter(isDue);
    // Layer 2 (priority-gated): queue tasks that are current roots + every
    // in_progress task (already being worked, so surface it even if a dep is open),
    // minus anything already in the due group.
    const queueRoots = active.filter(
      (t) =>
        !isDue(t) &&
        meets(t) &&
        WORKABLE.has(col(t.status)) &&
        (col(t.status) === "in_progress" || isRoot(t)),
    );

    if (!dueTasks.length && !queueRoots.length) {
      // Nothing clears the bar — say so (don't dump the backlog), and point at the
      // levers: queue, priority, the threshold setting, the full board.
      const note = [
        `The Claude Usage Tracker has ${active.length} open task(s) for project "${project}", but none clear the bar this session — none are due today, and no queued/unblocked task meets the "task priority in context" threshold.`,
        `Line up work, re-prioritize, or lower the threshold in the tracker's settings; via the CLI (${CLI_NOTE}):`,
        `· move a task into the queue: <cli> todos set status <id> queue`,
        `· raise a task's priority:    <cli> todos set priority <id> <high|medium|low|none>`,
        `· see the whole board:        <cli> todos list  (backlog | queue | in_progress | review | done)`,
        ...(bindNote ? [bindNote] : []),
        crossProjectNote,
        `File (don't edit): ${file}`,
      ].join("\n");
      process.stdout.write(note + "\n");
      return;
    }

    // Due group: most overdue (earliest date) first, then priority desc.
    dueTasks.sort(
      (a, b) =>
        String(a.scheduled_for).localeCompare(String(b.scheduled_for)) ||
        prank(b) - prank(a),
    );
    // Queue roots: highest priority first, then in_progress before queue (closer to
    // finishing), then soonest-scheduled as a tiebreaker.
    const statusOrder = { in_progress: 0, queue: 1 };
    queueRoots.sort(
      (a, b) =>
        prank(b) - prank(a) ||
        (statusOrder[col(a.status)] ?? 9) - (statusOrder[col(b.status)] ?? 9) ||
        String(a.scheduled_for || "9999-99-99").localeCompare(
          String(b.scheduled_for || "9999-99-99"),
        ),
    );

    // Due first, then the queue roots.
    const matched = [...dueTasks, ...queueRoots];
    const shown = matched.slice(0, CAP);
    const hidden = matched.length - shown.length;

    const lines = shown.map((t) => {
      const num = t.number ? `#${t.number} ` : "";
      const prio = t.priority ? ` ‹${t.priority}›` : "";
      let due = "";
      if (isDue(t)) {
        const date = String(t.scheduled_for).slice(0, 10);
        due = date < today ? ` ⏰ overdue (${date})` : ` ⏰ today`;
      }
      return `- ${num}[${col(t.status)}]${prio}${due} ${clip(t.subject)}  ⟨id:${t.id}⟩`;
    });
    if (hidden) {
      lines.push(
        `  …plus ${hidden} more due/queued task(s) — \`<cli> todos list\` shows all.`,
      );
    }

    // Change vision (t#252, renamed from `theme` at t#345): a task being WORKED
    // (in_progress) inherits its north star from the nearest change root up the
    // dep graph — surface that root's description here so the vision survives
    // the session boundary, the way the phases hook used to carry a plan's
    // vision into every session. Only for in_progress tasks (queued ones get it
    // at the status-move anchor), deduped when several subtasks share a root.
    const changeRoots = new Map();
    for (const t of shown) {
      if (col(t.status) !== "in_progress") continue;
      for (const r of changeRootsFor({ todos, changes }, t)) {
        if (r.description && r.description.trim() && !changeRoots.has(r.id)) {
          changeRoots.set(r.id, r);
        }
      }
    }
    for (const r of changeRoots.values()) {
      lines.push(
        block(
          `  ★ vision — change ${r.address ?? `t#${r.number}`} "${clip(r.subject)}" (north star for the in_progress task(s) above; keep them true to it — if one pulls away, stop and flag it):`,
          r.description,
        ),
      );
    }

    // Spec channel (t#340, docs/specs/README.md §7/§8): the addressed spec
    // section(s) for each shown in_progress task — its OWN `spec` field, or its
    // change root's when it has none (specAddressesFor). Printed NEXT TO the
    // vision above, never instead of it. Deduped ACROSS shown tasks (not just
    // within one task's own list) so several subtasks sharing a root's `spec`
    // don't repeat the same section.
    const specRoot = resolveRoot(cwd, appData);
    const specSeen = new Set();
    for (const t of shown) {
      if (col(t.status) !== "in_progress") continue;
      const specLink = specAddressesFor(t, changeRootsFor({ todos, changes }, t));
      const fresh = specLink.addresses.filter((a) => !specSeen.has(a));
      fresh.forEach((a) => specSeen.add(a));
      if (fresh.length) {
        lines.push(
          formatSpecSections(t, { source: specLink.source, addresses: fresh }, { root: specRoot, appData }),
        );
      }
    }

    const refExample = (shown[0] && shown[0].number) || 12;
    // Section order (the CLI contract must never be the part that gets truncated):
    // the how-to-edit contract goes FIRST, the task list SECOND, each under its own
    // banner so the two are unmistakably separate. Plain stdout on exit 0 is the
    // most robust way to inject SessionStart context (no additionalContext nesting).
    const context = [
      `──────── TASK TRACKER · how to edit the USER's todos (CLI) ────────`,
      `These are the USER's todos, not your working task list. The tracker owns todos.json — change it ONLY through the CLI (${CLI_NOTE}, written <cli> below), never by hand.`,
      `The survival kit is below; for anything it does not cover, \`<cli> todos --help\` is the authoritative command set.`,
      `  change a field  → <cli> todos set <field> <id> <value>   — one setter for all of: ${setFieldNames().join(" · ")}`,
      `                    (status takes ${STATUSES.join(" | ")}; \`<cli> todos set\` prints each field's values)`,
      `  add a follow-up → <cli> todos add "<subject>" [--project <name>]`,
      `  note a finding  → <cli> todos comment add <id> --text "<body>"`,
      `  link two tasks  → <cli> todos dep add <task> <depends-on>  (blocking, acyclic, one board)  ·  <cli> todos ref add <task> <target>  (non-blocking, cross-project ok)`,
      `  handoff         → what a task passes to whatever depends on it: inherited notes auto-print on → in_progress; leave yours with \`<cli> todos handoff set <id> --text "<body>"\`.`,
      `  see the board   → <cli> todos list  [--all | --status <col>[,<col>]]`,
      `Rules: <id> is a task's uuid, its number N, or #N — every command takes any of the three. Each command touches only its own field — leave the rest to the user. add/comment ONLY what the user asked to track, not your scratchpad; new tasks land in backlog. Reference a task in prose as t#${refExample} ("blocked by t#${refExample}") — a bare #N means a GitHub PR/issue, NOT a task link, and an inline t#N draws only a ref edge, never a blocking dep (use \`dep add\` for that).`,
      crossProjectNote,
      `File (don't edit): ${file}`,
      "",
      `──────── TASKS · project "${project}" · ⏰ due first, then queued & unblocked, up to ${CAP} ────────`,
      `⏰ = due today / overdue — surfaced first, whatever the column or priority. Below them (priority-gated by the tracker's "task priority in context" setting): queue tasks whose dependencies are all done — current roots of the graph — plus every in_progress task. Titles only; backlog, blocked queue tasks and non-due/below-threshold tasks are held back (\`<cli> todos list\` shows the whole board).`,
      lines.join("\n"),
      ...(bindNote ? [bindNote] : []),
    ].join("\n");

    process.stdout.write(context + "\n");
    return;
  }

  // No active tasks for THIS project (empty board, or all done, or tracker not
  // yet run). Still surface that the tracker and its CLI exist, so a session in a
  // project with no todos knows it can add/list them — otherwise it never learns
  // about the CLI or todos.json. The status/comment parts of the contract need
  // task ids, so they're omitted here.
  const note = [
    `The Claude Usage Tracker is available in this environment — its todo list is the USER's task tracker (the source of truth). No active tasks for project "${project}" right now.`,
    `Use the CLI (${CLI_NOTE}), don't hand-edit the JSON (the tracker may write it concurrently):`,
    `· add a task: <cli> todos add "<subject>" [--project <name>] [--description <text>] — lands in backlog; only what the user explicitly wants tracked.`,
    `· see tasks: <cli> todos list — statuses: backlog | queue | in_progress | review | done.`,
    crossProjectNote,
    `File (don't edit): ${file}`,
  ].join("\n");

  process.stdout.write(note + "\n");
}

// Render a possibly multi-line value as an indented block under a one-line label,
// KEEPING the author's line breaks (issue #58 #1/#4). The change vision is a
// carrier of cross-session intent; flattening a multi-section vision to one line
// would erase its structure. Single-line values stay inline. A generous char
// ceiling keeps a runaway value from flooding the session context.
function block(label, text, pad = "    ", cap = 2000) {
  let body = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "") // trailing space per line
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to one
    .trim();
  if (body.length > cap) body = body.slice(0, cap).trimEnd() + " …";
  if (!body.includes("\n")) return `${label} ${body}`;
  const indented = body
    .split("\n")
    .map((l) => (l ? pad + l : ""))
    .join("\n");
  return `${label}\n${indented}`;
}

// Entry for the unified dispatcher: `cli.mjs hook`. A todo hook must NEVER break
// a session, so any error is swallowed (exit 0, no output).
export function run() {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
