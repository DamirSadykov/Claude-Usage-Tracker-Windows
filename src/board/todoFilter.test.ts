import { describe, expect, it } from "vitest";
import { countAttention, defaultTodoFilters, localToday, projectTodos } from "./todoFilter";

const rows: any[] = [
  { id: "1", number: 1, subject: "Alpha", description: "needle", status: "backlog", priority: "high", project: "a", created_by: "user", change: false, created_at: "2026-09-01", updated_at: "2026-09-02", scheduled_for: null },
  { id: "2", number: 2, subject: "Change", description: "", status: "done", priority: "low", project: "b", created_by: "claude", change: true, created_at: "2026-09-03", updated_at: "2026-09-05", scheduled_for: null },
];

describe("projectTodos", () => {
  it("filters with the indexed search text and omits done by default", () => {
    const filters = defaultTodoFilters(); filters.query = "needle";
    const result = projectTodos(rows, filters, { search: new Map([["1", "indexed needle"], ["2", "change"]]) });
    expect(result.columns.backlog.map(x => x.id)).toEqual(["1"]);
    expect(result.columns.done).toEqual([]);
  });
  it("applies metadata filters and includes done when requested", () => {
    const filters = defaultTodoFilters(); Object.assign(filters, { showDone: true, createdBy: "claude", change: "change", createdFrom: "2026-09-02" });
    expect(projectTodos(rows, filters).columns.done.map(x => x.id)).toEqual(["2"]);
  });
  it("orders done by completion date rather than a later edit", () => {
    const filters = defaultTodoFilters(); filters.showDone = true;
    const done = [
      { ...rows[1], id: "older-close", closed_at: "2026-09-04", updated_at: "2026-09-10" },
      { ...rows[1], id: "newer-close", closed_at: "2026-09-06", updated_at: "2026-09-07" },
    ];
    expect(projectTodos(done, filters).columns.done.map(x => x.id)).toEqual(["newer-close", "older-close"]);
  });
  it("matches a merged project's canonical filter name without changing its label", () => {
    const filters = defaultTodoFilters(); filters.project = "canonical";
    const result = projectTodos([{ ...rows[0], project: "old-alias", filterProject: "canonical" }], filters);
    expect(result.columns.backlog.map(x => x.project)).toEqual(["old-alias"]);
  });
  it("shows overdue unfinished tasks only", () => {
    const filters = defaultTodoFilters(); filters.attention = "overdue";
    const result = projectTodos([
      { ...rows[0], id: "overdue", scheduled_for: "2026-09-30" },
      { ...rows[0], id: "today", scheduled_for: "2026-10-01" },
      { ...rows[1], id: "done-overdue", scheduled_for: "2026-09-30" },
    ], { ...filters, showDone: true }, undefined, "2026-10-01");
    expect(result.visible.map(x => x.id)).toEqual(["overdue"]);
  });
  it("treats active tasks updated strictly more than 14 days ago as stale", () => {
    const filters = defaultTodoFilters(); filters.attention = "stale";
    const result = projectTodos([
      { ...rows[0], id: "at-boundary", status: "queue", updated_at: "2026-09-17" },
      { ...rows[0], id: "stale", status: "review", updated_at: "2026-09-16" },
      { ...rows[0], id: "backlog", status: "backlog", updated_at: "2026-09-01" },
    ], filters, undefined, "2026-10-01");
    expect(result.visible.map(x => x.id)).toEqual(["stale"]);
  });
  it("shows active tasks without a priority", () => {
    const filters = defaultTodoFilters(); filters.attention = "no_priority";
    const result = projectTodos([
      { ...rows[0], id: "unprioritized", status: "in_progress", priority: "" },
      { ...rows[0], id: "prioritized", status: "queue", priority: "low" },
      { ...rows[0], id: "backlog", status: "backlog", priority: undefined },
    ], filters, undefined, "2026-10-01");
    expect(result.visible.map(x => x.id)).toEqual(["unprioritized"]);
  });
  it("counts attention among rows matching the other filters", () => {
    const filters = defaultTodoFilters(); filters.project = "a";
    const counts = countAttention([
      { ...rows[0], id: "overdue", status: "queue", scheduled_for: "2026-09-30", updated_at: "2026-09-30", priority: "high" },
      { ...rows[0], id: "stale", status: "review", scheduled_for: null, updated_at: "2026-09-16", priority: "medium" },
      { ...rows[0], id: "no-priority", status: "in_progress", scheduled_for: null, updated_at: "2026-09-30", priority: undefined },
      { ...rows[0], id: "other-project", project: "b", status: "queue", scheduled_for: "2026-09-20", updated_at: "2026-09-01", priority: undefined },
    ], filters, "2026-10-01");
    expect(counts).toEqual({ overdue: 1, stale: 1, no_priority: 1 });
  });
});

describe("localToday", () => {
  it("formats the local calendar date, not the UTC one", () => {
    expect(localToday(new Date(2026, 9, 1, 23, 30))).toBe("2026-10-01");
    expect(localToday(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
  });
});
