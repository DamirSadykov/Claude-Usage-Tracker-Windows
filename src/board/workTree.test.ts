import { describe, expect, it } from "vitest";
import {
  aggregateTree,
  attemptReview,
  attemptReviewSummary,
  classifyToolCall,
  contextLabels,
  contextTokens,
  filterTree,
  headersOnlyTree,
  modelCallNode,
  groupModelCalls,
  singleCall,
  pathTo,
  nodeType,
  traceSeries,
  traceMarkers,
  treeView,
  tokenCosts,
  typeSummary,
  type WorkNode,
} from "./workTree";

const container = (children: readonly WorkNode[]): WorkNode => ({
  id: "session",
  kind: "session",
  name: "session",
  model: null,
  startedAt: null,
  endedAt: null,
  tokens: 0,
  cost: 0,
  input: null,
  result: null,
  transcriptPath: null,
  children,
});

describe("tool classification", () => {
  it("classifies named calls and distinguishes reading shell commands", () => {
    expect(classifyToolCall("Read")).toBe("read");
    expect(classifyToolCall("mcp__fff__lookup")).toBe("read");
    expect(classifyToolCall("Bash", "rg WorkTree src")).toBe("read");
    expect(classifyToolCall("Bash", "rg WorkTree src > out.txt")).toBe("shell");
    expect(classifyToolCall("apply_patch")).toBe("edit");
    expect(classifyToolCall("Agent")).toBe("agent");
    expect(classifyToolCall("WebSearch")).toBe("web");
  });
});

describe("attempt reviews", () => {
  it("normalizes review findings and summarizes them in severity order", () => {
    const review = attemptReview({
      counts: { high: 3, medium: "nope" },
      findings: [
        { level: "low", file: "a.ts", line: 8, text: "Low", evidence: "proof" },
        { level: "critical", file: "b.ts", line: 2, text: "Critical" },
        { level: "future", text: "Unknown level" },
        { level: "high", file: "ignored.ts" },
        null,
      ],
    });
    expect(review?.findings).toEqual([
      { level: "low", file: "a.ts", line: 8, text: "Low", evidence: "proof" },
      { level: "critical", file: "b.ts", line: 2, text: "Critical", evidence: null },
      { level: null, file: null, line: null, text: "Unknown level", evidence: null },
    ]);
    expect(attemptReviewSummary("failed", review)).toEqual({
      passed: false,
      counts: { critical: 0, high: 3, medium: 0, low: 0 },
      findings: [
        { level: "critical", file: "b.ts", line: 2, text: "Critical", evidence: null },
        { level: "low", file: "a.ts", line: 8, text: "Low", evidence: "proof" },
        { level: null, file: null, line: null, text: "Unknown level", evidence: null },
      ],
    });
  });

  it("derives counts from findings when the review omitted them", () => {
    const review = attemptReview({ findings: [{ level: "high", text: "One" }, { level: "high", text: "Two" }] });
    expect(attemptReviewSummary("done", review)).toMatchObject({
      passed: true,
      counts: { critical: 0, high: 2, medium: 0, low: 0 },
    });
  });
});

describe("context labels", () => {
  it("labels fresh, inherited, continued and compacted contexts without labeling unknown ones", () => {
    expect(contextLabels({ mode: "fresh" })).toEqual([{ kind: "fresh" }]);
    expect(contextLabels({ mode: "fork", parentTask: 813, parentSession: "abcdef012345" })).toEqual([
      { kind: "inherits", parentTask: 813, parentSession: "abcdef01" },
    ]);
    expect(contextLabels({ mode: "continued", compacted: true })).toEqual([
      { kind: "continued" },
      { kind: "compacted" },
    ]);
    expect(contextLabels({ mode: "unknown" })).toEqual([]);
  });

  it("treats a fork subagent as inherited and an ordinary subagent as fresh", () => {
    expect(contextLabels({ agentType: "fork", parentTask: 813, parentSession: "parent-session" })).toEqual([
      { kind: "inherits", parentTask: 813, parentSession: "parent-s" },
    ]);
    expect(contextLabels({ agentType: "general-purpose", fork: false, mode: "fresh" })).toEqual([{ kind: "fresh" }]);
  });

  it("keeps an inheritance label when only part of the parent is known", () => {
    expect(contextLabels({ mode: "fork", parentSession: "parent-session" })).toEqual([
      { kind: "inherits", parentTask: undefined, parentSession: "parent-s" },
    ]);
    expect(contextLabels({ mode: "fork", parentTask: 813 })).toEqual([
      { kind: "inherits", parentTask: 813, parentSession: undefined },
    ]);
    expect(contextLabels({ mode: "fork", parentTask: 0 })).toEqual([
      { kind: "inherits", parentTask: undefined, parentSession: undefined },
    ]);
  });
});

describe("model call nodes", () => {
  it("keeps numbered calls and an Agent subagent as a branch", () => {
    const subagent = modelCallNode({ id: "sub-model", model: "small", tokenBreakdown: { output: 5 } });
    const node = modelCallNode({
      id: "model",
      model: "main",
      tokenBreakdown: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
      cost: 2,
      calls: [
        { id: "read", name: "Read" },
        { id: "agent", name: "Agent", subagent },
      ],
    });
    expect(node.tokens).toBe(105);
    expect(node.children.map((call) => call.sequence)).toEqual([1, 2]);
    expect(node.children[1].children[0].id).toBe("sub-model");
    expect(nodeType(node)).toBe("read");
    expect(contextTokens(node.tokenBreakdown)).toBe(60);
  });

  it("names a model call by its tools and finds the path to a nested node", () => {
    const subagent = modelCallNode({ id: "sub-model", model: "small" });
    const node = modelCallNode({
      id: "model",
      model: "main",
      calls: [
        { id: "a", name: "exec" },
        { id: "b", name: "exec" },
        { id: "c", name: "Agent", subagent },
      ],
    });
    expect(node.name).toBe("exec ×2 · Agent");
    expect(modelCallNode({ id: "text", model: "main" }).name).toBe("");
    expect(pathTo(node, "sub-model")?.map((n) => n.id)).toEqual(["model", "c", "sub-model"]);
    expect(pathTo(node, "missing")).toBeNull();
  });

  it("groups consecutive single-call model nodes of one tool and renumbers them", () => {
    const call = (id: string, name: string) =>
      modelCallNode({ id, model: "m", cost: 1, calls: [{ id: `${id}:c`, name }] });
    const session = aggregateTree({
      id: "s",
      kind: "session",
      name: "s",
      model: null,
      startedAt: null,
      endedAt: null,
      tokens: 0,
      cost: 0,
      input: null,
      result: null,
      transcriptPath: null,
      children: [call("a", "exec"), call("b", "exec"), call("c", "exec"), call("d", "apply_patch"), call("e", "exec")],
    });
    const grouped = groupModelCalls(session);
    expect(grouped.children.map((n) => n.kind)).toEqual(["group", "model", "model"]);
    expect(grouped.children[0].name).toBe("exec");
    expect(grouped.children[0].cost).toBe(3);
    expect(grouped.children[0].children.map((n) => n.sequence)).toEqual([1, 2, 3]);
    expect(singleCall(grouped.children[1])?.name).toBe("apply_patch");
  });

  it("sums model tokens and cost upwards without counting tool wrappers twice", () => {
    const child = modelCallNode({ id: "child", model: "child", tokenBreakdown: { output: 7 }, cost: 0.5 });
    const parent = modelCallNode({
      id: "parent",
      model: "parent",
      tokenBreakdown: { input: 3 },
      cost: 1,
      calls: [{ id: "agent", name: "Agent", subagent: child }],
    });
    const total = aggregateTree(container([parent]));
    expect(total.tokens).toBe(10);
    expect(total.cost).toBe(1.5);
  });

  it("derives container totals from children instead of stored aggregate totals", () => {
    const child = modelCallNode({ id: "child", model: "child", tokenBreakdown: { output: 10 }, cost: 1 });
    const session = { ...container([child]), tokens: 10, cost: 1 };
    const total = aggregateTree(session);
    expect(total.tokens).toBe(10);
    expect(total.cost).toBe(1);
  });
});

describe("token costs", () => {
  it("prices every token rate with the selected model's rates", () => {
    expect(tokenCosts("claude-sonnet-4", { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 })).toMatchObject({
      inputCost: 3,
      cacheReadCost: 0.3,
      cacheWriteCost: 3.75,
      outputCost: 15,
    });
  });

  it("does not charge Codex cached tokens again as fresh input", () => {
    expect(tokenCosts("gpt-5.6-terra", { input: 1_000_000, cacheRead: 300_000, cacheWrite: 100_000, output: 1_000_000 })).toMatchObject({
      inputCost: 1.2,
      cacheReadCost: 0.06,
      cacheWriteCost: 0.25,
      outputCost: 12,
    });
  });
});

describe("trace views", () => {
  const first = modelCallNode({
    id: "one",
    model: "m",
    tokenBreakdown: { input: 2, cacheRead: 3, cacheWrite: 5, output: 7 },
    cost: 1,
    calls: [{ id: "r", name: "Read" }],
  });
  const second = modelCallNode({
    id: "two",
    model: "m",
    tokenBreakdown: { input: 11, cacheRead: 13 },
    cost: 3,
    calls: [{ id: "e", name: "Edit" }],
  });
  const root = container([first, second]);
  it("builds context, cumulative cache and cumulative price in model-call order", () => {
    expect(traceSeries(root)).toEqual({
      context: [
        { index: 1, nodeId: "one", type: "read", value: 10 },
        { index: 2, nodeId: "two", type: "edit", value: 24 },
      ],
      cacheRead: [
        { index: 1, nodeId: "one", type: "read", value: 3 },
        { index: 2, nodeId: "two", type: "edit", value: 16 },
      ],
      cost: [
        { index: 1, nodeId: "one", type: "read", value: 1 },
        { index: 2, nodeId: "two", type: "edit", value: 4 },
      ],
    });
  });
  it("summarizes types and filters model calls while keeping their ancestors", () => {
    expect(typeSummary(root)).toEqual([
      { type: "read", nodes: 1, cost: 1, share: 0.25 },
      { type: "edit", nodes: 1, cost: 3, share: 0.75 },
    ]);
    expect(filterTree(root, new Set(["edit"]))?.children.map((node) => node.id)).toEqual(["two"]);
    expect(treeView(root, { types: new Set(["read"]), headersOnly: true })?.children.map((node) => node.id)).toEqual([
      "one",
    ]);
  });
  it("positions attempt, session and compaction markers against model calls", () => {
    const marked = {
      ...container([first, second]),
      children: [{ ...first, startedAt: 10, compactionAt: [15] }, { ...second, startedAt: 20 }],
    };
    const session = { ...marked, id: "session-marked", kind: "session" as const, name: "session", startedAt: 10 };
    const attempt = { ...marked, id: "attempt", kind: "run" as const, name: "Attempt 1", startedAt: 10, children: [session] };
    expect(traceMarkers({ ...container([attempt]), children: [attempt] })).toEqual([
      { index: 1, kind: "attempt", label: "Attempt 1" },
      { index: 1, kind: "session", label: "session" },
      { index: 2, kind: "compacted", label: "compacted" },
    ]);
  });
  it("removes tool rows in headings-only mode but preserves subagent branches", () => {
    const agentModel = modelCallNode({ id: "agent-model", model: "m", calls: [{ id: "x", name: "Read" }] });
    const parent = modelCallNode({
      id: "parent",
      model: "m",
      calls: [{ id: "agent", name: "Agent", subagent: agentModel }],
    });
    expect(headersOnlyTree(parent).children[0].id).toBe("agent-model");
  });

  it("keeps ancestors of matching nested subagent calls", () => {
    const agentModel = modelCallNode({ id: "agent-model", model: "m", calls: [{ id: "read", name: "Read" }] });
    const parent = modelCallNode({
      id: "parent",
      model: "m",
      calls: [{ id: "agent", name: "Agent", subagent: agentModel }],
    });
    const filtered = filterTree(parent, new Set(["read"]));
    expect(filtered?.id).toBe("parent");
    expect(filtered?.children[0].children[0].id).toBe("agent-model");
  });
});
