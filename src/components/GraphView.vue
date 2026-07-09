<script setup lang="ts">
// Task-graph view (#88): an alternative rendering of the SAME board the kanban
// shows, toggled in place inside the Tasks window. It takes the loaded todo list
// and the active project filter as props — no window, no picker of its own.
//
// TWO graphs, switched by a tab, over the same tasks (a node can appear in both):
//   • Deps — a left→right pipeline built ONLY from `depends_on` (GitLab/GitHub
//     style): x = dependency depth, parallel tasks stack in a column, arrows run
//     across. This is the editable one: drag node→node to add an edge,
//     right-click an arrow to remove it.
//   • Ref — a graph of non-blocking mentions (`links` + inline `t#N`), laid out by
//     connected component. Cross-board ref targets show as dashed external nodes.
// Each tab shows only the tasks that participate in that kind of link, so nothing
// gets forced into a meaningless grid.
//
// Pointer model: LEFT-click a node highlights its connections; drag (Deps tab)
// creates a dependency; RIGHT-click a node opens its card.
import { ref, computed, watch, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import type { Todo } from "./TodoWindow.vue";

const props = defineProps<{
  todos: Todo[];
  // The active board. "" means the kanban's "All projects" — show every task.
  project: string;
}>();
const emit = defineEmits<{
  (e: "update", todos: Todo[]): void;
  (e: "open", id: string): void;
}>();

const { t } = useI18n();

type Tab = "deps" | "ref";
const tab = ref<Tab>("deps");

// Kanban columns, in board order — mirrors todos.rs::STATUSES / TodoWindow.
const STATUS_ORDER = ["backlog", "queue", "in_progress", "review", "done"] as const;
const STATUS_LABEL: Record<string, string> = {
  backlog: "colBacklog",
  queue: "colQueue",
  in_progress: "statusInProgress",
  review: "colReview",
  done: "statusDone",
};
const STATUS_COLOR: Record<string, string> = {
  backlog: "#9aa0aa",
  queue: "#ffc107",
  in_progress: "#4cc2ff",
  review: "#b388ff",
  done: "#6ccb5f",
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? "#9aa0aa";
const canonStatus = (s: string) =>
  (STATUS_ORDER as readonly string[]).includes(s) ? s : "backlog";

// Which statuses are shown. Defaults to everything except `done`.
const visibleStatuses = ref<Set<string>>(
  new Set(STATUS_ORDER.filter((s) => s !== "done")),
);
function toggleStatus(s: string) {
  const next = new Set(visibleStatuses.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  visibleStatuses.value = next;
}

const errorMsg = ref("");
let errorTimer: number | null = null;
function flashError(msg: string) {
  errorMsg.value = msg;
  if (errorTimer !== null) clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => (errorMsg.value = ""), 4000);
}

const boardOf = (x: Todo) => x.project || "";

const byNumber = computed(() => {
  const m = new Map<number, Todo>();
  for (const x of props.todos) if (x.number) m.set(x.number, x);
  return m;
});
const byId = computed(() => {
  const m = new Map<string, Todo>();
  for (const x of props.todos) m.set(x.id, x);
  return m;
});

// --- Geometry constants ----------------------------------------------------
interface GNode {
  id: string;
  number?: number;
  subject: string;
  status: string;
  external: boolean;
  extProject?: string;
  lines: string[]; // subject wrapped to fit the node width
  h: number; // node height, grown to fit the wrapped lines
  x: number;
  y: number;
}
interface GEdge {
  fromId: string;
  toId: string;
  kind: "dep" | "ref";
  // A dep edge whose order already follows from a longer path — drawn faintly.
  redundant?: boolean;
}
// A project's bounding band on the Deps tab: heading + framed region around all of
// that board's nodes, so "All projects" reads as separate pipelines.
interface DepBand {
  project: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODE_W = 190;
const NODE_H = 46; // height of a single-line node; taller nodes add LINE_H each
const LINE_H = 15; // subject line height
const WRAP_CHARS = 26; // approx chars per line at NODE_W
const MAX_LINES = 3; // subject lines before ellipsis
const COL_GAP = 250;
const V_GAP = 26; // vertical gap between stacked nodes (deps pipeline)
const MARGIN = 40;
const BAND_HEAD = 30; // vertical room above a project group for its heading (deps)
const BAND_GAP = 46; // gap between stacked project groups (deps)

// Greedy word-wrap of a subject to fit the node: up to MAX_LINES lines of about
// WRAP_CHARS each, ellipsis if it still overflows. A single over-long word is
// hard-sliced so it can't blow past the box.
function wrapLines(text: string): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (lines.length >= MAX_LINES) break;
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length <= WRAP_CHARS) {
      cur = cand;
      continue;
    }
    if (cur) lines.push(cur);
    if (lines.length >= MAX_LINES) {
      cur = "";
      break;
    }
    if (w.length > WRAP_CHARS) {
      let rest = w;
      while (rest.length > WRAP_CHARS && lines.length < MAX_LINES) {
        lines.push(rest.slice(0, WRAP_CHARS));
        rest = rest.slice(WRAP_CHARS);
      }
      cur = rest;
    } else {
      cur = w;
    }
  }
  if (cur && lines.length < MAX_LINES) lines.push(cur);
  // If content was dropped, mark the last line with an ellipsis.
  const full = (text || "").replace(/\s+/g, " ").trim();
  if (lines.join(" ").length < full.length && lines.length) {
    const i = lines.length - 1;
    lines[i] = lines[i].slice(0, WRAP_CHARS - 1).replace(/\s+$/, "") + "…";
  }
  return lines.length ? lines : [""];
}

// Inline task references in a task's text. `t#N`, NOT a bare `#N` (#63): in prose
// `#104` almost always means a GitHub PR/issue, and matching it against task
// numbers drew phantom (often cross-project) ref edges. Only the explicit `t#N`
// form is a ref; the `t` must not be a word tail (lookbehind rejects `part#5`).
function inlineRefs(x: Todo): number[] {
  const text = `${x.description || ""}\n${x.plan || ""}`;
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[tT]#(\d+)/g)) out.add(parseInt(m[1], 10));
  return [...out];
}

const boardTasks = computed(() =>
  props.project ? props.todos.filter((x) => boardOf(x) === props.project) : props.todos.slice(),
);
const shownTasks = computed(() =>
  boardTasks.value.filter((x) => visibleStatuses.value.has(canonStatus(x.status))),
);

// Base node record for a task (fresh object each build so the two tabs never
// share/clobber coordinates).
// Truncate the external-project label so `#N project` fits the node width; the
// full name is shown as a <title> tooltip. Budget = line width minus "#N ".
function extLabel(n: GNode): string {
  const p = n.extProject ?? "";
  const budget = WRAP_CHARS - String(n.number ?? "").length - 2;
  return p.length > budget ? p.slice(0, Math.max(4, budget - 1)) + "…" : p;
}

function baseNode(x: Todo, external = false): GNode {
  const lines = wrapLines(x.subject);
  return {
    id: x.id,
    number: x.number,
    subject: x.subject,
    status: x.status,
    external,
    extProject: external ? boardOf(x) || t("graphExternal") : undefined,
    lines,
    h: NODE_H + (lines.length - 1) * LINE_H,
    x: 0,
    y: 0,
  };
}

// Raw edges over the shown tasks: dep (within-board, directed) and ref (mentions
// + links, possibly cross-board → external node). Nodes are materialized per tab.
const raw = computed(() => {
  const tasks = shownTasks.value;
  const boardIds = new Set(tasks.map((x) => x.id));
  const depEdges: GEdge[] = [];
  const refEdges: GEdge[] = [];
  const refSeen = new Set<string>();
  const externalTargets = new Map<string, Todo>();

  for (const x of tasks) {
    for (const depId of x.depends_on ?? []) {
      if (boardIds.has(depId)) depEdges.push({ fromId: depId, toId: x.id, kind: "dep" });
    }
    const addRef = (target: Todo) => {
      if (target.id === x.id) return;
      if (!boardIds.has(target.id)) externalTargets.set(target.id, target);
      const key = `${x.id} ${target.id}`;
      if (refSeen.has(key)) return;
      refSeen.add(key);
      refEdges.push({ fromId: x.id, toId: target.id, kind: "ref" });
    };
    for (const linkId of x.links ?? []) {
      const target = byId.value.get(linkId);
      if (target) addRef(target);
    }
    for (const num of inlineRefs(x)) {
      const target = byNumber.value.get(num);
      if (target) addRef(target);
    }
  }
  return { tasks, boardIds, depEdges, refEdges, externalTargets };
});

// --- Deps tab: per-project ALAP pipeline layout ----------------------------
const depModel = computed<{ nodes: GNode[]; edges: GEdge[]; bands: DepBand[] }>(() => {
  const { tasks, depEdges } = raw.value;
  const inGraph = new Set<string>();
  for (const e of depEdges) {
    inGraph.add(e.fromId);
    inGraph.add(e.toId);
  }
  const taskById = new Map(tasks.map((x) => [x.id, x]));
  const nodes = new Map<string, GNode>();
  for (const id of inGraph) {
    const x = taskById.get(id);
    if (x) nodes.set(id, baseNode(x));
  }

  // Upstream (prerequisites) and downstream (dependents) adjacency. Dep edges are
  // always intra-board (the CLI / back end reject a cross-project dependency), so a
  // node's neighbours are always on the same project board as the node itself.
  const prereqOf = new Map<string, string[]>();
  const dependentOf = new Map<string, string[]>();
  for (const id of inGraph) {
    prereqOf.set(id, []);
    dependentOf.set(id, []);
  }
  for (const e of depEdges) {
    prereqOf.get(e.toId)!.push(e.fromId);
    dependentOf.get(e.fromId)!.push(e.toId);
  }
  const numOf = (id: string) => nodes.get(id)!.number ?? 0;
  const colHeight = (ids: string[]) =>
    ids.reduce((s, id) => s + nodes.get(id)!.h, 0) + (ids.length - 1) * V_GAP;

  // Longest path along `adj` (memoized, cycle-guarded). Reused for both ASAP depth
  // (down prerequisites) and height-to-sink (down dependents).
  const longest = (
    id: string,
    adj: Map<string, string[]>,
    memo: Map<string, number>,
    guard: Set<string>,
  ): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (guard.has(id)) return 0; // deps are acyclic, but never loop on a bad edge
    guard.add(id);
    let d = 0;
    for (const nb of adj.get(id) ?? []) d = Math.max(d, longest(nb, adj, memo, guard) + 1);
    guard.delete(id);
    memo.set(id, d);
    return d;
  };

  // Lay ONE project's dep-subgraph out in local coordinates (origin 0,0), writing
  // x/y onto its nodes and returning the group's size. Column = ALAP level (as-late-
  // as-possible): a prerequisite sits in the column DIRECTLY LEFT of what it blocks
  // instead of being flung to depth 0 the moment it has no prerequisites of its own
  // (#126: 124/125 belong one level before the key task 121). ASAP depth only fixes
  // the pipeline length `maxLvl`; the level is maxLvl minus the height to a sink.
  // Within a column, barycenter sweeps line connected tasks up level with each other
  // and cut crossing arrows; task number seeds the order and breaks ties, so the
  // layout stays stable across rebuilds.
  const layoutGroup = (groupIds: string[]): { w: number; h: number } => {
    const asapMemo = new Map<string, number>();
    let maxLvl = 0;
    for (const id of groupIds) maxLvl = Math.max(maxLvl, longest(id, prereqOf, asapMemo, new Set()));
    const sinkMemo = new Map<string, number>();
    const levelOf = (id: string) => maxLvl - longest(id, dependentOf, sinkMemo, new Set());

    const columns = new Map<number, string[]>();
    for (const id of groupIds) {
      const lvl = levelOf(id);
      (columns.get(lvl) ?? columns.set(lvl, []).get(lvl)!).push(id);
    }
    const levels = [...columns.keys()].sort((a, b) => a - b);
    for (const lvl of levels) columns.get(lvl)!.sort((a, b) => numOf(a) - numOf(b));
    const posOf = new Map<string, number>();
    for (const lvl of levels) columns.get(lvl)!.forEach((id, i) => posOf.set(id, i));
    for (let sweep = 0; sweep < 6; sweep++) {
      const downward = sweep % 2 === 0; // alternate: align to prereqs, then to dependents
      const walk = downward ? levels : [...levels].reverse();
      const neighbourOf = downward ? prereqOf : dependentOf;
      for (const lvl of walk) {
        const colIds = columns.get(lvl)!;
        const bary = new Map<string, number>();
        for (const id of colIds) {
          const rows = (neighbourOf.get(id) ?? [])
            .map((nb) => posOf.get(nb))
            .filter((v): v is number => v !== undefined);
          bary.set(id, rows.length ? rows.reduce((s, v) => s + v, 0) / rows.length : posOf.get(id)!);
        }
        colIds.sort((a, b) => bary.get(a)! - bary.get(b)! || numOf(a) - numOf(b));
        colIds.forEach((id, i) => posOf.set(id, i)); // later columns this sweep see the new rows
      }
    }
    // x by the column's ORDINAL among occupied levels (ALAP can leave level 0 empty
    // — pack columns left so there's no blank leading gap); y stacks the ordered
    // column, centered in the group's tallest column.
    const bandH = Math.max(NODE_H, ...levels.map((l) => colHeight(columns.get(l)!)));
    levels.forEach((lvl, ord) => {
      const ids = columns.get(lvl)!;
      let y = (bandH - colHeight(ids)) / 2;
      for (const id of ids) {
        const n = nodes.get(id)!;
        n.x = ord * COL_GAP;
        n.y = y;
        y += n.h + V_GAP;
      }
    });
    const w = levels.length ? (levels.length - 1) * COL_GAP + NODE_W : NODE_W;
    return { w, h: bandH };
  };

  // Split the graph by project board, lay each project out on its own, then stack
  // the projects top-to-bottom with a clear gap + heading — so "All projects" reads
  // as separate pipelines, not one interleaved grid. A single board (project filter
  // set, or only one present) skips the heading and frame.
  const groups = new Map<string, string[]>();
  for (const id of inGraph) {
    const p = boardOf(taskById.get(id)!);
    (groups.get(p) ?? groups.set(p, []).get(p)!).push(id);
  }
  const showBands = groups.size > 1;
  const order = [...groups.keys()].sort(
    (a, b) => Math.min(...groups.get(a)!.map(numOf)) - Math.min(...groups.get(b)!.map(numOf)),
  );
  const bands: DepBand[] = [];
  let curY = MARGIN;
  for (const proj of order) {
    const ids = groups.get(proj)!;
    const { w, h } = layoutGroup(ids);
    const headH = showBands ? BAND_HEAD : 0;
    const offY = curY + headH;
    for (const id of ids) {
      const n = nodes.get(id)!;
      n.x += MARGIN;
      n.y += offY;
    }
    if (showBands) {
      bands.push({ project: proj || t("graphGlobalBoard"), x: MARGIN, y: curY, w, h: h + headH });
    }
    curY = offY + h + (showBands ? BAND_GAP : V_GAP);
  }

  // Soft transitive reduction: an edge u→v is REDUNDANT when v is already
  // reachable from u through another child (the same order follows from the
  // longer path). We don't hide it — hiding would make it undeletable and drop
  // the fact that it exists — we mark it so it's drawn faintly, keeping the
  // pipeline readable without a bold edge shooting across an intermediate column.
  const children = new Map<string, string[]>();
  for (const e of depEdges) (children.get(e.fromId) ?? children.set(e.fromId, []).get(e.fromId)!).push(e.toId);
  const reachCache = new Map<string, Set<string>>();
  const reachFrom = (s: string): Set<string> => {
    if (reachCache.has(s)) return reachCache.get(s)!;
    const seen = new Set<string>();
    const stack = [...(children.get(s) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const c of children.get(n) ?? []) stack.push(c);
    }
    reachCache.set(s, seen);
    return seen;
  };
  const edges: GEdge[] = depEdges.map((e) => {
    const sibs = children.get(e.fromId) ?? [];
    const redundant = sibs.some((w) => w !== e.toId && reachFrom(w).has(e.toId));
    return { ...e, redundant };
  });

  return { nodes: [...nodes.values()], edges, bands };
});

// Deterministic force-directed placement (Obsidian-style): seed nodes on a circle
// by number, then relax with all-pairs repulsion + per-edge attraction + a weak
// pull to the centre, over a fixed iteration count with cooling. No randomness, so
// the picture is stable across rebuilds. Ends with rectangular collision passes so
// wide cards never overlap. Normalized so the bounding box starts at (0,0); the
// caller (component packing) offsets each component into its slot.
function forceLayout(nodeList: GNode[], edges: GEdge[]) {
  const n = nodeList.length;
  if (n === 0) return;
  const order = [...nodeList].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const idx = new Map<string, number>();
  order.forEach((nd, i) => idx.set(nd.id, i));
  const L = 200; // ideal spacing between node centres (collision keeps cards apart)
  const side = Math.max(L * 2, Math.ceil(Math.sqrt(n)) * L * 1.3);
  // Wide frame: allow lots of horizontal room, keep vertical tight, so with the
  // anisotropic gravity below the component grows in WIDTH rather than height.
  const frameW = side * 3;
  const frameH = side;
  const cx = frameW / 2;
  const cy = frameH / 2;
  const px = new Array<number>(n);
  const py = new Array<number>(n);
  const R = side / 3;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    px[i] = cx + Math.cos(a) * R;
    py[i] = cy + Math.sin(a) * R;
  }
  const pairs: [number, number][] = [];
  for (const e of edges) {
    const a = idx.get(e.fromId);
    const b = idx.get(e.toId);
    if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
  }
  let temp = side / 8;
  const ITERS = 300;
  for (let it = 0; it < ITERS; it++) {
    const dx = new Array<number>(n).fill(0);
    const dy = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j];
        let vy = py[i] - py[j];
        const d = Math.hypot(vx, vy) || 0.01;
        const f = (L * L) / d;
        vx /= d;
        vy /= d;
        dx[i] += vx * f;
        dy[i] += vy * f;
        dx[j] -= vx * f;
        dy[j] -= vy * f;
      }
    for (const [a, b] of pairs) {
      let vx = px[a] - px[b];
      let vy = py[a] - py[b];
      const d = Math.hypot(vx, vy) || 0.01;
      const f = (d * d) / L;
      vx /= d;
      vy /= d;
      dx[a] -= vx * f;
      dy[a] -= vy * f;
      dx[b] += vx * f;
      dy[b] += vy * f;
    }
    // Anisotropic gravity: strong vertical pull squashes the component into a
    // horizontal band, weak horizontal pull lets it spread WIDE instead of tall.
    for (let i = 0; i < n; i++) {
      dx[i] += (cx - px[i]) * 0.015;
      dy[i] += (cy - py[i]) * 0.22;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 0.01;
      const m = Math.min(d, temp);
      px[i] = Math.min(frameW, Math.max(0, px[i] + (dx[i] / d) * m));
      py[i] = Math.min(frameH, Math.max(0, py[i] + (dy[i] / d) * m));
    }
    temp = Math.max(4, temp * 0.96);
  }
  const PAD = 16;
  for (let pass = 0; pass < 14; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const ox = NODE_W + PAD - Math.abs(px[i] - px[j]);
        const oy = (order[i].h + order[j].h) / 2 + PAD - Math.abs(py[i] - py[j]);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const s = (ox / 2) * (px[i] >= px[j] ? 1 : -1);
            px[i] += s;
            px[j] -= s;
          } else {
            const s = (oy / 2) * (py[i] >= py[j] ? 1 : -1);
            py[i] += s;
            py[j] -= s;
          }
          moved = true;
        }
      }
    if (!moved) break;
  }
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    const nd = order[i];
    nd.x = px[i] - NODE_W / 2;
    nd.y = py[i] - nd.h / 2;
    minX = Math.min(minX, nd.x);
    minY = Math.min(minY, nd.y);
  }
  for (const nd of order) {
    nd.x -= minX;
    nd.y -= minY;
  }
}

// --- Ref tab: force-directed layout, packed per connected component ----------
const refModel = computed<{ nodes: GNode[]; edges: GEdge[] }>(() => {
  const { tasks, refEdges, externalTargets } = raw.value;
  const taskById = new Map(tasks.map((x) => [x.id, x]));
  const inGraph = new Set<string>();
  for (const e of refEdges) {
    inGraph.add(e.fromId);
    inGraph.add(e.toId);
  }
  const nodes = new Map<string, GNode>();
  for (const id of inGraph) {
    const x = taskById.get(id);
    if (x) nodes.set(id, baseNode(x));
    else if (externalTargets.has(id)) nodes.set(id, baseNode(externalTargets.get(id)!, true));
  }

  // Undirected adjacency → connected components. Each is force-relaxed compactly
  // and the components are packed into rows, so unrelated mention-clusters read as
  // tidy groups instead of one sparse field.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of refEdges) {
    link(e.fromId, e.toId);
    link(e.toId, e.fromId);
  }
  const roots = [...nodes.keys()].sort(
    (a, b) => (nodes.get(a)!.number ?? 0) - (nodes.get(b)!.number ?? 0),
  );
  const seen = new Set<string>();
  const comps: { nodes: GNode[]; w: number; h: number; ord: number }[] = [];
  for (const start of roots) {
    if (seen.has(start)) continue;
    const compIds: string[] = [];
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      compIds.push(id);
      for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) stack.push(nb);
    }
    const compSet = new Set(compIds);
    const compNodes = compIds.map((id) => nodes.get(id)!);
    const compEdges = refEdges.filter((e) => compSet.has(e.fromId) && compSet.has(e.toId));
    forceLayout(compNodes, compEdges); // normalized to (0,0)
    let w = 0;
    let h = 0;
    for (const nd of compNodes) {
      w = Math.max(w, nd.x + NODE_W);
      h = Math.max(h, nd.y + nd.h);
    }
    const ord = Math.min(...compNodes.map((nd) => nd.number ?? Infinity));
    comps.push({ nodes: compNodes, w, h, ord });
  }

  // Pack tallest-first into rows. GAP is the space BETWEEN local graphs only —
  // spacing inside each component (the force layout) is untouched.
  comps.sort((a, b) => b.h - a.h || a.ord - b.ord);
  const ROW_MAX = 1500;
  const GAP = 52;
  let curX = MARGIN;
  let curY = MARGIN;
  let rowH = 0;
  for (const c of comps) {
    if (curX > MARGIN && curX + c.w > ROW_MAX) {
      curX = MARGIN;
      curY += rowH + GAP;
      rowH = 0;
    }
    for (const nd of c.nodes) {
      nd.x += curX;
      nd.y += curY;
    }
    curX += c.w + GAP;
    rowH = Math.max(rowH, c.h);
  }
  return { nodes: [...nodes.values()], edges: refEdges };
});

const model = computed<{ nodes: GNode[]; edges: GEdge[] }>(() =>
  tab.value === "deps" ? depModel.value : refModel.value,
);
// Project frames — only on the Deps tab, and only when more than one board is shown.
const depBands = computed<DepBand[]>(() => (tab.value === "deps" ? depModel.value.bands : []));
const nodeById = computed(() => {
  const m = new Map<string, GNode>();
  for (const n of model.value.nodes) m.set(n.id, n);
  return m;
});

// --- Selection highlight (LEFT-click a node) -------------------------------
const selected = ref<string | null>(null);
// The WHOLE chain through the selected node, not just its direct neighbours: in
// Deps that's every transitive prerequisite (upstream) AND everything it blocks
// (downstream) — so selecting #98 lights the pipeline all the way back to #93.
// In Ref (undirected) it's the entire connected component reachable from it.
const highlighted = computed(() => {
  const sel = selected.value;
  const set = new Set<string>();
  if (!sel) return set;
  const fwd = new Map<string, string[]>(); // prerequisite → dependent
  const back = new Map<string, string[]>(); // dependent → prerequisite
  for (const e of model.value.edges) {
    (fwd.get(e.fromId) ?? fwd.set(e.fromId, []).get(e.fromId)!).push(e.toId);
    (back.get(e.toId) ?? back.set(e.toId, []).get(e.toId)!).push(e.fromId);
  }
  const walk = (adjs: Map<string, string[]>[]) => {
    const stack = [sel];
    while (stack.length) {
      const id = stack.pop()!;
      for (const adj of adjs) {
        for (const nb of adj.get(id) ?? []) {
          if (!set.has(nb)) {
            set.add(nb);
            stack.push(nb);
          }
        }
      }
    }
  };
  set.add(sel);
  if (tab.value === "deps") {
    walk([back]); // all transitive prerequisites
    walk([fwd]); // all transitive dependents
  } else {
    walk([fwd, back]); // undirected reachability
  }
  return set;
});
const nodeDimmed = (id: string) => selected.value !== null && !highlighted.value.has(id);
// An edge is on the chain when BOTH its ends are highlighted.
const edgeActive = (e: EdgeGeom) =>
  selected.value !== null && highlighted.value.has(e.fromId) && highlighted.value.has(e.toId);

function clipToBox(sx: number, sy: number, cx: number, cy: number, halfH: number) {
  const halfW = NODE_W / 2;
  const dx = sx - cx;
  const dy = sy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const s = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  return { x: cx + dx * s, y: cy + dy * s };
}

// Path + curve-midpoint for a dep edge. A neighbouring-column edge stays a straight
// line (the pipeline reads crisply); an edge that LEAPS over one or more columns is
// bowed into a cubic so it arcs around the intermediate nodes instead of cutting
// straight through their boxes (e.g. #133 → #137 passing over #134/#135). It bows to
// the side the target already leans (below/above the source), deepening with span.
function depCurve(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const span = Math.round(Math.abs(dx) / COL_GAP);
  if (span <= 1) return { d: `M ${x1} ${y1} L ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  const dir = y2 >= y1 ? 1 : -1;
  const bow = Math.min(80, 24 + (span - 1) * 18);
  const cy = (y1 + y2) / 2 + dir * bow;
  const c1x = x1 + dx * 0.4;
  const c2x = x2 - dx * 0.4;
  const d = `M ${x1} ${y1} C ${c1x} ${cy} ${c2x} ${cy} ${x2} ${y2}`;
  return { d, mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8, my: (y1 + 6 * cy + y2) / 8 };
}

interface EdgeGeom {
  key: string;
  kind: "dep" | "ref";
  redundant: boolean;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Curve midpoint — where the remove-handle sits (curve-aware for bowed dep edges).
  mx: number;
  my: number;
}
const edgeGeoms = computed<EdgeGeom[]>(() => {
  const out: EdgeGeom[] = [];
  for (const e of model.value.edges) {
    const a = nodeById.value.get(e.fromId);
    const b = nodeById.value.get(e.toId);
    if (!a || !b) continue;
    const ac = { x: a.x + NODE_W / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + NODE_W / 2, y: b.y + b.h / 2 };
    const start = clipToBox(bc.x, bc.y, ac.x, ac.y, a.h / 2);
    const end = clipToBox(ac.x, ac.y, bc.x, bc.y, b.h / 2);
    const mid =
      e.kind === "dep"
        ? depCurve(start.x, start.y, end.x, end.y)
        : { mx: (start.x + end.x) / 2, my: (start.y + end.y) / 2 };
    out.push({
      key: `${e.kind}:${e.fromId}:${e.toId}`,
      kind: e.kind,
      redundant: e.redundant ?? false,
      fromId: e.fromId,
      toId: e.toId,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      mx: mid.mx,
      my: mid.my,
    });
  }
  return out;
});

// SVG path for a dep edge (straight for a one-column hop, bowed for a longer leap).
function depPath(e: EdgeGeom): string {
  return depCurve(e.x1, e.y1, e.x2, e.y2).d;
}

// --- Pan / zoom ------------------------------------------------------------
const svgEl = ref<SVGSVGElement | null>(null);
const tx = ref(0);
const ty = ref(0);
const scale = ref(1);
function resetView() {
  tx.value = 0;
  ty.value = 0;
  scale.value = 1;
}
// Deps and Ref are laid out in independent coordinate systems (each model
// normalizes to its own bbox at the origin). Panned/zoomed far into one tab and
// then switched, you'd stare at empty space — so snap the viewport back on switch.
watch(tab, () => {
  resetView();
  selected.value = null;
});
function toWorld(clientX: number, clientY: number) {
  const rect = svgEl.value?.getBoundingClientRect();
  const ox = rect ? rect.left : 0;
  const oy = rect ? rect.top : 0;
  return { x: (clientX - ox - tx.value) / scale.value, y: (clientY - oy - ty.value) / scale.value };
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const next = Math.min(2.5, Math.max(0.25, scale.value * factor));
  const rect = svgEl.value?.getBoundingClientRect();
  const px = e.clientX - (rect ? rect.left : 0);
  const py = e.clientY - (rect ? rect.top : 0);
  const wx = (px - tx.value) / scale.value;
  const wy = (py - ty.value) / scale.value;
  tx.value = px - wx * next;
  ty.value = py - wy * next;
  scale.value = next;
}

// --- Pointer: pan / select / connect ---------------------------------------
const panning = ref(false);
let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
let panMoved = false;
function onBgDown(e: MouseEvent) {
  if (e.button !== 0) return;
  panning.value = true;
  panMoved = false;
  panStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
}

const connectFrom = ref<string | null>(null);
const cursorWorld = ref({ x: 0, y: 0 });
const hoverNode = ref<string | null>(null);
let downClient = { x: 0, y: 0 };
const dragging = ref(false);
const DRAG_THRESHOLD = 5;

function onNodeDown(e: MouseEvent, id: string) {
  if (e.button !== 0) return; // left starts select/connect; right is contextmenu
  e.stopPropagation();
  connectFrom.value = id;
  dragging.value = false;
  downClient = { x: e.clientX, y: e.clientY };
  cursorWorld.value = toWorld(e.clientX, e.clientY);
}

function onMove(e: MouseEvent) {
  if (panning.value) {
    tx.value = panStart.tx + (e.clientX - panStart.x);
    ty.value = panStart.ty + (e.clientY - panStart.y);
    if (Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y) > DRAG_THRESHOLD) panMoved = true;
    return;
  }
  if (connectFrom.value) {
    if (
      !dragging.value &&
      Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) > DRAG_THRESHOLD
    ) {
      dragging.value = true;
    }
    cursorWorld.value = toWorld(e.clientX, e.clientY);
  }
}

async function onUp() {
  // Background release: a click with no drag clears the selection.
  if (panning.value && !connectFrom.value) {
    panning.value = false;
    if (!panMoved) selected.value = null;
    return;
  }
  panning.value = false;
  const from = connectFrom.value;
  const wasDragging = dragging.value;
  connectFrom.value = null;
  dragging.value = false;
  if (!from) return;
  // A press that never became a drag = LEFT click → toggle the node's highlight.
  if (!wasDragging) {
    selected.value = selected.value === from ? null : from;
    return;
  }
  // A real drag creates a dependency — Deps tab only, real→real, on another node.
  if (tab.value !== "deps") return;
  const target = hoverNode.value;
  if (!target || target === from) return;
  const src = nodeById.value.get(from);
  const dst = nodeById.value.get(target);
  if (!src || !dst || src.external || dst.external) {
    flashError(t("graphExternalEdge"));
    return;
  }
  // Reject an edge that already follows transitively — it would add nothing and
  // wouldn't even be drawn (transitive reduction), so it'd look like a no-op.
  // Show the existing path so it's clear WHY (e.g. #93 → #100 → #96).
  const path = existingDepPath(dst.id, src.id);
  if (path) {
    flashError(t("graphDepRedundant", { path: path.map((n) => `#${n}`).join(" → ") }));
    return;
  }
  await addDep(dst.id, src.id); // arrow source→target ⇒ target depends on source
}

// If `dependentId` already depends on `prereqId` through the chain, return the
// existing path as task NUMBERS in prerequisite→dependent order (e.g. [93,100,96]);
// null if there's no such path. BFS over prerequisites with parent tracking.
function existingDepPath(dependentId: string, prereqId: string): number[] | null {
  const back = new Map<string, string[]>(); // dependent → its prerequisites
  for (const e of raw.value.depEdges)
    (back.get(e.toId) ?? back.set(e.toId, []).get(e.toId)!).push(e.fromId);
  const parent = new Map<string, string>(); // node → the node we reached it from
  const queue = [dependentId];
  const seen = new Set<string>([dependentId]);
  let found = false;
  while (queue.length && !found) {
    const id = queue.shift()!;
    for (const p of back.get(id) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      parent.set(p, id);
      if (p === prereqId) {
        found = true;
        break;
      }
      queue.push(p);
    }
  }
  if (!found) return null;
  // Walk parent from prereq back to dependent, collecting ids, then to numbers.
  const chain: string[] = [];
  let cur: string | undefined = prereqId;
  while (cur !== undefined) {
    chain.push(cur);
    cur = parent.get(cur);
  }
  // chain is prereq → … → dependent already (parent points toward dependent).
  return chain.map((id) => byId.value.get(id)?.number ?? 0);
}

// RIGHT-click a node → open its card.
function onNodeContext(e: MouseEvent, id: string) {
  e.preventDefault();
  if (nodeById.value.get(id)?.external) return; // other-board task: no local card
  emit("open", id);
}

const connectPreview = computed(() => {
  if (!connectFrom.value || !dragging.value || tab.value !== "deps") return null;
  const a = nodeById.value.get(connectFrom.value);
  if (!a) return null;
  return {
    x1: a.x + NODE_W / 2,
    y1: a.y + a.h / 2,
    x2: cursorWorld.value.x,
    y2: cursorWorld.value.y,
  };
});

// --- Mutations -------------------------------------------------------------
async function addDep(fromId: string, onId: string) {
  try {
    emit("update", await invoke<Todo[]>("add_todo_dep", { fromId, onId }));
  } catch (err) {
    flashError(String(err));
  }
}
async function removeDep(fromId: string, onId: string) {
  try {
    emit("update", await invoke<Todo[]>("remove_todo_dep", { fromId, onId }));
  } catch (err) {
    flashError(String(err));
  }
}
// RIGHT-click a solid dep arrow (source→target ⇒ target depends on source).
function onDepContext(e: MouseEvent, edge: EdgeGeom) {
  e.preventDefault();
  if (edge.kind !== "dep") return;
  void removeDep(edge.toId, edge.fromId);
}

// Curved path for a ref edge: a quadratic Bézier bowed perpendicular to the
// straight line, so an edge running along a column (or across several) arcs aside
// instead of passing straight through the nodes between its endpoints. Ref edges
// are read-only — mentions are unlinked by editing the task text, not here.
function refPath(e: EdgeGeom): string {
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(70, Math.max(18, len * 0.22));
  const px = -dy / len; // unit perpendicular
  const py = dx / len;
  const cx = (e.x1 + e.x2) / 2 + px * off;
  const cy = (e.y1 + e.y2) / 2 + py * off;
  return `M ${e.x1} ${e.y1} Q ${cx} ${cy} ${e.x2} ${e.y2}`;
}

onUnmounted(() => {
  if (errorTimer !== null) clearTimeout(errorTimer);
});
</script>

<template>
  <div class="gv">
    <div class="gv-bar">
      <div class="gv-tabs" role="tablist">
        <button
          class="gv-tab"
          :class="{ active: tab === 'deps' }"
          role="tab"
          @click="tab = 'deps'"
        >
          {{ t("graphTabDeps") }}
        </button>
        <button
          class="gv-tab"
          :class="{ active: tab === 'ref' }"
          role="tab"
          @click="tab = 'ref'"
        >
          {{ t("graphTabRef") }}
        </button>
      </div>
      <div class="gv-statuses" :title="t('graphStatusFilter')">
        <button
          v-for="s in STATUS_ORDER"
          :key="s"
          class="gv-chip"
          :class="{ off: !visibleStatuses.has(s) }"
          :style="{ '--accent': statusColor(s) }"
          @click="toggleStatus(s)"
        >
          <i class="dot"></i>{{ t(STATUS_LABEL[s]) }}
        </button>
      </div>
      <span class="gv-spacer"></span>
      <button class="gv-btn" @click="resetView">{{ t("graphResetView") }}</button>
    </div>
    <p class="gv-hint">{{ tab === "deps" ? t("graphHintDeps") : t("graphHintRef") }}</p>

    <div v-if="errorMsg" class="gv-error">{{ errorMsg }}</div>

    <div v-if="!model.nodes.length" class="gv-empty">
      {{ tab === "deps" ? t("graphEmptyDeps") : t("graphEmptyRef") }}
    </div>

    <svg
      v-else
      ref="svgEl"
      class="gv-canvas"
      :class="{ connecting: dragging }"
      @wheel="onWheel"
      @mousedown="onBgDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
    >
      <defs>
        <marker
          id="arrow-dep"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
        <marker
          id="arrow-ref"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="#6f7681" />
        </marker>
      </defs>

      <g :transform="`translate(${tx},${ty}) scale(${scale})`" :class="{ 'has-sel': selected }">
        <!-- Project frames (Deps, multi-board): a labelled box around each board's
             pipeline so the projects read as separate graphs, not one grid. -->
        <g class="bands">
          <g v-for="b in depBands" :key="b.project" class="band">
            <rect
              class="band-box"
              :x="b.x - 16"
              :y="b.y - 8"
              :width="b.w + 32"
              :height="b.h + 16"
              rx="12"
            />
            <text class="band-label" :x="b.x - 4" :y="b.y + 14">{{ b.project }}</text>
          </g>
        </g>
        <g class="edges">
          <template v-for="e in edgeGeoms" :key="e.key">
            <!-- Ref edges are READ-ONLY (mentions live in the task text; unlink by
                 editing the text). Curved so an edge along a column bows aside
                 instead of running straight through the nodes between its ends. -->
            <path
              v-if="e.kind === 'ref'"
              class="edge ref"
              :class="{ active: edgeActive(e) }"
              :d="refPath(e)"
              marker-end="url(#arrow-ref)"
            />
            <g v-else class="dep-group" :class="{ active: edgeActive(e), redundant: e.redundant }">
              <!-- Straight for a one-column hop, bowed for a longer leap so it arcs
                   around the intermediate columns' nodes instead of through them. -->
              <path class="edge dep" :d="depPath(e)" marker-end="url(#arrow-dep)" />
              <!-- Wide transparent hit path: right-click-to-remove along the whole
                   edge, not just the 2px stroke. -->
              <path class="edge-hit" :d="depPath(e)" @contextmenu="onDepContext($event, e)" />
              <!-- Curve-midpoint handle: a clear target to click and drop the link. -->
              <circle
                class="edge-handle"
                :cx="e.mx"
                :cy="e.my"
                r="5"
                @mousedown.stop
                @click.stop="removeDep(e.toId, e.fromId)"
                @contextmenu.prevent.stop="removeDep(e.toId, e.fromId)"
              >
                <title>{{ t("graphRemoveDep") }}</title>
              </circle>
            </g>
          </template>
          <line
            v-if="connectPreview"
            class="edge preview"
            :x1="connectPreview.x1"
            :y1="connectPreview.y1"
            :x2="connectPreview.x2"
            :y2="connectPreview.y2"
          />
        </g>

        <g
          v-for="n in model.nodes"
          :key="n.id"
          class="node"
          :class="{ external: n.external, dimmed: nodeDimmed(n.id), sel: selected === n.id, target: hoverNode === n.id && dragging }"
          :transform="`translate(${n.x},${n.y})`"
          @mousedown="onNodeDown($event, n.id)"
          @mouseenter="hoverNode = n.id"
          @mouseleave="hoverNode = null"
          @contextmenu="onNodeContext($event, n.id)"
        >
          <rect
            class="box"
            :width="NODE_W"
            :height="n.h"
            rx="9"
            :style="{ '--accent': statusColor(n.status) }"
          />
          <text class="num" x="12" y="18">
            <tspan v-if="n.number">#{{ n.number }}</tspan>
            <tspan v-if="n.external" class="ext-proj" :dx="n.number ? 6 : 0">
              {{ extLabel(n) }}
            </tspan>
            <title v-if="n.external">{{ n.extProject }}</title>
          </text>
          <text class="subj" x="12" y="34">
            <tspan
              v-for="(ln, i) in n.lines"
              :key="i"
              x="12"
              :dy="i === 0 ? 0 : LINE_H"
            >{{ ln }}</tspan>
          </text>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.gv {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.gv-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-bottom: 1px solid #2c2f36;
}
.gv-tabs {
  display: inline-flex;
  border: 1px solid #3a3d44;
  border-radius: 6px;
  overflow: hidden;
}
.gv-tab {
  border: none;
  background: #24262b;
  color: #9aa0aa;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
}
.gv-tab + .gv-tab {
  border-left: 1px solid #3a3d44;
}
.gv-tab.active {
  background: #4cc2ff;
  color: #06283b;
}
.gv-statuses {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.gv-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #24262b;
  color: #e6e8eb;
  border: 1px solid #3a3d44;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 120ms;
}
.gv-chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #9aa0aa);
}
.gv-chip.off {
  opacity: 0.4;
}
.gv-chip.off .dot {
  background: transparent;
  border: 1px solid var(--accent, #9aa0aa);
}
.gv-spacer {
  flex: 1;
}
.gv-btn {
  background: #24262b;
  color: #e6e8eb;
  border: 1px solid #3a3d44;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.gv-btn:hover {
  background: #2c2f36;
}
.gv-hint {
  margin: 0;
  padding: 5px 14px;
  color: #7a808a;
  font-size: 12px;
  border-bottom: 1px solid #2c2f36;
}
.gv-error {
  margin: 8px 14px 0;
  padding: 7px 11px;
  background: #3a2528;
  color: #ff9a9a;
  border: 1px solid #6a3a3f;
  border-radius: 6px;
}
.gv-empty {
  margin: auto;
  color: #7a808a;
  text-align: center;
  max-width: 340px;
}
.gv-canvas {
  flex: 1;
  width: 100%;
  cursor: grab;
  user-select: none;
  overflow: hidden;
}
.gv-canvas.connecting {
  cursor: crosshair;
}
/* Project frame around a board's pipeline (Deps tab, multi-board view). */
.band-box {
  fill: rgba(255, 255, 255, 0.022);
  stroke: #34383f;
  stroke-width: 1.5;
  stroke-dasharray: 3 5;
  pointer-events: none;
}
.band-label {
  fill: #7a808a;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
}
.edge {
  stroke-linecap: round;
  fill: none; /* ref edges are <path>; keep them unfilled */
  pointer-events: none; /* visible strokes are decorative; hit line/handle catch clicks */
}
.edge.dep {
  stroke: #c7ccd4;
  stroke-width: 1.8;
  color: #c7ccd4;
}
/* Transitively-redundant edge: kept but de-emphasized so the direct path reads. */
.dep-group.redundant .edge.dep {
  stroke-width: 1.1;
  opacity: 0.28;
}
.dep-group.redundant .edge-handle {
  opacity: 0.2;
}
.dep-group.redundant:hover .edge.dep {
  opacity: 0.6;
}
.edge.ref {
  stroke: #6f7681;
  stroke-width: 1.4;
  stroke-dasharray: 5 4;
}
.edge.preview {
  stroke: #4cc2ff;
  stroke-width: 1.8;
  stroke-dasharray: 4 4;
}
/* Fat invisible click target running along the whole dep edge. */
.edge-hit {
  fill: none; /* it's a <path> now — don't let an open curve fill-close into a blob */
  stroke: transparent;
  stroke-width: 16;
  pointer-events: stroke;
  cursor: context-menu;
}
/* Midpoint handle — an obvious target to drop the dependency. */
.edge-handle {
  fill: #c7ccd4;
  stroke: #1b1d21;
  stroke-width: 1.4;
  opacity: 0.5;
  cursor: pointer;
  transition: opacity 120ms, fill 120ms, transform 120ms;
  transform-box: fill-box;
  transform-origin: center;
}
.dep-group:hover .edge-handle {
  opacity: 1;
}
.edge-handle:hover {
  fill: #ff9a9a;
  transform: scale(1.4);
}
/* When a node is selected, fade edges that don't touch it. */
.has-sel .edge.ref,
.has-sel .dep-group {
  opacity: 0.15;
}
.has-sel .edge.ref.active,
.has-sel .dep-group.active {
  opacity: 1;
}
.node {
  cursor: pointer;
}
.node.external {
  opacity: 0.85;
}
.node.dimmed {
  opacity: 0.25;
}
.node .box {
  fill: #24262b;
  stroke: var(--accent, #9aa0aa);
  stroke-width: 2;
}
.node.external .box {
  fill: #202227;
  stroke-dasharray: 5 4;
}
.node.sel .box {
  stroke: #4cc2ff;
  stroke-width: 2.6;
}
.node.target .box {
  stroke: #4cc2ff;
  stroke-width: 2.6;
}
.node .num {
  fill: #e6e8eb;
  font-weight: 600;
  font-size: 12px;
}
.node .num .ext-proj {
  fill: #9aa0aa;
  font-weight: 400;
}
.node .subj {
  fill: #b9bec6;
  font-size: 11px;
}
</style>
