import { describe, expect, it } from "vitest";
import type { BoardChange } from "../contracts/board";
import type { BoardRow } from "./boardStore";
import { boardTreeSummary, buildBoardTree, visibleBoardTreeRows, type BoardTreeRow } from "./boardTree";
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
    expect(canonical.children).toMatchObject([{ kind: "ungrouped", progress: { done: 0, total: 1 }, cost: 4 }]);
    expect(canonical.children[0].children.map((node) => node.id)).toEqual(["alias"]);
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

  it("marks a change complete when it is closed or all of its tasks are done", () => {
    const allDone = buildBoardTree([
      row({ id: "done-a", change_id: "c-1", status: "done" }),
      row({ id: "done-b", change_id: "c-1", status: "done" }),
    ], [change()], { ...defaultTodoFilters(), showDone: true });
    const explicitlyClosed = buildBoardTree([
      row({ id: "open", change_id: "c-1" }),
    ], [change({ closed_at: "2026-09-03" })], defaultTodoFilters());

    expect(allDone[0].children[0].closed).toBe(true);
    expect(explicitlyClosed[0].children[0].closed).toBe(true);
  });

  it("does not mark a partially done change complete when a status filter hides its open task", () => {
    const filters = { ...defaultTodoFilters(), status: "done" };
    const tree = buildBoardTree([
      row({ id: "done", change_id: "c-1", status: "done" }),
      row({ id: "open", change_id: "c-1", status: "queue" }),
    ], [change()], filters);

    expect(tree[0].children[0]).toMatchObject({
      progress: { done: 1, total: 1 },
      closed: false,
    });
  });

  it("builds a flat, newest-first change list with the project on each change", () => {
    const tree = buildBoardTree([
      row({ id: "old", change_id: "c-1", project: "first" }),
      row({ id: "new", change_id: "c-2", project: "second" }),
      row({ id: "legacy", number: 3, subject: "Legacy", change: true, created_at: "2026-09-04", project: "third" }),
      row({ id: "closed", change_id: "c-3", project: "fourth" }),
    ], [
      change({ id: "c-1", number: 1, created_at: "2026-09-01", updated_at: "2026-09-30" }),
      change({ id: "c-2", number: 2, created_at: "2026-09-03", updated_at: "2026-09-01" }),
      change({ id: "c-3", number: 4, created_at: "2026-09-05", closed_at: "2026-09-06" }),
    ], defaultTodoFilters(), undefined, { flat: true });

    expect(tree.map((node) => [node.id, node.project])).toEqual([
      ["legacy", "third"], ["c-2", "second"], ["c-1", "first"], ["c-3", "fourth"],
    ]);
    expect(tree.every((node) => node.kind === "change" || node.kind === "legacy")).toBe(true);
  });

  it("finds flat changes by title and c-number, revealing all members on a change match", () => {
    const filters = { ...defaultTodoFilters(), query: "release notes" };
    const tree = buildBoardTree([
      row({ id: "matching-title-member", subject: "Unrelated task", change_id: "c-1" }),
      row({ id: "other-change-member", subject: "release notes task", change_id: "c-2" }),
      row({ id: "hidden", change_id: "c-3" }),
    ], [
      change({ id: "c-1", number: 71, title: "Release notes" }),
      change({ id: "c-2", number: 72, title: "Other change" }),
      change({ id: "c-3", number: 73, title: "Hidden change" }),
    ], filters, undefined, { flat: true });

    expect(tree.map((node) => node.id)).toEqual(["c-2", "c-1"]);
    expect(tree.find((node) => node.id === "c-1")?.children.map((node) => node.id)).toEqual(["matching-title-member"]);

    const byNumber = buildBoardTree([
      row({ id: "number-member", subject: "Unrelated", change_id: "c-1" }),
    ], [change({ id: "c-1", number: 71, title: "Other change" })],
    { ...defaultTodoFilters(), query: "c#71" }, undefined, { flat: true });
    expect(byNumber.map((node) => node.id)).toEqual(["c-1"]);
  });

  it("keeps the project filter when a flat change matches only by title", () => {
    const tree = buildBoardTree([
      row({ id: "foreign", subject: "Unrelated", change_id: "c-1", project: "other" }),
    ], [change({ id: "c-1", number: 71, title: "Release notes", project: "other" })],
    { ...defaultTodoFilters(), query: "release", project: "mine" }, undefined, { flat: true });
    expect(tree).toEqual([]);
  });
});

describe("boardTreeSummary", () => {
  it("counts task leaves once, including tasks in the without-change group", () => {
    const tree = buildBoardTree([
      row({ id: "open", change_id: "c-1", cost: 1.25 }),
      row({ id: "done", status: "done", cost: 2.5 }),
    ], [change()], { ...defaultTodoFilters(), showDone: true });
    expect(boardTreeSummary(tree)).toEqual({ active: 1, total: 2, cost: 3.75 });
  });
});

describe("visibleBoardTreeRows", () => {
  it("flattens expanded branches with depth and skips collapsed descendants", () => {
    const tree = buildBoardTree([row({ id: "a", change_id: "c-1" })], [change()], defaultTodoFilters());
    expect(visibleBoardTreeRows(tree, new Set()).map(({ node, depth }) => [node.id, depth])).toEqual([["project:app", 0], ["c-1", 1], ["a", 2]]);
    expect(visibleBoardTreeRows(tree, new Set(["c-1"])).map(({ node }) => node.id)).toEqual(["project:app", "c-1"]);
  });
});
