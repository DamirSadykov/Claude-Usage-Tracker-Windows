import { describe, it, expect, vi } from "vitest";
import { normalizeGraph, normalizeNode, loadRunLayer, loadRunGroups } from "./graphModel";

const invoked: { change: string }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (_cmd: string, args: { change: string }) => {
    invoked.push(args);
    if (args.change === "boom") return Promise.reject(new Error("no such change"));
    if (args.change === "294") {
      return Promise.resolve({
        nodes: [
          { id: "u-294", number: 294, change: true, measurability: "no_in_progress" },
          { id: "u-297", number: 297, measurability: "measured", cost: 1.95, messages: 20 },
        ],
        edges: [{ from: "u-297", to: "u-294", membership: true }],
        groups: [
          {
            id: "u-294",
            number: 294,
            subject: "ТЕМА",
            members: ["u-297"],
            duration_minutes: 42,
            record: false,
          },
        ],
      });
    }
    return Promise.resolve({
      nodes: [
        { id: "u-299", number: 299, change: true, measurability: "measured", cost: 8.36, messages: 4 },
        // The same node the other change measured, seen here as an unmeasured member.
        { id: "u-294", number: 294, change: true, measurability: "no_in_progress" },
      ],
      edges: [],
    });
  },
}));

describe("normalizeNode", () => {
  it("keeps an unmeasured node's cost null instead of zeroing it", () => {
    // A change closed straight out of backlog (t#294, t#283) has no block.
    const n = normalizeNode({ number: 294, subject: "ТЕМА", cost: null, change: true });
    expect(n.cost).toBeNull();
    expect(n.group).toBe(true);
    // A genuine zero survives as zero — the two must stay distinguishable.
    // The state, not the value, decides: only `measured` may carry a figure.
    expect(normalizeNode({ number: 295, measurability: "measured", cost: 0 }).cost).toBe(0);
  });

  it("derives the gate flag from kind when the backend omits it", () => {
    expect(normalizeNode({ number: 1, kind: "auto" }).gate).toBe(false);
    expect(normalizeNode({ number: 2, kind: "manual" }).gate).toBe(true);
    // Empty kind means the default, which is manual (docs/specs/tasks.md §6):
    // every node of changes t#294 and t#283 has it blank.
    expect(normalizeNode({ number: 3, kind: "" }).gate).toBe(true);
    // An explicit flag wins over kind.
    expect(normalizeNode({ number: 4, kind: "manual", gate: false }).gate).toBe(false);
  });

  it("reads agent rows, keeping the main loop as the null-id row", () => {
    const n = normalizeNode({
      number: 297,
      cost: 5.18,
      agents: [
        { agent_id: null, cost: 2.47, messages: 15 },
        { agent_id: "ab68ca7d0d", agent_type: "general-purpose", description: "Блоки", cost: 2.16, messages: 33 },
      ],
    });
    expect(n.agents).toHaveLength(2);
    expect(n.agents[0].agent_id).toBeNull();
    expect(n.agents[1].description).toBe("Блоки");
    expect(n.agents[1].cost).toBeCloseTo(2.16, 5);
  });

  it("survives junk fields without throwing", () => {
    const n = normalizeNode({ number: "nope", cost: "free", agents: "many", subject: 42 });
    expect(n.number).toBe(0);
    expect(n.cost).toBeNull();
    expect(n.agents).toEqual([]);
    expect(n.subject).toBe("");
  });
});

describe("normalizeGraph", () => {
  it("drops half-formed edges", () => {
    const g = normalizeGraph({
      nodes: [{ number: 1 }, { number: 2 }],
      edges: [{ from: 1, to: 2 }, { from: 0, to: 2 }, { from: 3 }],
    });
    expect(g.edges).toEqual([{ from: 1, to: 2 }]);
  });

  it("accepts either mermaid or text as the export field", () => {
    expect(normalizeGraph({ mermaid: "flowchart TD" }).mermaid).toBe("flowchart TD");
    expect(normalizeGraph({ text: "flowchart TD" }).mermaid).toBe("flowchart TD");
  });

  it("returns an empty graph for null, a string, or a missing payload", () => {
    for (const bad of [null, undefined, "boom", 7]) {
      expect(normalizeGraph(bad)).toEqual({ nodes: [], edges: [], groups: [], mermaid: "" });
    }
  });
});

describe("contract from t#306", () => {
  it("translates id-keyed edges into board numbers and drops membership ones", () => {
    const g = normalizeGraph({
      nodes: [
        { id: "u-294", number: 294, change: true },
        { id: "u-295", number: 295 },
        { id: "u-297", number: 297 },
      ],
      edges: [
        { from: "u-295", to: "u-297", membership: false },
        { from: "u-295", to: "u-294", membership: true },
        { from: "u-297", to: "u-294", membership: true },
      ],
      groups: [
        {
          id: "u-294",
          number: 294,
          subject: "ТЕМА",
          members: ["u-295", "u-297"],
          duration_minutes: 130,
          record: true,
        },
      ],
    });
    expect(g.edges).toEqual([{ from: 295, to: 297 }]);
    expect(g.groups[0].members).toHaveLength(2);
    expect(g.groups[0].duration_minutes).toBe(130);
    expect(g.groups[0].record).toBe(true);
  });

  it("defaults a group's duration/record when the backend omits them", () => {
    const g = normalizeGraph({
      groups: [{ id: "g1", number: 1, subject: "x", members: [] }],
    });
    expect(g.groups[0].duration_minutes).toBeNull();
    expect(g.groups[0].record).toBe(false);
  });

  it("refuses numbers for every non-measured state", () => {
    for (const state of ["no_in_progress", "no_blocks", "empty_blocks"]) {
      const n = normalizeNode({
        number: 296,
        measurability: state,
        cost: 0,
        messages: 0,
        total_tokens: 0,
        tool_calls: 0,
      });
      expect(n.cost).toBeNull();
      expect(n.messages).toBeNull();
      expect(n.tokens).toBeNull();
      expect(n.measurability).toBe(state);
    }
  });

  it("keeps an honestly measured zero", () => {
    const n = normalizeNode({ number: 1, measurability: "measured", cost: 0, messages: 4 });
    expect(n.cost).toBe(0);
    expect(n.messages).toBe(4);
  });

  it("falls back to no_blocks on an unknown state string", () => {
    expect(normalizeNode({ number: 1, measurability: "wat" }).measurability).toBe("no_blocks");
  });

  it("merges several changes into one layer and survives a failing one", async () => {
    const layer = await loadRunLayer(["294", "299", "294", "boom", ""]);
    // Duplicates are asked once, the empty ref not at all, and the failing change
    // costs only its own rows.
    expect(invoked.map((a) => a.change)).toEqual(["294", "299", "boom"]);
    expect([...layer.keys()].sort()).toEqual(["u-294", "u-297", "u-299"]);
    expect(layer.get("u-297")!.cost).toBeCloseTo(1.95, 5);
    expect(layer.get("u-299")!.cost).toBeCloseTo(8.36, 5);
    expect(layer.get("u-294")!.cost).toBeNull();
  });

  it("keeps groups alongside nodes, keyed by group id (t#367)", async () => {
    const layer = await loadRunGroups(["294"]);
    expect([...layer.nodes.keys()].sort()).toEqual(["u-294", "u-297"]);
    const group = layer.groups.get("u-294");
    expect(group?.duration_minutes).toBe(42);
    expect(group?.record).toBe(false);
    expect(group?.members).toEqual(["u-297"]);
  });

  it("carries whole-task attribution and the unattributed remainder", () => {
    const n = normalizeNode({
      number: 297,
      measurability: "measured",
      cost: 1.95,
      task_cost: 3.7,
      unattributed_cost: 1.75,
    });
    expect(n.task_cost).toBeCloseTo(3.7, 5);
    expect(n.unattributed_cost).toBeCloseTo(1.75, 5);
  });
});
