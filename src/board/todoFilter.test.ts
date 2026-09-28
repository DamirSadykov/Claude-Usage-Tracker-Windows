import { describe, expect, it } from "vitest";
import { defaultTodoFilters, projectTodos } from "./todoFilter";

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
});
