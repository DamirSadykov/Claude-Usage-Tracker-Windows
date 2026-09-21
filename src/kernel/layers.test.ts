import { describe, expect, it } from "vitest";

const ALLOWED: Record<string, readonly string[]> = {
  kernel: ["kernel"],
  contracts: [],
  analytics: ["kernel", "contracts"],
  board: ["kernel", "contracts"],
  process: ["kernel", "contracts", "board"],
  spec: ["kernel", "contracts"],
  external: ["kernel", "contracts"],
  windows: ["kernel", "contracts", "analytics", "board", "process", "spec", "external", "windows"],
};

const ROOT_FILES = new Set(["App.vue", "main.ts", "env.d.ts"]);
const IMPORT = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

const rawModules = import.meta.glob("../**/*.{ts,vue}", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

function moduleId(filename: string) {
  if (filename.startsWith("../")) return filename.slice(3);
  if (filename.startsWith("./")) return `kernel/${filename.slice(2)}`;
  return filename;
}

function normalize(p: string) {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function isTest(id: string) {
  return id.endsWith(".test.ts");
}

function layerOf(id: string) {
  const [first, ...rest] = id.split("/");
  return rest.length === 0 ? null : first;
}

function displayTarget(id: string) {
  return id.replace(/\.(?:ts|vue)$/, "");
}

function resolveImport(source: string, specifier: string, modules: Set<string>) {
  const dir = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  const resolved = normalize(`${dir}/${specifier}`);
  const candidates = [resolved, `${resolved}.ts`, `${resolved}.vue`, `${resolved}/index.ts`, `${resolved}/index.vue`];
  return candidates.find((candidate) => modules.has(candidate)) ?? null;
}

function graph() {
  const modules = new Map(
    Object.entries(rawModules)
      .map(([filename, text]) => [moduleId(filename), text] as const)
      .filter(([id]) => !isTest(id)),
  );
  const ids = new Set(modules.keys());
  const edges = new Map<string, Set<string>>();

  for (const [source, text] of modules) {
    const deps = new Set<string>();
    for (const match of text.matchAll(IMPORT)) {
      const target = resolveImport(source, match[1] ?? match[2], ids);
      if (target) deps.add(target);
    }
    edges.set(source, deps);
  }
  return { modules: ids, edges };
}

function findCycle(edges: Map<string, Set<string>>) {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, "open");
    stack.push(node);
    for (const dependency of edges.get(node) ?? []) {
      if (state.get(dependency) === "open") return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of edges.keys()) {
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

describe("src layers", () => {
  const { modules, edges } = graph();

  it("keeps every non-test module in a known layer or at an approved root entry point", () => {
    const stray = [...modules].filter((id) => {
      const layer = layerOf(id);
      return layer ? !(layer in ALLOWED) : !ROOT_FILES.has(id);
    });
    expect(stray).toEqual([]);
  });

  it("imports only allowed layers and never imports App.vue from a layer", () => {
    const bad: string[] = [];
    for (const [source, dependencies] of edges) {
      const sourceLayer = layerOf(source);
      for (const target of dependencies) {
        if (target.endsWith("/App.vue") || target === "App.vue") {
          if (source !== "main.ts") bad.push(`${source} -> ${displayTarget(target)}`);
          continue;
        }
        if (!sourceLayer) continue; // Root entry points are adapters.
        const targetLayer = layerOf(target);
        if (targetLayer && targetLayer !== sourceLayer && !ALLOWED[sourceLayer].includes(targetLayer)) {
          bad.push(`${source} -> ${displayTarget(target)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("has no static or literal dynamic import cycle", () => {
    const cycle = findCycle(edges);
    expect(cycle ? cycle.join(" -> ") : null).toBeNull();
  });
});
