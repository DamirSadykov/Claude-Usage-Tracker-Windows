import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = /(?:(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*|import\(\s*)["'](\.{1,2}\/[^"']+\.mjs)["']/g;
const ALLOWED = {
  kernel: ["kernel"],
  board: ["kernel"],
  agents: ["kernel"],
  spec: ["kernel"],
  process: ["kernel", "board", "agents"],
  analytics: ["kernel", "board"],
  "cc-hooks": ["kernel", "board", "agents", "spec", "process", "analytics", "cc-hooks"],
};

function modules() {
  const out = [];
  for (const entry of readdirSync(ROOT)) {
    const dir = path.join(ROOT, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
      out.push(`${entry}/${f.slice(0, -4)}`);
    }
  }
  return out;
}

function graph() {
  const g = new Map();
  for (const id of modules()) {
    const [layer] = id.split("/");
    const text = readFileSync(path.join(ROOT, `${id}.mjs`), "utf8");
    const deps = new Set();
    for (const m of text.matchAll(IMPORT)) {
      const target = path.posix.normalize(path.posix.join(layer, m[1])).replace(/\.mjs$/, "");
      deps.add(target);
    }
    g.set(id, deps);
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

describe("scripts/cli layers", () => {
  const g = graph();

  it("every module sits in a known layer directory", () => {
    const stray = [...g.keys()].filter((id) => !(id.split("/")[0] in ALLOWED));
    expect(stray).toEqual([]);
    const flat = readdirSync(ROOT).filter((f) => f.endsWith(".mjs"));
    expect(flat).toEqual([]);
  });

  it("imports only cross layer boundaries the layer map allows", () => {
    const bad = [];
    for (const [id, deps] of g) {
      const [layer] = id.split("/");
      for (const d of deps) {
        const target = d.split("/")[0];
        if (target !== layer && !(ALLOWED[layer] ?? []).includes(target)) bad.push(`${id} -> ${d}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has no import cycle, static or dynamic", () => {
    const cycle = findCycle(g);
    expect(cycle ? cycle.join(" -> ") : null).toBeNull();
  });
});
