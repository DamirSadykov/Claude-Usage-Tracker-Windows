<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ToolBar from "../../atoms/ToolBar.vue";
import LegendBar from "../../atoms/LegendBar.vue";
import SegControl from "../../atoms/SegControl.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SidePanel from "../../atoms/SidePanel.vue";
import FocusRowItem from "../../atoms/FocusRowItem.vue";
import Kicker from "../../atoms/Kicker.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import RingCard from "../../atoms/RingCard.vue";
import {
    ORPHAN_SPEC,
    ancestors,
    nodeStatus,
    specTree,
    type SpecTree,
    type TreeNode,
} from "../adapt";
import { board as mockBoard } from "../boardMock";
import { useBoard } from "../useBoard";

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "rings" | "specs"): void;
    (e: "open", id: string): void;
}>();

const R_MIN = 84;
const R_MAX = 220;
const R_SCALE = 42;
const BUBBLE_GAP = 26;
const RELAX_ITERS = 56;
const RELAX_GUARD = 40;
const RELAX_PULL = 0.018;
const RELAX_CALM = 14;
const THEME_RING = 170;
const THEME_SLOT = 196;
const THEME_WIDTH = 140;
const TASK_ORBIT = 100;
const RIM_PAD = 56;
const FREE_PAD = 42;
const CHIP_PITCH = 34;
const CHIP_CAP = 14;
const CHIP_BADGE = 46;
const MORE_SEAT = 46;
const HEAD_HALF = 96;
const INNER_MIN = 150;
const DENSE_LIMIT = 26;
const SCENE_PAD = 120;
const TAU = Math.PI * 2;

const STATUS_TEXT: Record<string, string> = {
    queue: "очередь",
    in_progress: "в работе",
    review: "на ревью",
    done: "готова",
};

const KIND_TEXT: Record<string, string> = {
    ref: "ссылка",
    spec: "раздел спеки",
    dep: "зависимость",
};

type Health = "done" | "wait" | "blocked";

interface InnerNode {
    id: string;
    kind: "theme" | "task" | "more";
    label: string;
    title: string;
    health: Health;
    badge?: string;
    ext?: string;
    hasIn: boolean;
    hasOut: boolean;
    x: number;
    y: number;
}

interface Shape {
    id: string;
    kind: TreeNode["kind"];
    address: string;
    orphan: boolean;
    tasks: number;
    themes: number;
    split: { done: number; wait: number; blocked: number };
    loop: number;
    open: boolean;
    dense: boolean;
    nodes: InnerNode[];
    r: number;
}

interface Bubble extends Shape {
    x: number;
    y: number;
}

interface EdgePair {
    from: string;
    to: string;
    fromLabel: string;
    toLabel: string;
    kind: string;
}

interface CrossEdge {
    id: string;
    from: string;
    to: string;
    count: number;
    width: number;
    dashed: boolean;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    lx: number;
    ly: number;
    pairs: EdgePair[];
}

interface InnerEdge {
    id: string;
    path: string;
    dashed: boolean;
}

const { board: liveBoard, live } = useBoard();
const board = computed(() => (live.value ? liveBoard.value : mockBoard));
const byId = computed(() => new Map(board.value.map((t) => [t.id, t])));
const tree = computed(() => specTree(board.value));

const opened = ref<string[]>([]);
const picked = ref<string | null>(null);
const pickedEdge = ref<string | null>(null);
const crossOnly = ref(false);
const lockAll = ref(false);
const relation = ref("refs");
const shell = ref("bubbles");

const frame = ref<HTMLElement | null>(null);
const size = ref({ w: 1520, h: 820 });
const view = ref({ x: 0, y: 0, k: 1 });
const dragging = ref(false);

let ro: ResizeObserver | null = null;
let tick = 0;
let dragFrom = { mx: 0, my: 0, vx: 0, vy: 0 };
let dragged = false;

function measure() {
    const el = frame.value;
    if (!el) return;
    size.value = { w: el.clientWidth, h: el.clientHeight };
}

function schedule() {
    cancelAnimationFrame(tick);
    tick = requestAnimationFrame(measure);
}

function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    picked.value = null;
    pickedEdge.value = null;
}

onMounted(() => {
    ro = new ResizeObserver(schedule);
    if (frame.value) ro.observe(frame.value);
    window.addEventListener("resize", schedule);
    window.addEventListener("keydown", onKey);
    schedule();
});

onBeforeUnmount(() => {
    cancelAnimationFrame(tick);
    ro?.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("keydown", onKey);
    stopPan();
});

watch(board, () => {
    opened.value = [];
    picked.value = null;
    pickedEdge.value = null;
});

function word(count: number, one: string, few: string, many: string): string {
    const tail = count % 10;
    const teen = count % 100;
    if (teen >= 11 && teen <= 14) return `${count} ${many}`;
    if (tail === 1) return `${count} ${one}`;
    if (tail >= 2 && tail <= 4) return `${count} ${few}`;
    return `${count} ${many}`;
}

function clamp(value: number, low: number, high: number) {
    return Math.min(high, Math.max(low, value));
}

function subtreeOf(t: SpecTree, id: string): string[] {
    const out: string[] = [];
    const walk = (cur: string) => {
        for (const kid of t.children.get(cur) ?? []) {
            out.push(kid);
            walk(kid);
        }
    };
    walk(id);
    return out;
}

const rootOf = computed(() => {
    const map = new Map<string, string>();
    for (const node of tree.value.nodes) {
        const up = ancestors(tree.value, node.id);
        map.set(node.id, up.length ? up[up.length - 1] : node.id);
    }
    return map;
});

const depthOf = computed(() => {
    const map = new Map<string, number>();
    for (const node of tree.value.nodes) {
        map.set(node.id, ancestors(tree.value, node.id).length);
    }
    return map;
});

const roots = computed(() => {
    const rank = (n: TreeNode) =>
        n.id === ORPHAN_SPEC ? 1 : n.kind === "spec" ? 0 : 2;
    return tree.value.nodes
        .filter((n) => !n.parent)
        .slice()
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
});

function healthOf(id: string): Health {
    const todo = byId.value.get(id);
    if (!todo) return "wait";
    const state = nodeStatus(todo, byId.value);
    if (state === "done") return "done";
    if (state === "blocked") return "blocked";
    return "wait";
}

function labelOf(id: string): string {
    return tree.value.byId.get(id)?.label ?? id;
}

function titleOf(id: string): string {
    return tree.value.byId.get(id)?.title ?? "";
}

const external = computed(() => {
    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();
    for (const link of tree.value.cross) {
        if (rootOf.value.get(link.from) === rootOf.value.get(link.to)) continue;
        outbound.set(link.from, (outbound.get(link.from) ?? 0) + 1);
        inbound.set(link.to, (inbound.get(link.to) ?? 0) + 1);
    }
    return { inbound, outbound };
});

const innerCross = computed(() => {
    const map = new Map<string, number>();
    for (const link of tree.value.cross) {
        const home = rootOf.value.get(link.from);
        if (!home || home !== rootOf.value.get(link.to)) continue;
        map.set(home, (map.get(home) ?? 0) + 1);
    }
    return map;
});

function themeLayout(root: TreeNode, dense: boolean): { nodes: InnerNode[]; r: number } {
    const t = tree.value;
    const kids = t.children.get(root.id) ?? [];
    const themes = kids.filter((id) => t.byId.get(id)?.kind === "theme");
    const direct = kids.filter((id) => t.byId.get(id)?.kind === "task");
    const nodes: InnerNode[] = [];

    const seatOf = (id: string) => {
        const links =
            (external.value.outbound.get(id) ?? 0) +
            (external.value.inbound.get(id) ?? 0);
        const badge = !dense && links > 0 ? CHIP_BADGE : 0;
        return Math.min(labelOf(id).length, CHIP_CAP) * 6.4 + CHIP_PITCH + badge;
    };

    const ring = themes.length
        ? Math.max(THEME_RING, (themes.length * THEME_SLOT) / TAU)
        : 0;
    const orbit = ring + TASK_ORBIT;
    let radius = themes.length ? orbit + RIM_PAD : INNER_MIN;

    let free = 0;
    const freeSeats = direct.map(seatOf);
    if (direct.length) {
        const need = freeSeats.reduce((sum, w) => sum + w, 0);
        const widest = Math.max(...freeSeats);
        free = Math.max(radius - FREE_PAD, need / TAU, HEAD_HALF + widest / 2);
        radius = Math.max(radius, free + FREE_PAD);
    }

    const decorate = (id: string, kind: "theme" | "task", x: number, y: number) => {
        const out = external.value.outbound.get(id) ?? 0;
        const inb = external.value.inbound.get(id) ?? 0;
        const node: InnerNode = {
            id,
            kind,
            label: labelOf(id),
            title: titleOf(id),
            health: healthOf(id),
            hasIn: inb > 0,
            hasOut: out > 0,
            x,
            y,
        };
        if (kind === "theme") {
            const own = (t.children.get(id) ?? []).length;
            node.badge = word(own, "задача", "задачи", "задач");
        }
        if (!dense && inb + out > 0) node.ext = `${out} ↗ ${inb} ↘`;
        return node;
    };

    themes.forEach((id, i) => {
        const angle = -Math.PI / 2 + (i * TAU) / themes.length;
        nodes.push(
            decorate(id, "theme", ring * Math.cos(angle), ring * Math.sin(angle)),
        );
        const own = t.children.get(id) ?? [];
        const span = (TAU * orbit) / themes.length - CHIP_PITCH;
        const shown: string[] = [];
        let used = 0;
        for (const kid of own) {
            const width = seatOf(kid);
            if (used + width > span) break;
            shown.push(kid);
            used += width;
        }
        while (shown.length && shown.length < own.length && used + MORE_SEAT > span) {
            used -= seatOf(shown.pop() as string);
        }
        const rest = own.length - shown.length;
        const total = used + (rest ? MORE_SEAT : 0);
        let cursor = angle - total / 2 / orbit;
        for (const kid of shown) {
            const step = seatOf(kid) / orbit;
            const a = cursor + step / 2;
            cursor += step;
            nodes.push(
                decorate(kid, "task", orbit * Math.cos(a), orbit * Math.sin(a)),
            );
        }
        if (rest) {
            const a = cursor + MORE_SEAT / orbit / 2;
            nodes.push({
                id: `${id}:more`,
                kind: "more",
                label: `+${rest}`,
                title: "",
                health: "wait",
                hasIn: false,
                hasOut: false,
                x: orbit * Math.cos(a),
                y: orbit * Math.sin(a),
            });
        }
    });

    let seat = -Math.PI / 2;
    direct.forEach((id, i) => {
        const step = freeSeats[i] / free;
        const angle = seat + step / 2;
        seat += step;
        nodes.push(
            decorate(id, "task", free * Math.cos(angle), free * Math.sin(angle)),
        );
    });

    return { nodes, r: radius };
}

const shapes = computed<Shape[]>(() =>
    roots.value.map((root) => {
        const kids = tree.value.children.get(root.id) ?? [];
        const inside = subtreeOf(tree.value, root.id);
        const tasks = inside.filter((id) => tree.value.byId.get(id)?.kind === "task");
        const themes = kids.filter((id) => tree.value.byId.get(id)?.kind === "theme");
        const split = { done: 0, wait: 0, blocked: 0 };
        for (const id of tasks) split[healthOf(id)] += 1;
        const open = opened.value.includes(root.id);
        const dense = tasks.length + themes.length > DENSE_LIMIT;
        const inner = open ? themeLayout(root, dense) : { nodes: [], r: 0 };
        const collapsed = clamp(R_SCALE * Math.sqrt(tasks.length), R_MIN, R_MAX);
        return {
            id: root.id,
            kind: root.kind,
            address:
                root.kind === "project"
                    ? (root.project ?? "без проекта")
                    : root.id,
            orphan: root.id === ORPHAN_SPEC,
            tasks: tasks.length,
            themes: themes.length,
            split,
            loop: innerCross.value.get(root.id) ?? 0,
            open,
            dense,
            nodes: inner.nodes,
            r: open ? Math.max(collapsed, inner.r) : collapsed,
        };
    }),
);

function relax(list: Shape[], w: number, h: number): Bubble[] {
    const cx = w / 2;
    const cy = h / 2;
    const n = list.length;
    const total = list.reduce((sum, s) => sum + s.r, 0);
    const ring = n > 1 ? Math.max(240, (total * 2.2) / Math.PI) : 0;
    const placed: Bubble[] = list.map((s, i) => {
        const angle = -Math.PI / 2 + (i * TAU) / n;
        return { ...s, x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle) };
    });

    const separate = (): boolean => {
        let moved = false;
        for (let i = 0; i < n; i += 1) {
            for (let j = i + 1; j < n; j += 1) {
                const a = placed[i];
                const b = placed[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d = Math.hypot(dx, dy);
                const need = a.r + b.r + BUBBLE_GAP;
                if (d >= need) continue;
                if (d < 0.001) {
                    const angle = (((i * 37 + j * 61) % 360) * Math.PI) / 180;
                    dx = Math.cos(angle);
                    dy = Math.sin(angle);
                    d = 0.001;
                }
                const push = (need - d) / 2;
                a.x -= (dx / d) * push;
                a.y -= (dy / d) * push;
                b.x += (dx / d) * push;
                b.y += (dy / d) * push;
                moved = true;
            }
        }
        return moved;
    };

    for (let step = 0; step < RELAX_ITERS; step += 1) {
        if (step < RELAX_ITERS - RELAX_CALM) {
            for (const p of placed) {
                p.x += (cx - p.x) * RELAX_PULL;
                p.y += (cy - p.y) * RELAX_PULL;
            }
        }
        separate();
    }
    for (let step = 0; step < RELAX_GUARD; step += 1) if (!separate()) break;
    return placed;
}

const bubbles = computed(() => relax(shapes.value, size.value.w, size.value.h));

const bubbleById = computed(() => new Map(bubbles.value.map((b) => [b.id, b])));

const bounds = computed(() => {
    if (!bubbles.value.length)
        return { x0: 0, y0: 0, w: size.value.w, h: size.value.h };
    const x0 = Math.min(...bubbles.value.map((b) => b.x - b.r)) - SCENE_PAD;
    const x1 = Math.max(...bubbles.value.map((b) => b.x + b.r)) + SCENE_PAD;
    const y0 = Math.min(...bubbles.value.map((b) => b.y - b.r)) - SCENE_PAD;
    const y1 = Math.max(...bubbles.value.map((b) => b.y + b.r)) + SCENE_PAD;
    return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
});

const nodeAt = computed(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const b of bubbles.value) {
        for (const node of b.nodes) {
            if (node.kind === "more") continue;
            map.set(node.id, { x: b.x + node.x, y: b.y + node.y });
        }
    }
    return map;
});

const crossEdges = computed<CrossEdge[]>(() => {
    const groups = new Map<string, EdgePair[]>();
    for (const link of tree.value.cross) {
        const a = rootOf.value.get(link.from);
        const b = rootOf.value.get(link.to);
        if (!a || !b || a === b) continue;
        const key = `${a}->${b}`;
        const pair: EdgePair = {
            from: link.from,
            to: link.to,
            fromLabel: labelOf(link.from),
            toLabel: labelOf(link.to),
            kind: KIND_TEXT[link.kind] ?? link.kind,
        };
        const bag = groups.get(key);
        if (bag) bag.push(pair);
        else groups.set(key, [pair]);
    }

    const out: CrossEdge[] = [];
    for (const [key, pairs] of groups) {
        const [from, to] = key.split("->");
        const a = bubbleById.value.get(from);
        const b = bubbleById.value.get(to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        const twin = groups.has(`${to}->${from}`);
        const shift = twin ? 8 : 0;
        const seat = twin ? 0.36 : 0.5;
        const ox = -uy * shift;
        const oy = ux * shift;
        const x1 = a.x + ux * (a.r + 4) + ox;
        const y1 = a.y + uy * (a.r + 4) + oy;
        const x2 = b.x - ux * (b.r + 10) + ox;
        const y2 = b.y - uy * (b.r + 10) + oy;
        const level = pairs.some(
            (p) => depthOf.value.get(p.from) === depthOf.value.get(p.to),
        );
        out.push({
            id: key,
            from,
            to,
            count: pairs.length,
            width: 1 + Math.log2(pairs.length),
            dashed: !level,
            x1,
            y1,
            x2,
            y2,
            lx: x1 + (x2 - x1) * seat + ox,
            ly: y1 + (y2 - y1) * seat + oy,
            pairs,
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
});

const innerEdges = computed<InnerEdge[]>(() => {
    if (crossOnly.value) return [];
    const out: InnerEdge[] = [];
    for (const link of tree.value.cross) {
        const home = rootOf.value.get(link.from);
        if (!home || home !== rootOf.value.get(link.to)) continue;
        const bubble = bubbleById.value.get(home);
        if (!bubble || !bubble.open) continue;
        const a = nodeAt.value.get(link.from);
        const b = nodeAt.value.get(link.to);
        const rim = (near: { x: number; y: number }) => {
            const dx = near.x - bubble.x;
            const dy = near.y - bubble.y;
            const d = Math.hypot(dx, dy) || 1;
            return {
                x: bubble.x + (dx / d) * (bubble.r - 12),
                y: bubble.y + (dy / d) * (bubble.r - 12),
            };
        };
        const p1 = a ?? (b ? rim(b) : null);
        const p2 = b ?? (a ? rim(a) : null);
        if (!p1 || !p2) continue;
        const c1 = {
            x: p1.x + (p2.x - p1.x) / 3,
            y: p1.y + (p2.y - p1.y) / 3,
        };
        const c2 = {
            x: p1.x + (2 * (p2.x - p1.x)) / 3,
            y: p1.y + (2 * (p2.y - p1.y)) / 3,
        };
        const bow = 0.28;
        out.push({
            id: `${link.from}->${link.to}:${link.kind}`,
            path: `M ${p1.x} ${p1.y} C ${c1.x + (bubble.x - c1.x) * bow} ${
                c1.y + (bubble.y - c1.y) * bow
            } ${c2.x + (bubble.x - c2.x) * bow} ${
                c2.y + (bubble.y - c2.y) * bow
            } ${p2.x} ${p2.y}`,
            dashed: !a || !b,
        });
    }
    return out;
});

function polar(cx: number, cy: number, r: number, angle: number) {
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
    const p0 = polar(cx, cy, r, a0);
    const p1 = polar(cx, cy, r, a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`;
}

function ringSegments(b: Bubble) {
    const r = b.r - 7;
    const total = b.split.done + b.split.wait + b.split.blocked;
    if (!total) return [];
    const all: { tone: Health; share: number }[] = [
        { tone: "done", share: b.split.done },
        { tone: "wait", share: b.split.wait },
        { tone: "blocked", share: b.split.blocked },
    ];
    const parts = all.filter((p) => p.share > 0);
    const gap = parts.length > 1 ? 0.05 : 0;
    let cursor = -Math.PI / 2;
    return parts.map((p) => {
        const sweep = (p.share / total) * TAU;
        const a0 = cursor + gap / 2;
        const a1 = cursor + sweep - gap / 2;
        cursor += sweep;
        return { tone: p.tone, d: arcPath(b.r, b.r, r, a0, Math.max(a0 + 0.01, a1)) };
    });
}

function loopMark(b: Bubble) {
    const angle = (-50 * Math.PI) / 180;
    const seat = polar(b.r, b.r, b.r - 26, angle);
    const tail = polar(b.r, b.r, b.r - 7, angle);
    return {
        cx: seat.x,
        cy: seat.y,
        d: `M ${seat.x} ${seat.y} L ${tail.x} ${tail.y}`,
    };
}

const taskTotal = computed(() =>
    shapes.value.reduce((sum, s) => sum + s.tasks, 0),
);

const stats = computed(
    () =>
        [
            word(bubbles.value.length, "раздел", "раздела", "разделов"),
            word(taskTotal.value, "задача", "задачи", "задач"),
            word(tree.value.cross.length, "связь", "связи", "связей"),
        ].join(" · "),
);

const legendItems = computed(() => [
    { text: "пузырь — раздел спеки, размер по числу задач", color: "var(--accent)" },
    { text: "кольцо: готова · ждёт · заблокирована", color: "var(--ok)" },
    {
        text: "число у стрелки — сколько ссылок между разделами",
        mark: "line" as const,
    },
    { text: "пунктир — ссылка на другой уровень", mark: "dash" as const },
    { text: "петля у края — ссылки внутри раздела", color: "var(--text-4)" },
]);

const pick = computed(() => {
    const id = picked.value;
    if (!id) return null;
    const node = tree.value.byId.get(id);
    const todo = byId.value.get(id);
    if (!node) return null;
    const home = rootOf.value.get(id) ?? id;
    const outgoing = tree.value.cross
        .filter((l) => l.from === id)
        .map((l) => ({ id: labelOf(l.to), title: titleOf(l.to), target: l.to }));
    const incoming = tree.value.cross
        .filter((l) => l.to === id)
        .map((l) => ({ id: labelOf(l.from), title: titleOf(l.from), target: l.from }));
    return {
        id,
        label: node.label,
        title: node.title,
        project: node.project ?? todo?.project ?? "без проекта",
        status: todo ? (STATUS_TEXT[todo.status] ?? todo.status) : "нет в доске",
        health: healthOf(id),
        home,
        homeLabel: bubbleById.value.get(home)?.address ?? home,
        outgoing,
        incoming,
    };
});

const edgePick = computed(() => {
    const id = pickedEdge.value;
    if (!id) return null;
    return crossEdges.value.find((e) => e.id === id) ?? null;
});

function addressOf(id: string): string {
    const b = bubbleById.value.get(id);
    if (!b) return id;
    return b.orphan ? "без раздела" : b.address;
}

function healthText(health: Health): string {
    return health === "done" ? "готова" : health === "blocked" ? "заблокирована" : "ждёт";
}

function healthTone(health: Health): "ok" | "crit" | "theme" {
    return health === "done" ? "ok" : health === "blocked" ? "crit" : "theme";
}

function pickRelation(value: string) {
    relation.value = value;
    if (value === "deps") emit("mode", "lanes");
}

function pickShell(value: string) {
    shell.value = value;
    if (value === "rings") emit("mode", "rings");
}

function toggleAll() {
    lockAll.value = !lockAll.value;
    if (lockAll.value) {
        opened.value = [];
        pickedEdge.value = null;
    }
}

function expand(id: string) {
    if (dragged || opened.value.includes(id)) return;
    lockAll.value = false;
    opened.value = [...opened.value, id];
}

function collapse(id: string) {
    opened.value = opened.value.filter((x) => x !== id);
}

function onBubble(b: Bubble) {
    if (b.open) return;
    expand(b.id);
}

function onHead(b: Bubble) {
    if (dragged) return;
    if (b.open) collapse(b.id);
    else expand(b.id);
}

function selectNode(id: string) {
    if (dragged || !tree.value.byId.has(id)) return;
    picked.value = id;
    pickedEdge.value = null;
}

function focusRow(id: string) {
    const home = rootOf.value.get(id);
    if (home) expand(home);
    picked.value = id;
}

function selectEdge(id: string) {
    if (dragged) return;
    pickedEdge.value = id;
    picked.value = null;
}

function openPair(pair: EdgePair) {
    const home = rootOf.value.get(pair.from);
    const away = rootOf.value.get(pair.to);
    lockAll.value = false;
    const next = new Set(opened.value);
    if (home) next.add(home);
    if (away) next.add(away);
    opened.value = [...next];
    picked.value = pair.from;
    pickedEdge.value = null;
}

function openNode(id: string) {
    emit("open", id);
}

function isBackground(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return !el.closest(
        ".bub, .bub-elabel, .bub-hit, .bub-side, .bub-pick, .bub-empty",
    );
}

function onPanMove(e: MouseEvent) {
    const dx = e.clientX - dragFrom.mx;
    const dy = e.clientY - dragFrom.my;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
    view.value.x = dragFrom.vx + dx;
    view.value.y = dragFrom.vy + dy;
}

function stopPan() {
    dragging.value = false;
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", stopPan);
    window.setTimeout(() => {
        dragged = false;
    }, 0);
}

function onCanvasDown(e: MouseEvent) {
    if (e.button !== 0 || !isBackground(e.target)) return;
    picked.value = null;
    pickedEdge.value = null;
    dragging.value = true;
    dragged = false;
    dragFrom = { mx: e.clientX, my: e.clientY, vx: view.value.x, vy: view.value.y };
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", stopPan);
}

function onWheel(e: WheelEvent) {
    e.preventDefault();
    const host = frame.value;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k = clamp(view.value.k * Math.exp(-e.deltaY * 0.0016), 0.4, 2);
    const px = (mx - view.value.x) / view.value.k;
    const py = (my - view.value.y) / view.value.k;
    view.value = { x: mx - px * k, y: my - py * k, k };
}

function fit() {
    const b = bounds.value;
    if (!size.value.w || !size.value.h) return;
    const k = clamp(Math.min(size.value.w / b.w, size.value.h / b.h), 0.4, 1);
    view.value = {
        k,
        x: size.value.w / 2 - (b.x0 + b.w / 2) * k,
        y: size.value.h / 2 - (b.y0 + b.h / 2) * k,
    };
}

function onDouble(e: MouseEvent) {
    if (!isBackground(e.target)) return;
    fit();
}

watch([bounds, () => size.value.w, () => size.value.h], fit, { immediate: true });
</script>

<template>
    <ToolBar>
        <SegControl
            :model-value="relation"
            :options="[
                { id: 'deps', label: 'Зависимости' },
                { id: 'refs', label: 'Ссылки' },
            ]"
            @update:model-value="pickRelation"
        />
        <SegControl
            :model-value="shell"
            :options="[
                { id: 'bubbles', label: 'Пузыри разделов' },
                { id: 'rings', label: 'Кольца вокруг фокуса' },
            ]"
            @update:model-value="pickShell"
        />
        <ToolButton :active="crossOnly" @click="crossOnly = !crossOnly">
            Только связи между разделами
        </ToolButton>
        <ToolButton :active="lockAll" @click="toggleAll">Свернуть всё</ToolButton>
        <template #right>
            <span class="bub-stats">{{ stats }}</span>
        </template>
    </ToolBar>

    <LegendBar :items="legendItems">
        <template #right>
            <span class="bub-hints">
                ЛКМ по пузырю — раскрыть · ЛКМ по узлу — панель · двойной ЛКМ —
                открыть в доске · колесо — масштаб
            </span>
        </template>
    </LegendBar>

    <div class="pipe-canvas plain bub-canvas">
        <div
            ref="frame"
            class="bub-frame"
            :class="{ dragging }"
            @mousedown="onCanvasDown"
            @wheel="onWheel"
            @dblclick="onDouble"
        >
            <div v-if="board.length && !tree.cross.length" class="bub-empty">
                <div class="bub-empty-title">Ссылок между задачами нет</div>
                <p class="bub-empty-text">
                    На доске {{ board.length }} задач, они разложены по разделам, но
                    ни одна не ссылается на другую. Ссылка появляется, когда у задачи
                    заполнено поле связей или в её описании есть упоминание вида
                    <span class="pipe-mono">t#345</span>.
                </p>
            </div>

            <div
                class="bub-stage"
                :style="{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
                }"
            >
                <svg
                    class="bub-wires"
                    :style="{ left: `${bounds.x0}px`, top: `${bounds.y0}px` }"
                    :width="bounds.w"
                    :height="bounds.h"
                    :viewBox="`${bounds.x0} ${bounds.y0} ${bounds.w} ${bounds.h}`"
                >
                    <defs>
                        <marker
                            id="bub-head"
                            viewBox="0 0 10 8"
                            refX="9"
                            refY="4"
                            markerWidth="10"
                            markerHeight="8"
                            markerUnits="userSpaceOnUse"
                            orient="auto"
                        >
                            <path class="bub-arrow" d="M0 0 L10 4 L0 8 Z" />
                        </marker>
                    </defs>

                    <path
                        v-for="edge in innerEdges"
                        :key="edge.id"
                        class="bub-inner-wire"
                        :class="{ dashed: edge.dashed }"
                        :d="edge.path"
                    />

                    <template v-for="edge in crossEdges" :key="edge.id">
                        <line
                            class="bub-wire"
                            :class="{
                                dashed: edge.dashed,
                                marked: pickedEdge === edge.id,
                            }"
                            :x1="edge.x1"
                            :y1="edge.y1"
                            :x2="edge.x2"
                            :y2="edge.y2"
                            :style="{ strokeWidth: `${edge.width}px` }"
                            marker-end="url(#bub-head)"
                        />
                        <line
                            class="bub-hit"
                            :x1="edge.x1"
                            :y1="edge.y1"
                            :x2="edge.x2"
                            :y2="edge.y2"
                            @click.stop="selectEdge(edge.id)"
                        />
                    </template>
                </svg>

                <div
                    v-for="edge in crossEdges"
                    :key="`label-${edge.id}`"
                    class="bub-elabel"
                    :class="{ marked: pickedEdge === edge.id }"
                    :style="{
                        left: `${edge.lx}px`,
                        top: `${edge.ly}px`,
                        transform: `translate(-50%, -50%) scale(${1 / view.k})`,
                    }"
                    @click.stop="selectEdge(edge.id)"
                >
                    {{ edge.count }}
                </div>

                <div
                    v-for="b in bubbles"
                    :key="b.id"
                    class="bub"
                    :class="{ open: b.open, spec: b.kind === 'spec' && !b.orphan }"
                    :style="{
                        left: `${b.x - b.r}px`,
                        top: `${b.y - b.r}px`,
                        width: `${b.r * 2}px`,
                        height: `${b.r * 2}px`,
                    }"
                    @click="onBubble(b)"
                >
                    <svg
                        class="bub-ring"
                        :viewBox="`0 0 ${b.r * 2} ${b.r * 2}`"
                        :width="b.r * 2"
                        :height="b.r * 2"
                    >
                        <circle
                            class="bub-track"
                            :cx="b.r"
                            :cy="b.r"
                            :r="b.r - 7"
                        />
                        <path
                            v-for="seg in ringSegments(b)"
                            :key="seg.tone"
                            class="bub-seg"
                            :class="`tone-${seg.tone}`"
                            :d="seg.d"
                        />
                        <template v-if="b.loop && (!b.open || crossOnly)">
                            <path class="bub-loop-tail" :d="loopMark(b).d" />
                            <circle
                                class="bub-loop"
                                :cx="loopMark(b).cx"
                                :cy="loopMark(b).cy"
                                r="11"
                            />
                            <text
                                class="bub-loop-text"
                                :x="loopMark(b).cx"
                                :y="loopMark(b).cy"
                                text-anchor="middle"
                                dominant-baseline="central"
                            >
                                {{ b.loop }}
                            </text>
                        </template>
                    </svg>

                    <div
                        class="bub-head"
                        :class="{ open: b.open }"
                        :style="{ left: `${b.r}px`, top: `${b.r}px` }"
                        @click.stop="onHead(b)"
                    >
                        <Kicker :tone="b.kind === 'spec' && !b.orphan ? 'accent' : 'muted'">
                            {{ b.kind === "spec" ? "раздел спеки" : "проект" }}
                        </Kicker>
                        <div
                            class="bub-address"
                            :class="{ dim: b.orphan || b.kind !== 'spec' }"
                        >
                            {{ b.orphan ? "без раздела" : b.address }}
                        </div>
                        <div class="bub-counts">
                            {{ word(b.tasks, "задача", "задачи", "задач") }} ·
                            {{ word(b.themes, "тема", "темы", "тем") }}
                        </div>
                        <div v-if="b.open" class="bub-fold">свернуть</div>
                    </div>

                    <template v-if="b.open">
                        <div
                            v-for="node in b.nodes"
                            :key="node.id"
                            class="bub-node"
                            :class="{ marked: picked === node.id }"
                            :style="{
                                left: `${b.r + node.x}px`,
                                top: `${b.r + node.y}px`,
                            }"
                            @click.stop="node.kind !== 'more' && selectNode(node.id)"
                            @dblclick.stop="node.kind !== 'more' && openNode(node.id)"
                        >
                            <RingCard
                                v-if="node.kind === 'theme'"
                                :style="{ width: `${THEME_WIDTH}px` }"
                                :label="node.label"
                                :title="node.title"
                                :tone="picked === node.id ? 'hub' : 'plain'"
                                :badge="node.badge"
                                :counter="node.ext"
                            />
                            <span v-else-if="node.kind === 'more'" class="bub-more">
                                {{ node.label }}
                            </span>
                            <span
                                v-else
                                class="bub-chip"
                                :class="`tone-${node.health}`"
                                :title="node.title"
                            >
                                <span class="bub-chip-id">{{ node.label }}</span>
                                <span v-if="node.ext" class="bub-chip-ext">
                                    {{ node.ext }}
                                </span>
                                <span v-else-if="b.dense" class="bub-chip-dots">
                                    <i v-if="node.hasIn" class="dot in" />
                                    <i v-if="node.hasOut" class="dot out" />
                                </span>
                            </span>
                        </div>
                    </template>
                </div>
            </div>

            <div v-if="edgePick" class="bub-side">
                <SidePanel title="Связи между разделами">
                    <div class="bub-pair-head">
                        <span class="bub-pair-from">{{ addressOf(edgePick.from) }}</span>
                        <span class="bub-pair-arrow">→</span>
                        <span class="bub-pair-to">{{ addressOf(edgePick.to) }}</span>
                    </div>
                    <div class="bub-group">
                        <Kicker>{{
                            word(edgePick.count, "ссылка", "ссылки", "ссылок")
                        }}</Kicker>
                    </div>
                    <FocusRowItem
                        v-for="pair in edgePick.pairs"
                        :key="`${pair.from}->${pair.to}`"
                        :id="`${pair.fromLabel} → ${pair.toLabel}`"
                        :title="pair.kind"
                        @click="openPair(pair)"
                    />
                    <template #footer>
                        <ToolButton class="bub-wide" @click="pickedEdge = null">
                            Закрыть
                        </ToolButton>
                    </template>
                </SidePanel>
            </div>

            <div v-if="pick" class="bub-pick">
                <SidePanel title="Узел">
                    <div class="bub-pick-head">
                        <span class="bub-pick-id">{{ pick.label }}</span>
                        <span class="bub-pick-title">{{ pick.title }}</span>
                    </div>
                    <div class="bub-pick-row">
                        <span>раздел</span>
                        <span class="bub-pick-value">{{ addressOf(pick.home) }}</span>
                    </div>
                    <div class="bub-pick-row">
                        <span>проект</span>
                        <span class="bub-pick-value">{{ pick.project }}</span>
                    </div>
                    <div class="bub-pick-row">
                        <span>статус</span>
                        <span class="bub-pick-value">{{ pick.status }}</span>
                    </div>
                    <div class="bub-pick-row">
                        <span>состояние</span>
                        <MetaChip
                            :tone="healthTone(pick.health)"
                            :text="healthText(pick.health)"
                        />
                    </div>
                    <div class="bub-group">
                        <Kicker>он ссылается · {{ pick.outgoing.length }}</Kicker>
                    </div>
                    <FocusRowItem
                        v-for="row in pick.outgoing"
                        :key="`o-${row.target}`"
                        :id="row.id"
                        :title="row.title"
                        @click="focusRow(row.target)"
                    />
                    <div class="bub-group">
                        <Kicker>ссылаются на него · {{ pick.incoming.length }}</Kicker>
                    </div>
                    <FocusRowItem
                        v-for="row in pick.incoming"
                        :key="`i-${row.target}`"
                        :id="row.id"
                        :title="row.title"
                        @click="focusRow(row.target)"
                    />
                    <template #footer>
                        <div class="bub-pick-actions">
                            <ToolButton @click="collapse(pick!.home)">
                                Свернуть пузырь
                            </ToolButton>
                            <ToolButton variant="pri" @click="openNode(pick!.id)">
                                Открыть в доске
                            </ToolButton>
                        </div>
                    </template>
                </SidePanel>
            </div>
        </div>
    </div>
</template>

<style scoped>
.bub-stats {
    height: 30px;
    display: inline-flex;
    align-items: center;
    padding: 0 11px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    font-size: 11.5px;
    color: var(--text-4);
}
.bub-hints {
    font-size: 11px;
    color: var(--text-4);
}

.bub-canvas {
    overflow: hidden;
}
.bub-frame {
    position: absolute;
    inset: 0;
    overflow: hidden;
    cursor: grab;
}
.bub-frame.dragging {
    cursor: grabbing;
}
.bub-stage {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
}

.bub-wires {
    position: absolute;
    overflow: visible;
    pointer-events: none;
    z-index: 0;
}
.bub-wire {
    fill: none;
    stroke: rgba(255, 255, 255, 0.32);
    stroke-linecap: round;
}
.bub-wire.dashed {
    stroke-dasharray: 6 6;
}
.bub-wire.marked {
    stroke: var(--accent);
}
.bub-hit {
    stroke: transparent;
    stroke-width: 16;
    pointer-events: stroke;
    cursor: pointer;
}
.bub-arrow {
    fill: rgba(255, 255, 255, 0.4);
}
.bub-inner-wire {
    fill: none;
    stroke: rgba(255, 255, 255, 0.22);
    stroke-width: 1.2;
}
.bub-inner-wire.dashed {
    stroke-dasharray: 3 5;
}

.bub-elabel {
    position: absolute;
    z-index: 2;
    min-width: 18px;
    padding: 1px 6px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-pill);
    background: #1b1b1b;
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--text-3);
    text-align: center;
    cursor: pointer;
    transform-origin: 50% 50%;
}
.bub-elabel:hover,
.bub-elabel.marked {
    border-color: rgba(76, 194, 255, 0.5);
    color: var(--accent);
}

.bub {
    position: absolute;
    z-index: 1;
    border-radius: 50%;
    border: 1px solid var(--project-stroke);
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
}
.bub.spec {
    border-color: rgba(76, 194, 255, 0.22);
}
.bub.open {
    z-index: 1;
    background: rgba(255, 255, 255, 0.03);
    cursor: default;
}
.bub-ring {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
}
.bub-track {
    fill: none;
    stroke: var(--track);
    stroke-width: 5;
}
.bub-seg {
    fill: none;
    stroke-width: 5;
    stroke-linecap: butt;
}
.bub-seg.tone-done {
    stroke: var(--ok);
}
.bub-seg.tone-wait {
    stroke: var(--theme);
}
.bub-seg.tone-blocked {
    stroke: var(--crit);
}
.bub-loop {
    fill: #1f1f1f;
    stroke: rgba(255, 255, 255, 0.3);
    stroke-width: 1.2;
}
.bub-loop-tail {
    fill: none;
    stroke: rgba(255, 255, 255, 0.22);
    stroke-width: 1.2;
}
.bub-loop-text {
    fill: var(--text-3);
    font-family: var(--mono);
    font-size: 10px;
}

.bub-head {
    position: absolute;
    z-index: 3;
    width: 176px;
    padding: 6px 8px;
    transform: translate(-50%, -50%);
    text-align: center;
    cursor: pointer;
}
.bub-head.open {
    border: 1px solid var(--stroke);
    border-radius: var(--r-card);
    background: rgba(24, 24, 24, 0.92);
}
.bub-address {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.3;
    color: var(--accent);
    overflow-wrap: anywhere;
}
.bub-address.dim {
    color: var(--text-3);
}
.bub-counts {
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--text-4);
}
.bub-fold {
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--accent);
}

.bub-node {
    position: absolute;
    z-index: 2;
    transform: translate(-50%, -50%);
}
.bub-node.marked .bub-chip {
    border-color: var(--accent);
    color: var(--accent);
}
.bub-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-pill);
    background: var(--node-bg);
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.4;
    color: var(--text-2);
    white-space: nowrap;
    cursor: pointer;
}
.bub-chip.tone-done {
    border-color: rgba(108, 203, 95, 0.4);
    color: var(--ok);
}
.bub-chip.tone-blocked {
    border-color: rgba(248, 113, 113, 0.4);
    color: var(--crit);
}
.bub-chip.tone-wait {
    border-color: rgba(227, 179, 65, 0.32);
}
.bub-chip-id {
    display: block;
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.bub-chip-ext {
    font-size: 9px;
    color: var(--text-4);
}
.bub-chip-dots {
    display: inline-flex;
    gap: 2px;
}
.bub-chip-dots .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
}
.bub-chip-dots .dot.in {
    background: rgba(255, 255, 255, 0.45);
}
.bub-chip-dots .dot.out {
    background: var(--accent);
}
.bub-more {
    display: inline-flex;
    padding: 2px 7px;
    border: 1px dashed var(--stroke-strong);
    border-radius: var(--r-pill);
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--text-4);
}

.bub-empty {
    position: absolute;
    left: 50%;
    top: 22px;
    z-index: 4;
    width: 440px;
    padding: 14px 18px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.96);
    text-align: center;
    transform: translateX(-50%);
}
.bub-empty-title {
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 600;
}
.bub-empty-text {
    margin: 0;
    font-size: 11.8px;
    line-height: 1.5;
    color: var(--text-3);
}

.bub-side {
    position: absolute;
    left: 24px;
    top: 50%;
    z-index: 3;
    transform: translateY(-50%);
}
.bub-pick {
    position: absolute;
    right: 18px;
    top: 18px;
    z-index: 3;
    max-height: calc(100% - 36px);
    overflow: auto;
}
.bub-group {
    margin: 12px 0 4px;
}
.bub-pair-head {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--stroke);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
    overflow-wrap: anywhere;
}
.bub-pair-arrow {
    color: var(--text-4);
}
.bub-pair-to {
    color: var(--accent);
}
.bub-pick-head {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--stroke);
}
.bub-pick-id {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
}
.bub-pick-title {
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--text);
}
.bub-pick-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--text-4);
}
.bub-pick-value {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
    text-align: right;
    overflow-wrap: anywhere;
}
.bub-pick-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.bub-pick-actions .tool-button,
.bub-wide {
    width: 100%;
    justify-content: center;
}
</style>
