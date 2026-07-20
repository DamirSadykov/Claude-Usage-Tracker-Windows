// Unit tests for the theme-vision walk (`cli.mjs todos vision`, t#252).
//
// The pure helpers are what's worth testing: the UP-walk that finds the nearest
// theme root(s) along each branch of the reverse dep graph, and the block both
// `vision <task>` and the in_progress anchor print.

import { describe, it, expect } from "vitest";
import { themeRootsFor, formatThemeVision } from "./todos.mjs";

// Minimal board builder: rows are [id, {theme, depends_on, ...}].
const board = (...rows) => ({
  todos: rows.map(([id, extra], i) => ({
    id,
    number: i + 1,
    subject: `task ${id}`,
    status: "queue",
    ...extra,
  })),
});

const byId = (data, id) => data.todos.find((t) => t.id === id);

describe("themeRootsFor", () => {
  it("finds the theme root straight above a subtask", () => {
    const data = board(["child"], ["root", { theme: true, depends_on: ["child"] }]);
    const roots = themeRootsFor(data, byId(data, "child"));
    expect(roots.map((r) => r.id)).toEqual(["root"]);
  });

  it("walks through non-theme intermediates to the nearest root", () => {
    const data = board(
      ["leaf"],
      ["mid", { depends_on: ["leaf"] }],
      ["root", { theme: true, depends_on: ["mid"] }],
    );
    expect(themeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "root",
    ]);
  });

  it("stops at the NEAREST root — an outer theme wrapping an inner one stays out", () => {
    const data = board(
      ["leaf"],
      ["inner", { theme: true, depends_on: ["leaf"] }],
      ["outer", { theme: true, depends_on: ["inner"] }],
    );
    expect(themeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "inner",
    ]);
  });

  it("reports a root reachable via two branches once (diamond)", () => {
    const data = board(
      ["leaf"],
      ["a", { depends_on: ["leaf"] }],
      ["b", { depends_on: ["leaf"] }],
      ["root", { theme: true, depends_on: ["a", "b"] }],
    );
    expect(themeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "root",
    ]);
  });

  it("collects several distinct roots when branches lead to different themes", () => {
    const data = board(
      ["leaf"],
      ["root1", { theme: true, depends_on: ["leaf"] }],
      ["root2", { theme: true, depends_on: ["leaf"] }],
    );
    const ids = themeRootsFor(data, byId(data, "leaf")).map((r) => r.id);
    expect(ids.sort()).toEqual(["root1", "root2"]);
  });

  it("returns nothing when no theme sits above, and never the task itself", () => {
    const data = board(
      ["self", { theme: true }],
      ["dep", { depends_on: ["self"] }],
    );
    expect(themeRootsFor(data, byId(data, "self"))).toEqual([]);
    expect(themeRootsFor(data, byId(data, "dep"))).toEqual([]);
  });
});

describe("formatThemeVision", () => {
  const t = { number: 7, subject: "the subtask" };

  it("prints each root's description as the vision", () => {
    const out = formatThemeVision(t, [
      { number: 9, subject: "ТЕМА: X", status: "queue", description: "north star text" },
    ]);
    expect(out).toContain('#7 "the subtask"');
    expect(out).toContain("theme t#9 ТЕМА: X [queue]");
    expect(out).toContain("north star text");
  });

  it("nudges to fill an empty description instead of printing a blank block", () => {
    const out = formatThemeVision(t, [
      { number: 9, subject: "ТЕМА: X", status: "queue", description: "  " },
    ]);
    expect(out).toContain("vision is missing");
    expect(out).toContain("todos set-description 9");
  });
});
