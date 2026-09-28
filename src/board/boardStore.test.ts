import { describe, expect, it } from "vitest";
import { buildIndexes, type BoardRow } from "./boardStore";

const row = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  id: "a", number: 1, subject: "Ship board", description: "Shared store", status: "queue",
  priority: "high", kind: "auto", change: false, links: [], depends_on: [],
  created_at: "", updated_at: "", ref_count: 0, comment_count: 0, ...overrides,
});

describe("buildIndexes", () => {
  it("builds id, dependency, link and lower-case search indexes from one snapshot", () => {
    const indexes = buildIndexes([row({ id: "a", links: ["b"] }), row({ id: "b", depends_on: ["a"], subject: "Review API" })]);
    expect(indexes.byId.get("a")?.subject).toBe("Ship board");
    expect(indexes.dependencyChildren.get("a")).toEqual(["b"]);
    expect(indexes.links.get("a")).toEqual(["b"]);
    expect(indexes.search.get("b")).toContain("review api");
  });
});
