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
//                   [--description <text>] [--plan <text>] [--scheduled <YYYY-MM-DD>]
//                   no --project defaults to the current project (cwd basename); --global = project-less
//   set <field> <task> <value>      ONE setter for every scalar field of a node
//   take <id> [--session <id>]      bind THIS session to a task (cost attribution, t#295)
//   comment add <id> --text "<body>" [--by claude|user]
//   comment list <id> [--json]
//   list [--project <name> | --all] [--status <col>[,<col>]] [--priority <level>] [--json]
//        defaults to THIS project (cwd basename) + project-less tasks; --all spans every project.
//        --status filters by kanban column (backlog|queue|in_progress|review|done), comma-separated to combine
//   dep add|rm|list <task> [<depends-on>]  task-graph deps (#88): blocking edges, within one board, acyclic
//   ref add|rm|list <task> [<target>]      task-graph refs (#88): non-blocking links, cross-project ok
//        <task>/<target> accept an id, a bare number, or #N
//   produces add|rm|list <task> [<path>]   process DSL (t#302): what the step promises to produce
//   outcome <task> [--verify ok|issue] [--write] [--json]
//                                          promised -> produced -> consumed (t#304) → predicate ok|issue
//   lint [<change>] [--json]                §15 invariants on the RECORDED graph (t#313)
//   adoption [--since <date>] [--json]     is the language being used at all (t#315): ritual,
//                                          fill rate, refusals, doubles, cost of the injections
//
// Why ONE `set` (t#310): a dozen `set-<field>` verbs forced the instruction to
// carry the field list, and text is where a list rots. The table now lives in
// SET_FIELDS below — `cli todos set` with no field prints every field, its
// values and its rule, and an unknown field or value is REFUSED with that same
// list. Nothing about the fields is explained ahead of time any more.
//
// Exit code is non-zero on any error (bad status, unknown id, usage), so a
// caller can tell success from failure.

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchPlanCli } from "./settings.mjs";
import { resolveAddress, showSection, sectionFingerprint, blocksOf } from "./spec.mjs";
import { findChange, changeAddress } from "./change.mjs";

// Kanban columns, in board order. Keep in lockstep with todos.rs::STATUSES.
export const STATUSES = ["backlog", "queue", "in_progress", "review", "done"];

// Normalize a possibly-legacy status to a real column. Pre-column tasks stored
// `pending`; the tracker migrates them to `backlog` on load and the SessionStart
// hook does the same — mirror it so `--status` matches what the board shows.
const col = (s) => (STATUSES.includes(s) ? s : "backlog");

// A task counts as "done" iff its normalized column is `done` (review ≠ done —
// still a gate). Shared by the ready frontier and the done-gate so both read the
// dependency graph the same way.
export const isDone = (t) => !!t && col(t.status) === "done";

// A task counts as a CHANGE root when either the current field (`change`) or
// the field it replaces (`theme`, t#345) is set on it — the same read-old/write-
// new alias `col()` uses above for the pre-column `pending` status. Only
// `change` is ever written from here on; `theme` is read so an existing file
// keeps working until its rows are next saved.
export const isChangeRoot = (t) => !!(t && (t.change ?? t.theme));

// The READY predicate of the frontier (#88): a task is workable when it is not
// closed and every task it depends_on IS closed. Exported so `ready`, `pipeline`
// and the runner (run.mjs, t#305) all read the frontier from ONE definition — a
// second copy of it is how the graph and the run start disagreeing. A missing
// (deleted) prerequisite cannot block.
export function isReadyNode(t, byId) {
  return (
    !isDone(t) &&
    (t.depends_on ?? []).every((d) => {
      const dep = byId.get(d);
      return !dep || isDone(dep);
    })
  );
}

// Priority buckets, most to least important; "" = unset. Keep in lockstep with
// todos.rs::PRIORITIES and TodoWindow.vue. The SessionStart hook ranks by this
// order and a settings threshold picks the minimum level that enters context.
const PRIORITIES = ["high", "medium", "low"];

export const SUBJECT_LIMIT = 150;

// Task-graph node type (#88), in lockstep with todos.rs::Todo.kind and GraphView.
// `auto` = a node a headless runner may execute unattended; `manual` (the default,
// stored as an empty/absent field) = a human/review gate. Normalize returns the
// canonical value ("auto" | ""), or undefined for anything else. `manual`/`none`/""
// all clear the field, so the file stays clean and the default is conservative.
function normalizeKind(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "auto") return "auto";
  if (s === "manual" || s === "none" || s === "") return "";
  return undefined;
}

// Normalize a --priority / set-priority value to a real bucket or "" (unset).
// "none"/"clear"/"" explicitly clear it. Returns undefined for anything invalid,
// so the caller can fail with a helpful message instead of writing garbage.
function normalizePriority(v) {
  if (v == null || v === true) return undefined;
  const s = String(v).toLowerCase().trim();
  if (s === "none" || s === "clear" || s === "") return "";
  return PRIORITIES.includes(s) ? s : undefined;
}

// Normalize a declared LIMIT of the process DSL (t#302): the retry limit (§11),
// the node/group budget (§13) and the parallel limit (§10) are all "a positive
// number, or nothing declared". Returns the number, `null` when the caller
// clears the declaration, or undefined for anything invalid — the three states
// the DSL knows, since "no declaration" is never the same as "no limit" (§15,
// «никаких значений из воздуха»). The plan notations `<=M` (§11) and `$N` (§13)
// are accepted verbatim, so a limit copied out of a `## Steps` block lands
// without hand-editing.
export function normalizeLimit(value, { integer = true } = {}) {
  if (value == null || value === true) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "none" || s === "clear" || s === "off") return null;
  const num = s.replace(/^<=/, "").replace(/^\$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(num)) return undefined;
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
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
  if (deferred) {
    deferred.dirty = true;
    return;
  }
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

// A command that writes ONE row saves after it and is atomic by construction.
// `apply` writes a whole graph — a task, its edges, its declarations, then the
// next — and every one of those steps saved on its own: dozens of writes, each a
// chance to fail with the board half-built. It did fail (EPERM, the app holding
// the file), and the re-run forked the graph into duplicate tasks.
//
// So the unit of atomicity becomes the CALLER's, not the field's: inside this
// wrapper every save() only marks the board dirty, and the single write happens
// at the end. A throw anywhere in between leaves the file untouched — the run is
// all or nothing, which is what makes re-running the same file safe.
let deferred = null;

export function withDeferredSave(file, data, fn) {
  if (deferred) return fn();
  deferred = { dirty: false };
  let out;
  try {
    out = fn();
  } catch (e) {
    // A pass that threw is a pass that did not happen: drop the accumulated
    // changes rather than writing whatever got as far as memory.
    deferred = null;
    throw e;
  }
  const dirty = deferred.dirty;
  deferred = null;
  if (dirty) save(file, data);
  return out;
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// The board file and its forgiving load / atomic save, for the sibling commands
// that write through this module's rules (`apply`, t#314) instead of re-deriving
// the path and the JSON contract on their own.
export const boardPath = () => todosPath();
export const loadBoard = (file = todosPath()) => load(file);
export const saveBoard = (file, data) => save(file, data);

export function taskSessionsPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(
    appData,
    "com.claude-usage-tracker.app",
    "task-sessions.jsonl",
  );
}

export function currentSessionId(flags = {}) {
  const explicit = typeof flags.session === "string" ? flags.session.trim() : "";
  return explicit || String(process.env.CLAUDE_CODE_SESSION_ID || "").trim();
}

// The other side of the same variable (t#312): a child process that is NOT the
// session it inherited must not be handed its id, because everything reading it
// — `set status`, the SessionStart hook — would bind a session that is doing
// none of that child's work. Erasing it makes the child behave exactly as it
// does from a plain terminal, where the variable is unset. Lives next to
// `currentSessionId` so the reader and the eraser can never name different
// variables.
export function envWithoutSession(env = process.env) {
  const out = { ...env };
  delete out.CLAUDE_CODE_SESSION_ID;
  return out;
}

export function appendTaskSessionEvent({ session, task, event, source, project }) {
  if (!session || !task || !event) return false;
  const rec = {
    ts: new Date().toISOString(),
    session: String(session),
    task: String(task),
    event: String(event),
    source: String(source || ""),
  };
  if (project) rec.project = String(project);
  try {
    const file = taskSessionsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function readTaskSessionEvents(file = taskSessionsPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && rec.session && rec.task && rec.event) out.push(rec);
  }
  return out;
}

export function lastTaskSessionEvent(session, file = taskSessionsPath()) {
  if (!session) return null;
  const mine = readTaskSessionEvents(file).filter((r) => r.session === session);
  return mine.length ? mine[mine.length - 1] : null;
}

function cmdTake(args) {
  const { positional, flags } = parseArgs(args);
  const [id] = positional;
  if (!id) fail("usage: cli todos take <id> [--session <id>]");
  const session = currentSessionId(flags);
  if (!session) {
    fail(
      "no session id: CLAUDE_CODE_SESSION_ID is unset — `take` is meant to run INSIDE\n" +
        "a Claude Code session, where the binding it records has a session to point at.\n" +
        "pass one explicitly with --session <id> if you really know it.",
    );
  }
  const file = todosPath();
  const data = load(file);
  const todo = resolveTask(data, id);
  if (!todo) fail(`no todo with id ${id}`);
  const written = appendTaskSessionEvent({
    session,
    task: todo.id,
    event: "start",
    source: "take",
    project: todo.project || null,
  });
  process.stdout.write(
    `ok: session ${session} -> #${todo.number} [${col(todo.status)}]` +
      (written ? "\n" : " (binding NOT recorded — journal unwritable)\n"),
  );
  const prereqs = directPrereqs(data, todo);
  if (prereqs.some((p) => p.handoff && p.handoff.trim())) {
    process.stdout.write("\n" + formatInheritedHandoff(todo, prereqs));
  }
  const roots = changeRootsFor(data, todo);
  if (roots.length) {
    process.stdout.write("\n" + formatChangeVision(todo, roots));
  }
  const specLink = specAddressesFor(todo, roots);
  if (specLink.addresses.length) {
    process.stdout.write("\n" + formatSpecSections(todo, specLink));
    // The baseline is written AFTER the section is shown and needs its own save:
    // `take` writes nothing to the board otherwise, and in `setStatus` the row
    // was already saved before this anchor is reached.
    recordSpecBaseline(todo, specLink.addresses);
    save(file, data);
  }
}

// --- the fields (t#310) ------------------------------------------------------
//
// Handlers of `todos set <field> <task> <value>`. The dispatcher (cmdSet) has
// already resolved <task> and loaded the store, so a handler only validates its
// own value, applies the rule its field carries and saves. Every rule the DSL
// puts on a field lives HERE, in the refusal or the warning the handler prints —
// not in an instruction the caller is expected to have read first.

function setStatus({ data, file, todo, value, flags }) {
  const status = String(value);
  if (!STATUSES.includes(status))
    fail(`invalid status "${value}". valid: ${STATUSES.join(" | ")}`);
  // Done-gate (#88): `done` is the ONLY status that releases downstream tasks
  // (`ready` derives the frontier from it), so closing a task while its
  // prerequisites are unfinished would silently unblock work whose chain never
  // ran — the graph would show `ready` for links that were never satisfied.
  // Refuse it unless the caller explicitly overrides with --force. Only direct
  // depends_on are checked: a satisfied direct prereq transitively vouches for
  // its own upstream (it couldn't have closed honestly otherwise).
  if (status === "done" && !flags.force) {
    const blocking = directPrereqs(data, todo).filter((p) => !isDone(p));
    if (blocking.length) {
      fail(
        `refusing: #${todo.number} depends on unfinished task(s): ` +
          blocking.map((p) => `#${p.number} [${col(p.status)}]`).join(", ") +
          "\nfinish those first, or override with --force",
      );
    }
  }
  // The frontier (#88) is derived, so a start off it is legal — but it is worth
  // saying out loud, because the work it builds on is not finished yet.
  if (status === "in_progress") {
    const waiting = directPrereqs(data, todo).filter((p) => !isDone(p));
    if (waiting.length) {
      process.stdout.write(
        `warn: #${todo.number} is not on the frontier — it still waits on ` +
          waiting.map((p) => `#${p.number} [${col(p.status)}]`).join(", ") +
          "\n",
      );
    }
  }
  if (status === "in_progress" || status === "review" || status === "done") {
    appendTaskSessionEvent({
      session: currentSessionId(),
      task: todo.id,
      event: status === "in_progress" ? "start" : "end",
      // Wire value, NOT the command name: task_sessions.rs::EXPLICIT_SOURCES is a
      // two-item allowlist ("take", "set-status") and marks anything else a guess.
      source: "set-status",
      project: todo.project || null,
    });
  }
  if (todo.status === status) {
    process.stdout.write(`ok: #${todo.number} already ${status}\n`);
    return;
  }
  todo.status = status;
  todo.updated_at = new Date().toISOString();
  // Transition log (t#87): one entry per status ENTERED, so token attribution can
  // reconstruct "was this task in_progress during that session" — `updated_at`
  // can't (any edit bumps it). Every writer appends: here, todos.rs::set_status
  // (UI drag) and todos.rs::upsert (UI edit). Legacy rows have no history —
  // readers must treat "no entries" as "status held since created_at".
  (todo.status_history ??= []).push({ status, at: todo.updated_at });
  save(file, data);
  process.stdout.write(`ok: #${todo.number} -> ${status}\n`);
  // Anchor for the handoff mechanism (#141): moving a task INTO in_progress is the
  // "starting this task" moment, so surface what it inherits from its prerequisites
  // right here — the agent gets the baton without being told to ask for it. Only
  // when there's actually a handoff to carry, so root/handoff-less starts stay quiet.
  if (status === "in_progress") {
    const prereqs = directPrereqs(data, todo);
    if (prereqs.some((p) => p.handoff && p.handoff.trim())) {
      process.stdout.write("\n" + formatInheritedHandoff(todo, prereqs));
    }
    // Same anchor, other direction (t#252): the vision is read UP the graph —
    // starting a subtask surfaces the description of the nearest change root(s),
    // the way the phases hook used to surface a plan's vision. Only when a
    // change actually wraps this task, so change-less starts stay quiet.
    const roots = changeRootsFor(data, todo);
    if (roots.length) {
      process.stdout.write("\n" + formatChangeVision(todo, roots));
    }
    // Spec channel (t#340, docs/specs/README.md §7/§8): the addressed spec
    // section(s) for this task or its change root, printed NEXT TO the vision
    // above, never instead of it — same anchor, one extra thing in context.
    const specLink = specAddressesFor(todo, roots);
    if (specLink.addresses.length) {
      process.stdout.write("\n" + formatSpecSections(todo, specLink));
      recordSpecBaseline(todo, specLink.addresses);
      save(file, data); // the row was saved above, before this anchor was reached
    }
    // Preventive channel (t#250): "starting this task" is the moment the
    // channel exists for, so the match CLI runs INLINE here and whatever it
    // prints (its warning thread) lands under the handoff/vision anchors.
    notifyTaskEvent(todo, "in_progress");
  }
  // Queue is "lined up for execution" — refresh the match in the background so
  // the warning comment reflects the task text as it enters the pipeline.
  if (status === "queue") notifyTaskEvent(todo, "queue");
}

// Set (or clear) a todo's priority bucket. `level` is high|medium|low, or
// none|clear|"" to unset. Clearing removes the field so the file stays clean
// (matches the Rust skip_serializing_if and how the app omits an unset priority).
function setPriority({ data, file, todo, value }) {
  const priority = normalizePriority(value);
  if (priority === undefined)
    fail(`invalid priority "${value}". valid: ${PRIORITIES.join(" | ")} | none`);
  if ((todo.priority || "") === priority) {
    process.stdout.write(`ok: #${todo.number} already ${priority || "unset"}\n`);
    return;
  }
  if (priority) todo.priority = priority;
  else delete todo.priority;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: #${todo.number} priority -> ${priority || "unset"}\n`);
}

// Set (or clear) a todo's task-graph node type (#88): `auto` marks a node a
// headless runner may execute unattended; `manual` (the default) is a human/review
// gate. §15, «auto без verify — не auto»: the authority to close comes from the
// check, so marking a node auto while it declares none warns on the spot — the
// caller learns the invariant from the command, not from a paragraph.
function setKind({ data, file, todo, value }) {
  const kind = normalizeKind(value);
  if (kind === undefined)
    fail(`invalid kind "${value}". valid: auto | manual`);
  if (kind === "auto" && !hasVerify(todo)) {
    process.stdout.write(
      `warn: #${todo.number} declares no check — an auto node without verify runs as a GATE.\n` +
        `      declare it: todos set verify ${todo.number} "<cmd>"\n`,
    );
  }
  if ((todo.kind || "") === kind) {
    process.stdout.write(`ok: #${todo.number} already ${kind || "manual"}\n`);
    return;
  }
  if (kind) todo.kind = kind;
  else delete todo.kind;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: #${todo.number} kind -> ${kind || "manual"}\n`);
}

// Put a todo INTO a change, or take it out (c#9, formerly the root-task marker
// of t#255). A change is a record now (`change.mjs`), so membership is the
// `change_id` field, in lockstep with todos.rs::Todo.change_id — the value is
// an address `c#N`, and `none` clears it. The old boolean form is refused
// rather than reinterpreted: a session that remembers `change on` would
// otherwise silently mark a task as something that no longer exists. Clearing
// also drops the legacy `change`/`theme` flags of an unmigrated board, so an
// old file cannot resurrect a root through the read alias.
function setChange({ data, file, todo, value }) {
  const s = String(value).trim().toLowerCase();
  const clearing = ["off", "false", "none", "clear"].includes(s);
  if (!["on", "true"].includes(s) && !clearing) {
    const change = findChange(data, value);
    if (!change)
      fail(
        `invalid change "${value}". valid: <c#N> | none\n` +
          `  a change is a record now, not a flag — see them: cli change list --all`,
      );
    if (todo.change_id === change.id) {
      process.stdout.write(`ok: #${todo.number} already in ${changeAddress(change)}\n`);
      return;
    }
    todo.change_id = change.id;
    todo.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(
      `ok: #${todo.number} change -> ${changeAddress(change)} "${change.title}"\n`,
    );
    return;
  }
  if (clearing && todo.change_id) {
    delete todo.change_id;
    todo.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(`ok: #${todo.number} change -> none\n`);
    return;
  }
  if (!clearing)
    fail(
      `refusing: \`change ${s}\` is the OLD root-task form — a change is a record now.\n` +
        `  cli change new "<title>"   then   todos set change ${todo.number} <c#N>`,
    );
  if (isChangeRoot(todo)) {
    delete todo.change;
    delete todo.theme;
    todo.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(`ok: #${todo.number} change -> none (old root flag dropped)\n`);
    return;
  }
  process.stdout.write(`ok: #${todo.number} already change none\n`);
}

// --- process DSL declarations (t#302) ---------------------------------------
//
// The fields below are what a node DECLARES before it runs, as opposed to what
// it reports afterwards (`handoff`): `produces` (§6) is the contract, `verify`
// (§7) the machine predicate of the outcome, `retry_limit` (§11) the loop
// bound, `on_issue` (§12) the transition taken when the predicate says `issue`,
// `budget_usd` (§13) the spend ceiling, `parallel_limit` (§10) how many steps
// of a CHANGE the runner may drive at once. Every one of them is written only
// when declared — an absent field means "not declared", which is NOT the same
// as "no limit", and the runner is forbidden to guess (§15).
//
// The one field that is NOT an edge of the dep graph is `on_issue`: the loop it
// closes lives on the run layer, and writing it into `depends_on` would break
// acyclicity (§15). It is stored as a plain task id and validated here.
//
// "Declared BEFORE the work" is enforced, not asked for: refuseIfClosed() turns
// a declaration on a `done` node into a refusal that names the way back.

const hasVerify = (t) => !!(t && t.verify && String(t.verify).trim());

function refuseIfClosed(todo, what) {
  if (!isDone(todo)) return;
  fail(
    `refusing: #${todo.number} is done — ${what} is a promise made BEFORE the work, and this node has none left.\n` +
      `reopen it first: todos set status ${todo.number} queue`,
  );
}

// One declared output, shared by `produces add` and `apply` (t#314). The
// "declared BEFORE the work" refusal lives here, so a file cannot promise an
// output on a node that is already closed. Mutates the row; the caller saves.
export function addProduces(todo, item) {
  refuseIfClosed(todo, "a declared output");
  const list = Array.isArray(todo.produces) ? todo.produces : [];
  if (list.includes(item)) return "already";
  todo.produces = [...list, item];
  todo.updated_at = new Date().toISOString();
  return "added";
}

const PRODUCES_USAGE =
  "usage: cli todos produces add <task> <path>   (declare an output BEFORE the work)\n" +
  "       cli todos produces rm  <task> <path>\n" +
  "       cli todos produces list <task> [--json]\n" +
  "       <task> is an id, a number, or #N. <path> is a file path, an interface, a record —\n" +
  "       whatever the next step is meant to take.";

// Manage a node's declared outputs (§6). A declaration is a promise made BEFORE
// the work, so it is deliberately a separate field from `handoff` (the baton
// written after) — mixing the two roles is what made the graph unreadable.
// Duplicates are ignored; emptying the list removes the field so the file stays
// clean (mirrors the Rust skip_serializing_if used by every other optional field).
function cmdProduces(args) {
  const [sub, ...rest] = args;
  const file = todosPath();
  const data = load(file);
  if (sub === "add" || sub === "rm") {
    const t = resolveTask(data, rest[0]);
    const item = String(rest[1] ?? "").trim();
    if (!t || !item) fail(PRODUCES_USAGE);
    const list = Array.isArray(t.produces) ? t.produces : [];
    if (sub === "add") {
      if (addProduces(t, item) === "already") {
        process.stdout.write(`ok: #${t.number} already produces ${item}\n`);
        return;
      }
      save(file, data);
      process.stdout.write(`ok: #${t.number} produces ${item} (${t.produces.length} declared)\n`);
      return;
    }
    const next = list.filter((p) => p !== item);
    if (next.length === list.length) {
      process.stdout.write(`ok: #${t.number} did not declare ${item}\n`);
      return;
    }
    if (next.length) t.produces = next;
    else delete t.produces;
    t.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(`ok: #${t.number} no longer produces ${item} (${next.length} declared)\n`);
    return;
  }
  if (sub === "list") {
    const t = resolveTask(data, rest.find((a) => !a.startsWith("--")));
    if (!t) fail(PRODUCES_USAGE);
    const list = Array.isArray(t.produces) ? t.produces : [];
    if (rest.includes("--json")) {
      process.stdout.write(
        JSON.stringify(
          { task: { id: t.id, number: t.number, subject: t.subject }, produces: list },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(`#${t.number} ${t.subject}\n`);
    if (!list.length) {
      process.stdout.write("  produces: (nothing declared)\n");
      return;
    }
    for (const p of list) process.stdout.write(`  produces: ${p}\n`);
    return;
  }
  fail(PRODUCES_USAGE);
}

// Declare the node's CHECK (§7): a command whose exit code is the outcome
// predicate — 0 = `ok`, anything else = `issue`. An empty string clears the
// declaration; clearing it on an `auto` node demotes that node to a gate (§15),
// which is said here rather than left for the caller to remember.
function setVerify({ data, file, todo, value }) {
  const verify = String(value).trim();
  if (verify) todo.verify = verify;
  else delete todo.verify;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  if (verify) {
    process.stdout.write(`ok: #${todo.number} verify -> ${verify}\n`);
    return;
  }
  process.stdout.write(
    `ok: #${todo.number} verify cleared` +
      (todo.kind === "auto"
        ? " — it is auto with no check, so it now runs as a GATE\n"
        : "\n"),
  );
}

// Declare the node's RETRY LIMIT (§11): how many attempts the runner may make
// before it parks the node in `review` with an `issue` predicate. Attempt M+1
// never starts. `none` withdraws the declaration — which FORBIDS the ?issue
// transition rather than making it endless (§15), so `set on-issue` refuses on
// a node without one.
function setRetry({ data, file, todo, value }) {
  const limit = normalizeLimit(value);
  if (limit === undefined)
    fail(`invalid retry limit "${value}". valid: a positive whole number (also <=M) | none`);
  if ((todo.retry_limit ?? null) === limit) {
    process.stdout.write(
      `ok: #${todo.number} already retry ${limit === null ? "undeclared" : `<=${limit}`}\n`,
    );
    return;
  }
  if (limit === null) delete todo.retry_limit;
  else todo.retry_limit = limit;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  if (limit === null && todo.on_issue) {
    process.stdout.write(
      `warn: #${todo.number} still declares ?issue -> ${onIssueLabel(data, todo)}, and with no limit that transition\n` +
        `      does not run at all — declare a limit again, or drop it with todos set on-issue ${todo.number} none\n`,
    );
  }
  process.stdout.write(
    `ok: #${todo.number} retry -> ${limit === null ? "undeclared" : `<=${limit}`}\n`,
  );
}

// Declare a SPEND CEILING (§13): on a plain node its own, on a CHANGE the whole
// group's. Reaching it is a soft stop — the runner finishes the current step and
// parks on the step boundary; nothing is rolled back. Dollars are the v1 unit
// because they are what the tracker already counts per block.
function setBudget({ data, file, todo, value }) {
  const usd = normalizeLimit(value, { integer: false });
  if (usd === undefined)
    fail(`invalid budget "${value}". valid: a positive amount in USD (also $N) | none`);
  if ((todo.budget_usd ?? null) === usd) {
    process.stdout.write(
      `ok: #${todo.number} already budget ${usd === null ? "undeclared" : `$${usd}`}\n`,
    );
    return;
  }
  if (usd === null) delete todo.budget_usd;
  else todo.budget_usd = usd;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: #${todo.number} budget -> ${usd === null ? "undeclared" : `$${usd}`}${isChangeRoot(todo) ? " (change: the whole group's ceiling)" : ""}\n`,
  );
}

// Declare the PARALLEL LIMIT (§10): how many steps of a group the runner may
// drive at once. Parallelism itself is never declared — it is already described
// by the ABSENCE of an edge; only the ceiling is. The limit belongs to the
// GROUP, and since c#9 the group is a record, not a root task — so a task can
// only ever CLEAR an inherited limit here, never declare one. Reading stays:
// an unmigrated board still carries the ceiling on its root task, and the
// runner resolves it through the legacy virtual root.
function setParallel({ data, file, todo, value }) {
  const limit = normalizeLimit(value);
  if (limit === undefined)
    fail(`invalid parallel limit "${value}". valid: none (a change record holds the limit)`);
  if (limit !== null)
    fail(
      `refusing: a parallel limit belongs to the CHANGE, not to a task.\n` +
        `  cli change set parallel <c#N> ${limit}` +
        (todo.change_id ? "" : `   (put #${todo.number} in one first: todos set change ${todo.number} <c#N>)`),
    );
  if ((todo.parallel_limit ?? null) === limit) {
    process.stdout.write(
      `ok: #${todo.number} already parallel ${limit === null ? "undeclared" : limit}\n`,
    );
    return;
  }
  if (limit === null) delete todo.parallel_limit;
  else todo.parallel_limit = limit;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: #${todo.number} parallel -> ${limit === null ? "undeclared" : limit}\n`,
  );
}

// How an `on_issue` target reads in a message: its board number when the target
// still exists, the raw id otherwise (a deleted target must stay visible).
function onIssueLabel(data, todo) {
  const target = data.todos.find((x) => x && x.id === todo.on_issue);
  return target ? `#${target.number}` : todo.on_issue;
}

// Declare the ?issue TRANSITION (§12): where control goes when the outcome
// predicate is `issue` — this is how the everyday `code-review -> impl` loop is
// written down. Three guards, all from §15:
//   * a declared retry limit is REQUIRED — a missing limit forbids the
//     transition, it does not permit an endless one;
//   * the target lives on the same board and is not the node itself;
//   * the edge is NEVER written into `depends_on` — the loop belongs to the run
//     layer, and a back edge in the dep graph would break its acyclicity.
function setOnIssue({ data, file, todo, value }) {
  const v = String(value).trim();
  if (v === "" || /^(none|clear|off)$/i.test(v)) {
    if (!todo.on_issue) {
      process.stdout.write(`ok: #${todo.number} already declares no ?issue transition\n`);
      return;
    }
    delete todo.on_issue;
    todo.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(`ok: #${todo.number} ?issue transition cleared\n`);
    return;
  }
  const target = resolveTask(data, v);
  if (!target) fail(`no todo with id ${v}`);
  if (target.id === todo.id)
    fail("a task can't hand its own issue outcome back to itself — that loop never advances");
  if (boardOf(todo) !== boardOf(target))
    fail(
      `refusing: #${target.number} is on another board (${boardOf(target) || "global"} ≠ ${boardOf(todo) || "global"}).\n` +
        "an ?issue transition moves control inside ONE run, so it stays within one project board",
    );
  if (typeof todo.retry_limit !== "number") {
    fail(
      `refusing: #${todo.number} has no declared retry limit.\n` +
        "a missing limit FORBIDS the transition, it does not permit an endless one — " +
        `declare it first: todos set retry ${todo.number} <M>`,
    );
  }
  if (isDone(target)) {
    process.stdout.write(
      `warn: #${target.number} is done — control handed there on an issue lands on a closed node\n`,
    );
  }
  if (todo.on_issue === target.id) {
    process.stdout.write(`ok: #${todo.number} already ?issue -> #${target.number}\n`);
    return;
  }
  todo.on_issue = target.id;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  // Deliberately NOT touching depends_on: the transition is a run-layer edge.
  process.stdout.write(
    `ok: #${todo.number} ?issue -> #${target.number} (run-layer edge, ${todo.retry_limit} attempt(s) max; not a dependency)\n`,
  );
}

// Field roles after the t#253 review: description = WHAT & WHY (a change root's
// description is the change's DELTA — what this round changes and why now; the
// vision itself lives in the spec the change points at, docs/specs/README.md
// §1), plan = HOW only (steps + order, rewritten on re-plan), handoff = the
// result baton, comments = the journal. "Never the
// same text in two of them" used to be a line of prose; refuseIfDuplicate makes
// it a refusal, so the rule holds without anyone having read it.

function refuseIfDuplicate(todo, field, text) {
  const body = String(text || "").trim();
  if (!body) return;
  for (const other of ["description", "plan", "handoff"]) {
    if (other === field) continue;
    if (String(todo[other] || "").trim() === body) {
      fail(
        `refusing: that text is already the ${other} of #${todo.number} — one role each,\n` +
          "never the same text in two fields (description = WHAT & WHY, plan = HOW, handoff = the baton)",
      );
    }
  }
}

// Write a todo's `plan` field (t#253): the STEPS + ORDER part of an accepted
// plan — NOT the vision paragraph (that is the description's job). Rewritten on
// re-plan. `--text ""` clears it ("" = no plan; the field is non-optional).
function setPlan({ data, file, todo, value }) {
  refuseIfDuplicate(todo, "plan", value);
  todo.plan = value;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: #${todo.number} plan ${value.trim() ? `set (${value.length} chars)` : "cleared"}\n`,
  );
}

// Write a todo's `description` (t#253): the WHAT & WHY — for a ritual-recorded
// one-session plan this is where the VISION paragraph goes when the task was
// created without one. The exit hook tells sessions to use it only on an empty
// description; the command itself stays a plain setter (the user may overwrite).
function setDescription({ data, file, todo, value }) {
  refuseIfDuplicate(todo, "description", value);
  todo.description = value;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: #${todo.number} description ${value.trim() ? `set (${value.length} chars)` : "cleared"}\n`,
  );
}

function refuseIfSubjectTooLong(subject, taskRef) {
  if (subject.length <= SUBJECT_LIMIT) return;
  fail(
    `refusing: title is ${subject.length} chars — the cap is ${SUBJECT_LIMIT}.\n` +
      `put the long text in the description instead: cli todos set description ${taskRef} --text "…"`,
  );
}

function setSubject({ data, file, todo, value }) {
  const subject = String(value).trim();
  if (!subject) fail(`refusing: #${todo.number} can't have an empty title`);
  refuseIfSubjectTooLong(subject, todo.number);
  if (todo.subject === subject) {
    process.stdout.write(`ok: #${todo.number} already that title\n`);
    return;
  }
  todo.subject = subject;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: #${todo.number} subject -> ${subject}\n`);
}

// Set (or clear) a todo's project (issue #54: a task filed with the wrong/empty
// project couldn't be fixed from the CLI before — only in the app). <name> ties
// it to that board; `--global`/`none`/`clear` makes it project-less. Clearing
// removes the field so the file stays clean (matches the Rust skip_serializing_if).
function setProject({ data, file, todo, value }) {
  const v = String(value).trim();
  const clear = v === "" || v === "--global" || /^(none|clear|global)$/i.test(v);
  const next = clear ? null : v;
  const label = todo.number != null ? `#${todo.number}` : todo.id;
  if ((todo.project ?? null) === next) {
    process.stdout.write(`ok: ${label} already ${next ? `project "${next}"` : "global"}\n`);
    return;
  }
  if (next) todo.project = next;
  else delete todo.project;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(
    `ok: ${label} project -> ${next ? `"${next}"` : "global (project-less)"}\n`,
  );
}

// Link a change to one or more spec sections (t#339, docs/specs/README.md §8):
// `spec: <домен>#<слаг>[,<домен>#<слаг>…]`, the structural replacement for the
// old free-text `spec: tasks §5` inside description. Every address is
// resolved against the registry BEFORE the write — an invalid address is a
// refusal, never a silently accepted string, because a link that cannot be
// followed is worse than no link (README §5/§6). Availability of a REMOTE
// section's text is a separate question the registry answers at read time
// (spec show); it does not gate this write.
function setSpec({ data, file, todo, value }) {
  const v = String(value).trim();
  if (v === "" || /^(none|clear)$/i.test(v)) {
    if (!Array.isArray(todo.spec) || !todo.spec.length) {
      process.stdout.write(`ok: #${todo.number} already has no spec link\n`);
      return;
    }
    // Clearing the link on a task being closed disarms the closing guard, and
    // does it without a trace: the board afterwards is indistinguishable from
    // one where the link was never made. Every other escape hatch here says its
    // own name out loud (`--force`), so this one must too.
    if (col(todo.status) === "review" || col(todo.status) === "done") {
      fail(
        `refusing: #${todo.number} is ${todo.status} — dropping its spec link now would silently ` +
          `disarm the closing guard, and leave no record that it ever pointed anywhere.\n` +
          `If the link was wrong, answer for it first (cli spec answer ${todo.number} unchanged --text "…"),\n` +
          `or reopen the task: todos set status ${todo.number} in_progress`,
      );
    }
    delete todo.spec;
    todo.updated_at = new Date().toISOString();
    save(file, data);
    process.stdout.write(`ok: #${todo.number} spec link cleared\n`);
    return;
  }
  const addresses = v.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = addresses
    .map((a) => ({ a, r: resolveAddress(a) }))
    .filter(({ r }) => !r.ok)
    .map(({ a, r }) => `${a} — ${r.reason}`);
  if (invalid.length) {
    fail(`refusing: invalid spec address(es):\n` + invalid.map((m) => `  ${m}`).join("\n"));
  }
  if (JSON.stringify(todo.spec || []) === JSON.stringify(addresses)) {
    process.stdout.write(`ok: #${todo.number} spec already ${addresses.join(", ")}\n`);
    return;
  }
  todo.spec = addresses;
  todo.updated_at = new Date().toISOString();
  save(file, data);
  process.stdout.write(`ok: #${todo.number} spec -> ${addresses.join(", ")}\n`);
}

// The field table (t#310). `values` is what the command prints when it refuses,
// so the list of legal values exists in exactly one place and can never drift
// from what the code accepts. `declaration` marks a field of the process DSL —
// a promise made before the work, hence refused on a closed node.
const SET_FIELDS = {
  subject: {
    values: `"<title>"   max ${SUBJECT_LIMIT} chars — longer text goes in the description`,
    set: setSubject,
  },
  status: {
    values: `${STATUSES.join(" | ")}   [--force]   (done is refused while a prereq is open)`,
    set: setStatus,
  },
  priority: { values: `${PRIORITIES.join(" | ")} | none`, set: setPriority },
  kind: {
    values: "auto | manual   (auto with no verify runs as a gate)",
    declaration: true,
    set: setKind,
  },
  change: {
    values: "<c#N> | none   (a change is a record: cli change list --all)",
    set: setChange,
  },
  project: { values: "<name> | none   (none = global, project-less)", set: setProject },
  verify: {
    values: '"<cmd>"   exit 0 = ok, non-zero = issue; "" withdraws it',
    declaration: true,
    set: setVerify,
  },
  retry: {
    values: "<M> | none   (also <=M; none FORBIDS the ?issue transition)",
    declaration: true,
    set: setRetry,
  },
  budget: {
    values: "<usd> | none   (also $N; on a change = the whole group's)",
    declaration: true,
    set: setBudget,
  },
  parallel: {
    values: "<N> | none   (read off a CHANGE root)",
    declaration: true,
    set: setParallel,
  },
  "on-issue": {
    values: "<task> | none   (same board, needs a retry limit; never a dep edge)",
    declaration: true,
    set: setOnIssue,
  },
  plan: { values: '--text "<steps + order>"   HOW only', text: true, set: setPlan },
  description: {
    values: '--text "<what & why>"   a change root\'s = the change\'s DELTA (what changes this round, and why now)',
    text: true,
    set: setDescription,
  },
  spec: {
    values: "<домен>#<слаг>[,<домен>#<слаг>…] | none   (validated against the spec registry, t#339)",
    set: setSpec,
  },
};

export const setFieldNames = () => Object.keys(SET_FIELDS);

// The setter behind `todos set` AND behind `todos apply` (t#314): one field, one
// task, one rule set. Both entry points go through here so a rule declared in
// SET_FIELDS (a declaration is refused on a closed node, `auto` warns without a
// verify, `on-issue` demands a retry limit) holds whichever way the value came in
// — typed as a command or read out of an apply file.
export function setField({ data, file, todo, field, value, flags = {} }) {
  const spec = SET_FIELDS[field];
  if (!spec) fail(`unknown field "${field}"\n` + setUsage());
  if (spec.declaration) refuseIfClosed(todo, `the ${field} declaration`);
  spec.set({ data, file, todo, value, flags });
}

// The field list as it appears in the help and in `pipeline`: generated, so the
// two can never name a field the table does not have. Wrapped to `width`, each
// continuation line indented by `indent`.
function fieldList(indent, width = 60) {
  const lines = [];
  let cur = "";
  for (const f of setFieldNames()) {
    const next = cur ? `${cur} | ${f}` : f;
    if (next.length > width) {
      lines.push(cur);
      cur = f;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\n" + " ".repeat(indent));
}

function setUsage() {
  const w = Math.max(...setFieldNames().map((f) => f.length));
  return (
    "usage: cli todos set <field> <task> <value>\n" +
    '       cli todos set plan|description <task> --text "<markdown>"\n' +
    "       <task> is an id, a number, or #N\n" +
    "fields:\n" +
    Object.entries(SET_FIELDS)
      .map(([name, spec]) => `  ${name.padEnd(w)}  ${spec.values}`)
      .join("\n")
  );
}

// `todos set <field> <task> <value>` — the ONE scalar setter (t#310). It owns
// everything common to the fields: the field name, the task lookup, the value's
// presence, and the "declared before the work" rule. Whatever is specific to a
// field is refused by its handler, with the legal values printed from the table
// above — an unknown field or value never fails silently.
function cmdSet(args) {
  const { positional, flags } = parseArgs(args);
  const [field, task] = positional;
  if (!field) fail(setUsage());
  const spec = SET_FIELDS[field];
  if (!spec)
    fail(`unknown field "${field}"\n` + setUsage());
  if (!task) fail(`usage: cli todos set ${field} <task> ${spec.values}`);
  let value = spec.text ? flags.text : positional[2];
  // `--global` is the older spelling of a project-less task; keep it working as
  // a value rather than as a second way to spell the command.
  if (value === undefined && field === "project" && flags.global) value = "none";
  if (typeof value !== "string")
    fail(`usage: cli todos set ${field} <task> ${spec.values}`);
  const file = todosPath();
  const data = load(file);
  const todo = resolveTask(data, task);
  if (!todo) fail(`no todo with id ${task}`);
  setField({ data, file, todo, field, value, flags });
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
  "[--priority high|medium|low] [--description <text>] [--plan <text>] [--scheduled <YYYY-MM-DD>] [--by user|claude]\n" +
  "       (no --project → the current project; --global files a project-less task)";

// Create a new todo. Mirrors the field set the tracker writes (todos.rs / the
// TodoWindow form): id is a fresh UUID, created_at/updated_at stamped now,
// status defaults to backlog. Appends and writes atomically.
function cmdAdd(args) {
  const { positional, flags } = parseArgs(args);
  const subject = String(positional[0] ?? flags.subject ?? "").trim();
  if (!subject) fail(ADD_USAGE);
  refuseIfSubjectTooLong(subject, "<task>");
  const status = String(flags.status ?? "backlog");
  if (!STATUSES.includes(status))
    fail(`invalid status "${status}". valid: ${STATUSES.join(" | ")}`);
  let priority = "";
  if (flags.priority != null && flags.priority !== true) {
    const p = normalizePriority(flags.priority);
    if (p === undefined)
      fail(`invalid --priority "${flags.priority}". valid: ${PRIORITIES.join(" | ")} | none`);
    priority = p;
  }
  let kind = "";
  if (flags.kind != null && flags.kind !== true) {
    const k = normalizeKind(flags.kind);
    if (k === undefined) fail(`invalid --kind "${flags.kind}". valid: auto | manual`);
    kind = k;
  }
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
  const todo = newTodo(data, {
    subject,
    description: typeof flags.description === "string" ? flags.description : "",
    status,
    priority,
    kind,
    change: Boolean(flags.change),
    scheduled: typeof flags.scheduled === "string" ? flags.scheduled : null,
    plan: typeof flags.plan === "string" ? flags.plan : "",
    project: target,
    from,
    by: typeof flags.by === "string" ? flags.by : "claude",
  });
  save(file, data);
  process.stdout.write(
    `ok: added #${todo.number} ${todo.id} [${status}] (${target ? `project ${target}` : "global"}) ${subject}\n`,
  );
  // Preventive channel (t#250): hand the newborn task to the configured
  // match CLI in the background — warnings land as a comment by pickup time.
  notifyTaskEvent(todo, "add");
}

// The row `todos add` writes, factored out so `todos apply` (t#314) creates its
// tasks the same way instead of hand-building a second shape of the record.
// Pushes onto `data` and returns the row; SAVING and the add-notification stay
// with the caller, because apply writes many rows in one pass.
export function newTodo(data, fields = {}) {
  const now = new Date().toISOString();
  const status = STATUSES.includes(fields.status) ? fields.status : "backlog";
  const todo = {
    id: randomUUID(),
    // Stable human-facing number for inline `t#N` references, mirroring
    // todos.rs::ensure_numbers (next after the current max). The app backfills
    // any unnumbered rows on load, so a 0 here would still be fixed up later.
    number: nextNumber(data),
    subject: String(fields.subject ?? "").trim(),
    description: typeof fields.description === "string" ? fields.description : "",
    status,
    // Seed the transition log (t#87) with the birth status, so intervals can be
    // derived without special-casing "no history yet" for new rows.
    status_history: [{ status, at: now }],
    // Omit the field entirely when unset, mirroring todos.rs (skip_serializing_if).
    ...(fields.priority ? { priority: fields.priority } : {}),
    ...(fields.kind ? { kind: fields.kind } : {}),
    // Change root (t#255, renamed at t#345): the aggregator of a change — it
    // depends_on all its children and carries the delta in description.
    ...(fields.change ? { change: true } : {}),
    scheduled_for: typeof fields.scheduled === "string" ? fields.scheduled : null,
    plan: typeof fields.plan === "string" ? fields.plan : "",
    // Omit project/from when absent (global / same-project), mirroring the Rust
    // skip_serializing_if and `set-project`'s clear path — a global add no longer
    // writes a redundant `"project": null` (issue #54 review B1).
    ...(fields.project ? { project: fields.project } : {}),
    ...(fields.from ? { from: fields.from } : {}),
    // This CLI is Claude's interface (the hook tells Claude to use it), so a
    // task added here is AI-composed unless the caller overrides with --by user.
    created_by: fields.by || "claude",
    created_at: now,
    updated_at: now,
  };
  data.todos.push(todo);
  return todo;
}

const RM_USAGE =
  "usage: cli todos rm <task> [--go]\n" +
  "       deletes a task and every reference to it (dep edges, ref links, ?issue).\n" +
  "       --dry-run is the DEFAULT: it prints what would go, --go does it.";

// Delete a task (t#323). The board had no way to undo an `add` at all, so a
// duplicate born of a half-applied file could only be removed by hand in the UI.
//
// Two things make deletion safe enough to have: it is a DRY RUN unless `--go`
// (the same shape as `apply` and `run`, and for the same reason — this one is
// irreversible), and it refuses nothing quietly. Every edge that pointed at the
// task is listed BEFORE it goes, because those edges are what the graph means:
// a dep edge holds the frontier, an ?issue target carries the loop.
function cmdRemove(args) {
  const { positional, flags } = parseArgs(args);
  const file = todosPath();
  const data = load(file);
  const todo = resolveTask(data, positional[0]);
  if (!todo) fail(RM_USAGE);

  const dependents = data.todos.filter(
    (t) => t && Array.isArray(t.depends_on) && t.depends_on.includes(todo.id),
  );
  const refs = data.todos.filter((t) => t && Array.isArray(t.links) && t.links.includes(todo.id));
  const transitions = data.todos.filter((t) => t && t.on_issue === todo.id);
  const prereqs = directPrereqs(data, todo);

  const lines = [
    `#${todo.number} ${todo.subject}  [${col(todo.status)}]`,
    ...(prereqs.length ? [`  depends on:  ${prereqs.map((t) => "#" + t.number).join(", ")}`] : []),
    ...(dependents.length
      ? [`  blocks:      ${dependents.map((t) => "#" + t.number).join(", ")} — the edge goes with it`]
      : []),
    ...(refs.length ? [`  referenced:  ${refs.map((t) => "#" + t.number).join(", ")}`] : []),
    ...(transitions.length
      ? [`  ?issue from: ${transitions.map((t) => "#" + t.number).join(", ")} — that transition is left with no target`]
      : []),
    ...(Array.isArray(todo.comments) && todo.comments.length
      ? [`  comments:    ${todo.comments.length} — deleted with the task`]
      : []),
  ];

  if (!flags.go) {
    process.stdout.write(
      lines.join("\n") + "\n" + "DRY RUN — nothing deleted. Do it: todos rm " + todo.number + " --go\n",
    );
    return;
  }

  for (const t of dependents) {
    t.depends_on = t.depends_on.filter((id) => id !== todo.id);
    if (!t.depends_on.length) delete t.depends_on;
    t.updated_at = new Date().toISOString();
  }
  for (const t of refs) {
    t.links = t.links.filter((id) => id !== todo.id);
    if (!t.links.length) delete t.links;
    t.updated_at = new Date().toISOString();
  }
  // An ?issue pointing at a deleted task is the dangling reference `lint` reports,
  // so it is cleared here rather than left for the linter to find.
  for (const t of transitions) {
    delete t.on_issue;
    t.updated_at = new Date().toISOString();
  }
  data.todos = data.todos.filter((t) => t && t.id !== todo.id);
  save(file, data);
  process.stdout.write(
    lines.join("\n") +
      `\nok: deleted #${todo.number} (${dependents.length + refs.length + transitions.length} reference(s) cleared)\n`,
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
    const todo = resolveTask(data, id); // id | N | #N, as the help promises
    if (!todo) fail(`no todo with id ${id}`);
    if (!Array.isArray(todo.comments)) todo.comments = [];
    const now = new Date().toISOString();
    const comment = { id: randomUUID(), author, body, created_at: now };
    todo.comments.push(comment);
    todo.updated_at = now;
    save(file, data);
    process.stdout.write(
      `ok: comment ${comment.id} on ${todo.number != null ? `#${todo.number}` : todo.id} by ${author}\n`,
    );
    return;
  }
  if (sub === "list") {
    const id = String(rest.find((a) => !a.startsWith("--")) ?? "").trim();
    if (!id) fail(COMMENT_USAGE);
    const file = todosPath();
    const todo = resolveTask(load(file), id); // id | N | #N
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

// --- task-event notify (t#250) ----------------------------------------------
//
// The PUBLIC half of the preventive match-plan channel. The tracker knows
// NOTHING about any knowledge base: when a task is created or moves toward
// execution it hands the event to the kb-style CLI configured in settings
// (`matchPlanCli`, the same key the ExitPlanMode hook uses) — and that CLI owns
// everything else: matching, its dedup state, which projects it skips, and
// posting warnings back through the public `todos comment add`.
//
// Contract (extends the plan-hook `match-plan --text` one):
//   <cli> match-warn --todo <task-id> --event <add|queue|in_progress> --tracker-cli <path-to-cli.mjs>
// The CLI must be quiet and harmless when it has nothing to say. add/queue fire
// DETACHED so task recording never waits on it; in_progress runs INLINE with
// stdout passed through — that is the "before work starts" moment, whatever the
// CLI prints should reach the session that just picked the task up. Failures
// are silent: warnings are an extra, never a gate. CLI-only: transitions
// dragged in the tracker UI do not pass here.

const NOTIFY_TIMEOUT_MS = 30_000; // inline budget, same as the ExitPlanMode hook

function trackerCliPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
}

// `opts` (cli / trackerCli / exec / spawner) is the seam for the unit tests.
export function notifyTaskEvent(todo, event, opts = {}) {
  try {
    const cli = opts.cli ?? matchPlanCli();
    if (!cli) return;
    const argv = [
      cli,
      "match-warn",
      "--todo",
      todo.id,
      "--event",
      event,
      "--tracker-cli",
      opts.trackerCli ?? trackerCliPath(),
    ];
    if (event === "in_progress") {
      const exec = opts.exec ?? execFileSync;
      const out = exec(process.execPath, argv, {
        encoding: "utf8",
        timeout: NOTIFY_TIMEOUT_MS,
        windowsHide: true,
      });
      if (String(out || "").trim()) {
        process.stdout.write("\n" + String(out).trimEnd() + "\n");
      }
    } else {
      const spawner = opts.spawner ?? spawn;
      spawner(process.execPath, argv, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  } catch {
    // warnings are an extra, never a gate
  }
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

// Resolve a task locator to its todo object. Accepts an id, a bare number, a
// `#N` reference, or the `t#N` task-link form the hook/README train the agent to
// write — the graph/dep CLI is friendlier with the human-facing notation the
// board shows. Returns undefined if nothing matches.
export function resolveTask(data, token) {
  const t = String(token ?? "").trim();
  if (!t) return undefined;
  const byId = data.todos.find((x) => x && x.id === t);
  if (byId) return byId;
  // Strip an optional leading `t` (task-link form) then an optional `#`.
  const num = t.replace(/^t?#?/i, "");
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

// The dep-edge write, shared by `dep add` and `apply` (t#314): self-edge, board
// and acyclicity are checked HERE, so a graph built from a file cannot bypass a
// guard the typed command enforces. Mutates `data`; the caller saves.
export function addDepEdge(data, from, on) {
  if (from.id === on.id) fail("a task can't depend on itself");
  if (boardOf(from) !== boardOf(on))
    fail("dependencies must stay within one project board");
  if (depReaches(data, on.id, from.id)) fail("that dependency would create a cycle");
  if (!Array.isArray(from.depends_on)) from.depends_on = [];
  if (from.depends_on.includes(on.id)) return "already";
  from.depends_on.push(on.id);
  from.updated_at = new Date().toISOString();
  return "added";
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
      if (addDepEdge(data, from, on) === "already") {
        process.stdout.write(`ok: #${from.number} already depends on #${on.number}\n`);
        return;
      }
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

// Direct prerequisites of a task (the tasks it DEPENDS ON), resolved to objects.
// Only direct depends_on — cumulative context rides the authored handoff text.
function directPrereqs(data, t) {
  return (Array.isArray(t.depends_on) ? t.depends_on : [])
    .map((id) => data.todos.find((x) => x && x.id === id))
    .filter(Boolean);
}

// Nearest CHANGE roots above a task (t#252, renamed at t#345): walk UP the
// reverse dep edges (the tasks that depend on `t`, transitively) and collect
// the first node with `change` on along each branch (legacy `theme: true`
// reads the same way, isChangeRoot) — the closest aggregator is the one whose
// vision frames this subtask, so the walk does not continue past a found root
// (an outer change wrapping an inner one stays out of view). Exported for the
// SessionStart hook (hook.mjs), which surfaces the same vision for in_progress
// tasks.
export function changeAsRoot(record, data) {
  if (!record) return null;
  const members = (data?.todos ?? []).filter((x) => x && x.change_id === record.id);
  const closed = members.length > 0 && members.every((x) => isDone(x));
  return {
    id: record.id,
    number: record.number,
    address: `c#${record.number}`,
    subject: record.title,
    description: record.delta ?? "",
    plan: record.plan ?? "",
    spec: Array.isArray(record.spec) ? [...record.spec] : [],
    status: closed ? "done" : "queue",
    budget_usd: record.budget_usd,
    parallel_limit: record.parallel_limit,
    record: true,
    depends_on: members.map((x) => x.id),
  };
}

export function changeRootsFor(data, t) {
  if (t?.change_id) {
    const record = (data?.changes ?? []).find((c) => c && c.id === t.change_id);
    if (record) return [changeAsRoot(record, data)];
  }
  const roots = [];
  const seen = new Set([t.id]);
  let frontier = [t.id];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const d of data.todos) {
        if (!d || seen.has(d.id)) continue;
        if (!Array.isArray(d.depends_on) || !d.depends_on.includes(id)) continue;
        seen.add(d.id);
        if (isChangeRoot(d)) roots.push(d);
        else next.push(d.id);
      }
    }
    frontier = next;
  }
  return roots;
}

// Human-readable block of the vision a task inherits from its change root(s)
// — the counterpart of formatInheritedHandoff for the OTHER direction: handoff
// flows down the dep edges, the vision is read UP them (t#255 field roles: a
// change root's description carries it). Shared by `vision <task>` and the
// in_progress anchor so both read identically.
export function formatChangeVision(t, roots) {
  let out = `★ Vision inherited by #${t.number} "${t.subject}" from its change root(s) — the chain's north star; keep this task true to it (if it pulls away, stop and flag it):\n`;
  for (const r of roots) {
    out += `\n── change ${r.address ?? `t#${r.number}`} ${r.subject} [${col(r.status)}] ──\n`;
    out +=
      r.description && r.description.trim()
        ? r.description.trim() + "\n"
        : `(change ${r.address ?? `t#${r.number}`} has no delta — its vision is missing; write it on the record)\n`;
  }
  return out;
}

// Which spec address(es) a task carries into context at the in_progress anchor
// (t#340, docs/specs/README.md §7/§8): the task's OWN `spec` field wins outright
// when it has one; only when it has none does the walk fall back to the nearest
// change root(s)' `spec` (`roots`, from changeRootsFor — same up-walk the vision
// uses). This is a fallback, not a merge: a task carrying its own `spec` never
// also inherits its root's, so the two can't double-print the same address.
// Addresses collected from several roots are deduped in encounter order, since
// two branches can name the same section.
export function specAddressesFor(t, roots) {
  const own = Array.isArray(t.spec) ? t.spec.filter(Boolean) : [];
  if (own.length) return { source: "task", addresses: own };
  const seen = new Set();
  const addresses = [];
  for (const r of roots) {
    for (const a of Array.isArray(r.spec) ? r.spec.filter(Boolean) : []) {
      if (!seen.has(a)) {
        seen.add(a);
        addresses.push(a);
      }
    }
  }
  return { source: "root", addresses };
}

// One addressed section's block, in the exact three shapes `showSection` can
// answer (docs/specs/README.md §4's required third answer): found (its ready-
// to-inject text, heading + part + refs + prose, refs as ADDRESSES only — never
// expanded to text, per §7), no such address, or declared-but-unavailable
// (external repo not cloned/configured here) — the last two are printed, not
// swallowed, so a missing section reads as "missing", never as silence.
function formatSpecSection(address, opts = {}) {
  const res = showSection(address, opts.root, opts.appData);
  if (!res.ok) return `— ${address}: ${res.reason}`;
  if (res.remote && !res.available) {
    return (
      `— ${address}: ${res.unavailable}` +
      (res.stub && res.stub.trim() ? `\n\n${res.stub.trim()}` : "")
    );
  }
  return res.text && res.text.trim() ? res.text.trim() : `— ${address}: (empty section)`;
}

// Human-readable block of the spec section(s) addressed by <task>'s (or its
// change root's) `spec` field — printed WHOLE and NEXT TO the change vision
// (formatChangeVision), never instead of it: the vision stays the change's
// delta, this is the spec's long-lived state (docs/specs/README.md §1/§7).
// `spec` is the `{ source, addresses }` specAddressesFor returns.
// Fingerprint the addressed sections AS SHOWN, on the task. This is the
// baseline the closing answer is checked against: `spec answer updated` used to
// stamp provenance without comparing anything, so a verdict of "the section
// moved" cost exactly as much as "it did not" — and §7's whole provenance story
// rested on it. Recorded at the injection anchor because that is the only
// moment we know what text the session was actually given.
//
// Does not save: every caller is already inside a write that saves.
export function recordSpecBaseline(t, addresses, opts = {}) {
  if (!Array.isArray(addresses) || !addresses.length) return;
  const at = new Date().toISOString();
  const seen = Array.isArray(t.spec_seen) ? t.spec_seen.slice() : [];
  for (const address of addresses) {
    const hash = sectionFingerprint(address, opts.root);
    if (!hash) continue;
    // Block hashes as well as the whole-section one: the closing answer diffs
    // against them to record WHICH bullets this task moved, not just that
    // something moved.
    //
    // And the text itself, because hashes can only ever answer "did it move".
    // Showing WHAT moved — the delta a change is, side by side, the way a diff
    // shows it — needs the bytes that were there before, and this is the one
    // moment they exist. Bounded by the section budget (README §7, ~120 lines),
    // which is what makes keeping a copy per (task, section) affordable at all.
    const blocks = blocksOf(address, opts.root);
    const entry = {
      address,
      hash,
      blocks: blocks.map((b) => b.hash),
      text: blocks.map((b) => b.text).join("\n"),
      at,
    };
    const i = seen.findIndex((x) => x && x.address === address);
    if (i >= 0) seen[i] = entry;
    else seen.push(entry);
  }
  if (seen.length) t.spec_seen = seen;
}

export function formatSpecSections(t, spec, opts = {}) {
  const { source, addresses } = spec;
  if (!addresses.length) return "";
  const who =
    source === "task"
      ? `#${t.number} "${t.subject}"'s own \`spec\` field`
      : `the \`spec\` field of #${t.number} "${t.subject}"'s change root(s)`;
  const blocks = addresses.map((a) => formatSpecSection(a, opts));
  return (
    `📘 Spec section(s) addressed by ${who} — read in FULL before touching this area:\n\n` +
    blocks.join("\n\n") +
    `\n\n(any \`refs:\` line above names OTHER sections by address only — pull one's own text ` +
    `only if you actually need it, not preemptively)\n`
  );
}

// Human-readable block of what a task inherits from its prerequisites' handoff.
// Shared by `handoff <task>` and the in_progress anchor so both read identically.
function formatInheritedHandoff(t, prereqs) {
  let out = `Handoff inherited by #${t.number} "${t.subject}" from its direct prerequisites:\n`;
  for (const p of prereqs) {
    out += `\n── t#${p.number} ${p.subject} [${p.status}] ──\n`;
    out +=
      p.handoff && p.handoff.trim()
        ? p.handoff.trim() + "\n"
        : `(no handoff on t#${p.number} — proceed without it)\n`;
  }
  return out;
}

const HANDOFF_USAGE =
  "usage: cli todos handoff <task> [--json]            read the handoff of <task>'s DIRECT prerequisites\n" +
  '       cli todos handoff set <task> --text "<body>"  set <task>\'s own handoff (passed to its dependents)\n' +
  "       cli todos handoff clear <task>\n" +
  "       <task> is an id, a number, or #N";

// Handoff carried FORWARD along dependency edges (#141). A task's `handoff` is what
// it produced / where it left off, written by the LLM. A
// session working on a task reads the handoffs of the tasks it DEPENDS ON, so the
// work it builds on is in context. Only DIRECT prerequisites are read — cumulative
// context still flows because a handoff is authored prose that can itself reference
// upstream tasks (t#N), so no transitive walk is needed. Mirrors the `handoff`
// field in todos.rs.
function cmdHandoff(args) {
  const [sub, ...rest] = args;
  const file = todosPath();
  const data = load(file);

  // WRITE — set / clear this task's own handoff.
  if (sub === "set" || sub === "clear") {
    const { positional, flags } = parseArgs(rest);
    const t = resolveTask(data, positional[0]);
    if (!t) fail(HANDOFF_USAGE);
    if (sub === "set") {
      const body = typeof flags.text === "string" ? flags.text : "";
      if (!body.trim()) fail(HANDOFF_USAGE);
      t.handoff = body;
      // `handoff_at` (todos.rs) is when the BATON was written, as opposed to
      // updated_at, which any edit bumps. The Stop guard reads it to tell a baton
      // written for this session's work from one an earlier session left behind.
      t.handoff_at = new Date().toISOString();
      t.updated_at = t.handoff_at;
      save(file, data);
      process.stdout.write(`ok: handoff set on #${t.number}\n`);
      return;
    }
    // clear
    if (t.handoff) {
      delete t.handoff;
      delete t.handoff_at;
      t.updated_at = new Date().toISOString();
      save(file, data);
    }
    process.stdout.write(`ok: handoff cleared on #${t.number}\n`);
    return;
  }

  // READ — the handoffs of <task>'s direct prerequisites (what it inherits).
  const { positional, flags } = parseArgs(args);
  const t = resolveTask(data, positional[0]);
  if (!t) fail(HANDOFF_USAGE);
  const prereqs = directPrereqs(data, t);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          task: { id: t.id, number: t.number, subject: t.subject },
          root: prereqs.length === 0,
          prerequisites: prereqs.map((p) => ({
            id: p.id,
            number: p.number,
            subject: p.subject,
            status: p.status,
            handoff: p.handoff || "",
            has_handoff: !!(p.handoff && p.handoff.trim()),
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // No dependencies → this is a root task; there's nothing upstream to inherit.
  if (!prereqs.length) {
    process.stdout.write(
      `#${t.number} "${t.subject}" is a root task — it depends on nothing, so there is no upstream handoff to inherit.\n`,
    );
    return;
  }
  process.stdout.write(formatInheritedHandoff(t, prereqs));
}

const VISION_USAGE =
  "usage: cli todos vision <task> [--json]   read the vision <task> inherits from its change root(s)\n" +
  "       <task> is an id, a number, or #N. A change root's description carries it (`set description` writes it).";

// `todos vision <task>` — the read counterpart of `handoff <task>` for the UP
// direction (t#252): the description of the nearest change root(s) above <task>.
// Auto-printed by `set status <task> in_progress`; this re-reads it on demand.
function cmdVision(args) {
  const { positional, flags } = parseArgs(args);
  const file = todosPath();
  const data = load(file);
  const t = resolveTask(data, positional[0]);
  if (!t) fail(VISION_USAGE);
  const roots = changeRootsFor(data, t);
  const specLink = specAddressesFor(t, roots);
  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          task: { id: t.id, number: t.number, subject: t.subject },
          change_roots: roots.map((r) => ({
            id: r.id,
            number: r.number,
            subject: r.subject,
            status: col(r.status),
            vision: r.description || "",
            has_vision: !!(r.description && r.description.trim()),
          })),
          spec: specLink,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (!roots.length && !specLink.addresses.length) {
    process.stdout.write(
      `#${t.number} "${t.subject}" has no change above it and no spec link of its own — nothing to inherit. (A change is a record: \`cli change new "<title>"\`, then \`todos set change <id> <c#N>\`. A spec link is \`todos set spec <id> <домен>#<слаг>\`.)\n`,
    );
    return;
  }
  if (roots.length) process.stdout.write(formatChangeVision(t, roots));
  if (specLink.addresses.length) {
    process.stdout.write((roots.length ? "\n" : "") + formatSpecSections(t, specLink));
  }
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

// `todos ready` — the pipeline frontier: tasks whose every dependency is `done`
// (so they can be worked NOW) and that aren't done themselves. This is the Beads-
// style "what's ready" query #88 references. `review` is NOT `done`, so a task
// waiting on a prerequisite in review stays OUT of the list — mirroring the graph's
// blocked/ready derivation and docs/task-pipeline.md. A dependency-free task counts
// as ready (nothing blocks it). Scope mirrors `list` (cwd project + global by
// default; --project <name> / --all). Filter with --auto | --manual; --json for raw.
function cmdReady(args) {
  const { flags } = parseArgs(args);
  const all = load(todosPath()).todos.filter(Boolean);
  const byId = new Map(all.map((t) => [t.id, t]));

  let scope;
  if (flags.all) {
    scope = all;
  } else if (typeof flags.project === "string") {
    const p = flags.project.trim();
    scope = all.filter((t) => (t.project || "") === p);
  } else {
    const cwdProject = path.basename(process.cwd().replace(/[\\/]+$/, ""));
    scope = all.filter((t) => !t.project || t.project === cwdProject);
  }

  let ready = scope.filter((t) => isReadyNode(t, byId));
  // --auto / --manual narrow to a kind (the runnable frontier vs the human gates).
  if (flags.auto) ready = ready.filter((t) => t.kind === "auto");
  if (flags.manual) ready = ready.filter((t) => t.kind !== "auto");
  ready.sort((a, b) => (a.number || 0) - (b.number || 0));

  if (flags.json) {
    process.stdout.write(JSON.stringify(ready, null, 2) + "\n");
    return;
  }
  if (!ready.length) {
    process.stdout.write("(no ready tasks)\n");
    return;
  }
  for (const t of ready) {
    const kind = t.kind === "auto" ? "auto" : "manual";
    const proj = t.project || "global";
    process.stdout.write(
      `#${t.number} [${col(t.status)}/${kind}] ${proj} — ${t.subject}\n`,
    );
  }
}

// One compact line of what a node has DECLARED (t#302) — kind, produces,
// verify, retry, budget, parallel limit and the ?issue transition — plus the
// §15 warning when a node claims `auto` without a check: the authority to close
// comes from the check, not from the flag, so such a node runs as a gate. This
// listing is the discipline channel the DSL leans on (§8): `kind` was set on 3
// of 20 nodes while the field was invisible, so the declarations are printed
// where the pipeline instructions are read. `byId` resolves the ?issue target;
// `ready` marks a node of the frontier with ▸.
export function formatDeclarations(t, byId, { ready = false } = {}) {
  const parts = [t.kind === "auto" ? "auto" : "manual"];
  const produces = (Array.isArray(t.produces) ? t.produces : []).filter(Boolean);
  if (produces.length) parts.push(`produces: ${produces.join(", ")}`);
  if (hasVerify(t)) parts.push(`verify: ${String(t.verify).trim()}`);
  if (typeof t.retry_limit === "number") parts.push(`retry: <=${t.retry_limit}`);
  if (typeof t.budget_usd === "number") parts.push(`budget: $${t.budget_usd}`);
  if (typeof t.parallel_limit === "number") parts.push(`parallel: ${t.parallel_limit}`);
  if (t.on_issue) {
    const target = byId?.get?.(t.on_issue);
    parts.push(`?issue -> ${target ? `#${target.number}` : t.on_issue}`);
  }
  let out = `  ${ready ? "▸" : " "} #${t.number} [${col(t.status)}] ${t.subject} — ${parts.join(" · ")}\n`;
  if (t.kind === "auto" && !hasVerify(t)) {
    out += `      ⚠ auto without verify — runs as a GATE: todos set verify ${t.number} "<cmd>"\n`;
  }
  return out;
}

// A node "has declarations" when anything of the process language landed on it.
// `kind: auto` counts: it is the declaration that changes WHO may close the node,
// so an auto node is never filtered out of the board listing.
function hasDeclarations(t) {
  return !!(
    t.kind === "auto" ||
    (Array.isArray(t.produces) && t.produces.filter(Boolean).length) ||
    hasVerify(t) ||
    typeof t.retry_limit === "number" ||
    typeof t.budget_usd === "number" ||
    typeof t.parallel_limit === "number" ||
    t.on_issue
  );
}

// `todos pipeline` — how to drive the board as a DAG (#88), followed by what THIS
// board has actually declared. Rewritten for t#310: the text names the COMMANDS
// and the handful of rules a machine cannot check; everything checkable was moved
// into the commands themselves, which refuse with the reason and the fix. Kept
// self-contained (no file dependency) so it works from any project; the fuller
// version with rationale lives in docs/task-pipeline.md. Scope mirrors
// `list`/`ready`: cwd project + global, or --project <name> / --all.
function cmdPipeline(args = []) {
  process.stdout.write(
    "Task pipeline (#88) — the board is a dependency graph. A task = a node; an edge\n" +
      "A->B means A waits for B. STATUS (kanban column) and PIPELINE STATE (blocked or\n" +
      "ready, derived from the edges) are orthogonal; KIND decides who closes a node.\n\n" +
      "COMMANDS\n" +
      '  todos add "<subject>" [--project <name> | --global] [--kind auto|manual] [--change]\n' +
      "  todos dep add <task> <depends-on>    the edge: <task> waits for <depends-on>\n" +
      "  todos dep list <task>                its deps + dependents\n" +
      "  todos produces add <task> <path>     what the step promises to produce\n" +
      "  todos set <field> <task> <value>     " +
      fieldList(39) +
      "\n" +
      "                                       run `todos set` for each field's values\n" +
      "  todos ready [--auto | --manual]      the frontier: every dep done (review is NOT)\n" +
      "  todos take <id>                      bind THIS session to a task; a status move\n" +
      "                                       to in_progress already binds it\n" +
      '  todos handoff set <task> --text "…"  the baton, written AFTER the work\n' +
      "  todos outcome <task> [--verify ok|issue]   promised -> produced -> consumed\n" +
      "  todos run <change> [--dry-run | --go]       autonomous run of a change's graph\n" +
      "  todos vision <task>                  the vision this task inherits from its change\n\n" +
      "The CLI refuses what it can check — an unknown field or value, closing a node\n" +
      "with an unfinished prerequisite, a ?issue transition without a retry limit, a\n" +
      "declaration on a closed node, the same text in two fields — and says how to fix\n" +
      "it. Read the refusal; do not work around it.\n\n" +
      "WHAT IT CANNOT CHECK FOR YOU\n" +
      "  - manual node: you do the work, the USER moves review -> done. Stop there and\n" +
      "    send a PushNotification — the pipeline parked and needs their call. It\n" +
      "    self-skips if they are at the terminal.\n" +
      "  - auto node: do the work, run the check, close it yourself. Mark auto only what\n" +
      "    a headless run can actually verify.\n" +
      "  - declare BEFORE the work (produces, verify, retry, budget), report after\n" +
      "    (handoff). A field the plan is silent about stays UNDECLARED — never guessed.\n" +
      "  - one role per field: description = WHAT & WHY (a change root's = the change's\n" +
      "    DELTA — what this round changes, and why now), plan = HOW (steps + order),\n" +
      "    handoff = the baton, comments = journal.\n" +
      "  - a change is worth a root from ~4-5 nodes.\n\n" +
      "Full guide + rationale: docs/task-pipeline.md (claude-usage-tracker repo).\n",
  );
  printBoardDeclarations(args);
}

// What THIS board has declared (t#302), printed right under the instructions.
// Only OPEN nodes: a closed one can no longer be given a contract. Of those, only
// the ones a reader can act on — the frontier, whatever carries a declaration
// (auto included, so every auto-without-verify is listed) — and the rest as a
// single count. A per-node "nothing declared" line was 13 of ~100 lines of this
// output and told the reader nothing the count does not.
function printBoardDeclarations(args) {
  const { flags } = parseArgs(args);
  const all = load(todosPath()).todos.filter(Boolean);
  const byId = new Map(all.map((t) => [t.id, t]));
  let scope;
  if (flags.all) {
    scope = all;
  } else if (typeof flags.project === "string") {
    const p = flags.project.trim();
    scope = all.filter((t) => (t.project || "") === p);
  } else {
    const cwdProject = path.basename(process.cwd().replace(/[\\/]+$/, ""));
    scope = all.filter((t) => !t.project || t.project === cwdProject);
  }
  const open = scope.filter((t) => !isDone(t)).sort((a, b) => (a.number || 0) - (b.number || 0));
  process.stdout.write(
    "\nTHIS BOARD — ▸ = frontier, then kind · produces · verify · retry · budget · ?issue:\n",
  );
  if (!open.length) {
    process.stdout.write("  (no open tasks)\n");
    return;
  }
  let quiet = 0;
  for (const t of open) {
    const ready = isReadyNode(t, byId);
    if (!ready && !hasDeclarations(t)) {
      quiet++;
      continue;
    }
    process.stdout.write(formatDeclarations(t, byId, { ready }));
  }
  if (quiet) {
    process.stdout.write(
      `  ${quiet} more open node(s): blocked and undeclared.\n`,
    );
  }
  const bare = open.filter((t) => t.kind === "auto" && !hasVerify(t));
  if (bare.length) {
    process.stdout.write(
      `  ${bare.length} auto node(s) without a check run as gates — declare verify or set kind manual.\n`,
    );
  }
}

function usage(code) {
  process.stdout.write(
    "cli todos - Claude Usage Tracker todo CLI\n\n" +
      '  add "<subject>" [--project <name> | --global] [--from <project>] [--status <status>]\n' +
      "                  [--description <text>] [--plan <text>] [--scheduled <YYYY-MM-DD>] [--kind auto|manual]\n" +
      "                  no --project → the current project (cwd); --global = project-less\n" +
      "  set <field> <task> <value>      the ONE setter — field ∈ " +
      fieldList(34) +
      "\n" +
      '                                  plan/description take --text "<md>"; run `cli todos set`\n' +
      "                                  for every field's values and the rule each one carries\n" +
      "  take <id> [--session <id>]      bind THIS session to a task for cost attribution (t#295);\n" +
      "                                  needed when the binding didn't come from a move to in_progress:\n" +
      "                                  continuing after /clear, or picking a review task back up\n" +
      "  rm <task> [--go]                delete a task and every reference to it; --dry-run is the DEFAULT\n" +
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
      "  produces add <task> <path>      process DSL (t#302): declare an output BEFORE the work (path|interface|record)\n" +
      "  produces rm  <task> <path>      withdraw a declared output\n" +
      "  produces list <task> [--json]   what <task> promised to produce\n" +
      "  apply <file> [--go] [--force] [--json]\n" +
      "                                  record a whole process graph from a file (t#314): change, steps,\n" +
      "                                  needs → dep edges, produces/verify/retry/on-issue/kind/budget.\n" +
      "                                  --dry-run is the DEFAULT; re-applying matches steps by subject\n" +
      "  lint [<change>] [--json]         check the RECORDED graph against the same invariants apply checks\n" +
      "                                  on a file (t#313): dangling ?issue, a transition with no retry limit,\n" +
      "                                  a cycle, a change with no budget, a node closed on an unreconciled promise\n" +
      "  adoption [--since <date> | --days N] [--json]\n" +
      "                                  is the language actually used (t#315): did the plan ritual fire, are\n" +
      "                                  produces/verify filled (§18: 70%), what apply refused, doubled steps,\n" +
      "                                  what the injected texts cost. Reads transcripts + journal, writes nothing\n" +
      "  outcome <task> [--verify ok|issue] [--write] [--json]\n" +
      "                                  reconcile promised -> produced -> consumed (t#304) and print the machine\n" +
      "                                  predicate ok|issue; the declared verify is run by the RUNNER, not here\n" +
      "  run <change> [--dry-run | --go] [--parallel N] [--timeout <min>] [--json]\n" +
      "                                  autonomous run of a change's graph (t#305): frontier → step → verify →\n" +
      "                                  outcome, one session per step. --dry-run is the DEFAULT and prints the plan\n" +
      "  handoff <task> [--json]         read the handoff of <task>'s direct prerequisites (deps it inherits)\n" +
      '  handoff set <task> --text "…"   set <task>\'s own handoff (carried to tasks that depend on it)\n' +
      "  handoff clear <task>            drop <task>'s own handoff\n" +
      "  vision <task> [--json]          read the vision <task> inherits from its nearest change root(s) up the dep graph\n" +
      "                                  (a change root's DESCRIPTION carries it; auto-printed on -> in_progress)\n" +
      "  related <project> [--json]      projects that work with <project>\n" +
      "  groups [--json]                 list association groups\n" +
      "  ready [--project <name> | --all] [--auto | --manual] [--json]\n" +
      "                                  pipeline frontier: tasks whose deps are all done (review ≠ done)\n" +
      "  pipeline [--project <name> | --all]\n" +
      "                                  how to drive the task graph (#88), then what the board's open\n" +
      "                                  nodes have actually declared (t#302)\n" +
      "\n" +
      "  Inline task references (inside a description/comment): write t#N, e.g. \"blocked by t#12\".\n" +
      "  A bare #N is read as a GitHub PR/issue and is NOT linked — always prefix a task reference with t.\n" +
      "\n" +
      "  Handoff (`handoff set`) — write for the NEXT task, the one that depends on this:\n" +
      "    DO:  the concrete outcome a dependent builds on (files/paths, interfaces, schema,\n" +
      "         decisions made); where it left off if unfinished; gotchas/constraints; the\n" +
      "         suggested next step. Reference related tasks as t#N so context chains forward.\n" +
      "    DON'T: restate the task's own subject/description (the dependent can read those);\n" +
      "         session chatter or notes-to-self; step-by-step of how you got there; secrets.\n" +
      "    Keep it short and specific — a baton, not a log. Empty is fine (nothing to pass on).\n" +
      "  Moving a task to `in_progress` AUTO-prints the handoff it inherits, so starting a task\n" +
      "  hands you its prerequisites' batons without asking. `handoff <task>` re-reads it.\n",
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
    case "set":
      cmdSet(rest);
      break;
    case "take":
      cmdTake(rest);
      break;
    case "produces":
      cmdProduces(rest);
      break;
    case "rm":
      cmdRemove(rest);
      break;
    // Loaded lazily: the reconciliation reads transcripts and imports back from
    // this module, so a static import would close a cycle and make every plain
    // `todos list` pay for a parser it never uses.
    case "outcome":
      return import("./outcome.mjs").then((m) => m.run(rest));
    // Same reason for the lazy load: the runner imports back from this module and
    // pulls in the step executor, and a plain `todos list` must not pay for it.
    case "run":
      return import("./run.mjs").then((m) => m.run(rest));
    // Lazy for the same reason: the file reader is dead weight for every command
    // that is not recording a graph.
    case "apply":
      return import("./apply.mjs").then((m) => m.run(rest));
    // Lazy too — it pulls in the rule table and the runner's change closure.
    case "lint":
      return import("./lint.mjs").then((m) => m.run(rest));
    // Lazy as well: the field-run metric reads transcripts and the plan hook, and
    // no ordinary board command should pay for either.
    case "adoption":
      return import("./adoption.mjs").then((m) => m.run(rest));
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
    case "handoff":
      cmdHandoff(rest);
      break;
    case "vision":
      cmdVision(rest);
      break;
    case "related":
      cmdRelated(rest);
      break;
    case "groups":
      cmdGroups(rest);
      break;
    case "ready":
      cmdReady(rest);
      break;
    case "pipeline":
      cmdPipeline(rest);
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
