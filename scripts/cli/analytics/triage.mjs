// `cli.mjs triage` — publish/read the nightly-triage DIGEST without hand-editing
// the file. Lazily loaded by ../cli.mjs. The nightly triage agent (a scheduled
// Claude session, see task #35) reads a compact extract of the board, reasons
// about it, and writes its findings to a file; `triage publish` assembles the
// digest. The tracker watches the resulting `triage-digest.json` and raises a
// desktop notification + an in-app summary (later phases).
//
// Why a separate file + CLI (not todos.json): the digest is DERIVED, regenerated
// each run, and strictly advisory — it must never touch the user's board (the
// triage agent is read-only over todos by design). Keeping it in its own file
// means a bad/partial digest can't corrupt the shared todo list, and the writer
// path is one validated, atomic temp+rename — mirroring todos.mjs / todos.rs.
//
// Commands (run as `cli.mjs triage <cmd>`):
//   export --today <YYYY-MM-DD> --out-dir <dir>  extract cut into parts + ready facts
//   publish [--file <path>] [--json <inline>] [--dir <export-dir>]
//                                               write the digest (else read stdin)
//   show [--json]                               print the current digest
//   clear                                       remove the digest file
//
// The on-disk shape (snake_case, matching the rest of the app's wire format),
// mirrored by src-tauri/src/triage.rs::TriageDigest:
//   {
//     "version": 1,
//     "generated_at": "<ISO-8601>",      // stamped by publish if absent
//     "project": "<basename>" | null,    // which board this triage covered
//     "headline": "<short line>",        // <=140 chars, for the notification
//     "summary": "<prose>",              // human digest, for the in-app card
//     "items": [                         // findings + suggestions
//       { "kind": "stale|overdue|no_priority|suggestion|link",
//         "number": <int>|null, "id": "<uuid>"|null,
//         "subject": "<str>", "note": "<str>",
//         "related": <int> }              // only for kind "link": the other task
//     ]
//   }
//
// Exit code is non-zero on any error (bad JSON, bad shape, usage), so the caller
// (and the triage prompt) can tell success from failure.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appDataFile, writeJsonAtomic } from "../kernel/appdata.mjs";
import { load as loadBoard, todosPath } from "../kernel/board-io.mjs";

// Finding kinds the digest understands. Keep in lockstep with triage.rs::KINDS
// and the in-app digest view. `stale`/`overdue`/`no_priority` are facts computed
// by `export` (not by the agent); `suggestion` is an advisory move and `link`
// ties task `number` to the task in `related` (never applied here).
const KINDS = ["stale", "overdue", "no_priority", "suggestion", "link"];
const FACT_KINDS = ["overdue", "stale", "no_priority"];
const FACT_LABELS = { overdue: "просрочено", stale: "без движения", no_priority: "без приоритета" };
const DAY_MS = 86400000;
const WINDOW_DAYS = 14;
const EXCERPT_MAX = 160;
const WARN_BYTES = 200 * 1024;
const ACTIVE = ["queue", "in_progress", "review"];
const NO_PROJECT = "без проекта";

// Same app data dir the tracker, todos CLI, and hook use; the digest lives next
// to todos.json so the tracker finds it without extra config.
function digestPath() {
  return appDataFile("triage-digest.json");
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Forgiving read: a missing/corrupt file yields null (no digest yet), mirroring
// the read-side contract in triage.rs::load. `show` turns that into a friendly
// note; the tracker treats it as "nothing to surface".
function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// Minimal `--flag value` parser (same shape as todos.mjs): positional args plus
// flag pairs; a flag with no following value becomes `true`.
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

const PUBLISH_USAGE =
  "usage: cli triage publish [--file <path>] [--json <inline>] [--dir <export-dir>]\n" +
  "       (with none of them, the digest JSON is read from stdin)";

// Read the raw digest JSON the caller is publishing: --file <path>, --json
// <inline>, or stdin (fd 0). Exactly one source; --file wins over --json.
function readInput(flags) {
  if (typeof flags.file === "string") {
    try {
      return readFileSync(flags.file, "utf8");
    } catch (e) {
      fail(`cannot read --file ${flags.file}: ${(e && e.message) || e}`);
    }
  }
  if (typeof flags.json === "string") return flags.json;
  try {
    return readFileSync(0, "utf8");
  } catch {
    fail(PUBLISH_USAGE);
  }
}

function readJsonFile(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`cannot read ${what} ${file}: ${(e && e.message) || e}`);
  }
}

function dayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t;
}

function factsFor(task, todayMs) {
  const out = [];
  const base = { number: task.number ?? null };
  if (task.scheduled_for && task.status !== "done") {
    const due = dayStart(String(task.scheduled_for).slice(0, 10));
    if (due != null && due < todayMs) {
      const days = Math.round((todayMs - due) / DAY_MS);
      out.push({ kind: "overdue", ...base, note: `просрочена на ${days} дн.` });
    }
  }
  if (ACTIVE.includes(task.status)) {
    const upd = Date.parse(task.updated_at);
    if (!Number.isNaN(upd) && upd < todayMs - WINDOW_DAYS * DAY_MS) {
      const days = Math.floor((todayMs - upd) / DAY_MS);
      out.push({ kind: "stale", ...base, note: `без движения ${days} дн.` });
    }
    if (!task.priority) {
      out.push({ kind: "no_priority", ...base, note: `без приоритета, колонка ${task.status}` });
    }
  }
  return out;
}

// Association groups (project-groups.json, written by the app). Same forgiving
// read as todos.mjs::loadGroups, duplicated on purpose: analytics must not import
// from board, and a new shared module would need a tauri bundle.resources entry.
function loadGroups() {
  try {
    const data = JSON.parse(readFileSync(appDataFile("project-groups.json"), "utf8"));
    return Array.isArray(data?.groups) ? data.groups.filter((g) => g && typeof g === "object") : [];
  } catch {
    return [];
  }
}

// Which part a task belongs to: its manual group (a project in several groups
// goes to the first one in file order), else its own project, else "no project".
function unitKey(project, groups) {
  if (!project) return { key: "none", name: NO_PROJECT, projects: [] };
  const g = groups.findIndex((x) => Array.isArray(x.projects) && x.projects.includes(project));
  if (g >= 0) return { key: `g${g}`, name: String(groups[g].name || `группа ${g + 1}`), order: g, projects: [] };
  return { key: `p:${project}`, name: project, projects: [project] };
}

function cmdExport(args) {
  const { flags } = parseArgs(args);
  const todayMs = typeof flags.today === "string" ? dayStart(flags.today) : null;
  if (todayMs == null || typeof flags["out-dir"] !== "string")
    fail("usage: cli triage export --today <YYYY-MM-DD> --out-dir <dir>");
  const dir = flags["out-dir"];

  const data = loadBoard(todosPath());
  const todos = Array.isArray(data?.todos) ? data.todos.filter((t) => t && typeof t === "object") : [];
  const changes = new Map((data?.changes ?? []).filter(Boolean).map((c) => [c.id, c.title]));
  const groups = loadGroups();
  const cutoff = todayMs - WINDOW_DAYS * DAY_MS;

  const units = new Map();
  const dropped = { doneOld: 0, backlogNoDate: 0 };
  let factTotal = 0;
  let taskTotal = 0;
  for (const t of todos) {
    const status = t.status;
    let keep;
    if (status === "done") {
      const upd = Date.parse(t.updated_at);
      keep = !Number.isNaN(upd) && upd >= cutoff;
      if (!keep) dropped.doneOld++;
    } else if (ACTIVE.includes(status)) {
      keep = true;
    } else {
      keep = !!t.scheduled_for;
      if (!keep) dropped.backlogNoDate++;
    }
    if (!keep) continue;
    const k = unitKey(t.project, groups);
    let u = units.get(k.key);
    if (!u) units.set(k.key, (u = { ...k, projectSet: new Set(), facts: [], tasks: [] }));
    if (t.project) u.projectSet.add(t.project);
    const facts = factsFor(t, todayMs);
    u.facts.push(...facts);
    factTotal += facts.length;
    const desc = typeof t.description === "string" ? t.description.replace(/\s+/g, " ").trim() : "";
    const change = (t.change_id && changes.get(t.change_id)) || (typeof t.change === "string" ? t.change : null);
    const row = { number: t.number ?? null, subject: t.subject ?? "", status };
    const needs = (Array.isArray(t.depends_on) ? t.depends_on : [])
      .map((id) => todos.find((candidate) => candidate.id === id)?.number)
      .filter(Number.isInteger);
    if (needs.length) row.needs = needs;
    if (t.priority) row.priority = t.priority;
    if (t.project) row.project = t.project;
    if (t.scheduled_for) row.scheduled_for = String(t.scheduled_for).slice(0, 10);
    if (t.updated_at) row.updated = String(t.updated_at).slice(0, 10);
    if (change) row.change = change;
    if (desc) row.excerpt = desc.slice(0, EXCERPT_MAX);
    u.tasks.push(row);
    taskTotal++;
  }

  const rank = (u) => (u.key === "none" ? 2 : u.order != null ? 0 : 1);
  const ordered = [...units.values()].sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0));

  try {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (/^unit-\d+(\.digest)?\.json$/.test(f)) unlinkSync(path.join(dir, f));
    }
  } catch (e) {
    fail(`cannot prepare --out-dir ${dir}: ${(e && e.message) || e}`);
  }
  const lines = (rows) => rows.map((r) => JSON.stringify(r)).join(",\n");
  const index = [];
  let bytes = 0;
  ordered.forEach((u, i) => {
    u.facts.sort((a, b) => FACT_KINDS.indexOf(a.kind) - FACT_KINDS.indexOf(b.kind));
    const unit = { name: u.name, projects: u.projects.length ? u.projects : [...u.projectSet].sort() };
    const file = `unit-${i + 1}.json`;
    const json =
      `{"today":${JSON.stringify(flags.today)},\n"unit":${JSON.stringify(unit)},\n` +
      `"facts":[\n${lines(u.facts)}\n],\n"tasks":[\n${lines(u.tasks)}\n]}\n`;
    try {
      writeFileSync(path.join(dir, file), json);
    } catch (e) {
      fail(`cannot write ${file} in ${dir}: ${(e && e.message) || e}`);
    }
    bytes += Buffer.byteLength(json);
    index.push({
      ...unit,
      file,
      digest: `unit-${i + 1}.digest.json`,
      tasks: u.tasks.length,
      facts: u.facts.length,
      agent: u.tasks.length >= 2,
    });
  });
  writeFileSync(path.join(dir, "units.json"), JSON.stringify({ today: flags.today, units: index }, null, 1) + "\n");

  const droppedTotal = dropped.doneOld + dropped.backlogNoDate;
  process.stdout.write(
    `triage export: всего ${todos.length}, в выжимке ${taskTotal}, отброшено ${droppedTotal}` +
      ` (done старше ${WINDOW_DAYS} дн.: ${dropped.doneOld}, backlog без срока: ${dropped.backlogNoDate});` +
      ` фактов ${factTotal}; частей ${index.length}, с агентом ${index.filter((u) => u.agent).length}\n`,
  );
  if (bytes > WARN_BYTES) {
    process.stderr.write(`warning: выжимка ${Math.round(bytes / 1024)} КБ — больше 200 КБ\n`);
  }
}

function validateItem(it, where) {
  if (!it || typeof it !== "object" || Array.isArray(it)) fail(`${where} must be an object`);
  if (!KINDS.includes(it.kind)) fail(`${where}.kind must be one of: ${KINDS.join(" | ")}`);
  if (typeof it.subject !== "string" || !it.subject.trim())
    fail(`${where}.subject must be a non-empty string`);
  if (it.number != null && !Number.isInteger(it.number)) fail(`${where}.number must be an integer`);
  if (it.id != null && typeof it.id !== "string") fail(`${where}.id must be a string`);
  if (it.note != null && typeof it.note !== "string") fail(`${where}.note must be a string`);
  if (it.kind === "link" && !Number.isInteger(it.related))
    fail(`${where}.related must be an integer for kind "link"`);
  const item = {
    kind: it.kind,
    number: it.number == null ? null : it.number,
    id: it.id == null ? null : it.id,
    subject: it.subject,
    note: typeof it.note === "string" ? it.note : "",
  };
  if (it.kind === "link") item.related = it.related;
  return item;
}

function boardByNumber() {
  return new Map(
    (loadBoard(todosPath())?.todos ?? []).filter((t) => t && Number.isInteger(t.number)).map((t) => [t.number, t]),
  );
}

function hasDependencyPath(from, target, byId) {
  const seen = new Set();
  const stack = [from.id];
  while (stack.length) {
    const id = stack.pop();
    if (id === target.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = byId.get(id);
    for (const dependency of Array.isArray(task?.depends_on) ? task.depends_on : []) {
      if (!seen.has(dependency)) stack.push(dependency);
    }
  }
  return false;
}

function withoutGraphLinks(items, byNumber) {
  const byId = new Map([...byNumber.values()].filter((task) => typeof task.id === "string").map((task) => [task.id, task]));
  let dropped = 0;
  const kept = items.filter((item) => {
    if (item.kind !== "link") return true;
    const number = byNumber.get(item.number);
    const related = byNumber.get(item.related);
    const connected =
      number && related &&
      (hasDependencyPath(number, related, byId) || hasDependencyPath(related, number, byId));
    if (!connected) return true;
    dropped++;
    return false;
  });
  return { items: kept, dropped };
}

// Validate one agent digest (a whole one or one part's): scalar types, items
// shape; task identity is canonicalized from the board by number. Agent output
// is advisory, so a stale subject or an id copied from another task must never
// become a link in the published digest.
function readAgentItems(input, byNumber, where) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${where} must be a JSON object`);
  for (const key of ["headline", "summary"]) {
    if (input[key] != null && typeof input[key] !== "string") fail(`${where}: "${key}" must be a string`);
  }
  const rawItems = input.items == null ? [] : input.items;
  if (!Array.isArray(rawItems)) fail(`${where}: "items" must be an array`);
  const items = rawItems.map((it, i) => validateItem(it, `${where}.items[${i}]`));
  for (const item of items) {
    const known = item.number != null ? byNumber.get(item.number) : null;
    if (known) {
      item.id = known.id ?? null;
      item.subject = known.subject ?? "";
    }
  }
  return items;
}

function digestFromDir(dir) {
  const index = readJsonFile(path.join(dir, "units.json"), "units.json in --dir");
  if (!Array.isArray(index?.units)) fail("units.json has no units array");
  const byNumber = boardByNumber();
  const facts = [];
  const rest = [];
  const summaries = [];
  for (const [i, u] of index.units.entries()) {
    const exported = readJsonFile(path.join(dir, u.file), "part file");
    if (!Array.isArray(exported?.facts)) fail(`${u.file} has no facts array`);
    exported.facts.forEach((f, j) => {
      const known = f && byNumber.get(f.number);
      const filled = known ? { ...f, id: known.id ?? null, subject: known.subject ?? "" } : f;
      const item = validateItem(filled, `${u.file}.facts[${j}]`);
      if (!FACT_KINDS.includes(item.kind))
        fail(`${u.file}.facts[${j}].kind must be one of: ${FACT_KINDS.join(" | ")}`);
      facts.push(item);
    });
    const digestName = u.digest || `unit-${i + 1}.digest.json`;
    const digestFile = path.join(dir, digestName);
    if (!existsSync(digestFile)) {
      if (u.agent) summaries.push(`${u.name}: дайджест части не получен.`);
      continue;
    }
    const part = readJsonFile(digestFile, "part digest");
    const items = readAgentItems(part, byNumber, digestName);
    rest.push(...items.filter((it) => !FACT_KINDS.includes(it.kind)));
    const text = typeof part.summary === "string" ? part.summary.trim() : "";
    if (text) summaries.push(`${u.name}: ${text}`);
  }
  facts.sort((a, b) => FACT_KINDS.indexOf(a.kind) - FACT_KINDS.indexOf(b.kind));
  const count = (k) => facts.filter((f) => f.kind === k).length;
  const parts = FACT_KINDS.filter((k) => count(k)).map((k) => `${count(k)} ${FACT_LABELS[k]}`);
  const filtered = withoutGraphLinks(rest, byNumber);
  const links = filtered.items.filter((it) => it.kind === "link").length;
  if (links) parts.push(`${links} связей`);
  return {
    headline: parts.length ? parts.join(" · ") : "Всё в порядке",
    summary: summaries.join("\n\n"),
    items: [...facts, ...filtered.items],
    droppedLinks: filtered.dropped,
  };
}

// Validate + normalize the incoming digest, then write it atomically. Unlike the
// forgiving read side, publish is STRICT: a malformed digest is rejected (exit 1)
// rather than written, so the tracker never has to defend against junk and the
// triage prompt gets a clear failure it can retry. Stamps version=1 and, if the
// caller didn't supply one, generated_at=now. With --dir the digest is assembled
// from the parts of an `export --out-dir` run instead of read from a file.
function cmdPublish(args) {
  const { flags } = parseArgs(args);
  let input;
  let items;
  let droppedLinks = 0;
  if (typeof flags.dir === "string") {
    input = digestFromDir(flags.dir);
    items = input.items;
    droppedLinks = input.droppedLinks;
  } else {
    const raw = readInput(flags);
    try {
      input = JSON.parse(raw);
    } catch (e) {
      fail(`digest is not valid JSON: ${(e && e.message) || e}`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      fail("digest must be a JSON object");
    }
    if (input.project != null && typeof input.project !== "string") fail('"project" must be a string or null');
    if (input.generated_at != null && typeof input.generated_at !== "string")
      fail('"generated_at" must be an ISO-8601 string');
    items = readAgentItems(input, boardByNumber(), "digest");
  }

  const digest = {
    version: 1,
    generated_at:
      typeof input.generated_at === "string"
        ? input.generated_at
        : new Date().toISOString(),
    project: typeof input.project === "string" ? input.project : null,
    headline: typeof input.headline === "string" ? input.headline : "",
    summary: typeof input.summary === "string" ? input.summary : "",
    items,
  };

  const file = digestPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, digest);
  process.stdout.write(
    `ok: published digest (${items.length} item(s)) -> ${file}\n`,
  );
  if (typeof flags.dir === "string") process.stdout.write(`отброшено связей по графу: ${droppedLinks}\n`);
}

function cmdShow(args) {
  const file = digestPath();
  const digest = load(file);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    return;
  }
  if (!digest) {
    process.stdout.write("(no triage digest yet)\n");
    return;
  }
  process.stdout.write(`generated_at: ${digest.generated_at || "?"}\n`);
  if (digest.project) process.stdout.write(`project: ${digest.project}\n`);
  if (digest.headline) process.stdout.write(`headline: ${digest.headline}\n`);
  if (digest.summary) process.stdout.write(`\n${digest.summary}\n`);
  const items = Array.isArray(digest.items) ? digest.items : [];
  if (items.length) {
    process.stdout.write("\nitems:\n");
    for (const it of items) {
      const num = it.number != null ? `#${it.number} ` : "";
      // Subject on its own line, the note (the advice) indented below with an
      // arrow — keeps "which task" and "what to do" visually separate, mirroring
      // the in-app digest popover.
      process.stdout.write(`  [${it.kind}] ${num}${it.subject || ""}\n`);
      if (it.note) process.stdout.write(`        → ${it.note}\n`);
    }
  }
}

function cmdClear() {
  const file = digestPath();
  try {
    unlinkSync(file);
    process.stdout.write(`ok: removed ${file}\n`);
  } catch {
    // Already absent → nothing to do; clearing is idempotent.
    process.stdout.write("ok: no digest to remove\n");
  }
}

function usage(code) {
  process.stdout.write(
    "cli triage - Claude Usage Tracker nightly-triage digest\n\n" +
      "  export --today <YYYY-MM-DD> --out-dir <dir>  extract cut into parts\n" +
      "  publish [--file <path>] [--json <inline>] [--dir <export-dir>]\n" +
      "                                              write the digest (else stdin)\n" +
      "  show [--json]                               print the current digest\n" +
      "  clear                                       remove the digest file\n",
  );
  process.exit(code);
}

// Entry for the unified dispatcher: `cli.mjs triage <cmd> …` → run([...]).
export function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "export":
      cmdExport(rest);
      break;
    case "publish":
      cmdPublish(rest);
      break;
    case "show":
      cmdShow(rest);
      break;
    case "clear":
      cmdClear();
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
