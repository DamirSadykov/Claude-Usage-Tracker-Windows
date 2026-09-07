// `cli todos apply <file>` — the tracker READS a process graph instead of being
// driven into one command by command (t#314).
//
// Why this exists. Recording a plan used to cost a page of instruction: the exit
// prompt of plan mode had to name every command, every field and every rule, and
// 45% of that text was the command list alone. A file changes what the prompt has
// to say — the vocabulary of keys IS the instruction, and the rules move here, to
// code that refuses a bad graph instead of prose that asks for a good one.
//
// The file is the OWN vocabulary of the DSL (§3), in the YAML-ish shape the model
// reaches for unprompted (t#308 measured it: what is recognised is the FORM —
// steps/needs — not any particular external language):
//
//   change: CHANGE: <name>       # optional; without it the steps land rootless
//   vision: <what & why>         # the change root's description
//   plan: |                      # optional STEPS/ORDER text on the root
//   parallel: 2                  # how many steps the runner may drive at once
//   budget: 5                    # the group's ceiling in USD
//   steps:
//     1:
//       title: <the step phrase>
//       needs: [2, 3]            # BLOCKING edges -> depends_on
//       produces: [path, ...]    # promised outputs (§6)
//       verify: npm test         # the check that decides the outcome (§7)
//       retry: 3                 # attempt limit (§11)
//       on-issue: 2              # run-layer transition, NEVER a dep edge (§12)
//       kind: auto | manual      # who closes it (§8)
//       budget: 2
//
// Nothing here writes to the board directly: every task, edge and declaration
// goes through todos.mjs (newTodo / addDepEdge / addProduces / setField), so a
// graph built from a file passes exactly the guards a typed command passes.
// `--dry-run` is the DEFAULT, mirroring `todos run` — the file is read, checked
// and the changes printed; `--go` applies them.

import { readFileSync } from "node:fs";
import {
  boardPath,
  loadBoard,
  saveBoard,
  withDeferredSave,
  isDone,
  newTodo,
  addDepEdge,
  addProduces,
  setField,
  resolveTask,
  normalizeLimit,
  notifyTaskEvent,
} from "./todos.mjs";
import { checkGraph, splitFindings } from "./graph-rules.mjs";
import { createChange, findChangeByTitle, changeAddress } from "./change.mjs";
import { parseYamlSubset } from "./yaml-subset.mjs";
import path from "node:path";

const USAGE =
  "usage: cli todos apply <file> [--go] [--force] [--json]\n" +
  "       reads a process graph and records it: tasks, dep edges, declarations.\n" +
  "       --dry-run is the DEFAULT (prints what would change); --go writes.\n" +
  "       --force overwrites a vision/plan that is already there.\n" +
  "keys:  change, vision, plan, parallel, budget, steps{<id>: {title, needs,\n" +
  "       produces, verify, retry, on-issue, kind, budget, why, priority}}";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// The YAML subset itself moved to yaml-subset.mjs (t#339): spec.mjs's
// frontmatter parser needs the same nested-mapping/inline-list/quoted-scalar
// reader, and a parser stated twice is a parser that drifts. Re-exported here
// so the existing `import { parseYamlSubset } from "./apply.mjs"` call sites
// (this module's own use below, apply.test.mjs) keep working unchanged.
export { parseYamlSubset } from "./yaml-subset.mjs";

// --- the document ------------------------------------------------------------

// The vocabulary itself — exported so the plan-mode instruction can be checked
// against the keys the parser really takes, instead of against a copy of them.
// The document keys of the language proper, and separately the one the parser
// still takes for compatibility: `plan` used to carry the prose steps, and since
// t#317 the plan IS the file — the prose lives in `vision` and per-step `why`.
export const DSL_DOC_FIELDS = ["change", "vision", "parallel", "budget", "steps"];

export const DOC_FIELDS = [...DSL_DOC_FIELDS, "plan"];

// The step keys of the DSL proper (§4–§13) and, separately, the board niceties
// a file may also carry. Only the first list is what the plan-mode instruction
// has to teach.
export const DSL_STEP_FIELDS = [
  "title",
  "task",
  "needs",
  "produces",
  "verify",
  "retry",
  "on-issue",
  "kind",
  "budget",
];

// `why` is the step's reasoning — what it rests on, where its risk shows. It is
// not a construct of the process language (it commands nothing at run time); it
// is the task's DESCRIPTION, and it exists so that writing the plan AS the file
// does not cost the prose that made it a plan (t#317).
export const STEP_FIELDS = [...DSL_STEP_FIELDS, "why", "priority"];

// `318`, `#318`, `t#318` and a uuid all name one task, so two steps naming the
// same one in different spellings must still read as a collision.
const normRef = (v) =>
  String(v ?? "")
    .trim()
    .replace(/^t?#/, "")
    .toLowerCase();

const asList = (v) => {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return [String(v).trim()].filter(Boolean);
};

// A step may be written as a mapping of fields or, when it declares nothing but
// its phrase, as a bare string: `1: собрать граф прогона`.
function readSteps(raw) {
  const steps = [];
  if (!raw || typeof raw !== "object") return steps;
  const entries = Array.isArray(raw)
    ? raw.map((s, n) => [String(s?.id ?? s?.step ?? n + 1), s])
    : Object.entries(raw);
  for (const [key, body] of entries) {
    const id = String(key).trim();
    if (typeof body === "string" || body == null) {
      steps.push({
        id,
        task: "",
        title: String(body ?? "").trim(),
        why: "",
        needs: [],
        produces: [],
      });
      continue;
    }
    steps.push({
      id,
      // The step IS a task that already exists (t#324). Written as `task: 318`
      // (or #318 / t#318 / a uuid), it replaces guessing by phrase: a plan that
      // continues work on a task says which one instead of hoping the title is
      // reproduced verbatim.
      task: body.task == null ? "" : String(body.task).trim(),
      title: String(body.title ?? body.subject ?? "").trim(),
      why: String(body.why ?? body.description ?? "").trim(),
      needs: asList(body.needs ?? body.depends_on ?? body.after),
      produces: asList(body.produces),
      verify: body.verify == null ? "" : String(body.verify).trim(),
      retry: body.retry == null ? "" : String(body.retry).trim(),
      onIssue: body["on-issue"] == null ? "" : String(body["on-issue"]).trim(),
      kind: body.kind == null ? "" : String(body.kind).trim().toLowerCase(),
      budget: body.budget == null ? "" : String(body.budget).trim(),
      priority: body.priority == null ? "" : String(body.priority).trim(),
      unknown: Object.keys(body).filter(
        (k) =>
          ![...STEP_FIELDS, "subject", "description", "depends_on", "after", "id", "step"].includes(
            k,
          ),
      ),
    });
  }
  return steps;
}

export function readDocument(text) {
  const doc = parseYamlSubset(text);
  return {
    // `theme`/`group` are the field's earlier names (t#345 renamed the entity
    // to `change`) — read here so a plan the model still writes the old way
    // does not fail to parse; only `change` appears in the vocabulary above.
    change: String(doc.change ?? doc.theme ?? doc.group ?? "").trim(),
    vision: String(doc.vision ?? doc.description ?? "").trim(),
    plan: String(doc.plan ?? "").trim(),
    parallel: doc.parallel == null ? "" : String(doc.parallel).trim(),
    budget: doc.budget == null ? "" : String(doc.budget).trim(),
    steps: readSteps(doc.steps),
  };
}

// --- the validator (the rules the prompt no longer has to carry) -------------
//
// The rules themselves live in graph-rules.mjs, because `todos lint` checks the
// SAME §15 invariants on a board that was never a file (t#313). What stays here
// is the file's own half: turning the document into the shape the rules read,
// and the faults only a document can have — a step declared twice, an unknown
// key, a group ceiling with no root to sit on.

// The document as a graph. Every step is open (a file describes work not yet
// done), so the rules about the past never fire, and a reference may point at a
// step of this file OR at a task already on the board — a plan is allowed to
// hang off what is already there.
function documentGraph(doc, onBoard) {
  const ids = new Set(doc.steps.map((s) => s.id));
  return {
    changes: doc.change ? [{ label: `change "${doc.change}"`, budget: doc.budget }] : [],
    nodes: doc.steps.map((s) => ({
      id: s.id,
      label: `step "${s.id}"`,
      // A step bound to an existing task is already named — by the task. The
      // phrase is then optional, and repeating it in the file is only a way to
      // disagree with the board about what that task is called.
      title: s.title || (s.task ? `task ${s.task}` : ""),
      needs: s.needs,
      produces: s.produces,
      verify: s.verify,
      retry: s.retry,
      budget: s.budget,
      onIssue: s.onIssue,
      kind: s.kind,
      closed: false,
      outcome: "",
    })),
    resolves: (ref) => ids.has(ref) || onBoard(ref),
    unknownRef: (ref) => `"${ref}", which is neither a step of this file nor a task on the board`,
  };
}

export function validate(doc, { onBoard = () => false, inheritsChange = false, requireChange = false } = {}) {
  const { errors, warnings } = splitFindings(checkGraph(documentGraph(doc, onBoard)));
  if (!doc.steps.length) errors.push("no steps: the file declares nothing to record");
  // A file that only CONTINUES existing tasks needs no group of its own — the
  // one-step plan bound by `task: <N>` is the format's own normal case. A file
  // that opens NEW tasks does: without a change they land nowhere, and "nowhere"
  // used to be a silent state of the board.
  if (requireChange && !doc.change && !inheritsChange && doc.steps.some((s) => !s.task))
    errors.push(
      "no change: a step that opens a NEW task belongs to one, and nothing here says which. " +
        "Name it — `change: CHANGE: <что меняем>` — or bind the step to a task that already sits in a change (`task: <N>`)",
    );
  const seen = new Set();
  const bound = new Set();
  for (const s of doc.steps) {
    if (seen.has(s.id)) errors.push(`step "${s.id}" is declared twice`);
    seen.add(s.id);
    if (s.task) {
      // A binding that points at nothing is worse than no binding: it would
      // silently fall back to matching by phrase and create the very duplicate
      // the key exists to prevent.
      const ref = normRef(s.task);
      if (!onBoard(s.task))
        errors.push(`step "${s.id}": task "${s.task}" is not a task on this board`);
      else if (bound.has(ref))
        errors.push(`step "${s.id}": task "${s.task}" is already bound to an earlier step`);
      bound.add(ref);
    }
    for (const u of s.unknown || []) warnings.push(`step "${s.id}": unknown key "${u}" — ignored`);
  }
  if (doc.parallel && normalizeLimit(doc.parallel) === undefined)
    errors.push(`invalid parallel "${doc.parallel}"`);
  if (doc.budget && normalizeLimit(doc.budget, { integer: false }) === undefined)
    errors.push(`invalid budget "${doc.budget}"`);
  if ((doc.parallel || doc.budget) && !doc.change)
    warnings.push(
      "parallel/budget are the GROUP's ceilings and the runner reads them off a change root — " +
        "declare `change:` or they land nowhere",
    );
  return { errors, warnings };
}

// --- recording ---------------------------------------------------------------

const boardOf = (t) => t?.project || "";
const sameSubject = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Re-applying a file must not fork the graph, so a step is matched to a task by
// its phrase. Matching is by subject because that is the only thing a plan and a
// board share — the file carries no task ids.
//
// The search is the change's children FIRST and the whole project's board after
// (t#323). Children first because a phrase repeated across changes should land
// on this change's task; the board after because a task the previous run
// created and never got to link — exactly what an interrupted apply leaves
// behind — is invisible among the children, and a search that stops there
// answers "no such task" and forks the graph in two. A task found outside the
// group is adopted by it: the edge root -> step is written like any other.
//
// A task already taken by an earlier step is not offered to a later one: two
// steps sharing a phrase must not collapse onto one row, and a board that
// already holds duplicates must not have them silently merged.
function matchExisting(data, doc, project) {
  const record = doc.change ? findChangeByTitle(data, doc.change, project) : null;
  const children = record ? data.todos.filter((t) => t && t.change_id === record.id) : [];
  const board = data.todos.filter((t) => t && boardOf(t) === project);
  const byStep = new Map();
  const adopted = new Set();
  const renamed = new Set();
  const taken = new Set();
  for (const s of doc.steps) {
    // `task: <N>` is the step SAYING which task it is (t#324) — it outranks the
    // phrase, and its own resolution is the board's (`N` | `#N` | `t#N` | uuid),
    // so the file never has to reproduce a title character for character.
    const free = (t) => !taken.has(t.id) && sameSubject(t.subject, s.title);
    const hit = s.task ? resolveTask(data, s.task) : children.find(free) || board.find(free);
    if (!hit) continue;
    byStep.set(s.id, hit);
    taken.add(hit.id);
    if (record && !children.includes(hit)) adopted.add(hit.id);
    if (s.task && s.title && !sameSubject(hit.subject, s.title)) renamed.add(hit.id);
  }
  return { record, byStep, adopted, renamed };
}

const clipLine = (text, max = 60) => {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

function fmtTask(t) {
  return `#${t.number} ${t.subject}`;
}

// The setters of todos.mjs narrate to stdout — right for a command, fatal for a
// hook, whose stdout carries ONE json object and nothing else. So the narration
// is captured and handed back as `log`; `todos apply` prints it, the hook keeps
// its channel clean.
function capturing(fn) {
  const real = process.stdout.write.bind(process.stdout);
  const log = [];
  process.stdout.write = (chunk) => {
    log.push(String(chunk));
    return true;
  };
  try {
    return { value: fn(), log: log.join("").split("\n").filter(Boolean) };
  } finally {
    process.stdout.write = real;
  }
}

// The command minus its terminal: read a document, check it, and either report
// what would change or change it. `todos apply` prints the result and sets an
// exit code; the plan-mode hook (t#321) records an approved plan with it and has
// neither a terminal nor an exit code to spend. Everything either of them needs
// comes back as data:
//
//   { ok, errors, warnings, plan, notes, log, created, root, applied }
//
// `plan` is the human-readable diff (the dry-run listing), `created` the rows
// that came into being, `applied` whether anything was written.
export function applyDocument(doc, { go = false, force = false, project, board } = {}) {
  const boardFile = board?.file ?? boardPath();
  const data = board?.data ?? loadBoard(boardFile);
  project = project ?? path.basename(process.cwd().replace(/[\\/]+$/, ""));
  const { errors, warnings } = validate(doc, {
    onBoard: (token) => Boolean(resolveTask(data, token)),
    inheritsChange: doc.steps.some((s) => s.task && resolveTask(data, s.task)?.change_id),
    requireChange: true,
  });
  if (errors.length)
    return {
      ok: false,
      errors,
      warnings,
      plan: [],
      notes: [],
      log: [],
      created: [],
      root: null,
      applied: false,
    };

  const { record: existingChange, byStep, adopted, renamed } = matchExisting(data, doc, project);
  const plan = [];
  const say = (line) => plan.push(line);

  if (doc.change)
    say(existingChange ? `= change  ${changeAddress(existingChange)} ${existingChange.title}` : `+ change  "${doc.change}"`);
  for (const s of doc.steps) {
    const hit = byStep.get(s.id);
    if (!hit) {
      say(`+ step ${s.id}  "${s.title}"`);
      continue;
    }
    const marks = [
      s.task ? `by task: ${s.task}` : "",
      adopted.has(hit.id) ? "adopted into the change" : "",
      renamed.has(hit.id) ? "title differs from the board — the task keeps its own" : "",
      isDone(hit) ? "closed — declarations left as they are" : "",
    ].filter(Boolean);
    say(`= step ${s.id}  ${fmtTask(hit)}${marks.length ? `  (${marks.join("; ")})` : ""}`);
  }
  for (const s of doc.steps) {
    for (const n of s.needs) say(`  dep    ${s.id} -> ${n}`);
    for (const p of s.produces) say(`  produces ${s.id}  ${p}`);
    if (s.verify) say(`  verify ${s.id}  ${s.verify}`);
    if (s.retry) say(`  retry  ${s.id}  <=${s.retry}`);
    if (s.kind) say(`  kind   ${s.id}  ${s.kind}`);
    if (s.budget) say(`  budget ${s.id}  $${s.budget}`);
    if (s.why) say(`  why    ${s.id}  ${clipLine(s.why)}`);
    if (s.priority) say(`  prio   ${s.id}  ${s.priority}`);
    if (s.onIssue) say(`  ?issue ${s.id} -> ${s.onIssue}  (run layer, not a dep)`);
  }
  if (doc.parallel) say(`  parallel change  ${doc.parallel}`);
  if (doc.budget) say(`  budget change  $${doc.budget}`);

  if (!go)
    return {
      ok: true,
      errors: [],
      warnings,
      plan,
      notes: [],
      log: [],
      created: [],
      change: existingChange,
      changeCreated: false,
      root: null,
      applied: false,
    };

  // --- write ---------------------------------------------------------------
  // Order is the contract: rows first (so an edge always has both ends), then
  // the change flag and edges, then the declarations, and on-issue LAST — it is
  // the one field that demands another field (retry) to already be there.
  //
  // The whole pass is ONE write (t#323): withDeferredSave holds the board in
  // memory and puts it on disk once, at the end. Half a graph is worse than no
  // graph — it is the shape that made the previous run fork into duplicates.
  const created = [];
  const notes = [];
  let change = existingChange;
  let changeCreated = false;
  const { log } = capturing(() =>
    withDeferredSave(boardFile, data, () => {
      if (doc.change && !change) {
        change = createChange(data, {
          title: doc.change,
          delta: doc.vision,
          project,
          budget_usd: doc.budget ? Number(String(doc.budget).replace(/^\$/, "")) : undefined,
          parallel_limit: doc.parallel ? Number(doc.parallel) : undefined,
        });
        if (doc.plan) change.plan = doc.plan;
        changeCreated = true;
      }
      if (!change) {
        const bound = doc.steps
          .map((s) => (s.task ? resolveTask(data, s.task) : null))
          .find((t) => t?.change_id);
        if (bound) change = (data.changes ?? []).find((c) => c.id === bound.change_id) ?? null;
      }
      // No  in the file, but a step continues a task that already sits
      // in one — the new steps join it rather than landing nowhere.
      if (!change) {
        const bound = doc.steps
          .map((s) => (s.task ? resolveTask(data, s.task) : null))
          .find((t) => t?.change_id);
        if (bound) change = (data.changes ?? []).find((c) => c.id === bound.change_id) ?? null;
      }
      const tasks = new Map();
      for (const s of doc.steps) {
        let t = byStep.get(s.id);
        if (!t) {
          t = newTodo(data, { subject: s.title, project });
          created.push(t);
        }
        tasks.set(s.id, t);
      }

      const resolveStep = (token) => tasks.get(token) || resolveTask(data, token);
      const set = (todo, field, value) =>
        setField({ data, file: boardFile, todo, field, value: String(value) });

      if (change) {
        if (doc.vision && (force || !String(change.delta || "").trim())) change.delta = doc.vision;
        else if (doc.vision && !force && !sameSubject(change.delta || "", doc.vision))
          notes.push(
            `keep: ${changeAddress(change)} already carries a delta — left as is (--force overwrites)`,
          );
        if (doc.plan && (force || !String(change.plan || "").trim())) change.plan = doc.plan;
      }
      for (const s of doc.steps) {
        const t = tasks.get(s.id);
        // A bound step names the task; it does not rename it. Renaming is a
        // decision of its own — and a silent one here would move the task out from
        // under every phrase-matched reference to it.
        if (renamed.has(t.id))
          notes.push(
            `keep: #${t.number} keeps its own title — the file calls this step "${s.title}"`,
          );
        for (const n of s.needs) {
          const on = resolveStep(n);
          if (!on) continue;
          if (addDepEdge(data, t, on) === "added")
            notes.push(`ok: #${t.number} now depends on #${on.number}`);
        }
        if (change && t.change_id !== change.id) {
          t.change_id = change.id;
          notes.push(`ok: #${t.number} now belongs to ${changeAddress(change)}`);
        }
        // A declaration is a promise made BEFORE the work, so the board refuses
        // one on a closed node — and rightly. Re-applying a file whose early steps
        // are already done is the NORMAL case, though, and dying on it would undo
        // the rest of the pass. The closed node keeps what it has; only its edges,
        // which are the graph and not a promise, are still written.
        if (isDone(t)) {
          if (s.produces.length || s.verify || s.retry || s.kind || s.budget || s.why)
            notes.push(`keep: #${t.number} is done — its declarations were left as they are`);
          continue;
        }
        for (const p of s.produces) addProduces(t, p);
        if (s.produces.length)
          notes.push(
            `ok: #${t.number} produces ${t.produces.join(", ")} (${t.produces.length} declared)`,
          );
        // The reasoning lands in `description`, the field that already holds WHAT &
        // WHY — and only while it is empty, exactly as the vision of a change root.
        // Kept quiet, the skip is invisible in the worst case there is: a step
        // bound by `task: N` to an older task, whose description then frames the
        // work as it was understood weeks ago and not as this plan reasoned it.
        if (s.why && (force || !String(t.description || "").trim())) set(t, "description", s.why);
        else if (s.why && !sameSubject(t.description || "", s.why))
          notes.push(
            `keep: #${t.number} already carries a description — the file's \`why\` for step "${s.id}" was NOT recorded (--force overwrites)`,
          );
        if (s.priority) set(t, "priority", s.priority);
        if (s.verify) set(t, "verify", s.verify);
        if (s.retry) set(t, "retry", s.retry);
        if (s.kind) set(t, "kind", s.kind);
        if (s.budget) set(t, "budget", s.budget);
      }
      if (change) {
        if (doc.parallel) change.parallel_limit = Number(doc.parallel);
        if (doc.budget) change.budget_usd = Number(String(doc.budget).replace(/^\$/, ""));
        change.updated_at = new Date().toISOString();
      }
      for (const s of doc.steps) {
        if (!s.onIssue) continue;
        const t = tasks.get(s.id);
        const target = resolveStep(s.onIssue);
        if (target && !isDone(t)) set(t, "on-issue", target.id);
      }
      saveBoard(boardFile, data);
    }),
  );

  for (const t of created) notifyTaskEvent(t, "add");
  return {
    ok: true,
    errors: [],
    warnings,
    plan,
    notes,
    log,
    created,
    change,
    changeCreated,
    root: null,
    applied: true,
  };
}

// How a finished pass reads in one line, for whoever has to report it.
export function summarize(result, doc) {
  const newSteps = result.created.length;
  return (
    `${newSteps} new step(s), ${doc.steps.length - newSteps} matched (by task or subject)` +
    (result.change
      ? result.changeCreated
        ? `, change ${changeAddress(result.change)} created`
        : `, change ${changeAddress(result.change)} reused`
      : "")
  );
}

export function run(args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const file = positional[0];
  if (!file) fail(USAGE);
  const go = flags.has("--go");
  const json = flags.has("--json");

  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
  const doc = readDocument(text);
  const result = applyDocument(doc, { go, force: flags.has("--force") });
  const { errors, warnings, plan, notes } = result;

  if (!result.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, errors, warnings }, null, 2) + "\n");
      process.exit(1);
    }
    fail(
      `refusing to apply ${path.basename(file)} — ${errors.length} error(s):\n` +
        errors.map((e) => "  - " + e).join("\n") +
        (warnings.length ? "\nwarnings:\n" + warnings.map((w) => "  - " + w).join("\n") : ""),
    );
  }

  if (!result.applied) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: true, dryRun: true, plan, warnings }, null, 2) + "\n",
      );
      return;
    }
    process.stdout.write(
      `${path.basename(file)}: ${doc.steps.length} step(s)` +
        (doc.change ? ", 1 change" : "") +
        " — DRY RUN, nothing written\n" +
        plan.map((l) => "  " + l).join("\n") +
        "\n" +
        (warnings.length ? "warnings:\n" + warnings.map((w) => "  - " + w).join("\n") + "\n" : "") +
        "apply it: add --go\n",
    );
    return;
  }

  if (result.log.length) process.stdout.write(result.log.join("\n") + "\n");
  if (notes.length) process.stdout.write(notes.join("\n") + "\n");
  if (warnings.length)
    process.stdout.write("warnings:\n" + warnings.map((w) => "  - " + w).join("\n") + "\n");
  process.stdout.write(`ok: applied ${path.basename(file)} — ${summarize(result, doc)}\n`);
}
