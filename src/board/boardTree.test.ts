import { describe, expect, it } from "vitest";
import type { BoardChange } from "../contracts/board";
import type { BoardRow } from "./boardStore";
import { buildBoardTree, visibleBoardTreeRows, type BoardTreeRow } from "./boardTree";
import { defaultTodoFilters } from "./todoFilter";

const row = (overrides: Partial<BoardTreeRow> = {}): BoardTreeRow => ({
  id: "task-1", number: 1, subject: "Task", description: "", status: "queue", priority: "medium",
  kind: "auto", change: false, links: [], depends_on: [], created_at: "2026-09-01", updated_at: "2026-09-01",
  ref_count: 0, comment_count: 0, project: "app", ...overrides,
} as BoardRow & BoardTreeRow);

const change = (overrides: Partial<BoardChange> = {}): BoardChange => ({
  id: "c-1", number: 1, title: "Modern change", updated_at: "2026-09-02", ...overrides,
});

describe("buildBoardTree", () => {
  it("puts active changes first by activity and totals their visible tasks", () => {
    const tree = buildBoardTree([
      row({ id: "a", number: 2, subject: "Done", status: "done", change_id: "c-1", cost: 1.25 }),
      row({ id: "b", number: 1, subject: "Open", change_id: "c-1", cost: 2 }),
      row({ id: "c", number: 3, change_id: "c-2" }),
    ], [change(), change({ id: "c-2", number: 2, title: "Newest", updated_at: "2026-09-03" })], defaultTodoFilters());
    expect(tree.map((node) => node.id)).toEqual(["project:app"]);
    const changes = tree[0].children;
    expect(changes.map((node) => node.title)).toEqual(["Newest", "Modern change"]);
    expect(changes[1]).toMatchObject({ kind: "change", progress: { done: 1, total: 2 }, cost: 3.25, closed: false });
    expect(changes[1].children.map((node) => node.number)).toEqual([1, 2]);
  });

  it("represents old change roots and puts unassigned tasks in canonical project groups", () => {
    const tree = buildBoardTree([
      row({ id: "root", number: 10, subject: "Old root", change: true, status: "done" }),
      row({ id: "member", number: 11, change_id: "root" }),
      row({ id: "alias", number: 12, filterProject: "canonical", project: "old-name", cost: 4 }),
    ], [], defaultTodoFilters());
    const app = tree.find((node) => node.id === "project:app")!;
    const canonical = tree.find((node) => node.id === "project:canonical")!;
    expect(app.children[0]).toMatchObject({ kind: "legacy", id: "root", title: "Old root", closed: true });
    expect(app.children[0].children.map((node) => node.id)).toEqual(["member"]);
    expect(canonical).toMatchObject({ kind: "group", title: "canonical", cost: 4 });
    expect(canonical.children.map((node) => node.id)).toEqual(["alias"]);
  });

  it("filters tasks through projectTodos while retaining their non-empty parent", () => {
    const filters = defaultTodoFilters();
    filters.status = "queue";
    const tree = buildBoardTree([
      row({ id: "queue", change_id: "c-1", status: "queue" }),
      row({ id: "done", change_id: "c-1", status: "done" }),
      row({ id: "hidden", status: "backlog" }),
    ], [change()], filters);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.id)).toEqual(["c-1"]);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual(["queue"]);
  });
});

describe("visibleBoardTreeRows", () => {
  it("flattens expanded branches with depth and skips collapsed descendants", () => {
    const tree = buildBoardTree([row({ id: "a", change_id: "c-1" })], [change()], defaultTodoFilters());
    expect(visibleBoardTreeRows(tree, new Set()).map(({ node, depth }) => [node.id, depth])).toEqual([["project:app", 0], ["c-1", 1], ["a", 2]]);
    expect(visibleBoardTreeRows(tree, new Set(["c-1"])).map(({ node }) => node.id)).toEqual(["project:app", "c-1"]);
  });
});
