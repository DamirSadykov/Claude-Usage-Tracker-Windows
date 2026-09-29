import { describe, expect, it } from "vitest";
import {
  aggregateTree,
  classifyToolCall,
  contextTokens,
  filterTree,
  headersOnlyTree,
  modelCallNode,
  nodeType,
  traceSeries,
  treeView,
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
