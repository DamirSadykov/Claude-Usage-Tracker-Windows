// `cli.mjs todos` — mutate the tracker's todo list WITHOUT hand-editing
// todos.json. Lazily loaded by ../cli.mjs; also reachable via the back-compat
// `cc-todos.mjs` shim. The SessionStart hook tells Claude to call this instead
// of rewriting the file directly.
//
// Why a CLI: hand-edited JSON is fragile — Claude can break formatting, set an
// invalid status, clobber a field, or race the tracker's own atomic write. This
// funnels every change through one validated, atomic path (temp file + rename),
// mirroring src-tauri/src/todos.rs. The status set MUST stay in sync with
// `todos.rs::STATUSES` and the kanban columns in TodoWindow.vue.
//
// Commands (run as `cli.mjs todos <cmd>`):
//   add "<subject>" [--project <name> | --global] [--status <status>] [--priority <level>]
//                   [--description <text>] [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>]
//                   no --project defaults to the current project (cwd basename); --global = project-less
//   set-status <id> <status>        status ∈ backlog|queue|in_progress|review|done
//   set-priority <id> <level>       level ∈ high|medium|low|none
//   set-project <id> <name>         tie to a project; <--global|none|clear> to clear
//   comment add <id> --text "<body>" [--by claude|user]
//   comment list <id> [--json]
//   list [--project <name> | --all] [--status <col>[,<col>]] [--priority <level>] [--json]
//        defaults to THIS project (cwd basename) + project-less tasks; --all spans every project.
//        --status filters by kanban column (backlog|queue|in_progress|review|done), comma-separated to combine
//   dep add|rm|list <task> [<depends-on>]  task-graph deps (#88): blocking edges, within one board, acyclic
//   ref add|rm|list <task> [<target>]      task-graph refs (#88): non-blocking links, cross-project ok
//        <task>/<target> accept an id, a bare number, or #N
//
// Exit code is non-zero on any error (bad status, unknown id, usage), so a
// caller can tell success from failure.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Kanban columns, in board order. Keep in lockstep with todos.rs::STATUSES.
const STATUSES = ["backlog", "queue", "in_progress", "review", "done"];

// Normalize a possibly-legacy status to a real column. Pre-column tasks stored
// `pending`; the tracker migrates them to `backlog` on load and the SessionStart
// hook does the same — mirror it so `--status` matches what the board shows.
const col = (s) => (STATUSES.includes(s) ? s : "backlog");

// Priority buckets, most to least important; "" = unset. Keep in lockstep with
// todos.rs::PRIORITIES and TodoWindow.vue. The SessionStart hook ranks by this
// order and a settings threshold picks the minimum level that enters context.
const PRIORITIES = ["high", "medium", "low"];

// Normalize a --priority / set-priority value to a real bucket or "" (unset).
// "none"/"clear"/"" explicitly clear it. Returns undefined for anything invalid,
// so the caller can fail with a helpful message instead of writing garbage.
function normalizePriority(v) {
  if (v == null || v === true) return undefined;
  const s = String(v).toLowerCase().trim();
  if (s === "none" || s === "clear" || s === "") return "";
  return PRIORITIES.includes(s) ? s : undefined;
}

// Same location the tracker and the hook use: the app data dir on Windows.
function todosPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", "todos.json");
}

// A missing/corrupt file yields an empty store rather than throwing — same
// forgiving contract as todos.rs::load.
function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.todos)) return { version: 1, todos: [] };
    if (typeof data.version !== "number") data.version = 1;
    return data;
  } catch {
    return { version: 1, todos: [] };
  }
}

// Association groups live next to todos.json (project-groups.json), written by
// the app. Sibling of `todosPath`. See src-tauri/src/project_groups.rs.
function groupsPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", "project-groups.json");
}

// Forgiving load: missing/corrupt yields an empty set (mirrors project_groups.rs).
function loadGroups() {
  try {
    const data = JSON.parse(readFileSync(groupsPath(), "utf8"));
    return Array.isArray(data?.groups) ? data.groups : [];
  } catch {
    return [];
  }
}

// Projects that work WITH `project` (issue #13): the union of co-members across
// every association group that contains it, minus the project itself.
function relatedProjects(project) {
  const set = new Set();
  for (const g of loadGroups()) {
    const members = Array.isArray(g.projects) ? g.projects : [];
    if (!members.includes(project)) continue;
    for (const p of members) if (p !== project) set.add(p);
  }
  return [...set].sort();
}

// Atomic write: serialize to a sibling temp file, then rename over the target
// (rename replaces the destination on Windows). 2-space pretty-print matches the
// tracker's serde output so hand-readable diffs stay stable.
function save(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function cmdSetStatus(id, status) {
  if (!id || !status) fail("usage: cli todos set-status <id> <status>");
  if (!STATUSES.includes(status))
    fail(`invalid status "${status}". valid: ${STATUSES.join(" | ")}`);
  const file = todosPath();
  const data = load(file);
  const todo = data.todos.find((t) => t && t.id === id);
  if (!todo) fail(`no todo with id ${id}`);
  if (todo.status === status) {
    process.stdout.write(`ok: ${id} already ${status}\n`);
    return;
  }
  todo.status = status;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: ${id} -> ${status}\n`);
}

// Set (or clear) a todo's priority bucket. `level` is high|medium|low, or
// none|clear|"" to unset. Mirrors cmdSetStatus: validate, locate by id, write
// atomically. Clearing removes the field so the file stays clean (matches the
// Rust skip_serializing_if and how the app omits an unset priority).
function cmdSetPriority(id, level) {
  if (!id || level == null)
    fail(`usage: cli todos set-priority <id> <${PRIORITIES.join("|")}|none>`);
  const priority = normalizePriority(level);
  if (priority === undefined)
    fail(`invalid priority "${level}". valid: ${PRIORITIES.join(" | ")} | none`);
  const file = todosPath();
  const data = load(file);
  const todo = data.todos.find((t) => t && t.id === id);
  if (!todo) fail(`no todo with id ${id}`);
  if ((todo.priority || "") === priority) {
    process.stdout.write(`ok: ${id} already ${priority || "unset"}\n`);
    return;
  }
  if (priority) todo.priority = priority;
  else delete todo.priority;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: ${id} priority -> ${priority || "unset"}\n`);
}

// Set (or clear) a todo's project (issue #54: a task filed with the wrong/empty
// project couldn't be fixed from the CLI before — only in the app). <name> ties
// it to that board; `--global`/`none`/`clear` makes it project-less. Clearing
// removes the field so the file stays clean (matches the Rust skip_serializing_if).
function cmdSetProject(id, value) {
  if (!id || value == null)
    fail("usage: cli todos set-project <id> <project | --global>");
  const v = String(value).trim();
  const clear = v === "" || v === "--global" || /^(none|clear|global)$/i.test(v);
  const next = clear ? null : v;
  const file = todosPath();
  const data = load(file);
  const todo = data.todos.find((t) => t && t.id === id);
  if (!todo) fail(`no todo with id ${id}`);
  if ((todo.project ?? null) === next) {
    process.stdout.write(`ok: ${id} already ${next ? `project "${next}"` : "global"}\n`);
    return;
  }
  if (next) todo.project = next;
  else delete todo.project;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: ${id} project -> ${next ? `"${next}"` : "global (project-less)"}\n`,
  );
}

// Minimal `--flag value` parser: collects positional args and flag pairs.
// A flag with no following value (or followed by another --flag) becomes `true`.
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = true;
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const ADD_USAGE =
  'usage: cli todos add "<subject>" [--project <name> | --global] [--from <project>] [--status <status>] ' +
  "[--priority high|medium|low] [--description <text>] [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>] [--by user|claude]\n" +
  "       (no --project → the current project; --global files a project-less task)";

// Create a new todo. Mirrors the field set the tracker writes (todos.rs / the
// TodoWindow form): id is a fresh UUID, created_at/updated_at stamped now,
// status defaults to backlog. Appends and writes atomically.
function cmdAdd(args) {
  const { positional, flags } = parseArgs(args);
  const subject = String(positional[0] ?? flags.subject ?? "").trim();
  if (!subject) fail(ADD_USAGE);
  const status = String(flags.status ?? "backlog");
  if (!STATUSES.includes(status))
    fail(`invalid status "${status}". valid: ${STATUSES.join(" | ")}`);
  let estimate = null;
  if (flags.estimate != null && flags.estimate !== true) {
    const n = Number(flags.estimate);
    if (Number.isFinite(n)) estimate = Math.max(0, Math.round(n));
  }
  let priority = "";
  if (flags.priority != null && flags.priority !== true) {
    const p = normalizePriority(flags.priority);
    if (p === undefined)
      fail(`invalid --priority "${flags.priority}". valid: ${PRIORITIES.join(" | ")} | none`);
    priority = p;
  }
  const now = new Date().toISOString();
  const file = todosPath();
  const data = load(file);
  const cwdProject = path.basename(process.cwd().replace(/[\\/]+$/, ""));
  // Project resolution (issue #54): a bare `add` defaults to the CURRENT project
  // (cwd basename), mirroring `todos list` and the SessionStart hook — a follow-up
  // filed from a session belongs to that session's project, not the global board.
  // (A project-less task surfaces in EVERY project's context, which was the leak:
  // adds without --project used to land global.) `--project <name>` targets another
  // board; `--global` (or `--project ""`) files an explicitly project-less task.
  let target;
  if (flags.global) {
    target = null;
  } else if (typeof flags.project === "string") {
    const p = flags.project.trim();
    target = p ? p : null;
  } else {
    target = cwdProject;
  }
  // Provenance (issue #13): the project this task was filed FROM. Auto-set to the
  // current project only when the task targets a DIFFERENT one (cross-project);
  // same-project and global adds leave it empty. --from overrides the auto value.
  let from =
    typeof flags.from === "string" && flags.from.trim() ? flags.from.trim() : null;
  if (from === null && target && target !== cwdProject) from = cwdProject;
  const todo = {
    id: randomUUID(),
    // Stable human-facing number for inline `#N` references, mirroring
    // todos.rs::ensure_numbers (next after the current max). The app backfills
    // any unnumbered rows on load, so a 0 here would still be fixed up later.
    number: nextNumber(data),
    subject,
    description: typeof flags.description === "string" ? flags.description : "",
    status,
    // Omit the field entirely when unset, mirroring todos.rs (skip_serializing_if).
    ...(priority ? { priority } : {}),
    estimate_minutes: estimate,
    scheduled_for: typeof flags.scheduled === "string" ? flags.scheduled : null,
    plan: typeof flags.plan === "string" ? flags.plan : "",
    // Omit project/from when absent (global / same-project), mirroring the Rust
    // skip_serializing_if and `set-project`'s clear path — a global add no longer
    // writes a redundant `"project": null` (issue #54 review B1).
    ...(target ? { project: target } : {}),
    ...(from ? { from } : {}),
    // This CLI is Claude's interface (the hook tells Claude to use it), so a
    // task added here is AI-composed unless the caller overrides with --by user.
    created_by: typeof flags.by === "string" ? flags.by : "claude",
    created_at: now,
    updated_at: now,
  };
  data.todos.push(todo);
  save(file, data);
  process.stdout.write(
    `ok: added #${todo.number} ${todo.id} [${status}] (${target ? `project ${target}` : "global"}) ${subject}\n`,
  );
}

// Next task number = one past the current max (mirrors todos.rs::max_number+1).
function nextNumber(data) {
  let max = 0;
  for (const t of data.todos) {
    if (t && typeof t.number === "number" && t.number > max) max = t.number;
  }
  return max + 1;
}

const COMMENT_USAGE =
  'usage: cli todos comment add <id> --text "<body>" [--by claude|user]\n' +
  "       cli todos comment list <id> [--json]";

// Append or list comments on a todo. Mirrors the Comment shape in todos.rs /
// TodoWindow.vue: { id, author, body, created_at }. The thread is shared with
// the tracker UI (the user posts there as "user"); this CLI is Claude's path, so
// a comment added here defaults to author "claude" unless --by overrides it.
function cmdComment(args) {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const { positional, flags } = parseArgs(rest);
    const id = String(positional[0] ?? "").trim();
    const body = typeof flags.text === "string" ? flags.text : "";
    if (!id || !body.trim()) fail(COMMENT_USAGE);
    const author = flags.by === "user" ? "user" : "claude";
    const file = todosPath();
    const data = load(file);
    const todo = data.todos.find((t) => t && t.id === id);
    if (!todo) fail(`no todo with id ${id}`);
    if (!Array.isArray(todo.comments)) todo.comments = [];
    const now = new Date().toISOString();
    const comment = { id: randomUUID(), author, body, created_at: now };
    todo.comments.push(comment);
    todo.updated_at = now;
    save(file, data);
    process.stdout.write(`ok: comment ${comment.id} on ${id} by ${author}\n`);
    return;
  }
  if (sub === "list") {
    const id = String(rest.find((a) => !a.startsWith("--")) ?? "").trim();
    if (!id) fail(COMMENT_USAGE);
    const file = todosPath();
    const todo = load(file).todos.find((t) => t && t.id === id);
    if (!todo) fail(`no todo with id ${id}`);
    const comments = Array.isArray(todo.comments) ? todo.comments : [];
    if (rest.includes("--json")) {
      process.stdout.write(JSON.stringify(comments, null, 2) + "\n");
      return;
    }
    if (!comments.length) {
      process.stdout.write("(no comments)\n");
      return;
    }
    for (const c of comments) {
      process.stdout.write(`[${c.author}] ${c.body}  ⟨${c.created_at}⟩\n`);
    }
    return;
  }
  fail(COMMENT_USAGE);
}

function cmdList(args) {
  const file = todosPath();
  let todos = load(file).todos.filter(Boolean);
  const pi = args.indexOf("--project");
  const hasProject = pi !== -1 && args[pi + 1] && !args[pi + 1].startsWith("--");
  if (hasProject) {
    const p = args[pi + 1];
    todos = todos.filter((t) => (t.project || "") === p);
  } else if (!args.includes("--all")) {
    // Default scope: THIS session's project (the cwd basename) plus project-less
    // (global) tasks — mirroring the SessionStart hook's filter (hook.mjs), so a
    // bare `todos list` shows the current board instead of every project's tasks.
    // `--all` opts back into the full cross-project list; `--project <name>`
    // targets another board. cwd is the project dir (the CLI runs there), same as
    // cmdAdd derives `cwdProject`.
    const cwdProject = path.basename(process.cwd().replace(/[\\/]+$/, ""));
    todos = todos.filter((t) => !t.project || t.project === cwdProject);
  }
  // --status <col>[,<col>]: keep only the named kanban columns (a bare `list`
  // shows the whole board, done included, which floods context). Comma-separate
  // to combine (e.g. `--status review,done`); legacy statuses fold to backlog.
  const si = args.indexOf("--status");
  if (si !== -1) {
    const val = args[si + 1];
    if (!val || val.startsWith("--"))
      fail(`--status needs a value: ${STATUSES.join(" | ")} (comma-separate to combine, e.g. review,done)`);
    const wanted = val.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((s) => !STATUSES.includes(s));
    if (bad.length)
      fail(`invalid --status "${bad.join(",")}". valid: ${STATUSES.join(" | ")}`);
    const want = new Set(wanted);
    todos = todos.filter((t) => want.has(col(t.status)));
  }
  const pri = args.indexOf("--priority");
  if (pri !== -1 && args[pri + 1]) {
    const want = normalizePriority(args[pri + 1]);
    if (want === undefined)
      fail(`invalid --priority "${args[pri + 1]}". valid: ${PRIORITIES.join(" | ")} | none`);
    todos = todos.filter((t) => (t.priority || "") === want);
  }
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(todos, null, 2) + "\n");
    return;
  }
  if (!todos.length) {
    process.stdout.write("(no todos)\n");
    return;
  }
  for (const t of todos) {
    const num = t.number ? `#${t.number} ` : "";
    const prio = t.priority ? ` ‹${t.priority}›` : "";
    process.stdout.write(`${num}[${t.status}]${prio} ${t.subject}  ⟨id:${t.id}⟩\n`);
  }
}

// Resolve a task locator to its todo object. Accepts an id, a bare number, or a
// `#N` reference — the graph/dep CLI is friendlier with the human-facing #N the
// board shows. Returns undefined if nothing matches.
function resolveTask(data, token) {
  const t = String(token ?? "").trim();
  if (!t) return undefined;
  const byId = data.todos.find((x) => x && x.id === t);
  if (byId) return byId;
  const num = t.startsWith("#") ? t.slice(1) : t;
  if (/^\d+$/.test(num)) {
    const n = parseInt(num, 10);
    return data.todos.find((x) => x && x.number === n);
  }
  return undefined;
}

// The board a task belongs to, normalized (global = ""). Mirrors todos.rs::board_of.
const boardOf = (t) => t.project || "";

// True if `start` reaches `target` by following depends_on — a cycle guard.
// Mirrors todos.rs::dep_reaches (plain DFS over the small within-board graph).
function depReaches(data, start, target) {
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = data.todos.find((x) => x && x.id === id);
    if (t && Array.isArray(t.depends_on)) stack.push(...t.depends_on);
  }
  return false;
}

// Task numbers referenced inline via `t#N` in a task's description/plan (mirrors
// GraphView.inlineRefs). `t#N`, NOT a bare `#N` (#63): in prose `#104` almost
// always means a GitHub PR/issue, so a bare `#N` no longer links — only the
// explicit `t#N` form does. These edges live in the task TEXT, not the `links`
// array — surfaced by `ref list` but only unlinkable by editing the text, never
// by `ref rm`. The `t` must not be a word tail; self-mentions are dropped.
function inlineRefNumbers(t) {
  const text = `${t.description || ""}\n${t.plan || ""}`;
  const out = new Set();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[tT]#(\d+)/g)) {
    const n = parseInt(m[1], 10);
    if (n !== t.number) out.add(n);
  }
  return [...out];
}

const DEP_USAGE =
  "usage: cli todos dep add <task> <depends-on>   (task depends on depends-on)\n" +
  "       cli todos dep rm  <task> <depends-on>\n" +
  "       cli todos dep list <task> [--json]\n" +
  "       <task> is an id, a number, or #N";

// Manage task-graph dependency edges (#88), mirroring todos.rs::add_dep/remove_dep:
// `dep add A B` makes A depend on B (B blocks A). Edges stay acyclic and within
// one project board. `dep list` shows both directions (depends-on + blocks).
function cmdDep(args) {
  const [sub, ...rest] = args;
  const file = todosPath();
  const data = load(file);
  if (sub === "add" || sub === "rm") {
    const from = resolveTask(data, rest[0]);
    const on = resolveTask(data, rest[1]);
    if (!from || !on) fail(DEP_USAGE);
    if (sub === "add") {
      if (from.id === on.id) fail("a task can't depend on itself");
      if (boardOf(from) !== boardOf(on))
        fail("dependencies must stay within one project board");
      if (depReaches(data, on.id, from.id))
        fail("that dependency would create a cycle");
      if (!Array.isArray(from.depends_on)) from.depends_on = [];
      if (from.depends_on.includes(on.id)) {
        process.stdout.write(`ok: #${from.number} already depends on #${on.number}\n`);
        return;
      }
      from.depends_on.push(on.id);
      from.updated_at = new Date().toISOString();
      save(file, data);
      process.stdout.write(`ok: #${from.number} now depends on #${on.number}\n`);
      return;
    }
    // rm
    const before = Array.isArray(from.depends_on) ? from.depends_on.length : 0;
    if (before) from.depends_on = from.depends_on.filter((d) => d !== on.id);
    if ((from.depends_on?.length ?? 0) !== before) {
      if (!from.depends_on.length) delete from.depends_on;
      from.updated_at = new Date().toISOString();
      save(file, data);
      process.stdout.write(`ok: #${from.number} no longer depends on #${on.number}\n`);
    } else {
      process.stdout.write(`ok: #${from.number} did not depend on #${on.number}\n`);
    }
    return;
  }
  if (sub === "list") {
    const t = resolveTask(data, rest.find((a) => !a.startsWith("--")));
    if (!t) fail(DEP_USAGE);
    const deps = (Array.isArray(t.depends_on) ? t.depends_on : [])
      .map((id) => data.todos.find((x) => x && x.id === id))
      .filter(Boolean);
    const blocks = data.todos.filter(
      (x) => x && Array.isArray(x.depends_on) && x.depends_on.includes(t.id),
    );
    if (rest.includes("--json")) {
      process.stdout.write(
        JSON.stringify(
          {
            task: { id: t.id, number: t.number, subject: t.subject },
            depends_on: deps.map((d) => ({ id: d.id, number: d.number, subject: d.subject })),
            blocks: blocks.map((b) => ({ id: b.id, number: b.number, subject: b.subject })),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(`#${t.number} ${t.subject}\n`);
    process.stdout.write(
      `  depends on: ${deps.length ? deps.map((d) => "#" + d.number).join(", ") : "(none)"}\n`,
    );
    process.stdout.write(
      `  blocks:     ${blocks.length ? blocks.map((b) => "#" + b.number).join(", ") : "(none)"}\n`,
    );
    return;
  }
  fail(DEP_USAGE);
}

const REF_USAGE =
  "usage: cli todos ref add <task> <target>    (task references target; non-blocking)\n" +
  "       cli todos ref rm  <task> <target>\n" +
  "       cli todos ref list <task> [--json]\n" +
  "       <task>/<target> is an id, a number, or #N. Cross-project refs are allowed.";

// Manage ref-graph links (#88): the non-blocking references drawn on the Ref tab,
// stored in `x.links` (todos.rs). This is the LLM's write path — the UI Ref tab
// is read-only. Validation deliberately DIFFERS from `dep`: a ref may cross
// project boards (that's exactly what renders an external node) and can never form
// a blocking cycle, so the only guards are self-link and target-exists. Inline
// `#N` mentions in the task text are ALSO ref edges but live in the text; this
// command manages the explicit `links` array, which the graph shows alongside them.
function cmdRef(args) {
  const [sub, ...rest] = args;
  const file = todosPath();
  const data = load(file);
  if (sub === "add" || sub === "rm") {
    const from = resolveTask(data, rest[0]);
    const to = resolveTask(data, rest[1]);
    if (!from || !to) fail(REF_USAGE);
    if (sub === "add") {
      if (from.id === to.id) fail("a task can't reference itself");
      if (!Array.isArray(from.links)) from.links = [];
      if (from.links.includes(to.id)) {
        process.stdout.write(`ok: #${from.number} already references #${to.number}\n`);
        return;
      }
      from.links.push(to.id);
      from.updated_at = new Date().toISOString();
      save(file, data);
      const cross = boardOf(from) !== boardOf(to) ? " (cross-project)" : "";
      const dup = inlineRefNumbers(from).includes(to.number)
        ? ` (note: the text already mentions t#${to.number} inline — the edge existed already)`
        : "";
      process.stdout.write(`ok: #${from.number} now references #${to.number}${cross}${dup}\n`);
      return;
    }
    // rm removes only the EXPLICIT link. An inline `t#N` in the text keeps drawing
    // the edge — say so, so the caller knows why it may still appear on the graph.
    const before = Array.isArray(from.links) ? from.links.length : 0;
    if (before) from.links = from.links.filter((l) => l !== to.id);
    if ((from.links?.length ?? 0) !== before) {
      if (!from.links.length) delete from.links;
      from.updated_at = new Date().toISOString();
      save(file, data);
      const inline = inlineRefNumbers(from).includes(to.number)
        ? ` (still mentions t#${to.number} inline — edit the text to drop that edge)`
        : "";
      process.stdout.write(`ok: #${from.number} no longer references #${to.number}${inline}\n`);
    } else {
      const inline = inlineRefNumbers(from).includes(to.number)
        ? ` (it mentions t#${to.number} inline; edit the text to drop that edge)`
        : "";
      process.stdout.write(`ok: #${from.number} had no explicit link to #${to.number}${inline}\n`);
    }
    return;
  }
  if (sub === "list") {
    const t = resolveTask(data, rest.find((a) => !a.startsWith("--")));
    if (!t) fail(REF_USAGE);
    // Outgoing = explicit links (source "link") + inline t#N mentions (source
    // "inline"); a target reachable both ways is reported once as "link+inline".
    const outMap = new Map();
    for (const id of Array.isArray(t.links) ? t.links : []) {
      const x = data.todos.find((y) => y && y.id === id);
      if (x) outMap.set(x.id, { task: x, via: new Set(["link"]) });
    }
    for (const n of inlineRefNumbers(t)) {
      const x = data.todos.find((y) => y && y.number === n);
      if (!x) continue;
      const e = outMap.get(x.id);
      if (e) e.via.add("inline");
      else outMap.set(x.id, { task: x, via: new Set(["inline"]) });
    }
    // Incoming = tasks that reference THIS one via a link or an inline mention.
    const incoming = data.todos.filter((x) => {
      if (!x || x.id === t.id) return false;
      const viaLink = Array.isArray(x.links) && x.links.includes(t.id);
      const viaInline = t.number != null && inlineRefNumbers(x).includes(t.number);
      return viaLink || viaInline;
    });
    const fmtVia = (via) => [...via].sort().reverse().join("+"); // link+inline
    const out = [...outMap.values()];
    if (rest.includes("--json")) {
      process.stdout.write(
        JSON.stringify(
          {
            task: { id: t.id, number: t.number, subject: t.subject },
            references: out.map((e) => ({
              id: e.task.id,
              number: e.task.number,
              subject: e.task.subject,
              via: [...e.via].sort(),
              cross_project: boardOf(e.task) !== boardOf(t),
            })),
            referenced_by: incoming.map((x) => ({
              id: x.id,
              number: x.number,
              subject: x.subject,
              cross_project: boardOf(x) !== boardOf(t),
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(`#${t.number} ${t.subject}\n`);
    process.stdout.write(
      `  references:    ${out.length ? out.map((e) => `#${e.task.number}⟨${fmtVia(e.via)}⟩`).join(", ") : "(none)"}\n`,
    );
    process.stdout.write(
      `  referenced by: ${incoming.length ? incoming.map((x) => "#" + x.number).join(", ") : "(none)"}\n`,
    );
    return;
  }
  fail(REF_USAGE);
}

// List the projects related to <project> via association groups, so a session in
// one project can file a task against a sibling project (e.g. engine ↔ advmcp).
// Plain text prints one related project per line (empty → a friendly note);
// `--json` emits { project, related } for programmatic use.
function cmdRelated(args) {
  const { positional, flags } = parseArgs(args);
  const project = String(positional[0] ?? flags.project ?? "").trim();
  if (!project) fail("usage: cli todos related <project> [--json]");
  const related = relatedProjects(project);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ project, related }, null, 2) + "\n");
    return;
  }
  if (!related.length) {
    process.stdout.write(`(no projects associated with "${project}")\n`);
    return;
  }
  for (const p of related) process.stdout.write(p + "\n");
}

// List every association group and its members.
function cmdGroups(args) {
  const groups = loadGroups();
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(groups, null, 2) + "\n");
    return;
  }
  if (!groups.length) {
    process.stdout.write("(no project groups)\n");
    return;
  }
  for (const g of groups) {
    const members = Array.isArray(g.projects) ? g.projects.join(", ") : "";
    process.stdout.write(`${g.name}: ${members}\n`);
  }
}

function usage(code) {
  process.stdout.write(
    "cli todos - Claude Usage Tracker todo CLI\n\n" +
      '  add "<subject>" [--project <name> | --global] [--from <project>] [--status <status>]\n' +
      "                  [--description <text>] [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>]\n" +
      "                  no --project → the current project (cwd); --global = project-less\n" +
      "  set-status <id> <status>        status ∈ " +
      STATUSES.join(" | ") +
      "\n" +
      "  set-priority <id> <level>       level ∈ " +
      PRIORITIES.join(" | ") +
      " | none\n" +
      "  set-project <id> <name>         tie to a project; <--global|none> to clear\n" +
      '  comment add <id> --text "<body>" [--by claude|user]\n' +
      "  comment list <id> [--json]\n" +
      "  list [--project <name> | --all] [--status <col>[,<col>]] [--priority <level>] [--json]\n" +
      "                                  default: this project (cwd) + global (open + done); --all = every project\n" +
      "                                  --status filters by column: " +
      STATUSES.join(" | ") +
      " (comma-separate to combine)\n" +
      "  dep add <task> <depends-on>     task-graph edge: <task> depends on <depends-on> (id|N|#N)\n" +
      "  dep rm  <task> <depends-on>     remove a dependency edge\n" +
      "  dep list <task> [--json]        show a task's depends-on + blocks\n" +
      "  ref add <task> <target>         ref-graph edge: <task> references <target> (non-blocking, cross-project ok)\n" +
      "  ref rm  <task> <target>         remove an explicit ref link (inline t#N stays; edit text to drop)\n" +
      "  ref list <task> [--json]        show a task's references + referenced-by (link + inline t#N)\n" +
      "  related <project> [--json]      projects that work with <project>\n" +
      "  groups [--json]                 list association groups\n",
  );
  process.exit(code);
}

// Entry for the unified dispatcher: `cli.mjs todos <cmd> …` → run([...]).
export function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "add":
      cmdAdd(rest);
      break;
    case "set-status":
      cmdSetStatus(rest[0], rest[1]);
      break;
    case "set-priority":
      cmdSetPriority(rest[0], rest[1]);
      break;
    case "set-project":
      cmdSetProject(rest[0], rest[1]);
      break;
    case "comment":
      cmdComment(rest);
      break;
    case "list":
      cmdList(rest);
      break;
    case "dep":
      cmdDep(rest);
      break;
    case "ref":
      cmdRef(rest);
      break;
    case "related":
      cmdRelated(rest);
      break;
    case "groups":
      cmdGroups(rest);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage(0);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      usage(1);
  }
}
