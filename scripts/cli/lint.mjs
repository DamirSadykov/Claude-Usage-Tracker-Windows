// `cli todos lint [<change>]` — the §15 invariants checked on the graph that is
// ALREADY on the board (t#313).
//
// Why, when `todos apply` already validates: apply checks a FILE on the way in,
// and a board is not only built from files. It is built command by command just
// as often, and — the part no input validator can cover — it ROTS while the work
// goes on: a task is deleted out from under an ?issue arrow, a retry limit is
// withdrawn (which silently forbids the transition), a change root never gets
// the budget the runner demands, a node closes without its promised outputs
// ever reconciled. Nothing re-reads the graph after the plan was recorded; this
// does.
//
// The rules are NOT here. They live in graph-rules.mjs and are the same objects
// apply.mjs checks a document with — this module only adapts the board to the
// shape those rules read and prints what comes back. A rule stated twice is a
// rule that drifts.
//
// Read-only by construction: the board is loaded, never saved.

import path from "node:path";

import { boardPath, loadBoard, isDone, isChangeRoot } from "./todos.mjs";
import { collectChange } from "./run.mjs";
import { checkGraph, splitFindings } from "./graph-rules.mjs";

const USAGE =
  "usage: cli todos lint [<change>] [--json]\n" +
  "       checks the recorded graph against the invariants of the process language.\n" +
  "       no argument = this project's board (+ project-less tasks); <change> = id|N|#N,\n" +
  "       its dependency closure. Reads the board, never writes it.\n" +
  "       Exit code: 1 when there is an error, 0 on warnings only.";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// The board's node in the shape the rules read. `kind` is normalized the way the
// board stores it (absent = manual), and the DECLARED-ness of a limit is what
// carries over: an absent retry_limit becomes "", which is what "no declaration"
// means to §15 — never a limit of zero.
const boardNode = (t) => ({
  id: t.id,
  label: `#${t.number}`,
  title: String(t.subject || "").trim(),
  needs: (Array.isArray(t.depends_on) ? t.depends_on : []).filter(Boolean),
  produces: (Array.isArray(t.produces) ? t.produces : []).filter(Boolean),
  verify: String(t.verify || "").trim(),
  retry: typeof t.retry_limit === "number" ? String(t.retry_limit) : "",
  budget: typeof t.budget_usd === "number" ? String(t.budget_usd) : "",
  onIssue: t.on_issue || "",
  kind: t.kind === "auto" ? "auto" : "",
  closed: isDone(t),
  outcome: String(t.outcome || "").trim(),
});

// A reference resolves against the WHOLE board, not against the linted scope: a
// dep edge leaving a change points at a real task, and only a reference that
// matches nothing anywhere is the dangling one (the task was deleted).
export function boardGraph(data, tasks) {
  const known = new Set((data.todos || []).filter(Boolean).map((t) => t.id));
  return {
    changes: [
      ...(data.changes ?? [])
        .filter(Boolean)
        .map((c) => {
          const members = (data.todos ?? []).filter((t) => t && t.change_id === c.id);
          return {
            label: `change c#${c.number} "${c.title}"`,
            budget: typeof c.budget_usd === "number" ? String(c.budget_usd) : "",
            runnable: members.some((t) => !isDone(t)),
          };
        }),
      ...tasks
      .filter((t) => isChangeRoot(t) && !isDone(t))
      .map((t) => ({
        label: `change #${t.number} "${t.subject}"`,
        budget: typeof t.budget_usd === "number" ? String(t.budget_usd) : "",
        // A change depends on every one of its members and closes last, so its
        // own prerequisites ARE the group: nothing open among them means there
        // is no run left for a ceiling to bound.
        runnable: (Array.isArray(t.depends_on) ? t.depends_on : []).some((id) => {
          const member = (data.todos || []).find((x) => x && x.id === id);
          return member && !isDone(member);
        }),
      })),
    ],
    nodes: tasks.map(boardNode),
    resolves: (ref) => known.has(ref),
    unknownRef: (ref) => `"${ref}", which is not a task on this board any more (deleted)`,
    // Board references are uuids; a message that prints one is unreadable, so a
    // live task is named by its board number.
    refLabel: (ref) => {
      const t = (data.todos || []).find((x) => x && x.id === ref);
      return t ? `#${t.number}` : `"${ref}"`;
    },
  };
}

// Scope mirrors `list` / `ready` / `pipeline`: this project plus project-less
// tasks, or a change's dependency closure — and the closure comes from the
// runner's own collectChange, so lint checks exactly the set `todos run` would
// execute rather than a second opinion about what a change contains.
export function scopeOf(data, change) {
  const all = (data.todos || []).filter(Boolean);
  if (change) {
    const { root, members } = collectChange(data, change);
    if (!root) fail(`no such task: ${change}`);
    return {
      label: `change #${root.number} "${root.subject}"`,
      root,
      tasks: [root, ...members],
    };
  }
  const project = path.basename(process.cwd().replace(/[\\/]+$/, ""));
  return {
    label: `board ${project}`,
    root: null,
    tasks: all
      .filter((t) => !t.project || t.project === project)
      .sort((a, b) => (a.number || 0) - (b.number || 0)),
  };
}

export function lint(data, change) {
  const scope = scopeOf(data, change);
  const findings = checkGraph(boardGraph(data, scope.tasks));
  return { scope, findings, ...splitFindings(findings) };
}

export function formatReport({ scope, findings, errors, warnings }) {
  const head = `lint ${scope.label} — ${scope.tasks.length} node(s) checked\n`;
  if (!findings.length) return head + "ok: nothing violates the process language\n";
  const line = (f) => `  ${f.severity === "error" ? "✗" : "⚠"} ${f.message}\n`;
  return (
    head +
    findings
      .filter((f) => f.severity === "error")
      .map(line)
      .join("") +
    findings
      .filter((f) => f.severity === "warning")
      .map(line)
      .join("") +
    `${errors.length} error(s), ${warnings.length} warning(s) — fix with todos set <field> <task> <value>\n`
  );
}

export function run(args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  if (flags.has("--help") || flags.has("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const report = lint(loadBoard(boardPath()), positional[0]);
  if (flags.has("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: report.errors.length === 0,
          scope: report.scope.label,
          checked: report.scope.tasks.length,
          findings: report.findings.map((f) => ({
            rule: f.rule,
            severity: f.severity,
            task: f.label,
            message: f.message,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(formatReport(report));
  }
  if (report.errors.length) process.exit(1);
}
