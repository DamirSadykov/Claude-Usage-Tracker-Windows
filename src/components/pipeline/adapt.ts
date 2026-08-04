import type { RunGraphNode } from "../../graphModel";
import type {
    Artifact,
    Lane,
    NodeStatus,
    PortRef,
    ProjectBand,
    RingLink,
    RingNode,
    FocusRow,
    SpecLane,
    SpecLaneRef,
    TaskLink,
    TaskNode,
} from "./types";

export interface BoardTodo {
    id: string;
    number?: number;
    subject: string;
    description?: string;
    status: string;
    kind?: string;
    change?: boolean;
    project?: string | null;
    depends_on?: string[];
    links?: string[];
    handoff?: string;
    produces?: string[];
    spec?: string[];
    spec_answers?: { address: string; verdict: string }[];
    spec_seen?: { address: string }[];
}

export interface TaskCostRow {
    id: string;
    project?: string | null;
    cost: number;
}

export interface SpecSectionPayload {
    address: string;
    entry: {
        title?: string;
        part?: string;
        updated?: string;
        refs?: string[];
    };
    anchors?: { slug: string; title: string }[];
    text?: string;
    files?: { path: string; exists: boolean; anchor?: string }[];
    lineCount?: number;
    lineCeiling?: number;
}

const INLINE_REF = /\bt#(\d+)\b/g;

export function isDone(status: string): boolean {
    return status === "done";
}

export function isGate(todo: BoardTodo): boolean {
    return (todo.kind ?? "") !== "auto";
}

export function nodeStatus(todo: BoardTodo, byId: Map<string, BoardTodo>): NodeStatus {
    if (isDone(todo.status)) return "done";
    for (const dep of todo.depends_on ?? []) {
        const prev = byId.get(dep);
        if (prev && !isDone(prev.status)) return "blocked";
    }
    return isGate(todo) ? "waiting" : "ready";
}

export function wavesOf<T>(ids: T[], edges: { from: T; to: T }[]): Map<T, number> {
    const inside = new Set(ids);
    const preds = new Map<T, T[]>();
    for (const id of ids) preds.set(id, []);
    for (const e of edges) {
        if (!inside.has(e.from) || !inside.has(e.to)) continue;
        preds.get(e.to)!.push(e.from);
    }
    const level = new Map<T, number>();
    const visiting = new Set<T>();
    const walk = (id: T): number => {
        const known = level.get(id);
        if (known !== undefined) return known;
        if (visiting.has(id)) return 1;
        visiting.add(id);
        let best = 1;
        for (const p of preds.get(id) ?? []) best = Math.max(best, walk(p) + 1);
        visiting.delete(id);
        level.set(id, best);
        return best;
    };
    for (const id of ids) walk(id);
    return level;
}

export interface LaneIndex {
    roots: BoardTodo[];
    laneOf: Map<string, string>;
    members: Map<string, string[]>;
}

function plural(count: number, one: string, few: string, many: string): string {
    const tail = count % 10;
    const teen = count % 100;
    if (teen >= 11 && teen <= 14) return `${count} ${many}`;
    if (tail === 1) return `${count} ${one}`;
    if (tail >= 2 && tail <= 4) return `${count} ${few}`;
    return `${count} ${many}`;
}

export function freeLaneId(project?: string | null): string {
    return `free:${project ?? ""}`;
}

export function isFreeLane(id: string): boolean {
    return id.startsWith("free:");
}

export function laneIndex(board: BoardTodo[]): LaneIndex {
    const byId = new Map(board.map((t) => [t.id, t]));
    const roots = board
        .filter((t) => t.change === true)
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const laneOf = new Map<string, string>();
    const members = new Map<string, string[]>();
    for (const root of roots) {
        const seen: string[] = [];
        const stack = [...(root.depends_on ?? [])];
        const guard = new Set<string>([root.id]);
        while (stack.length) {
            const id = stack.pop()!;
            if (guard.has(id)) continue;
            guard.add(id);
            const t = byId.get(id);
            if (!t || t.change === true) continue;
            if (laneOf.has(id)) continue;
            laneOf.set(id, root.id);
            seen.push(id);
            stack.push(...(t.depends_on ?? []));
        }
        laneOf.set(root.id, root.id);
        members.set(root.id, seen);
    }
    for (const t of board) {
        if (laneOf.has(t.id)) continue;
        const lane = freeLaneId(t.project);
        laneOf.set(t.id, lane);
        members.set(lane, [...(members.get(lane) ?? []), t.id]);
    }
    return { roots, laneOf, members };
}

export interface Money {
    text: string;
    known: boolean;
    reason?: string;
}

const UNMEASURED_REASON: Record<string, string> = {
    no_in_progress: "не бралась",
    no_blocks: "нет блоков в журнале",
    empty_blocks: "работа ушла в соседний блок",
};

export function formatMoney(value: number): string {
    return `$${value.toFixed(2)}`;
}

export function formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (!h) return `${m}м`;
    return `${h}ч ${String(m).padStart(2, "0")}м`;
}

export function moneyOf(node: RunGraphNode): Money {
    if (node.cost !== null) return { text: formatMoney(node.cost), known: true };
    const reason = UNMEASURED_REASON[node.measurability] ?? "не измерена";
    if (node.task_cost !== null) {
        return {
            text: formatMoney(node.task_cost),
            known: true,
            reason: `по задаче целиком · ${reason}`,
        };
    }
    return { text: "неизвестно", known: false, reason };
}

export interface LaneTotals {
    cost: number;
    minutes: number;
    unknown: number;
    unattributed: number;
}

export function laneTotals(nodes: RunGraphNode[]): LaneTotals {
    let cost = 0;
    let minutes = 0;
    let unknown = 0;
    let unattributed = 0;
    for (const n of nodes) {
        if (n.cost !== null) cost += n.cost;
        else if (n.task_cost !== null) cost += n.task_cost;
        else unknown += 1;
        if (n.duration_minutes !== null && !n.duration_calendar)
            minutes += n.duration_minutes;
        if (n.unattributed_cost !== null) unattributed += n.unattributed_cost;
    }
    return { cost, minutes, unknown, unattributed };
}

export function specPorts(todo: BoardTodo): PortRef[] {
    const ports: PortRef[] = [];
    const written = new Set(
        (todo.spec_answers ?? [])
            .filter((a) => a.verdict === "updated")
            .map((a) => a.address),
    );
    for (const seen of todo.spec_seen ?? []) {
        if (written.has(seen.address)) continue;
        ports.push({ dir: "R", kind: "spec", label: seen.address });
    }
    for (const address of written) ports.push({ dir: "W", kind: "spec", label: address });
    for (const address of todo.spec ?? []) {
        if (written.has(address)) continue;
        if ((todo.spec_seen ?? []).some((s) => s.address === address)) continue;
        ports.push({ dir: "R", kind: "spec", label: address });
    }
    return ports;
}

export function toTaskNodes(
    board: BoardTodo[],
    run: Map<string, RunGraphNode>,
    index: LaneIndex,
    waves: Map<string, number>,
    withPorts = false,
): TaskNode[] {
    const byId = new Map(board.map((t) => [t.id, t]));
    return board.map((t) => {
        const node = run.get(t.id);
        const money = node ? moneyOf(node) : null;
        const status = nodeStatus(t, byId);
        const card: TaskNode = {
            id: t.number ? `#${t.number}` : t.id,
            title: t.subject,
            status,
            auto: !isGate(t),
            done: status === "done",
            active: t.status === "in_progress",
            wave: waves.get(t.id) ?? 1,
            lane: index.laneOf.get(t.id) ?? freeLaneId(t.project),
            runs: node?.blocks,
        };
        if (money) {
            card.cost = money.text;
            card.costKnown = money.known;
            card.costNote = money.reason;
            if (node && node.cost !== null) card.costShare = node.cost;
        }
        if (withPorts) {
            const ports = specPorts(t);
            if (ports.length) card.ports = ports;
        }
        return card;
    });
}

export function normalizeShares(nodes: TaskNode[]): TaskNode[] {
    const top = nodes.reduce((max, n) => Math.max(max, n.costShare ?? 0), 0);
    if (!top) return nodes;
    return nodes.map((n) =>
        n.costShare === undefined ? n : { ...n, costShare: n.costShare / top },
    );
}

export function sharedSpecArtifact(
    from: BoardTodo,
    to: BoardTodo,
): Artifact | undefined {
    const written = (from.spec_answers ?? [])
        .filter((a) => a.verdict === "updated")
        .map((a) => a.address);
    const read = new Set([
        ...(to.spec ?? []),
        ...(to.spec_seen ?? []).map((s) => s.address),
    ]);
    const hit = written.find((a) => read.has(a));
    if (!hit) return undefined;
    return { kind: "spec", address: hit, short: hit, exists: true };
}

export function toTaskLinks(board: BoardTodo[], index: LaneIndex): TaskLink[] {
    const byId = new Map(board.map((t) => [t.id, t]));
    const label = (t: BoardTodo) => (t.number ? `#${t.number}` : t.id);
    const links: TaskLink[] = [];
    for (const t of board) {
        for (const dep of t.depends_on ?? []) {
            const prev = byId.get(dep);
            if (!prev) continue;
            const artifact =
                sharedSpecArtifact(prev, t) ??
                (prev.handoff
                    ? {
                          kind: "handoff" as const,
                          address: `handoff ${label(prev)}`,
                          short: `handoff ${label(prev)}`,
                          exists: true,
                      }
                    : undefined);
            links.push({ from: label(prev), to: label(t), artifact });
        }
    }
    return links.filter(
        (l) =>
            index.laneOf.get(idOfLabel(board, l.from) ?? "") ===
            index.laneOf.get(idOfLabel(board, l.to) ?? ""),
    );
}

function idOfLabel(board: BoardTodo[], label: string): string | undefined {
    const num = label.startsWith("#") ? Number(label.slice(1)) : NaN;
    const hit = board.find((t) => (Number.isNaN(num) ? t.id === label : t.number === num));
    return hit?.id;
}

export function toLanes(
    board: BoardTodo[],
    run: Map<string, RunGraphNode>,
    index: LaneIndex,
    waves: Map<string, number>,
): Lane[] {
    const byId = new Map(board.map((t) => [t.id, t]));
    const lanes: Lane[] = index.roots.map((root) => {
        const ids = [root.id, ...(index.members.get(root.id) ?? [])];
        const nodes = ids.map((id) => run.get(id)).filter(Boolean) as RunGraphNode[];
        const totals = laneTotals(nodes);
        const done = ids.filter((id) => isDone(byId.get(id)?.status ?? "")).length;
        const levels = ids.map((id) => waves.get(id) ?? 1);
        const span = levels.length
            ? `волны ${Math.min(...levels)}–${Math.max(...levels)}`
            : "";
        const unknownNote = totals.unknown ? ` · ${totals.unknown} без замера` : "";
        return {
            id: root.id,
            kicker: `тема · change #${root.number ?? ""}`.trim(),
            title: root.subject,
            note: (root.description ?? "").split("\n")[0] || undefined,
            progress: ids.length ? done / ids.length : 0,
            progressLabel: `${done} / ${ids.length} готово · ${span}${unknownNote}`,
            cost: formatMoney(totals.cost),
            duration: totals.minutes ? formatDuration(totals.minutes) : undefined,
            tone: "theme",
            done: ids.length > 0 && done === ids.length,
        };
    });
    for (const [id, ids] of index.members) {
        if (!isFreeLane(id) || !ids.length) continue;
        lanes.push({
            id,
            kicker: "без темы",
            title: "Свободные задачи",
            note: "не привязаны к change'у",
            tone: "plain",
            progressLabel: plural(ids.length, "задача", "задачи", "задач"),
        });
    }
    return lanes;
}

export function toProjectBands(
    board: BoardTodo[],
    costs: TaskCostRow[],
    index: LaneIndex,
): ProjectBand[] {
    const spend = new Map<string, number>();
    for (const row of costs) {
        const key = row.project ?? "";
        spend.set(key, (spend.get(key) ?? 0) + row.cost);
    }
    const grouped = new Map<string, BoardTodo[]>();
    for (const t of board) {
        const key = t.project ?? "";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(t);
    }
    return [...grouped.entries()].map(([name, todos]) => ({
        name: name || "без проекта",
        tasks: `${todos.length} задач`,
        cost: formatMoney(spend.get(name) ?? 0),
        lanes: [
            ...new Set(todos.map((t) => index.laneOf.get(t.id) ?? "free")),
        ],
    }));
}

export function refEdges(board: BoardTodo[]): { from: string; to: string }[] {
    const byNumber = new Map(
        board.filter((t) => t.number).map((t) => [t.number as number, t.id]),
    );
    const out: { from: string; to: string }[] = [];
    const seen = new Set<string>();
    const push = (from: string, to: string) => {
        const key = `${from}->${to}`;
        if (from === to || seen.has(key)) return;
        seen.add(key);
        out.push({ from, to });
    };
    for (const t of board) {
        for (const link of t.links ?? []) push(t.id, link);
        const text = t.description ?? "";
        for (const m of text.matchAll(INLINE_REF)) {
            const target = byNumber.get(Number(m[1]));
            if (target) push(t.id, target);
        }
    }
    return out;
}

export function hubIds(board: BoardTodo[], threshold = 5): Set<string> {
    const incoming = new Map<string, number>();
    for (const e of refEdges(board))
        incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    return new Set(
        [...incoming.entries()].filter(([, n]) => n >= threshold).map(([id]) => id),
    );
}

export function ringsAround(
    board: BoardTodo[],
    focusId: string,
    depth = 2,
): { nodes: RingNode[]; links: RingLink[] } {
    const byId = new Map(board.map((t) => [t.id, t]));
    const edges = refEdges(board);
    const neighbours = new Map<string, Set<string>>();
    for (const e of edges) {
        if (!neighbours.has(e.from)) neighbours.set(e.from, new Set());
        if (!neighbours.has(e.to)) neighbours.set(e.to, new Set());
        neighbours.get(e.from)!.add(e.to);
        neighbours.get(e.to)!.add(e.from);
    }
    const hubs = hubIds(board);
    const ring = new Map<string, number>([[focusId, 0]]);
    let frontier = [focusId];
    for (let d = 1; d <= depth; d += 1) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const n of neighbours.get(id) ?? []) {
                if (ring.has(n)) continue;
                ring.set(n, d);
                next.push(n);
            }
        }
        frontier = next;
    }
    const nodes: RingNode[] = [];
    for (const [id, d] of ring) {
        if (!d) continue;
        const todo = byId.get(id);
        if (!todo) continue;
        nodes.push({
            id,
            label: todo.number ? `#${todo.number}` : id,
            title: todo.subject,
            ring: d === 1 ? 1 : 2,
            angle: 0,
            radius: 0,
            tone: hubs.has(id) ? "hub" : "plain",
            dashed: d > 1,
        });
    }
    const links: RingLink[] = edges
        .filter((e) => ring.has(e.from) && ring.has(e.to))
        .map((e) => ({
            from: e.from,
            to: e.to,
            dashed: (ring.get(e.from) ?? 0) > 1 || (ring.get(e.to) ?? 0) > 1,
        }));
    return { nodes, links };
}

export function focusRows(
    board: BoardTodo[],
    focusId: string,
): { outgoing: FocusRow[]; incoming: FocusRow[] } {
    const byId = new Map(board.map((t) => [t.id, t]));
    const edges = refEdges(board);
    const count = new Map<string, number>();
    const bump = (key: string) => count.set(key, (count.get(key) ?? 0) + 1);
    const outgoing: FocusRow[] = [];
    const incoming: FocusRow[] = [];
    for (const e of edges) {
        if (e.from === focusId) {
            bump(`o:${e.to}`);
            const todo = byId.get(e.to);
            if (todo && !outgoing.some((r) => r.id === todo.id))
                outgoing.push({
                    id: todo.number ? `#${todo.number}` : todo.id,
                    title: todo.subject,
                    count: 0,
                });
        }
        if (e.to === focusId) {
            bump(`i:${e.from}`);
            const todo = byId.get(e.from);
            if (todo && !incoming.some((r) => r.id === todo.id))
                incoming.push({
                    id: todo.number ? `#${todo.number}` : todo.id,
                    title: todo.subject,
                    count: 0,
                });
        }
    }
    const fill = (rows: FocusRow[], prefix: string) =>
        rows.map((r) => ({
            ...r,
            count:
                [...count.entries()]
                    .filter(([k]) => k.startsWith(prefix))
                    .find(([k]) => k.endsWith(idOfLabel(board, r.id) ?? ""))?.[1] ?? 1,
        }));
    return { outgoing: fill(outgoing, "o:"), incoming: fill(incoming, "i:") };
}

export function toSpecLanes(
    sections: SpecSectionPayload[],
    board: BoardTodo[],
): SpecLane[] {
    const stateOf = (status: string) =>
        status === "in_progress" ? "в работе" : status === "queue" ? "очередь" : status;
    return sections.map((section) => {
        const incoming: SpecLaneRef[] = board
            .filter((t) => (t.spec ?? []).includes(section.address))
            .map((t) => ({
                id: t.number ? `#${t.number}` : t.id,
                title: t.subject,
                state: stateOf(t.status),
            }));
        const outgoing: SpecLaneRef[] = (section.entry.refs ?? []).map((address) => ({
            id: address,
            title: "",
            tone: "spec" as const,
        }));
        const overCeiling =
            section.lineCount !== undefined &&
            section.lineCeiling !== undefined &&
            section.lineCount > section.lineCeiling;
        const changes = board.filter(
            (t) => t.change === true && (t.spec ?? []).includes(section.address),
        ).length;
        return {
            id: section.address,
            kicker: overCeiling ? "раздел спеки · внимание" : "раздел спеки",
            address: section.address,
            title: section.entry.title ?? section.address,
            part: [
                section.entry.part ? `часть: ${section.entry.part}` : "",
                section.entry.updated ? `обновлён ${section.entry.updated}` : "",
            ]
                .filter(Boolean)
                .join("  "),
            partWarn: overCeiling ? "за потолком прозы" : undefined,
            prose: section.text,
            lintLabel:
                section.lineCount !== undefined && section.lineCeiling !== undefined
                    ? `${section.lineCount} / ${section.lineCeiling} строк`
                    : undefined,
            lintTone: overCeiling ? "warn" : "ok",
            metrics: [
                `${incoming.length + outgoing.length} ссылок`,
                `${changes} change'а`,
            ],
            tone: overCeiling ? "warn" : "spec",
            incoming,
            outgoing,
            files: (section.files ?? []).map((f) => ({
                path: f.path,
                anchor: f.anchor ?? "",
                exists: f.exists,
                note: f.exists ? undefined : "не найден",
            })),
        };
    });
}

export type TreeKind = "spec" | "theme" | "task" | "project";

export interface TreeNode {
    id: string;
    kind: TreeKind;
    label: string;
    title: string;
    parent: string | null;
    project: string | null;
    weight: number;
}

export interface CrossLink {
    from: string;
    to: string;
    kind: "ref" | "spec" | "dep";
}

export interface SpecTree {
    nodes: TreeNode[];
    byId: Map<string, TreeNode>;
    children: Map<string, string[]>;
    cross: CrossLink[];
}

export const ORPHAN_SPEC = "spec:без раздела";

export function ancestors(tree: SpecTree, id: string): string[] {
    const path: string[] = [];
    let cursor = tree.byId.get(id)?.parent ?? null;
    const guard = new Set<string>([id]);
    while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        path.push(cursor);
        cursor = tree.byId.get(cursor)?.parent ?? null;
    }
    return path;
}

export function commonAncestor(tree: SpecTree, a: string, b: string): string | null {
    const up = new Set([a, ...ancestors(tree, a)]);
    if (up.has(b)) return b;
    for (const step of [b, ...ancestors(tree, b)]) if (up.has(step)) return step;
    return null;
}

export function specTree(board: BoardTodo[]): SpecTree {
    const index = laneIndex(board);
    const byId = new Map<string, TreeNode>();
    const children = new Map<string, string[]>();
    const label = (t: BoardTodo) => (t.number ? `#${t.number}` : t.id);

    const put = (node: TreeNode) => {
        byId.set(node.id, node);
        if (!node.parent) return;
        children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
    };

    const projectOf = new Map<string, string | null>();
    for (const t of board) projectOf.set(t.id, t.project ?? null);

    const addressesOf = (t: BoardTodo) => t.spec ?? [];
    const specIds = new Set<string>();
    for (const t of board) for (const address of addressesOf(t)) specIds.add(address);

    for (const address of specIds) {
        put({
            id: address,
            kind: "spec",
            label: address,
            title: address,
            parent: null,
            project: null,
            weight: 0,
        });
    }

    const themeSpec = new Map<string, string>();
    for (const root of index.roots) {
        const own = addressesOf(root);
        const inherited = (index.members.get(root.id) ?? [])
            .flatMap((id) => addressesOf(board.find((t) => t.id === id) ?? ({} as BoardTodo)))
            .filter(Boolean);
        const home = own[0] ?? inherited[0] ?? ORPHAN_SPEC;
        if (!byId.has(home)) {
            put({
                id: home,
                kind: "spec",
                label: home === ORPHAN_SPEC ? "без раздела" : home,
                title: home === ORPHAN_SPEC ? "темы без раздела спеки" : home,
                parent: null,
                project: null,
                weight: 0,
            });
        }
        themeSpec.set(root.id, home);
        put({
            id: root.id,
            kind: "theme",
            label: label(root),
            title: root.subject,
            parent: home,
            project: root.project ?? null,
            weight: (index.members.get(root.id) ?? []).length,
        });
    }

    for (const t of board) {
        if (t.change === true) continue;
        const lane = index.laneOf.get(t.id) ?? "";
        const parent = byId.has(lane) ? lane : projectRoot(t.project);
        if (!byId.has(parent)) {
            put({
                id: parent,
                kind: "project",
                title: t.project ?? "без проекта",
                label: t.project ?? "без проекта",
                parent: null,
                project: t.project ?? null,
                weight: 0,
            });
        }
        put({
            id: t.id,
            kind: "task",
            label: label(t),
            title: t.subject,
            parent,
            project: t.project ?? null,
            weight: 1,
        });
    }

    const tree: SpecTree = { nodes: [...byId.values()], byId, children, cross: [] };

    const seen = new Set<string>();
    const push = (from: string, to: string, kind: CrossLink["kind"]) => {
        if (!byId.has(from) || !byId.has(to) || from === to) return;
        const key = `${from}->${to}:${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        tree.cross.push({ from, to, kind });
    };

    for (const edge of refEdges(board)) push(edge.from, edge.to, "ref");
    for (const t of board) {
        const home = t.change === true ? themeSpec.get(t.id) : undefined;
        for (const address of addressesOf(t)) {
            if (address === home) continue;
            if (byId.get(t.id)?.parent === address) continue;
            push(t.id, address, "spec");
        }
    }

    return tree;
}

function projectRoot(project?: string | null): string {
    return `project:${project ?? ""}`;
}
