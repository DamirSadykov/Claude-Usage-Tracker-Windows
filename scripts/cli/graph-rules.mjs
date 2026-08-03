// The invariants of the process language (§15), stated ONCE.
//
// Two readers check the same graph from two directions: `todos apply` checks the
// FILE before it is recorded (apply.mjs), `todos lint` checks the graph that is
// ALREADY on the board (lint.mjs). Both are needed — a file can be valid on the
// way in and the graph still rot afterwards (a task deleted out from under an
// ?issue arrow, a retry limit withdrawn, a node closed without its outcome
// reconciled), and a graph is just as often built command by command, never
// passing through a file at all. What must NOT happen twice is the RULE: a rule
// written in two files is a rule that drifts, and drift is exactly what t#310
// found between the prompt and the CLI.
//
// A caller adapts its world to one shape and gets findings back:
//
//   graph = {
//     changes: [{ label, budget }],     // group roots whose ceilings the runner reads
//     nodes:  [{ id, label, title, needs, produces, verify, retry, budget,
//                onIssue, kind, closed, outcome }],
//     resolves(ref) -> boolean,         // does this reference point at anything
//     unknownRef(ref) -> string,        // ...and how to say that it does not
//     refLabel(ref) -> string,          // how to NAME one in a message (optional)
//   }
//
// Everything the two worlds do NOT share stays with the caller: the file's own
// faults (an unparsable value, a step declared twice, an unknown key) live in
// apply.mjs, because a board cannot have them.

import { normalizeLimit } from "./todos.mjs";

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

// A reference is a step key in a file and a task id on a board, and a raw uuid in
// a message tells the reader nothing. The caller says how to name one; a caller
// that does not care gets the reference itself.
const nameRef = (g, ref) => (typeof g.refLabel === "function" ? g.refLabel(ref) : `"${ref}"`);
const list = (out) => (Array.isArray(out) ? out : out ? [out] : []);

// `when` says which nodes a rule is about, and the answer is never "all of them":
// a CLOSED node can no longer be executed, so every rule about the next run is
// noise on it (a gate that will never open, a transition that will never fire),
// while the one rule about the past — was what the node promised ever reconciled —
// only makes sense once it is closed.
export const NODE_RULES = [
  {
    id: "no-title",
    severity: "error",
    when: "any",
    check: (n) => (n.title ? null : `${n.label} has no title`),
  },
  {
    id: "invalid-kind",
    severity: "error",
    when: "any",
    check: (n) =>
      n.kind && !["auto", "manual"].includes(n.kind)
        ? `${n.label}: invalid kind "${n.kind}" — auto | manual`
        : null,
  },
  {
    id: "invalid-limit",
    severity: "error",
    when: "any",
    check: (n) =>
      [
        ["retry", n.retry, {}],
        ["budget", n.budget, { integer: false }],
      ]
        .filter(([, value, opts]) => value && normalizeLimit(value, opts) === undefined)
        .map(([field, value]) => `${n.label}: invalid ${field} "${value}"`),
  },
  {
    id: "needs-self",
    severity: "error",
    when: "open",
    check: (n) => (n.needs.includes(n.id) ? `${n.label} needs itself` : null),
  },
  {
    id: "needs-unknown",
    severity: "error",
    when: "open",
    check: (n, g) =>
      n.needs
        .filter((ref) => ref !== n.id && !g.resolves(ref))
        .map((ref) => `${n.label} needs ${g.unknownRef(ref)}`),
  },
  {
    id: "on-issue-unknown",
    severity: "error",
    when: "open",
    check: (n, g) =>
      n.onIssue && n.onIssue !== n.id && !g.resolves(n.onIssue)
        ? `${n.label}: on-issue points at ${g.unknownRef(n.onIssue)}`
        : null,
  },
  {
    id: "on-issue-self",
    severity: "error",
    when: "open",
    check: (n) =>
      n.onIssue && n.onIssue === n.id
        ? `${n.label}: on-issue points at itself — that loop never advances`
        : null,
  },
  {
    id: "on-issue-without-retry",
    severity: "error",
    when: "open",
    check: (n) =>
      n.onIssue && blank(n.retry)
        ? `${n.label}: on-issue without a retry limit. A missing limit FORBIDS the transition, ` +
          "it does not permit an endless one — declare retry on this node"
        : null,
  },
  {
    // The canonical retry shape has the ?issue target among the node's own
    // prerequisites (docs/plan-format.md §5), so this is a note, not a fault:
    // what is refused is the loop CLOSED in depends_on, and that is the cycle
    // rule below.
    id: "on-issue-is-a-dependency",
    severity: "warning",
    when: "open",
    check: (n, g) =>
      n.onIssue && n.onIssue !== n.id && n.needs.includes(n.onIssue)
        ? `${n.label}: ${nameRef(g, n.onIssue)} is both a dependency and the ?issue target — the transition stays ` +
          "on the run layer, only the dependency is a blocking edge"
        : null,
  },
  {
    id: "auto-without-verify",
    severity: "warning",
    when: "open",
    check: (n) =>
      n.kind === "auto" && blank(n.verify)
        ? `${n.label}: auto with no verify runs as a GATE — the authority to close a node comes ` +
          "from the check, not from the flag"
        : null,
  },
  {
    // The reconciliation (t#304) is what turns a promise into an artefact of an
    // edge; a node closed without it leaves the dependents' inputs unproven, and
    // nothing later goes back to check.
    id: "promised-without-outcome",
    severity: "warning",
    when: "closed",
    check: (n) =>
      n.produces.length && blank(n.outcome)
        ? `${n.label}: closed with ${n.produces.length} promised output(s) and no reconciled outcome — ` +
          "what it produced was never checked against what it promised"
        : null,
  },
];

export const GRAPH_RULES = [
  {
    id: "needs-cycle",
    severity: "error",
    check: (g) => {
      const cycle = findCycle(g.nodes);
      return cycle
        ? `needs form a cycle: ${cycle.join(" -> ")}. Blocking edges stay acyclic; a loop belongs on ` +
          "the run layer, declared with on-issue"
        : null;
    },
  },
  {
    // A change without a ceiling is not a smaller run, it is no run at all: the
    // runner refuses `--go` outright (run.mjs), so the graph is complete and
    // still unexecutable. Silent on a change with nothing left to run — a group
    // whose members are all closed has no run ahead of it to be stopped, and
    // declaring a ceiling over finished work would be a number from thin air.
    id: "change-without-budget",
    severity: "warning",
    check: (g) =>
      g.changes
        .filter((t) => blank(t.budget) && t.runnable !== false)
        .map(
          (t) =>
            `${t.label}: no budget declared on the group — \`todos run --go\` refuses to start a change ` +
            "without one, so this graph can only be driven by hand",
        ),
  },
];

// Every violation of the graph, in one pass. Findings keep their rule id and
// severity so a caller can print them, filter them or hand them out as JSON
// without re-deriving what kind of thing it is holding.
export function checkGraph(graph) {
  const findings = [];
  for (const node of graph.nodes) {
    for (const rule of NODE_RULES) {
      if (rule.when === "open" && node.closed) continue;
      if (rule.when === "closed" && !node.closed) continue;
      for (const message of list(rule.check(node, graph)))
        findings.push({ rule: rule.id, severity: rule.severity, node: node.id, label: node.label, message });
    }
  }
  for (const rule of GRAPH_RULES)
    for (const message of list(rule.check(graph)))
      findings.push({ rule: rule.id, severity: rule.severity, node: null, label: null, message });
  return findings;
}

export function splitFindings(findings) {
  return {
    errors: findings.filter((f) => f.severity === "error").map((f) => f.message),
    warnings: findings.filter((f) => f.severity === "warning").map((f) => f.message),
  };
}

// The ring itself, not just the fact of one — naming the nodes is what makes a
// cycle fixable. Edges that leave the checked set are ignored: a graph is linted
// in a scope (one file, one change), and a reference out of it is somebody else's
// node, not a link in this ring.
export function findCycle(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map();
  const stack = [];
  let found = null;
  const walk = (id) => {
    if (found) return;
    const st = state.get(id);
    if (st === "done") return;
    if (st === "open") {
      found = [...stack.slice(stack.indexOf(id)), id].map((x) => byId.get(x)?.label ?? x);
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const ref of byId.get(id)?.needs ?? []) if (byId.has(ref)) walk(ref);
    stack.pop();
    state.set(id, "done");
  };
  for (const n of nodes) walk(n.id);
  return found;
}
