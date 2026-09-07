import { randomUUID } from "node:crypto";
import { boardPath, loadBoard, saveBoard } from "./todos.mjs";

export const CHANGE_REF = /^c\s*#?\s*(\d+)$/i;

export function parseChangeRef(ref) {
  const s = String(ref ?? "").trim();
  if (!s) return null;
  const m = s.match(CHANGE_REF);
  if (m) return { number: Number(m[1]) };
  if (/^\d+$/.test(s)) return { number: Number(s) };
  return { id: s };
}

export function changesOf(data) {
  return Array.isArray(data?.changes) ? data.changes.filter(Boolean) : [];
}

export function nextChangeNumber(data) {
  let max = 0;
  for (const c of changesOf(data)) {
    if (typeof c.number === "number" && c.number > max) max = c.number;
  }
  return max + 1;
}

export function changeAddress(change) {
  if (!change) return "";
  if (change.legacy) return `t#${change.number}`;
  return `c#${change.number}`;
}

export function createChange(data, fields = {}) {
  if (!Array.isArray(data.changes)) data.changes = [];
  const title = String(fields.title ?? "").trim();
  if (!title) throw new Error("a change needs a title");
  const now = new Date().toISOString();
  const change = {
    id: randomUUID(),
    number: nextChangeNumber(data),
    title,
    delta: String(fields.delta ?? ""),
    project: fields.project ?? null,
    spec: Array.isArray(fields.spec) ? [...fields.spec] : [],
    created_at: now,
    updated_at: now,
  };
  if (fields.budget_usd !== undefined && fields.budget_usd !== null)
    change.budget_usd = fields.budget_usd;
  if (fields.parallel_limit !== undefined && fields.parallel_limit !== null)
    change.parallel_limit = fields.parallel_limit;
  data.changes.push(change);
  return change;
}

export function byRecency(a, b) {
  const ta = Date.parse(a?.created_at ?? "");
  const tb = Date.parse(b?.created_at ?? "");
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  return (b?.number ?? 0) - (a?.number ?? 0);
}

export function sortedChanges(data) {
  return [...changesOf(data)].sort(byRecency);
}

export function findChange(data, ref) {
  const parsed = parseChangeRef(ref);
  if (!parsed) return null;
  const list = changesOf(data);
  if (parsed.number !== undefined)
    return list.find((c) => c.number === parsed.number) ?? null;
  return list.find((c) => c.id === parsed.id) ?? null;
}

export function findChangeByTitle(data, title, project) {
  const wanted = String(title ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const sameBoard = (c) =>
    project === undefined || (c.project ?? null) === (project ?? null);
  return (
    changesOf(data).find(
      (c) => sameBoard(c) && String(c.title ?? "").trim().toLowerCase() === wanted,
    ) ?? null
  );
}

const isClosedTask = (t) => (t?.status ?? "") === "done";

const isLegacyRoot = (t) => !!(t && (t.change ?? t.theme));

export function legacyRootsOf(data, todo) {
  if (!todo) return [];
  const byId = new Map((data?.todos ?? []).map((t) => [t.id, t]));
  const seen = new Set([todo.id]);
  const roots = [];
  const dependents = (id) =>
    (data?.todos ?? []).filter((t) => (t.depends_on ?? []).includes(id));
  const walk = (id) => {
    for (const up of dependents(id)) {
      if (seen.has(up.id)) continue;
      seen.add(up.id);
      if (isLegacyRoot(up)) roots.push(up);
      else walk(up.id);
    }
  };
  if (isLegacyRoot(todo)) return [todo];
  walk(todo.id);
  return roots.filter((r) => byId.has(r.id));
}

export function legacyChange(root) {
  if (!root) return null;
  const change = {
    id: root.id,
    number: root.number,
    title: root.subject,
    delta: root.description ?? "",
    project: root.project ?? null,
    spec: Array.isArray(root.spec) ? [...root.spec] : [],
    legacy: true,
  };
  if (root.budget_usd !== undefined && root.budget_usd !== null)
    change.budget_usd = root.budget_usd;
  if (root.parallel_limit !== undefined && root.parallel_limit !== null)
    change.parallel_limit = root.parallel_limit;
  return change;
}

export function changeOfTask(data, todo) {
  if (!todo) return null;
  if (todo.change_id) {
    const hit = changesOf(data).find((c) => c.id === todo.change_id);
    if (hit) return hit;
  }
  const [root] = legacyRootsOf(data, todo);
  return root ? legacyChange(root) : null;
}

export function membersOf(data, change) {
  if (!change) return [];
  const todos = data?.todos ?? [];
  if (!change.legacy) return todos.filter((t) => t.change_id === change.id);
  const byId = new Map(todos.map((t) => [t.id, t]));
  const root = byId.get(change.id);
  if (!root) return [];
  const out = [];
  const seen = new Set([root.id]);
  const stack = [...(root.depends_on ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const t = byId.get(id);
    if (!t || isLegacyRoot(t)) continue;
    out.push(t);
    stack.push(...(t.depends_on ?? []));
  }
  return out;
}

export function changeProgress(data, change) {
  const members = membersOf(data, change);
  return {
    total: members.length,
    done: members.filter(isClosedTask).length,
  };
}

export function changeStatus(data, change) {
  if (!change) return "open";
  const { total, done } = changeProgress(data, change);
  return total > 0 && done === total ? "closed" : "open";
}

export function isChangeOpen(data, change) {
  return changeStatus(data, change) === "open";
}

export function legacyChanges(data) {
  return (data?.todos ?? [])
    .filter(isLegacyRoot)
    .map((root) => ({ ...legacyChange(root), created_at: root.created_at }));
}

export function allChanges(data) {
  return [...changesOf(data), ...legacyChanges(data)].sort(byRecency);
}

const USAGE =
  'usage: cli change new "<title>" [--project <name> | --global] [--delta "<text>"]\n' +
  "                    [--spec <домен#слаг>[,<…>]] [--budget <usd>] [--parallel <N>]\n" +
  "       cli change list [--project <name> | --all] [--json]\n" +
  "       cli change show <c#N> [--json]\n" +
  "       cli change close <c#N>\n" +
  "       cli change set title|delta|spec|budget|parallel <c#N> <value>\n" +
  "       cli change migrate [--go]        root tasks -> records; dry run by default\n\n" +
  "A change is a RECORD, not a task: it holds the delta, the spec sections and the\n" +
  "group's ceilings, while a task points at it through `todos set change <task> c#N`.\n" +
  "Its status is derived — open while any of its tasks is open — and never stored.\n" +
  "Roots not migrated yet are listed under their old address t#N.";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const currentProject = () => process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? null;

function numberFlag(value, name) {
  if (value === undefined) return undefined;
  const n = Number(String(value).replace(/^\$/, ""));
  if (!Number.isFinite(n) || n <= 0) fail(`refusing: --${name} takes a positive number`);
  return n;
}

export function formatChangeLine(data, change) {
  const { done, total } = changeProgress(data, change);
  const status = changeStatus(data, change);
  const caps = [
    change.budget_usd === undefined ? "" : `$${change.budget_usd}`,
    change.parallel_limit === undefined ? "" : `параллельно ${change.parallel_limit}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    `${changeAddress(change)} [${status}] ${change.title}` +
    ` — ${done}/${total} готово` +
    (change.project ? ` · ${change.project}` : "") +
    (caps ? ` · ${caps}` : "") +
    (change.legacy ? " · не мигрирован" : "")
  );
}

function cmdNew(args) {
  const { positional, flags } = parseArgs(args);
  const title = String(positional[0] ?? flags.title ?? "").trim();
  if (!title) fail(USAGE);
  const file = boardPath();
  const data = loadBoard(file);
  const project = flags.global ? null : String(flags.project ?? currentProject());
  const twin = findChangeByTitle(data, title, project);
  if (twin)
    fail(
      `refusing: ${changeAddress(twin)} on this board already carries that title.\n` +
        `  point the task at it instead: todos set change <task> ${changeAddress(twin)}`,
    );
  const change = createChange(data, {
    title,
    delta: flags.delta === true ? "" : (flags.delta ?? ""),
    project,
    spec: flags.spec && flags.spec !== true ? String(flags.spec).split(",").map((s) => s.trim()).filter(Boolean) : [],
    budget_usd: numberFlag(flags.budget, "budget"),
    parallel_limit: numberFlag(flags.parallel, "parallel"),
  });
  saveBoard(file, data);
  process.stdout.write(`ok: ${changeAddress(change)} "${change.title}"\n`);
}

function cmdList(args) {
  const { flags } = parseArgs(args);
  const data = loadBoard(boardPath());
  const project = flags.all ? null : String(flags.project ?? currentProject());
  const list = allChanges(data).filter(
    (c) => flags.all || (c.project ?? null) === project || c.project == null,
  );
  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        list.map((c) => ({
          address: changeAddress(c),
          ...c,
          status: changeStatus(data, c),
          progress: changeProgress(data, c),
        })),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (!list.length) {
    process.stdout.write("нет ни одного change'а на этой доске\n");
    return;
  }
  for (const c of list) process.stdout.write(formatChangeLine(data, c) + "\n");
}

function resolveOrFail(data, ref) {
  const hit = findChange(data, ref) ?? allChanges(data).find((c) => changeAddress(c) === String(ref).trim());
  if (!hit) fail(`refusing: no change ${ref} — see them all: cli change list --all`);
  return hit;
}

function cmdShow(args) {
  const { positional, flags } = parseArgs(args);
  if (!positional[0]) fail(USAGE);
  const data = loadBoard(boardPath());
  const change = resolveOrFail(data, positional[0]);
  const members = membersOf(data, change);
  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          address: changeAddress(change),
          ...change,
          status: changeStatus(data, change),
          progress: changeProgress(data, change),
          tasks: members.map((t) => ({ number: t.number, subject: t.subject, status: t.status })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  process.stdout.write(formatChangeLine(data, change) + "\n");
  if (change.delta) process.stdout.write(`\n${change.delta}\n`);
  if (change.spec?.length) process.stdout.write(`\nразделы спеки: ${change.spec.join(", ")}\n`);
  if (!members.length) {
    process.stdout.write("\nни одной задачи не смотрит на этот change\n");
    return;
  }
  process.stdout.write("\nзадачи:\n");
  for (const t of members)
    process.stdout.write(`  #${t.number} [${t.status}] ${t.subject}\n`);
}

function cmdClose(args) {
  const { positional } = parseArgs(args);
  if (!positional[0]) fail(USAGE);
  const file = boardPath();
  const data = loadBoard(file);
  const change = resolveOrFail(data, positional[0]);
  if (change.legacy)
    fail(
      `refusing: ${changeAddress(change)} is still a root task — close it as a task, or migrate the board first.`,
    );
  const { done, total } = changeProgress(data, change);
  if (total === 0)
    fail(`refusing: ${changeAddress(change)} has no tasks — nothing it could have finished.`);
  if (done < total)
    fail(
      `refusing: ${changeAddress(change)} still has ${total - done} open task(s).\n` +
        `  its status is derived, so closing it means closing them: cli change show ${changeAddress(change)}`,
    );
  if (change.closed_at) {
    process.stdout.write(`ok: ${changeAddress(change)} already closed at ${change.closed_at}\n`);
    return;
  }
  change.closed_at = new Date().toISOString();
  change.updated_at = change.closed_at;
  saveBoard(file, data);
  process.stdout.write(`ok: ${changeAddress(change)} closed — ${total} task(s) done\n`);
}

const SET_FIELDS = {
  title: (change, value) => {
    const title = String(value).trim();
    if (!title) fail("refusing: a change needs a title");
    change.title = title;
    return title;
  },
  delta: (change, value) => {
    change.delta = String(value);
    return change.delta.split("\n")[0];
  },
  spec: (change, value) => {
    const list = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length || list[0] === "none") {
      delete change.spec;
      return "none";
    }
    change.spec = list;
    return list.join(", ");
  },
  budget: (change, value) => {
    if (String(value).trim() === "none") {
      delete change.budget_usd;
      return "none";
    }
    change.budget_usd = numberFlag(value, "budget");
    return `$${change.budget_usd}`;
  },
  parallel: (change, value) => {
    if (String(value).trim() === "none") {
      delete change.parallel_limit;
      return "none";
    }
    change.parallel_limit = numberFlag(value, "parallel");
    return String(change.parallel_limit);
  },
};

function cmdSet(args) {
  const { positional, flags } = parseArgs(args);
  const [field, ref] = positional;
  const value = flags.text !== undefined ? flags.text : positional.slice(2).join(" ");
  if (!field || !SET_FIELDS[field])
    fail(`usage: cli change set <${Object.keys(SET_FIELDS).join("|")}> <c#N> <value>`);
  if (!ref) fail(`usage: cli change set ${field} <c#N> <value>`);
  const file = boardPath();
  const data = loadBoard(file);
  const change = resolveOrFail(data, ref);
  if (change.legacy)
    fail(
      `refusing: ${changeAddress(change)} is still a root task — set the field on the task, or migrate the board first.`,
    );
  const shown = SET_FIELDS[field](change, value);
  change.updated_at = new Date().toISOString();
  saveBoard(file, data);
  process.stdout.write(`ok: ${changeAddress(change)} ${field} -> ${shown}\n`);
}

async function cmdMigrate(args) {
  const { flags } = parseArgs(args);
  const { describe: describeMigration, migrate } = await import("./change-migrate.mjs");
  const file = boardPath();
  const data = loadBoard(file);
  const lines = describeMigration(data);
  if (!lines.length) {
    process.stdout.write("нечего мигрировать: ни одного корня с флагом на доске\n");
    return;
  }
  process.stdout.write(lines.join("\n") + "\n");
  if (!flags.go) {
    process.stdout.write("\nсухой прогон, ничего не записано — повтори с --go\n");
    return;
  }
  const result = migrate(data);
  saveBoard(file, data);
  for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(
    `ok: ${result.created.length} запис(и) заведено, ${result.roots} корней снято с доски\n`,
  );
}

export function run(args) {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE + "\n");
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "new") return cmdNew(rest);
  if (cmd === "list") return cmdList(rest);
  if (cmd === "show") return cmdShow(rest);
  if (cmd === "close") return cmdClose(rest);
  if (cmd === "set") return cmdSet(rest);
  if (cmd === "migrate") return cmdMigrate(rest);
  fail(`unknown command: ${cmd}\n\n${USAGE}`);
}
