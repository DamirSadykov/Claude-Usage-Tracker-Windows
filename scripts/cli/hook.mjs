// `cli.mjs hook` — Claude Code SessionStart hook for the Claude Usage Tracker.
//
// The tracker owns `todos.json` (the user's task list); this hook surfaces the
// ACTIVE todos for the current project into the session context, plus a short
// contract telling Claude how it may edit them. It is strictly read-only and
// MUST never disrupt a session: a missing/unreadable file, no matching todos,
// or any error is a silent no-op (exit 0, no output).
//
// Wired as a global SessionStart hook in ~/.claude/settings.json (the tracker's
// installer writes `node "<cli.mjs>" hook`) so it fires in every project; it
// filters todos by the current cwd's project basename (plus any project-less
// todos). See todos.rs / TodoWindow.vue for the schema.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The unified CLI is this module's grandparent-relative entry (scripts/cli.mjs);
// resolve its absolute path so the contract below can hand Claude exact,
// copy-pasteable commands (`cli.mjs todos <cmd> …`).
const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "cli.mjs",
);

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
    `Tasks aren't limited to this project — to file one against a DIFFERENT project ` +
    `(e.g. a related one you also work on), pass --project <name> to the add command; ` +
    `the originating project ("${project}") is recorded automatically as the task's "from". ` +
    `Run \`node "${CLI}" todos related ${project}\` to list projects associated with "${project}".`;
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
  if (active.length) {
    // Surface what the user is closest to finishing first: in_progress, then
    // review, then queued, then backlog.
    const order = { in_progress: 0, review: 1, queue: 2, backlog: 3 };
    const rank = (s) => order[col(s)] ?? 3;
    active.sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        String(a.scheduled_for || "9999-99-99").localeCompare(
          String(b.scheduled_for || "9999-99-99"),
        ),
    );

    const lines = active.map((t) => {
      const bits = [];
      if (t.estimate_minutes != null) bits.push(`~${t.estimate_minutes}min`);
      if (t.scheduled_for) bits.push(`by ${t.scheduled_for}`);
      const meta = bits.length ? ` (${bits.join(", ")})` : "";
      const desc = t.description
        ? ` — ${String(t.description).split("\n")[0].slice(0, 140)}`
        : "";
      const num = t.number ? `#${t.number} ` : "";
      return `- ${num}[${col(t.status)}] ${t.subject}${meta}${desc}  ⟨id:${t.id}⟩`;
    });

    // Plain stdout on exit 0 is the most robust way to inject SessionStart
    // context (no additionalContext-nesting ambiguity across CC versions).
    const context = [
      `User's active tasks from the Claude Usage Tracker (project "${project}"; the tracker is the source of truth):`,
      lines.join("\n"),
      "",
      `These are the USER's todos, not your working task list.`,
      `When the user says a task moved (e.g. done / in progress / in review), change its status with the tracker's CLI — do NOT hand-edit todos.json (the tracker may write it concurrently, and a malformed edit breaks the shared file):`,
      `    node "${CLI}" todos set-status <id> <status>`,
      `where <status> is one kanban column: backlog | queue | in_progress | review | done, and <id> is the ⟨id⟩ shown above. The CLI validates the status and writes atomically. Run \`node "${CLI}" todos list\` to see current tasks. Editing other fields (subject / description / plan / estimate_minutes / scheduled_for / project) on an EXISTING task is not supported by the CLI and should be left to the user.`,
      `To record a NEW follow-up the user asked you to track, create it via the CLI (don't hand-edit): node "${CLI}" todos add "<subject>" [--project <name>] [--description <text>] — it lands in the backlog column. Only add tasks the user explicitly wants tracked; this is their list, not your scratchpad.`,
      `To leave a note on a task the user asked you to record (a finding, progress, a decision), post a comment — it shows in the task's thread attributed to you: node "${CLI}" todos comment add <id> --text "<body>". Comment only when the user wants it recorded on the task. In a comment or description you can reference another task by its number (e.g. "blocked by #${active[0] && active[0].number ? active[0].number : 12}") — the tracker renders it as a clickable link.`,
      crossProjectNote,
      `Source of truth file (read-only for you): ${file}`,
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
    `To record a NEW task the user asks you to track, or to see existing ones, use its CLI — don't hand-edit the JSON (the tracker may write it concurrently):`,
    `    node "${CLI}" todos add "<subject>" [--project <name>] [--description <text>]`,
    `    node "${CLI}" todos list`,
    `Statuses are kanban columns: backlog | queue | in_progress | review | done. Only add tasks the user explicitly wants tracked; this is their list, not your scratchpad.`,
    crossProjectNote,
    `Source of truth file (read-only for you): ${file}`,
  ].join("\n");

  process.stdout.write(note + "\n");
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
