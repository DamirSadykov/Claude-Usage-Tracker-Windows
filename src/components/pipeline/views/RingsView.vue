<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ToolBar from "../../atoms/ToolBar.vue";
import LegendBar from "../../atoms/LegendBar.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import SegControl from "../../atoms/SegControl.vue";
import StatusChip from "../../atoms/StatusChip.vue";
import Kicker from "../../atoms/Kicker.vue";
import RingBackdrop from "../../atoms/RingBackdrop.vue";
import RingCard from "../../atoms/RingCard.vue";
import RadialWireLayer from "../../atoms/RadialWireLayer.vue";
import ClusterBubble from "../../atoms/ClusterBubble.vue";
import SidePanel from "../../atoms/SidePanel.vue";
import FocusRowItem from "../../atoms/FocusRowItem.vue";
import MiniMap from "../../atoms/MiniMap.vue";
import { focusRows, hubIds, refEdges, ringsAround } from "../adapt";
import { board as mockBoard } from "../boardMock";
import { useBoard } from "../useBoard";

const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "bubbles" | "rings" | "specs"): void;
    (e: "open", id: string): void;
}>();

const ROOT_FOCUS = "t337";
const SPEC_ID = /^[a-z][a-z0-9-]*#[a-z0-9-]+$/;
const BASE_RADII = [0, 300, 510, 720, 930];
const FREE_RADII = [0, 220, 430, 640, 850];
const STAGGER = 18;
const SLOT_ARC = 33;
const RING_GAP = 200;
const MAP_PAD = 150;
const FREE_CARDS = 26;
const PROJECT_CARDS = 30;
const SATELLITE_CARDS = 12;

const STATUS_TEXT: Record<string, string> = {
    queue: "очередь",
    in_progress: "в работе",
    review: "на ревью",
    done: "готова",
};

const { board: liveBoard, live } = useBoard();
const board = computed(() => (live.value ? liveBoard.value : mockBoard));

const byId = computed(() => new Map(board.value.map((t) => [t.id, t])));
const edges = computed(() => refEdges(board.value));
const hubs = computed(() => hubIds(board.value));

const incoming = computed(() => {
    const map = new Map<string, number>();
    for (const e of edges.value) map.set(e.to, (map.get(e.to) ?? 0) + 1);
    return map;
});

const outgoing = computed(() => {
    const map = new Map<string, number>();
    for (const e of edges.value) map.set(e.from, (map.get(e.from) ?? 0) + 1);
    return map;
});

const adjacency = computed(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges.value) {
        if (!map.has(e.from)) map.set(e.from, new Set());
        if (!map.has(e.to)) map.set(e.to, new Set());
        map.get(e.from)!.add(e.to);
        map.get(e.to)!.add(e.from);
    }
    return map;
});

const idOfLabel = computed(
    () => new Map(board.value.map((t) => [t.number ? `#${t.number}` : t.id, t.id])),
);

interface PlacedNode {
    id: string;
    label: string;
    title: string;
    tone: "hub" | "spec" | "plain";
    counter?: string;
    ring: number;
    x: number;
    y: number;
}

interface PlacedCluster {
    id: string;
    title: string;
    note: string;
    size: number;
    x: number;
    y: number;
}

interface PlacedPlaque {
    id: string;
    title: string;
    note: string;
    x: number;
    y: number;
}

const relation = ref("refs");
const depth = ref("2");
const collapseForeign = ref(false);
const specOnly = ref(false);
const focusId = ref<string | null>(ROOT_FOCUS);

function busiestNode(): string | null {
    const degree = new Map<string, number>();
    for (const e of edges.value) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    let best: string | null = null;
    let top = 0;
    for (const [id, n] of degree) {
        if (n > top) {
            top = n;
            best = id;
        }
    }
    return best;
}

watch(
    board,
    () => {
        if (focusId.value && byId.value.has(focusId.value)) return;
        focusId.value = busiestNode();
        picked.value = null;
        opened.value = [];
        onlyProject.value = null;
    },
    { immediate: true },
);
const picked = ref<string | null>(null);
const opened = ref<string[]>([]);
const onlyProject = ref<string | null>(null);

const frame = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const mapHost = ref<HTMLElement | null>(null);
const wires = ref<InstanceType<typeof RadialWireLayer> | null>(null);
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
    if (e.key === "Escape") picked.value = null;
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
    stopMapDrag();
});

const cx = computed(() => size.value.w / 2);
const cy = computed(() => size.value.h / 2);
const depthValue = computed(() => (depth.value === "all" ? 4 : Number(depth.value)));

const focusTodo = computed(() =>
    focusId.value ? (byId.value.get(focusId.value) ?? null) : null,
);
const focusNumber = computed(() => {
    const todo = focusTodo.value;
    if (!todo) return "";
    return todo.number ? `#${todo.number}` : todo.id;
});

const pivotProject = computed(() => {
    if (focusTodo.value) return focusTodo.value.project ?? null;
    const tally = new Map<string, number>();
    for (const id of adjacency.value.keys()) {
        const name = byId.value.get(id)?.project;
        if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    let best: string | null = null;
    let top = 0;
    for (const [name, n] of tally) {
        if (n > top) {
            top = n;
            best = name;
        }
    }
    return best;
});

function distancesFor(limit: number) {
    const map = new Map<string, number>();
    if (!focusId.value) return map;
    for (let d = 1; d <= limit; d += 1) {
        for (const node of ringsAround(board.value, focusId.value, d).nodes) {
            if (!map.has(node.id)) map.set(node.id, d);
        }
    }
    return map;
}

const distances = computed(() => distancesFor(depthValue.value));

function toneOf(id: string): "hub" | "spec" | "plain" {
    if (SPEC_ID.test(id)) return "spec";
    return hubs.value.has(id) ? "hub" : "plain";
}

function labelOf(id: string): string {
    const todo = byId.value.get(id);
    if (!todo) return id;
    const base = todo.number ? `#${todo.number}` : id;
    if (hubs.value.has(id) && !SPEC_ID.test(id)) return `${base} · хаб · ${incoming.value.get(id) ?? 0} ↵`;
    return base;
}

function passes(id: string): boolean {
    if (specOnly.value && !SPEC_ID.test(id)) return false;
    if (onlyProject.value) return (byId.value.get(id)?.project ?? null) === onlyProject.value;
    if (collapseForeign.value && (byId.value.get(id)?.project ?? null) !== pivotProject.value)
        return false;
    return true;
}

function ranked() {
    const universe = adjacency.value.size
        ? [...new Set([...adjacency.value.keys(), ...board.value.map((t) => t.id)])]
        : board.value.map((t) => t.id);
    return universe
        .filter((id) => byId.value.has(id))
        .sort((a, b) => {
            const da = adjacency.value.get(a)?.size ?? 0;
            const db = adjacency.value.get(b)?.size ?? 0;
            return da === db ? a.localeCompare(b) : db - da;
        });
}

function freeRings() {
    const shown: { id: string; ring: number }[] = [];
    const hidden: { id: string; ring: number }[] = [];
    const cap = onlyProject.value ? PROJECT_CARDS : FREE_CARDS;
    for (const id of ranked()) {
        const degree = adjacency.value.get(id)?.size ?? 0;
        const ring = hubs.value.has(id) ? 1 : degree >= 3 ? 2 : 3;
        if (!passes(id) || shown.length >= cap) hidden.push({ id, ring });
        else shown.push({ id, ring });
    }
    return { shown, hidden, rings: 3 };
}

function focusedRings() {
    const shown: { id: string; ring: number }[] = [];
    const hidden: { id: string; ring: number }[] = [];
    for (const [id, d] of distances.value) {
        if (passes(id)) shown.push({ id, ring: d });
        else hidden.push({ id, ring: d });
    }
    return { shown, hidden, rings: depthValue.value };
}

const scene = computed(() => {
    const free = focusId.value === null;
    const source = free ? freeRings() : focusedRings();
    const base = free ? FREE_RADII : BASE_RADII;
    const ringOf = new Map(source.shown.map((n) => [n.id, n.ring]));

    const angles = new Map<string, number>();
    if (focusId.value) angles.set(focusId.value, 0);
    const nodes: PlacedNode[] = [];
    const radii: number[] = [];
    let prev = 0;

    for (let d = 1; d <= source.rings; d += 1) {
        const ids = source.shown.filter((n) => n.ring === d).map((n) => n.id);
        if (!ids.length) continue;
        const desired = new Map<string, number>();
        for (const id of ids) {
            let hit: number | undefined;
            for (const near of adjacency.value.get(id) ?? []) {
                const known = angles.get(near);
                if (known !== undefined && (ringOf.get(near) ?? 0) === d - 1) {
                    hit = known;
                    break;
                }
            }
            desired.set(id, hit ?? 0);
        }
        ids.sort((a, b) => {
            const da = desired.get(a) ?? 0;
            const db = desired.get(b) ?? 0;
            return da === db ? a.localeCompare(b) : da - db;
        });

        const step = 360 / ids.length;
        const radius = Math.max(
            base[d] ?? prev + RING_GAP,
            SLOT_ARC * ids.length,
            prev + RING_GAP,
        );
        let start = 0;
        if (d > 1) {
            let sx = 0;
            let sy = 0;
            ids.forEach((id, i) => {
                const a = (((desired.get(id) ?? 0) - i * step) * Math.PI) / 180;
                sx += Math.cos(a);
                sy += Math.sin(a);
            });
            start = (Math.atan2(sy, sx) * 180) / Math.PI;
        }

        ids.forEach((id, i) => {
            const angle = start + i * step;
            const r = radius - (i % 2 ? STAGGER : 0);
            const rad = (angle * Math.PI) / 180;
            angles.set(id, angle);
            nodes.push({
                id,
                label: labelOf(id),
                title: byId.value.get(id)?.subject ?? "",
                tone: toneOf(id),
                counter: SPEC_ID.test(id) ? `${incoming.value.get(id) ?? 0} ↵` : undefined,
                ring: d,
                x: cx.value + r * Math.cos(rad),
                y: cy.value + r * Math.sin(rad),
            });
        });

        radii.push(radius);
        prev = radius;
    }

    const clusters: PlacedCluster[] = [];
    const plaques: PlacedPlaque[] = [];
    const groups = new Map<string, string[]>();
    for (const n of source.hidden) {
        if (specOnly.value && !SPEC_ID.test(n.id)) continue;
        const key = byId.value.get(n.id)?.project ?? "без проекта";
        const bag = groups.get(key);
        if (bag) bag.push(n.id);
        else groups.set(key, [n.id]);
    }
    if (groups.size && !onlyProject.value && (free || collapseForeign.value)) {
        const last = radii[radii.length - 1] ?? base[1];
        const names = [...groups.keys()].sort();
        names.forEach((name, i) => {
            const angle = -40 + (i * 360) / names.length;
            const rad = (angle * Math.PI) / 180;
            const ids = groups.get(name) ?? [];
            if (!opened.value.includes(name)) {
                const outer = last + 180;
                clusters.push({
                    id: name,
                    title: name,
                    note: `ещё ${ids.length}`,
                    size: Math.min(140, 84 + ids.length * 4),
                    x: cx.value + outer * Math.cos(rad),
                    y: cy.value + outer * Math.sin(rad),
                });
                return;
            }
            const seen = ids.slice(0, SATELLITE_CARDS);
            const satellite = Math.max(160, SLOT_ARC * seen.length);
            const away = last + 190 + satellite;
            const ox = cx.value + away * Math.cos(rad);
            const oy = cy.value + away * Math.sin(rad);
            const step = 360 / seen.length;
            seen.forEach((id, j) => {
                const a = ((angle + 180 + j * step) * Math.PI) / 180;
                nodes.push({
                    id,
                    label: labelOf(id),
                    title: byId.value.get(id)?.subject ?? "",
                    tone: toneOf(id),
                    counter: SPEC_ID.test(id) ? `${incoming.value.get(id) ?? 0} ↵` : undefined,
                    ring: 2,
                    x: ox + satellite * Math.cos(a),
                    y: oy + satellite * Math.sin(a),
                });
            });
            plaques.push({
                id: name,
                title: name,
                note:
                    ids.length > seen.length
                        ? `${seen.length} из ${ids.length} узлов`
                        : `${ids.length} узлов`,
                x: ox,
                y: oy,
            });
        });
    }

    const alive = new Set(nodes.map((n) => n.id));
    if (focusId.value) alive.add(focusId.value);
    const raw = free
        ? edges.value.map((e) => ({ from: e.from, to: e.to }))
        : ringsAround(board.value, focusId.value ?? "", source.rings).links;
    const links = raw
        .filter((l) => alive.has(l.from) && alive.has(l.to))
        .map((l) => ({
            from: l.from,
            to: l.to,
            dashed: !free && l.from !== focusId.value && l.to !== focusId.value,
            tone:
                l.from === focusId.value
                    ? ("out" as const)
                    : l.to === focusId.value
                      ? ("in" as const)
                      : ("plain" as const),
        }));

    return {
        nodes,
        clusters,
        plaques,
        links,
        radii,
        offstage: source.hidden.length - (nodes.length - source.shown.length),
        free,
    };
});

const rows = computed(() =>
    focusId.value
        ? focusRows(board.value, focusId.value)
        : { outgoing: [], incoming: [] },
);

const deeper = computed(() => {
    if (!focusId.value || depthValue.value >= 4) return 0;
    return distancesFor(depthValue.value + 1).size - distances.value.size;
});

const onCanvas = computed(() => scene.value.nodes.length + (focusId.value ? 1 : 0));

const stats = computed(
    () =>
        `${board.value.length} узлов · ${onCanvas.value} ${focusId.value ? "в фокусе" : "на холсте"} · ${board.value.length - onCanvas.value} свёрнуто`,
);

const focusBadge = computed(
    () => `${rows.value.outgoing.length + rows.value.incoming.length} ссылок`,
);

const pick = computed(() => {
    const id = picked.value;
    const todo = id ? byId.value.get(id) : undefined;
    if (!id || !todo) return null;
    return {
        id,
        label: todo.number ? `#${todo.number}` : id,
        title: todo.subject,
        project: todo.project ?? "без проекта",
        status: STATUS_TEXT[todo.status] ?? todo.status,
        incoming: incoming.value.get(id) ?? 0,
        outgoing: outgoing.value.get(id) ?? 0,
    };
});

const legendItems = computed(() => [
    { text: "хаб — 5+ входящих ссылок", color: "var(--accent)" },
    { text: "сплошная со стрелкой — фокус ссылается", mark: "line" as const },
    { text: "серая со стрелкой — ссылаются на фокус", mark: "line" as const },
    { text: "пунктир — связи глубже фокуса", mark: "dash" as const },
]);

const bounds = computed(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    if (focusId.value || !scene.value.nodes.length) {
        xs.push(cx.value);
        ys.push(cy.value);
    }
    for (const n of scene.value.nodes) {
        xs.push(n.x);
        ys.push(n.y);
    }
    for (const c of scene.value.clusters) {
        xs.push(c.x);
        ys.push(c.y);
    }
    const x0 = Math.min(...xs) - MAP_PAD;
    const x1 = Math.max(...xs) + MAP_PAD;
    const y0 = Math.min(...ys) - MAP_PAD;
    const y1 = Math.max(...ys) + MAP_PAD;
    return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
});

const mapPoints = computed(() => {
    const b = bounds.value;
    const points = scene.value.nodes.map((n) => ({
        x: (n.x - b.x0) / b.w,
        y: (n.y - b.y0) / b.h,
    }));
    if (focusId.value)
        points.push({ x: (cx.value - b.x0) / b.w, y: (cy.value - b.y0) / b.h });
    return points;
});

function clamp(value: number, low: number, high: number) {
    return Math.min(high, Math.max(low, value));
}

const mapViewport = computed(() => {
    const b = bounds.value;
    const k = view.value.k;
    const x = clamp((-view.value.x / k - b.x0) / b.w, 0, 1);
    const y = clamp((-view.value.y / k - b.y0) / b.h, 0, 1);
    return {
        x,
        y,
        w: clamp(size.value.w / k / b.w, 0.04, 1 - x),
        h: clamp(size.value.h / k / b.h, 0.04, 1 - y),
    };
});

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

function pickLayout(value: string) {
    if (value === "bubbles") emit("mode", "bubbles");
}

function pickRelation(value: string) {
    relation.value = value;
    if (value === "deps") emit("mode", "lanes");
}

function selectNode(id: string) {
    if (dragged || !byId.value.has(id)) return;
    picked.value = id;
    if (!onlyProject.value) focusId.value = id;
}

function expandProject(name: string) {
    if (dragged || opened.value.includes(name)) return;
    opened.value = [...opened.value, name];
}

function collapseProject(name: string) {
    opened.value = opened.value.filter((n) => n !== name);
}

function showOnly(name: string) {
    onlyProject.value = name;
    focusId.value = null;
    picked.value = null;
    opened.value = [];
}

function showAll() {
    onlyProject.value = null;
    picked.value = null;
}

function toggleForeign() {
    collapseForeign.value = !collapseForeign.value;
    opened.value = [];
}

function setFocus(id: string) {
    if (!byId.value.has(id)) return;
    focusId.value = id;
}

function openNode(id: string) {
    emit("open", id);
}

function dropFocus() {
    focusId.value = null;
    picked.value = null;
}

function focusRow(label: string) {
    const id = idOfLabel.value.get(label);
    if (id) setFocus(id);
}

function expandDepth() {
    depth.value = depthValue.value >= 3 ? "all" : String(depthValue.value + 1);
}

function isBackground(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return !el.closest(
        ".rings-node, .rings-cluster, .rings-plaque, .rings-side, .rings-pick, .rings-map",
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

function onDouble(e: MouseEvent) {
    if (!isBackground(e.target)) return;
    view.value = { x: 0, y: 0, k: 1 };
}

function moveTo(e: MouseEvent) {
    const body = mapHost.value?.querySelector(".mini-map-body");
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const fx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const fy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    const b = bounds.value;
    const k = view.value.k;
    view.value.x = size.value.w / 2 - (b.x0 + fx * b.w) * k;
    view.value.y = size.value.h / 2 - (b.y0 + fy * b.h) * k;
}

function stopMapDrag() {
    window.removeEventListener("mousemove", moveTo);
    window.removeEventListener("mouseup", stopMapDrag);
}

function onMapDown(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    moveTo(e);
    window.addEventListener("mousemove", moveTo);
    window.addEventListener("mouseup", stopMapDrag);
}

watch([() => scene.value, () => size.value.w, () => size.value.h], fit, {
    immediate: true,
});

watch(
    [() => view.value.k, () => scene.value, () => size.value.w, () => size.value.h],
    async () => {
        await nextTick();
        wires.value?.remeasure();
    },
);
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
            model-value="rings"
            :options="[
                { id: 'bubbles', label: 'Пузыри разделов' },
                { id: 'rings', label: 'Кольца вокруг фокуса' },
            ]"
            @update:model-value="pickLayout"
        />
        <template v-if="onlyProject">
            <span class="rings-field">Проект</span>
            <StatusChip class="rings-focus" tone="spec" :title="onlyProject">
                <span class="rings-focus-id">{{ onlyProject }}</span>
                <span class="rings-focus-close" @click.stop="showAll">✕</span>
            </StatusChip>
            <ToolButton @click="showAll">Показать всё</ToolButton>
        </template>
        <template v-else>
            <span class="rings-field">Фокус</span>
            <StatusChip
                v-if="focusTodo"
                class="rings-focus"
                tone="spec"
                :title="`${focusNumber} · ${focusTodo.subject}`"
            >
                <span class="rings-focus-id">{{ focusNumber }}</span>
                <span class="rings-focus-sep">·</span>
                <span class="rings-focus-title">{{ focusTodo.subject }}</span>
                <span class="rings-focus-close" @click.stop="dropFocus">✕</span>
            </StatusChip>
            <StatusChip v-else text="фокус не выбран" />
        </template>
        <template v-if="focusTodo && !onlyProject">
            <span class="rings-field">Глубина</span>
            <SegControl
                v-model="depth"
                :options="[
                    { id: '1', label: '1' },
                    { id: '2', label: '2' },
                    { id: '3', label: '3' },
                    { id: 'all', label: 'всё' },
                ]"
            />
        </template>
        <ToolButton
            v-if="!onlyProject"
            :active="collapseForeign"
            @click="toggleForeign"
        >
            Свернуть чужие проекты
        </ToolButton>
        <ToolButton :active="specOnly" @click="specOnly = !specOnly">
            Только ссылки на спеки
        </ToolButton>
        <template #right>
            <span class="rings-stats">{{ stats }}</span>
        </template>
    </ToolBar>

    <LegendBar :items="legendItems">
        <template #right>
            <span class="rings-hints">
                ЛКМ — сделать фокусом · двойной ЛКМ — открыть в доске · колесо —
                масштаб · перетаскивание — панорама
            </span>
        </template>
    </LegendBar>

    <div class="pipe-canvas plain rings-canvas">
        <div
            ref="frame"
            class="rings-frame"
            :class="{ dragging }"
            @mousedown="onCanvasDown"
            @wheel="onWheel"
            @dblclick="onDouble"
        >
            <div v-if="board.length && !edges.length && focusId" class="rings-empty">
                <div class="rings-empty-title">Ссылок между задачами нет</div>
                <p class="rings-empty-text">
                    На доске {{ board.length }} задач, но ни одна не ссылается на
                    другую. Ссылка появляется, когда у задачи заполнено поле связей
                    или в её описании есть упоминание вида
                    <span class="pipe-mono">t#345</span>.
                </p>
            </div>

            <div
                ref="stage"
                class="rings-stage"
                :style="{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
                }"
            >
                <RingBackdrop :radii="scene.radii" :cx="cx" :cy="cy" />

                <div
                    class="rings-wire-host"
                    :style="{ transform: `scale(${1 / view.k})` }"
                >
                    <RadialWireLayer
                        ref="wires"
                        :container="stage"
                        :links="scene.links"
                    />
                </div>

                <div
                    v-for="cluster in scene.clusters"
                    :key="cluster.id"
                    class="rings-cluster"
                    :style="{ left: `${cluster.x}px`, top: `${cluster.y}px` }"
                >
                    <ClusterBubble
                        :title="cluster.title"
                        :note="cluster.note"
                        :size="cluster.size"
                        @click="expandProject(cluster.id)"
                    />
                </div>

                <div
                    v-for="plaque in scene.plaques"
                    :key="plaque.id"
                    class="rings-plaque"
                    :style="{ left: `${plaque.x}px`, top: `${plaque.y}px` }"
                >
                    <div class="rings-plaque-head">
                        <span class="rings-plaque-title">{{ plaque.title }}</span>
                        <span
                            class="rings-plaque-close"
                            @click.stop="collapseProject(plaque.id)"
                            >✕</span
                        >
                    </div>
                    <span class="rings-plaque-note">{{ plaque.note }}</span>
                    <button
                        type="button"
                        class="rings-plaque-action"
                        @click.stop="showOnly(plaque.id)"
                    >
                        Показать только этот проект
                    </button>
                </div>

                <div
                    v-if="focusTodo"
                    class="rings-node"
                    :style="{ left: `${cx}px`, top: `${cy}px` }"
                    @click="selectNode(focusTodo.id)"
                    @dblclick.stop="openNode(focusTodo.id)"
                >
                    <RingCard
                        :data-node="focusTodo.id"
                        tone="focus"
                        :label="
                            focusTodo.change
                                ? `тема · change ${focusNumber}`
                                : focusNumber
                        "
                        :title="focusTodo.subject"
                        :badge="focusBadge"
                    />
                </div>

                <div
                    v-for="node in scene.nodes"
                    :key="node.id"
                    class="rings-node"
                    :style="{ left: `${node.x}px`, top: `${node.y}px` }"
                    @click="selectNode(node.id)"
                    @dblclick.stop="openNode(node.id)"
                >
                    <RingCard
                        :data-node="node.id"
                        :class="{ 'rings-marked': picked === node.id }"
                        :label="node.label"
                        :title="node.title"
                        :tone="node.tone"
                        :dim="node.ring >= 2"
                        :counter="node.counter"
                    />
                </div>
            </div>

            <div class="rings-side">
                <SidePanel
                    :title="
                        focusTodo ? `Связи фокуса · ${focusNumber}` : 'Связи фокуса'
                    "
                >
                    <template v-if="focusTodo">
                        <div class="rings-group">
                            <Kicker>Фокус ссылается · {{ rows.outgoing.length }}</Kicker>
                        </div>
                        <FocusRowItem
                            v-for="row in rows.outgoing"
                            :key="`o-${row.id}`"
                            :id="row.id"
                            :title="row.title"
                            :count="row.count"
                            :kind="SPEC_ID.test(row.id) ? 'spec' : 'task'"
                            @click="focusRow(row.id)"
                        />
                        <div class="rings-group">
                            <Kicker>Ссылаются на фокус · {{ rows.incoming.length }}</Kicker>
                        </div>
                        <FocusRowItem
                            v-for="row in rows.incoming"
                            :key="`i-${row.id}`"
                            :id="row.id"
                            :title="row.title"
                            :count="row.count"
                            :kind="SPEC_ID.test(row.id) ? 'spec' : 'task'"
                            @click="focusRow(row.id)"
                        />
                        <div v-if="deeper > 0" class="rings-more">
                            <span>+ {{ deeper }} на глубине {{ depthValue + 1 }}</span>
                            <button
                                type="button"
                                class="rings-more-action"
                                @click="expandDepth"
                            >
                                развернуть
                            </button>
                        </div>
                    </template>
                    <div v-else-if="onlyProject" class="rings-empty">
                        На холсте только проект {{ onlyProject }}. ЛКМ по узлу
                        открывает карточку, «Показать всё» возвращает весь граф.
                    </div>
                    <div v-else class="rings-empty">
                        Фокус снят — на холсте весь граф ссылок. ЛКМ по узлу снова
                        задаёт фокус, ЛКМ по пузырю разворачивает проект.
                        <span v-if="scene.offstage" class="rings-empty-more">
                            ещё {{ scene.offstage }} узлов свёрнуто в пузыри проектов
                        </span>
                    </div>
                    <template v-if="focusTodo" #footer>
                        <ToolButton
                            class="rings-open"
                            @click="openNode(focusTodo!.id)"
                        >
                            Открыть {{ focusNumber }} в доске
                        </ToolButton>
                    </template>
                </SidePanel>
            </div>

            <div v-if="pick" class="rings-pick">
                <SidePanel title="Узел">
                    <div class="rings-pick-head">
                        <span class="rings-pick-id">{{ pick.label }}</span>
                        <span class="rings-pick-title">{{ pick.title }}</span>
                    </div>
                    <div class="rings-pick-row">
                        <span>проект</span>
                        <span class="rings-pick-value">{{ pick.project }}</span>
                    </div>
                    <div class="rings-pick-row">
                        <span>статус</span>
                        <span class="rings-pick-value">{{ pick.status }}</span>
                    </div>
                    <div class="rings-pick-row">
                        <span>ссылаются на него</span>
                        <span class="rings-pick-value">{{ pick.incoming }}</span>
                    </div>
                    <div class="rings-pick-row">
                        <span>он ссылается</span>
                        <span class="rings-pick-value">{{ pick.outgoing }}</span>
                    </div>
                    <template #footer>
                        <div class="rings-pick-actions">
                            <ToolButton
                                :active="focusId === pick.id"
                                @click="setFocus(pick.id)"
                            >
                                Сделать фокусом
                            </ToolButton>
                            <ToolButton
                                v-if="pick.project !== onlyProject"
                                @click="showOnly(pick.project)"
                            >
                                Показать только этот проект
                            </ToolButton>
                            <ToolButton v-else @click="showAll">
                                Показать всё
                            </ToolButton>
                            <ToolButton variant="pri" @click="openNode(pick.id)">
                                Открыть в доске
                            </ToolButton>
                        </div>
                    </template>
                </SidePanel>
            </div>

            <div ref="mapHost" class="rings-map" @mousedown="onMapDown">
                <MiniMap
                    title="Весь граф"
                    :count="String(board.length)"
                    :points="mapPoints"
                    :viewport="mapViewport"
                />
            </div>
        </div>
    </div>
</template>

<style scoped>
.rings-field {
    margin-left: 6px;
    font-size: 11px;
    color: var(--text-4);
}
.rings-focus {
    min-width: 0;
    max-width: min(340px, 34vw);
    gap: 6px;
}
.rings-focus-id {
    flex: none;
    font-family: var(--mono);
}
.rings-focus-sep {
    flex: none;
    opacity: 0.6;
}
.rings-focus-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.rings-focus-close {
    flex: none;
    margin-left: 2px;
    font-size: 11px;
    opacity: 0.75;
    cursor: pointer;
}
.rings-focus-close:hover {
    opacity: 1;
}
.rings-stats {
    height: 30px;
    display: inline-flex;
    align-items: center;
    padding: 0 11px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    font-size: 11.5px;
    color: var(--text-4);
}
.rings-hints {
    font-size: 11px;
    color: var(--text-4);
}

.rings-canvas {
    overflow: hidden;
}
.rings-frame {
    position: absolute;
    inset: 0;
    overflow: hidden;
    cursor: grab;
}
.rings-frame.dragging {
    cursor: grabbing;
}
.rings-empty {
    position: absolute;
    left: 50%;
    top: 40%;
    transform: translate(-50%, -50%);
    width: 420px;
    padding: 18px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.96);
    text-align: center;
}
.rings-empty-title {
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
}
.rings-empty-text {
    margin: 0;
    font-size: 11.8px;
    line-height: 1.5;
    color: var(--text-3);
}
.rings-stage {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
}
.rings-wire-host {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    transform-origin: 0 0;
}
.rings-node {
    position: absolute;
    z-index: 1;
    transform: translate(-50%, -50%);
}
.rings-node .rings-marked {
    box-shadow: 0 0 0 2px var(--accent);
}
.rings-cluster {
    position: absolute;
    z-index: 1;
    transform: translate(-50%, -50%);
}
.rings-plaque {
    position: absolute;
    z-index: 2;
    width: 190px;
    padding: 9px 10px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(26, 26, 26, 0.96);
    transform: translate(-50%, -50%);
}
.rings-plaque-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
}
.rings-plaque-title {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
}
.rings-plaque-close {
    font-size: 11px;
    color: var(--text-4);
    cursor: pointer;
}
.rings-plaque-close:hover {
    color: var(--text-2);
}
.rings-plaque-note {
    display: block;
    margin-top: 3px;
    font-size: 11px;
    color: var(--text-4);
}
.rings-plaque-action {
    margin-top: 7px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
}
.rings-side {
    position: absolute;
    left: 24px;
    top: 50%;
    z-index: 3;
    transform: translateY(-50%);
}
.rings-pick {
    position: absolute;
    right: 18px;
    top: 18px;
    z-index: 3;
}
.rings-map {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 3;
    cursor: crosshair;
}
.rings-group {
    margin: 10px 0 4px;
}
.rings-group:first-child {
    margin-top: 0;
}
.rings-more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 8px;
    padding: 0 6px;
    font-size: 11.5px;
    color: var(--text-4);
}
.rings-more-action {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
}
.rings-empty {
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--text-4);
}
.rings-empty-more {
    display: block;
    margin-top: 8px;
    color: var(--text-3);
}
.rings-open {
    width: 100%;
    justify-content: center;
}
.rings-pick-head {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--stroke);
}
.rings-pick-id {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
}
.rings-pick-title {
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--text);
}
.rings-pick-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--text-4);
}
.rings-pick-value {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-2);
    text-align: right;
}
.rings-pick-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.rings-pick-actions .tool-button {
    width: 100%;
    justify-content: center;
}
</style>
