import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = "scripts/cli.mjs";

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["'](\.{1,2}\/[^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const META_URL = /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

function referencesOf(file) {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const dir = path.posix.dirname(file);
  const out = new Set();
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT, META_URL]) {
    for (const m of text.matchAll(re)) out.add(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  return out;
}

function closureOf(entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (!file.endsWith(".mjs")) continue;
    for (const ref of referencesOf(file)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      queue.push(ref);
    }
  }
  return seen;
}

function areaModules() {
  const text = readFileSync(path.join(ROOT, ENTRY), "utf8");
  const block = text.match(/const AREAS = \{([\s\S]*?)\n\};/);
  expect(block, "AREAS map in scripts/cli.mjs").toBeTruthy();
  return [...block[1].matchAll(/["'](\.\/cli\/[^"']+\.mjs)["']/g)].map((m) =>
    path.posix.normalize(path.posix.join("scripts", m[1])),
  );
}

function bundledResources() {
  const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return new Set(Object.values(conf.bundle.resources));
}

describe("bundle.resources covers the CLI import closure", () => {
  it("every module the CLI can reach at runtime is bundled", () => {
    const needed = new Set([ENTRY]);
    for (const area of areaModules()) for (const f of closureOf(area)) needed.add(f);
    const bundled = bundledResources();
    const missing = [...needed].filter((f) => !bundled.has(f)).sort();
    expect(missing).toEqual([]);
  });

  it("every bundled scripts/ resource is reachable from the CLI", () => {
    const needed = new Set([ENTRY]);
    for (const area of areaModules()) for (const f of closureOf(area)) needed.add(f);
    const stale = [...bundledResources()]
      .filter((f) => f.startsWith("scripts/") && !needed.has(f))
      .sort();
    expect(stale).toEqual([]);
  });

  it("resolves the known gap that shipped in PR #95", () => {
    expect(closureOf("scripts/cli/todos.mjs").has("scripts/cli/board-recover.mjs")).toBe(true);
    expect(closureOf("scripts/cli/stop-hook.mjs").has("scripts/cli/board-recover.mjs")).toBe(true);
  });
});
