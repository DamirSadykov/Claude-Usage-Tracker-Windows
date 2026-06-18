#!/usr/bin/env node
// CLI for Claude Code to mutate the tracker's todo list WITHOUT hand-editing
// todos.json. Ships next to cc-todos-hook.mjs; the SessionStart hook tells Claude
// to call this instead of rewriting the file directly.
//
// Why a CLI: hand-edited JSON is fragile — Claude can break formatting, set an
// invalid status, clobber a field, or race the tracker's own atomic write. This
// funnels every change through one validated, atomic path (temp file + rename),
// mirroring src-tauri/src/todos.rs. The status set MUST stay in sync with
// `todos.rs::STATUSES` and the kanban columns in TodoWindow.vue.
//
// Commands:
//   add "<subject>" [--project <name>] [--status <status>] [--description <text>]
//                   [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>]
//   set-status <id> <status>        status ∈ backlog|queue|in_progress|review|done
//   comment add <id> --text "<body>" [--by claude|user]
//   comment list <id> [--json]
//   list [--project <name>] [--json]
//
// Exit code is non-zero on any error (bad status, unknown id, usage), so a
// caller can tell success from failure.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Kanban columns, in board order. Keep in lockstep with todos.rs::STATUSES.
const STATUSES = ["backlog", "queue", "in_progress", "review", "done"];

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
  if (!id || !status) fail("usage: cc-todos set-status <id> <status>");
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
  'usage: cc-todos add "<subject>" [--project <name>] [--status <status>] ' +
  "[--description <text>] [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>] [--by user|claude]";

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
  const now = new Date().toISOString();
  const todo = {
    id: randomUUID(),
    subject,
    description: typeof flags.description === "string" ? flags.description : "",
    status,
    estimate_minutes: estimate,
    scheduled_for: typeof flags.scheduled === "string" ? flags.scheduled : null,
    plan: typeof flags.plan === "string" ? flags.plan : "",
    project: typeof flags.project === "string" ? flags.project : null,
    // This CLI is Claude's interface (the hook tells Claude to use it), so a
    // task added here is AI-composed unless the caller overrides with --by user.
    created_by: typeof flags.by === "string" ? flags.by : "claude",
    created_at: now,
    updated_at: now,
  };
  const file = todosPath();
  const data = load(file);
  data.todos.push(todo);
  save(file, data);
  process.stdout.write(`ok: added ${todo.id} [${status}] ${subject}\n`);
}

const COMMENT_USAGE =
  'usage: cc-todos comment add <id> --text "<body>" [--by claude|user]\n' +
  "       cc-todos comment list <id> [--json]";

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
  if (pi !== -1 && args[pi + 1]) {
    const p = args[pi + 1];
    todos = todos.filter((t) => (t.project || "") === p);
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
    process.stdout.write(`[${t.status}] ${t.subject}  ⟨id:${t.id}⟩\n`);
  }
}

function usage(code) {
  process.stdout.write(
    "cc-todos - Claude Usage Tracker todo CLI\n\n" +
      '  add "<subject>" [--project <name>] [--status <status>]\n' +
      "                  [--description <text>] [--plan <text>] [--estimate <min>] [--scheduled <YYYY-MM-DD>]\n" +
      "  set-status <id> <status>        status ∈ " +
      STATUSES.join(" | ") +
      "\n" +
      '  comment add <id> --text "<body>" [--by claude|user]\n' +
      "  comment list <id> [--json]\n" +
      "  list [--project <name>] [--json]\n",
  );
  process.exit(code);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "add":
    cmdAdd(rest);
    break;
  case "set-status":
    cmdSetStatus(rest[0], rest[1]);
    break;
  case "comment":
    cmdComment(rest);
    break;
  case "list":
    cmdList(rest);
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
