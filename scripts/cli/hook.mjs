// `cli.mjs hook` — Claude Code SessionStart hook for the Claude Usage Tracker.
//
// Two modes, by whether the current project is mid-PLAN (issue #16):
//   • PHASE MODE — the project has a plan with an unfinished phase: surface the
//     CURRENT phase + handoff baton + the discipline, and DON'T dump the task
//     board (the session is aimed at the phase; the full list would just bloat
//     context). A thin pointer keeps the plan's own task and `todos list` reachable.
//   • TODO MODE — no active phase: surface the ACTIVE todos for the project plus
//     the short contract for editing them. Two sub-modes:
//       – DUE MODE (#36): if anything is scheduled for today or earlier, show ONLY
//         those (today's focus, flagged ⏰, most overdue first) and hold the rest
//         of the board back.
//       – PRIORITY MODE (#32): with nothing due, fall back to the project's open
//         tasks gated by the "task priority in context" setting (settings.json,
//         default `medium`) — high-priority in full, the rest as one-liners.
// It is strictly read-only and MUST never disrupt a session: a missing/unreadable
// file, no matching todos, or any error is a silent no-op (exit 0, no output).
//
// Wired as a global SessionStart hook in ~/.claude/settings.json (the tracker's
// installer writes `node "<cli.mjs>" hook`) so it fires in every project; it
// filters todos by the current cwd's project basename (plus any project-less
// todos). See todos.rs / TodoWindow.vue for the schema.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPlansForHook, markPlanDoneForDoneTasks } from "./phases.mjs";

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

// The "task priority in context" setting (settings.json, written by the tracker's
// SettingsPanel) names the LOWEST priority a task must have to reach a session:
// all | low | medium | high → a min rank. Default is `medium`, so low/unset tasks
// stay out of context unless the user opts them in. Read-only and forgiving: a
// missing file, bad JSON, or unknown value falls back to the default.
function contextMinRank(appData) {
  const MIN = { all: 0, low: 1, medium: 2, high: 3 };
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      "utf8",
    );
    const v = JSON.parse(raw).taskContextPriority;
    if (typeof v === "string" && v in MIN) return MIN[v];
  } catch {
    // no settings file / bad JSON / missing key → default
  }
  return MIN.medium;
}

// The "session context" setting (settings.json, written by SettingsPanel) chooses
// what a session LEADS WITH when the project is mid-plan: "phase" (default) — the
// current phase, focused, board held back; or "tasks" — always the task board,
// even mid-plan. Read-only and forgiving: missing/bad/unknown falls back to "phase".
function sessionContextMode(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      "utf8",
    );
    const v = JSON.parse(raw).sessionContext;
    if (v === "tasks" || v === "phase") return v;
  } catch {
    // no settings file / bad JSON / missing key → default
  }
  return "phase";
}

// Master switch (settings.json `hookContextEnabled`, written by SettingsPanel):
// when false, the hook injects NOTHING into the session — no task board and no
// phase context. Default true (inject). Read-only and forgiving: a missing file,
// bad JSON, or absent key falls back to on.
function hookContextEnabled(appData) {
  try {
    const raw = readFileSync(
      path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      "utf8",
    );
    const v = JSON.parse(raw).hookContextEnabled;
    if (typeof v === "boolean") return v;
  } catch {
    // no settings file / bad JSON / missing key → default on
  }
  return true;
}

// Local calendar date as YYYY-MM-DD — "today" is the USER's day, not UTC (a
// scheduled_for date is a plain local date). Used to surface due/overdue tasks.
function localToday() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function main() {
  // SessionStart hooks receive a JSON payload on stdin (session_id, cwd,
  // source, …). Fall back to process.cwd() if it's absent or unparseable.
  let cwd = process.cwd();
  try {
    const raw = readFileSync(0, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.cwd === "string" && j.cwd) cwd = j.cwd;
  } catch {
    // no stdin / bad JSON → keep process.cwd()
  }

  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  // Master off-switch: the user turned off task/phase context injection entirely.
  if (!hookContextEnabled(appData)) return;
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

  // If this project is mid-PLAN, the session is aimed at the CURRENT phase, not
  // the task board — surface the phase (focused) and do NOT dump the task list.
  // Read-only and guarded: any failure falls through to plain todo mode.
  //
  // A plan whose linked tracker task is `done` is finished work, even if some
  // phase boxes were never ticked. We mark such plans done (markPlanDoneForDone-
  // Tasks below) so they read complete in `phases list` too, not just here — a
  // done task has no open plan to keep around. The task status (not the phase
  // files) is the trigger, so this catches a status flip made in the tracker UI
  // too — the CLI isn't the only path to done.
  const donePlanTasks = new Set(
    todos
      .filter((t) => t && t.number != null && col(t.status) === "done")
      .map((t) => t.number),
  );
  // Best-effort reconcile (guarded — a write failure must never break a session).
  // After it, a done-task plan has no open phase, so the `p.current` filter drops
  // it on its own. The extra task-status guard below is the fallback for when the
  // write couldn't land (e.g. a read-only checkout): hide it from the hook anyway.
  try {
    markPlanDoneForDoneTasks(cwd, (n) => donePlanTasks.has(n));
  } catch {
    // ignore — fall through to the read-only display filter
  }
  let phasePlans = [];
  try {
    phasePlans = readPlansForHook(cwd).filter(
      (p) => p.current && !(p.task != null && donePlanTasks.has(p.task)),
    );
  } catch {
    phasePlans = [];
  }
  // Phase mode is the default lead when the project is mid-plan, but the user can
  // force the task board instead via the "session context" setting.
  if (phasePlans.length && sessionContextMode(appData) === "phase") {
    process.stdout.write(
      phaseModeContext(project, todos, active, file, phasePlans) + "\n",
    );
    return;
  }

  if (active.length) {
    const minRank = contextMinRank(appData);
    const today = localToday();
    const isDue = (t) =>
      !!t.scheduled_for && String(t.scheduled_for).slice(0, 10) <= today;
    // Two modes for the todo context:
    //  • DUE MODE (issue #36): if anything is scheduled for today or earlier, the
    //    session focuses on THOSE — today's plan, not the whole board.
    //  • PRIORITY MODE (issue #32): with nothing due, fall back to the project's
    //    open tasks gated by the "task priority in context" threshold (default
    //    medium). This is the original behaviour.
    const dueMode = active.some(isDue);
    const shown = dueMode
      ? active.filter(isDue)
      : active.filter((t) => prank(t) >= minRank);
    const hidden = active.length - shown.length;

    if (!shown.length) {
      // Not in due mode (nothing scheduled) and nothing clears the priority
      // threshold: don't dump the rest, but say so rather than going silently empty.
      const note = [
        `The Claude Usage Tracker has ${active.length} open task(s) for project "${project}", but none are due today and all are below the "task priority in context" threshold — none are shown here.`,
        `See them or re-prioritize via the CLI (${CLI_NOTE}); lower the threshold in the tracker's settings to surface more:`,
        `· list this project's tasks: <cli> todos list (defaults to this project + global; add --all for every project)`,
        `· set a priority: <cli> todos set-priority <id> <high|medium|low|none>`,
        crossProjectNote,
        `File (don't edit): ${file}`,
      ].join("\n");
      process.stdout.write(note + "\n");
      return;
    }

    // Order: the due group first and, within it, the most overdue (earliest
    // date) first; then everything by priority desc, closest-to-finishing status,
    // and soonest scheduled.
    const order = { in_progress: 0, review: 1, queue: 2, backlog: 3 };
    const rank = (s) => order[col(s)] ?? 3;
    shown.sort(
      (a, b) =>
        (isDue(a) ? 0 : 1) - (isDue(b) ? 0 : 1) ||
        (isDue(a) && isDue(b)
          ? String(a.scheduled_for).localeCompare(String(b.scheduled_for))
          : 0) ||
        prank(b) - prank(a) ||
        rank(a.status) - rank(b.status) ||
        String(a.scheduled_for || "9999-99-99").localeCompare(
          String(b.scheduled_for || "9999-99-99"),
        ),
    );

    const lines = shown.map((t) => {
      const num = t.number ? `#${t.number} ` : "";
      const prio = t.priority ? ` ‹${t.priority}›` : "";
      const date = t.scheduled_for ? String(t.scheduled_for).slice(0, 10) : "";
      const due = isDue(t) ? (date < today ? ` ⏰ overdue (${date})` : ` ⏰ today`) : "";
      const head = `- ${num}[${col(t.status)}]${prio}${due} ${t.subject}`;
      // Due or high-priority tasks → LONG form (meta + first description line);
      // everything else that cleared the threshold stays a compact one-liner.
      if (isDue(t) || t.priority === "high") {
        const bits = [];
        if (t.estimate_minutes != null) bits.push(`~${t.estimate_minutes}min`);
        // The ⏰ marker already carries a due task's date; only show a future date.
        if (t.scheduled_for && !isDue(t)) bits.push(`by ${date}`);
        const meta = bits.length ? ` (${bits.join(", ")})` : "";
        const desc = t.description
          ? ` — ${String(t.description).split("\n")[0].slice(0, 140)}`
          : "";
        return `${head}${meta}${desc}  ⟨id:${t.id}⟩`;
      }
      return `${head}  ⟨id:${t.id}⟩`;
    });
    if (hidden) {
      lines.push(
        dueMode
          ? `  …plus ${hidden} other open task(s) not due today — held back to keep the focus on today; \`<cli> todos list\` shows all.`
          : `  …plus ${hidden} lower-priority task(s) below the "task priority in context" threshold — \`<cli> todos list\` shows all.`,
      );
    }

    const refExample = shown[0] && shown[0].number ? shown[0].number : 12;
    const headerLine = dueMode
      ? `User's tasks DUE TODAY / overdue (⏰) (Claude Usage Tracker, project "${project}") — today's focus, shown in full. The rest of the board is held back this session:`
      : `User's active tasks (Claude Usage Tracker, project "${project}"). High-priority shown in full, the rest as one-liners:`;
    // Plain stdout on exit 0 is the most robust way to inject SessionStart
    // context (no additionalContext-nesting ambiguity across CC versions).
    const context = [
      headerLine,
      lines.join("\n"),
      "",
      `These are the USER's todos, not your working task list. Mutate ONLY via the CLI (${CLI_NOTE}), never by hand-editing todos.json (the tracker may write it concurrently, and a malformed edit breaks the shared file):`,
      `· move a task: <cli> todos set-status <id> <status> — <id> is the ⟨id⟩ above; <status> ∈ backlog | queue | in_progress | review | done. Don't edit other fields of existing tasks — leave them to the user.`,
      `· set priority: <cli> todos set-priority <id> <high|medium|low|none> — priority decides which tasks reach this context (the threshold lives in the tracker's settings).`,
      `· new follow-up: <cli> todos add "<subject>" [--project <name> | --global] [--priority high|medium|low] [--scheduled YYYY-MM-DD] [--description <text>] — lands in backlog for THIS project by default (--project targets another board, --global is project-less). Only add what the user asked to track — their list, not your scratchpad.`,
      `· note a finding: <cli> todos comment add <id> --text "<body>" — shows in the task thread as you; only when the user wants it recorded. Reference another task as #N (e.g. "blocked by #${refExample}").`,
      `· see current tasks: <cli> todos list — this project (cwd) + global; --all spans every project; --status <col>[,<col>] filters by column (e.g. --status review,done) so the list isn't the whole board.`,
      crossProjectNote,
      `File (don't edit): ${file}`,
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
// KEEPING the author's line breaks (issue #58 #1/#4). Vision and handoff are the
// only carriers of cross-session intent; flattening a multi-section vision/handoff
// to one line (the old behaviour) erased its structure, and the 500-char cap on
// vision sliced off the current phase's own goal. Single-line values stay inline.
// A generous char ceiling keeps a runaway value from flooding the session context.
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

// PHASE MODE (issue #16): when the current project has a plan with an unfinished
// phase, the session is aimed at that phase — so we surface the phase INSTEAD of
// the task board (the full todo list is noise here, and bloats context). We still
// hand Claude exactly enough to drive the plan's own task: its id + the status/
// comment commands, plus a count of the other open tasks behind a `todos list`.
// `plans` are the project's plans with a current phase; `active` is the open todos.
function phaseModeContext(project, todos, active, file, plans) {
  const byNumber = new Map(
    todos.filter((t) => t && t.number != null).map((t) => [t.number, t]),
  );
  const linked = [];
  const lines = [];
  for (const p of plans) {
    const todo = p.task != null ? byNumber.get(p.task) : null;
    if (todo) linked.push(todo);
    const idPart = todo ? `, id:${todo.id}` : "";
    const link =
      p.task != null
        ? `task #${p.task}${todo ? ` "${todo.subject}"` : ""}${idPart}`
        : "(not linked to a task)";
    const next = p.nextSub
      ? ` — next: ${p.current.num}.${p.nextSub.num} ${p.nextSub.title}`
      : "";
    // An empty phase title shows as `phase 2/2 ""` — a missing orientation anchor
    // (issue #58 #6). Fall back to an actionable nudge instead of a bare "".
    const titleShown = p.current.title
      ? `"${p.current.title}"`
      : `(untitled — set one: <cli> phases edit ${p.current.num} --title "…")`;
    lines.push(
      `- plan "${p.slug}" (${link}): phase ${p.current.num}/${p.total} ${titleShown}${next}`,
    );
    if (p.vision) {
      lines.push(
        block(
          `  ★ vision (the plan's north star — keep this phase true to it; if it pulls away, stop and flag it):`,
          p.vision,
        ),
      );
    }
    if (p.handoff) lines.push(block(`  ↪ handoff from last session:`, p.handoff));
  }

  const linkedIds = new Set(linked.map((t) => t.id));
  const otherOpen = active.filter((t) => !linkedIds.has(t.id));

  const out = [
    `This project is mid-PLAN (skill: phases) — work the CURRENT phase only, one phase per session. The task board is NOT loaded here, to keep the session phase-focused. (${CLI_NOTE})`,
    lines.join("\n"),
    "Phase ops — `<cli> phases <cmd>`: done <N.k> (tick a subphase) · done <N> then verify then STOP (next phase = next session) · handoff \"<what's done; the concrete next step>\" · list.",
  ];
  if (linked.length) {
    const ids = linked.map((t) => `#${t.number} (id:${t.id})`).join(", ");
    out.push(
      `The plan's own tracker task ${ids} — \`<cli> todos <cmd>\`: set-status <id> <status> (backlog|queue|in_progress|review|done) · comment add <id> --text "<body>". Don't hand-edit todos.json.`,
    );
  }
  out.push(
    `Other open tasks for "${project}": ${otherOpen.length} (\`<cli> todos list\`).`,
  );
  out.push(`File (don't edit): ${file}`);
  return out.join("\n");
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
