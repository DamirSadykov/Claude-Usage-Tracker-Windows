import { describe, it, expect } from "vitest";
import { diffLines, diffHunks, diffStat } from "./specDiff";

describe("specDiff", () => {
  it("marks a rewritten line as removal plus addition, keeping its neighbours", () => {
    const d = diffLines("- один\n- два\n- три", "- один\n- два, переписанный\n- три");
    expect(d.map((l) => l.op + l.text)).toEqual([
      " - один",
      "-- два",
      "+- два, переписанный",
      " - три",
    ]);
  });

  it("an insertion does not shift everything after it", () => {
    const d = diffLines("- a\n- b", "- a\n- новый\n- b");
    expect(diffStat(d)).toEqual({ added: 1, removed: 0 });
  });

  it("identical text is all context and yields no hunks", () => {
    const same = "- a\n- b\n- c";
    const d = diffLines(same, same);
    expect(d.every((l) => l.op === " ")).toBe(true);
    expect(diffHunks(d)).toEqual([]);
  });

  it("an empty baseline reads as a section written from nothing", () => {
    expect(diffStat(diffLines("", "- a\n- b"))).toEqual({ added: 2, removed: 0 });
  });

  it("hunks cut the untouched middle out and number both sides", () => {
    const before = Array.from({ length: 20 }, (_, i) => `- пункт ${i}`).join("\n");
    const after = before.replace("- пункт 0", "- пункт 0, правленый");
    const h = diffHunks(diffLines(before, after), 1);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    // The 18 untouched lines at the end are not in the hunk.
    expect(h[0].lines.length).toBeLessThan(6);
  });

  it("two separate edits give two hunks, not one spanning the section", () => {
    const before = Array.from({ length: 12 }, (_, i) => `- ${i}`).join("\n");
    const after = before.replace("- 0", "- 0!").replace("- 11", "- 11!");
    expect(diffHunks(diffLines(before, after), 1)).toHaveLength(2);
  });
});
