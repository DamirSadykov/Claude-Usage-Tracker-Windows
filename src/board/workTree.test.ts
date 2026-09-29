import { describe, expect, it } from "vitest";
import {
  collapseReadingNodes,
  isExpensiveNode,
  isReadingNode,
  timelineBar,
  timelineScale,
  type WorkNode,
} from "./workTree";

const node = (overrides: Partial<WorkNode> = {}): WorkNode => ({
  id: "node", kind: "tool", name: "Read", model: null, startedAt: 0, endedAt: 10,
  tokens: 10, cost: 0.1, input: null, result: null, transcriptPath: null, children: [], ...overrides,
});

describe("collapseReadingNodes", () => {
  it("groups only consecutive reading tools and recalculates the group totals", () => {
    const collapsed = collapseReadingNodes([
      node({ id: "read", name: "Read", startedAt: 10, endedAt: 20, tokens: 4, cost: 0.02 }),
      node({ id: "grep", name: "Grep", startedAt: 22, endedAt: 30, tokens: 6, cost: 0.03 }),
      node({ id: "edit", name: "Edit", startedAt: 32, endedAt: 40 }),
      node({ id: "glob", name: "Glob", startedAt: 42, endedAt: 45 }),
    ]);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toMatchObject({ kind: "reads", count: 2, startedAt: 10, endedAt: 30, tokens: 10, cost: 0.05 });
    expect(collapsed[0].children.map((child) => child.id)).toEqual(["read", "grep"]);
    expect(collapsed[2].id).toBe("glob");
  });

  it("recognizes safe reading Bash commands but not commands with side effects", () => {
    expect(isReadingNode(node({ name: "Read · src/board/workTree.ts" }))).toBe(true);
    expect(isReadingNode(node({ name: "Bash", input: "rg WorkNode src" }))).toBe(true);
    expect(isReadingNode(node({ name: "Bash", input: "rg WorkNode src > output.txt" }))).toBe(false);
    expect(isReadingNode(node({ name: "Bash", input: "npm test" }))).toBe(false);
  });

  it("collapses each nested sibling list without changing non-reading nodes", () => {
    const session = node({ kind: "session", name: "Session", children: [node({ id: "a" }), node({ id: "b", name: "Glob" })] });
    const collapsed = collapseReadingNodes([session]);
    expect(collapsed[0].children[0]).toMatchObject({ kind: "reads", count: 2 });
  });
});

describe("timeline", () => {
  it("puts bars on the root axis and enforces the minimum visible width", () => {
    const root = node({ kind: "session", startedAt: 100, endedAt: 1_100 });
    const scale = timelineScale(root);
    expect(timelineBar(node({ startedAt: 350, endedAt: 550 }), scale)).toEqual({ start: 25, width: 20 });
    expect(timelineBar(node({ startedAt: 900, endedAt: 901 }), scale)).toEqual({ start: 80, width: 1 });
  });

  it("keeps a zero-length root visible and does not invent bars for unknown time", () => {
    const scale = timelineScale(node({ startedAt: 10, endedAt: 10 }));
    expect(timelineBar(node({ startedAt: 10, endedAt: 10 }), scale)).toEqual({ start: 0, width: 100 });
    expect(timelineBar(node({ startedAt: null, endedAt: null }), scale)).toBeNull();
  });
});

describe("isExpensiveNode", () => {
  it("uses the inclusive cost threshold and allows a caller to tune it", () => {
    expect(isExpensiveNode(node({ cost: 1 }))).toBe(true);
    expect(isExpensiveNode(node({ cost: 0.99 }))).toBe(false);
    expect(isExpensiveNode(node({ cost: 0.5 }), 0.5)).toBe(true);
  });
});
