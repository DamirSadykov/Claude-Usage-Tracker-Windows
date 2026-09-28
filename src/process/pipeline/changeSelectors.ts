import type { BoardTodo } from "./adapt";
import type { ChangeRecord, ChangeTask } from "./changeAdapt";
import { changeMembers, changeProgress } from "./changeAdapt";

export interface ReferenceIndex {
    edges: { from: string; to: string }[];
    incoming: Map<string, number>;
    outgoing: Map<string, number>;
    incomingNodes: Map<string, string[]>;
    outgoingNodes: Map<string, string[]>;
    adjacency: Map<string, Set<string>>;
    hubs: Set<string>;
}

// Board snapshots are immutable and replaced on revision. Keeping this cache by
// identity means a render never scans every description again.
const referenceIndexes = new WeakMap<readonly BoardTodo[], ReferenceIndex>();
const INLINE_REF = /\bt#(\d+)\b/g;

export function referenceIndex(board: readonly BoardTodo[]): ReferenceIndex {
    const cached = referenceIndexes.get(board);
    if (cached) return cached;
    const byNumber = new Map(board.filter((t) => t.number).map((t) => [t.number!, t.id]));
    const seen = new Set<string>();
    const edges: { from: string; to: string }[] = [];
    const add = (from: string, to: string) => {
        const key = `${from}->${to}`;
        if (from !== to && !seen.has(key)) {
            seen.add(key);
            edges.push({ from, to });
        }
    };
    for (const todo of board) {
        for (const target of todo.links ?? []) add(todo.id, target);
        for (const match of (todo.description ?? "").matchAll(INLINE_REF)) {
            const target = byNumber.get(Number(match[1]));
            if (target) add(todo.id, target);
        }
    }
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    const incomingNodes = new Map<string, string[]>();
    const outgoingNodes = new Map<string, string[]>();
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
        outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
        const sources = incomingNodes.get(edge.to) ?? [];
        sources.push(edge.from);
        incomingNodes.set(edge.to, sources);
        const targets = outgoingNodes.get(edge.from) ?? [];
        targets.push(edge.to);
        outgoingNodes.set(edge.from, targets);
        const from = adjacency.get(edge.from) ?? new Set<string>();
        const to = adjacency.get(edge.to) ?? new Set<string>();
        from.add(edge.to); to.add(edge.from);
        adjacency.set(edge.from, from); adjacency.set(edge.to, to);
    }
    const index = { edges, incoming, outgoing, incomingNodes, outgoingNodes, adjacency,
        hubs: new Set([...incoming].filter(([, count]) => count >= 5).map(([id]) => id)) };
    referenceIndexes.set(board, index);
    return index;
}

export function indexedRings(index: ReferenceIndex, focusId: string, depth: number) {
    const distances = new Map<string, number>([[focusId, 0]]);
    let frontier = [focusId];
    for (let ring = 1; ring <= depth; ring += 1) {
        const next: string[] = [];
        for (const id of frontier) for (const neighbour of index.adjacency.get(id) ?? []) {
            if (!distances.has(neighbour)) { distances.set(neighbour, ring); next.push(neighbour); }
        }
        frontier = next;
    }
    return {
        distances,
        links: index.edges.filter((edge) => distances.has(edge.from) && distances.has(edge.to)),
    };
}

export interface BubbleRoot { id: string; radius: number; }
export interface BubblePoint { x: number; y: number; }

// Root placement deliberately depends only on collapsed radii. Opening a root
// may grow its contents, but cannot re-run the O(n²) collision layout for peers.
export function stableBubbleRoots(roots: readonly BubbleRoot[], width: number, height: number): Map<string, BubblePoint> {
    const out = new Map<string, BubblePoint>();
    const total = roots.reduce((sum, root) => sum + root.radius, 0);
    const ring = roots.length > 1 ? Math.max(240, (total * 2.2) / Math.PI) : 0;
    const ordered = [...roots].sort((a, b) => a.id.localeCompare(b.id));
    ordered.forEach((root, index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / ordered.length;
        out.set(root.id, { x: width / 2 + ring * Math.cos(angle), y: height / 2 + ring * Math.sin(angle) });
    });
    return out;
}

export interface ChangeHeaderSummary { total: number; done: number; open: boolean; }

/** Header data is board-only: selecting a change must not fetch its run graph. */
export function changeHeaderSummary(change: ChangeRecord | null, board: ChangeTask[]): ChangeHeaderSummary {
    const progress = change ? changeProgress(changeMembers(board, change)) : { total: 0, done: 0 };
    return { ...progress, open: progress.total === 0 || progress.done !== progress.total };
}
