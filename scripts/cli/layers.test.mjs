import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["']\.\/([^"']+)\.mjs["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']\.\/([^"']+)\.mjs["']\s*\)/g;
const KERNEL = new Set(["settings", "board-lock", "board-recover", "yaml-subset", "board-io"]);

function graph() {
  const g = new Map();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
    const text = readFileSync(path.join(DIR, f), "utf8");
    const deps = new Set();
    for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) for (const m of text.matchAll(re)) deps.add(m[1]);
    g.set(f.slice(0, -4), deps);
  }
  return g;
}

function findCycle(g) {
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, "open");
    stack.push(n);
    for (const d of g.get(n) ?? []) {
      const s = state.get(d);
      if (s === "open") return [...stack.slice(stack.indexOf(d)), d];
      if (!s) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const n of g.keys()) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

describe("scripts/cli import graph", () => {
  const g = graph();

  it("has no import cycle, static or dynamic", () => {
    const cycle = findCycle(g);
    expect(cycle ? cycle.join(" -> ") : null).toBeNull();
  });

  it("kernel modules import only kernel modules", () => {
    const leaks = [];
    for (const k of KERNEL) for (const d of g.get(k) ?? []) if (!KERNEL.has(d)) leaks.push(`${k} -> ${d}`);
    expect(leaks).toEqual([]);
  });

  it("keeps the board independent of the spec ritual", () => {
    expect(g.get("todos")).not.toContain("spec");
  });
});
