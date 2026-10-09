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
//     nodes:  [{ id, label, title, needs, produces, verify, retry, size, budget,
//                onIssue, kind, closed, outcome }],
//     resolves(ref) -> boolean,         // does this reference point at anything
//     unknownRef(ref) -> string,        // ...and how to say that it does not
//     refLabel(ref) -> string,          // how to NAME one in a message (optional)
//   }
//
// Everything the two worlds do NOT share stays with the caller: the file's own
// faults (an unparsable value, a step declared twice, an unknown key) live in
// apply.mjs, because a board cannot have them.

import { normalizeLimit } from "../kernel/board-io.mjs";

const blank = (v) => v === undefined || v === null || String(v).trim() === "";
const FLOW_LANGUAGE_EXTENSIONS = {
  cs: [".cs"],
  rs: [".rs"],
  ts: [".ts", ".tsx"],
  js: [".js", ".mjs", ".cjs"],
};
export const supportedFlowExtensions = Object.values(FLOW_LANGUAGE_EXTENSIONS).flat();
export const flowExtensions = (languages = ["cs"]) =>
  [...new Set((Array.isArray(languages) ? languages : ["cs"]).flatMap((language) => FLOW_LANGUAGE_EXTENSIONS[language] || []))];
const flowOutput = (n, languages) => {
  const extensions = flowExtensions(languages);
  return (n.produces || []).some((value) => extensions.some((extension) => String(value).trim().toLowerCase().endsWith(extension)));
};
const flowNaReason = (flow) => {
  if (typeof flow !== "string") return null;
  const match = /^n\/a(?:\s+(.*))?$/i.exec(flow.trim());
  return match ? String(match[1] || "").trim() : null;
};
const flowSpec = (spec) => spec !== null && typeof spec === "object" && !Array.isArray(spec);
export const flowDeclared = (flow) =>
  flowSpec(flow) || (Array.isArray(flow) && flow.length > 0 && flow.every(flowSpec));

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
    id: "invalid-size",
    severity: "error",
    when: "any",
    check: (n) =>
      n.size && !["S", "M", "L"].includes(n.size)
        ? `${n.label}: invalid size "${n.size}" — accepted values: S | M | L`
        : null,
  },
  {
    id: "new-auto-without-size",
    severity: "error",
    when: "open",
    check: (n) =>
      n.newTask && n.kind === "auto" && blank(n.size)
        ? `${n.label}: new auto step has no size — declare size: S | M | L`
        : null,
  },
  {
    id: "invalid-risk",
    severity: "error",
    when: "any",
    check: (n) =>
      n.risk && !["high", "sensitive"].includes(n.risk)
        ? `${n.label}: invalid risk "${n.risk}" — the only accepted value is "high" for agent routing; ` +
          `accepted values: "high" | "sensitive"`
        : null,
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
    // prerequisites (docs/plan-format-issues.md), so this is a note, not a fault:
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
    id: "large-step",
    severity: "warning",
    when: "open",
    check: (n, g) =>
      n.produces.length >= 4 &&
      typeof g.lineCount === "function" &&
      n.produces.some((p) => {
        const count = g.lineCount(p);
        return typeof count === "number" && count > 1500;
      })
        ? `${n.label}: шаг крупный — разрезать по produces; см. docs/plan-format-cutting.md`
        : null,
  },
  {
    id: "red-without-red-tests",
    severity: "error",
    when: "open",
    check: (n) =>
      !blank(n.red) && !(n.redTests && n.redTests.length)
        ? `${n.label}: red declared without red-tests — the gate needs to know which regression test file(s) prove the bug`
        : null,
  },
  {
    id: "red-tests-without-red",
    severity: "error",
    when: "open",
    check: (n) =>
      n.redTests && n.redTests.length && blank(n.red)
        ? `${n.label}: red-tests declared without red — a regression test with nothing to prove it fails first`
        : null,
  },
  {
    id: "red-tests-not-in-produces",
    severity: "warning",
    when: "open",
    check: (n) =>
      (n.redTests || [])
        .filter((p) => !(n.produces || []).includes(p))
        .map((p) => `${n.label}: red-tests path "${p}" is not declared in produces`),
  },
  {
    id: "red-on-manual",
    severity: "warning",
    when: "open",
    check: (n) =>
      !blank(n.red) && n.kind !== "auto"
        ? `${n.label}: red declared on a manual node — a gate never runs it`
        : null,
  },
  {
    id: "code-without-flow",
    severity: "error",
    when: "open",
    check: (n, g) => {
      if (n.kind !== "auto" || !flowOutput(n, g.flowLanguages)) return null;
      if (blank(n.flow))
        return `${n.label}: auto step produces configured flow-language code but has no flow — declare flow or flow: n/a <reason>`;
      if (typeof n.flow === "string") {
        if (!/^n\/a\b/i.test(n.flow.trim()))
          return `${n.label}: flow must be a method delta, a list of them, or flow: n/a <reason>`;
        return flowNaReason(n.flow) ? null : `${n.label}: flow: n/a needs a reason`;
      }
      return flowDeclared(n.flow) ? null : `${n.label}: flow must be a method delta, a list of them, or flow: n/a <reason>`;
    },
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
    id: "produces-overlap",
    severity: "warning",
    check: (g) => {
      const nodes = g.nodes.filter((n) => !n.closed);
      const findings = [];
      for (let index = 0; index < nodes.length; index += 1) {
        const left = nodes[index];
        for (const right of nodes.slice(index + 1)) {
          if (needsPath(g.nodes, left.id, right.id) || needsPath(g.nodes, right.id, left.id)) continue;
          const rightPaths = new Map((right.produces || []).map((p) => [normalizeProducesPath(p), p]));
          for (const rawPath of left.produces || []) {
            const path = normalizeProducesPath(rawPath);
            if (!path || !rightPaths.has(path)) continue;
            findings.push(
              `${left.label} and ${right.label} both produce "${rightPaths.get(path)}" without a needs path between them — add a needs edge or make one step`,
            );
          }
        }
      }
      return findings;
    },
  },
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

function normalizeProducesPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function needsPath(nodes, from, target) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const walk = (id) => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.needs || []).some(walk);
  };
  return walk(from);
}
