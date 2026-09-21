<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";

type WireTone = "out" | "in" | "plain";

interface RadialLink {
    from: string;
    to: string;
    dashed?: boolean;
    tone?: WireTone;
}

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface Segment {
    key: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    dashed: boolean;
    tone: WireTone;
}

const uid = Math.random().toString(36).slice(2, 8);

const props = withDefaults(
    defineProps<{
        container: HTMLElement | null;
        links: RadialLink[];
        attr?: string;
    }>(),
    { attr: "data-node" },
);

const size = ref({ w: 0, h: 0 });
const segments = ref<Segment[]>([]);

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let frame = 0;

function rectOf(el: HTMLElement, host: HTMLElement): Rect {
    const r = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return {
        x: r.left - h.left + host.scrollLeft,
        y: r.top - h.top + host.scrollTop,
        w: r.width,
        h: r.height,
    };
}

function edgePoint(r: Rect, tx: number, ty: number) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 0.01 && ay < 0.01) return { x: cx, y: cy };
    const hw = r.w / 2 + 3;
    const hh = r.h / 2 + 3;
    const tx1 = ax > 0.01 ? hw / ax : Number.POSITIVE_INFINITY;
    const ty1 = ay > 0.01 ? hh / ay : Number.POSITIVE_INFINITY;
    const t = Math.min(tx1, ty1);
    return { x: cx + dx * t, y: cy + dy * t };
}

function measure() {
    const host = props.container;
    if (!host) return;
    size.value = {
        w: Math.max(host.scrollWidth, host.clientWidth),
        h: Math.max(host.scrollHeight, host.clientHeight),
    };
    const out: Segment[] = [];
    for (const link of props.links) {
        const a = host.querySelector<HTMLElement>(
            `[${props.attr}="${CSS.escape(link.from)}"]`,
        );
        const b = host.querySelector<HTMLElement>(
            `[${props.attr}="${CSS.escape(link.to)}"]`,
        );
        if (!a || !b) continue;
        const ra = rectOf(a, host);
        const rb = rectOf(b, host);
        const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
        const cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
        const p1 = edgePoint(ra, cb.x, cb.y);
        const p2 = edgePoint(rb, ca.x, ca.y);
        const dot =
            (p2.x - p1.x) * (cb.x - ca.x) + (p2.y - p1.y) * (cb.y - ca.y);
        if (dot <= 0) continue;
        out.push({
            key: `${link.from}->${link.to}`,
            x1: p1.x,
            y1: p1.y,
            x2: p2.x,
            y2: p2.y,
            dashed: Boolean(link.dashed),
            tone: link.tone ?? "plain",
        });
    }
    segments.value = out;
    if (ro) {
        ro.disconnect();
        ro.observe(host);
        host
            .querySelectorAll<HTMLElement>(`[${props.attr}]`)
            .forEach((el) => ro!.observe(el));
    }
}

function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
}

onMounted(async () => {
    ro = new ResizeObserver(schedule);
    mo = new MutationObserver(schedule);
    await nextTick();
    if (props.container) {
        mo.observe(props.container, { childList: true, subtree: true });
        props.container.addEventListener("scroll", schedule, { passive: true });
    }
    window.addEventListener("resize", schedule);
    schedule();
    if (document.fonts?.ready) document.fonts.ready.then(schedule);
});

onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    ro?.disconnect();
    mo?.disconnect();
    window.removeEventListener("resize", schedule);
    props.container?.removeEventListener("scroll", schedule);
});

watch(() => props.links, schedule, { deep: true });
watch(
    () => props.container,
    async (host) => {
        await nextTick();
        if (host && mo) {
            mo.disconnect();
            mo.observe(host, { childList: true, subtree: true });
        }
        schedule();
    },
);

defineExpose({ remeasure: schedule });
</script>

<template>
    <svg
        class="radial-wire-layer"
        :width="size.w"
        :height="size.h"
        :viewBox="`0 0 ${size.w} ${size.h}`"
        preserveAspectRatio="none"
    >
        <defs>
            <marker
                v-for="tone in ['out', 'in', 'plain']"
                :id="`wire-head-${tone}-${uid}`"
                :key="tone"
                viewBox="0 0 9 8"
                refX="8"
                refY="4"
                markerWidth="9"
                markerHeight="8"
                markerUnits="userSpaceOnUse"
                orient="auto"
            >
                <path class="radial-head" :class="`tone-${tone}`" d="M0 0 L9 4 L0 8 Z" />
            </marker>
        </defs>
        <line
            v-for="s in segments"
            :key="s.key"
            class="radial-wire"
            :class="[`tone-${s.tone}`, { dashed: s.dashed }]"
            :x1="s.x1"
            :y1="s.y1"
            :x2="s.x2"
            :y2="s.y2"
            :marker-end="`url(#wire-head-${s.tone}-${uid})`"
        />
    </svg>
</template>

<style scoped>
.radial-wire-layer {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 0;
}
.radial-wire {
    fill: none;
    stroke: rgba(255, 255, 255, 0.18);
    stroke-width: 1.2;
}
.radial-wire.dashed {
    stroke-dasharray: 3 5;
}
.radial-wire.tone-out {
    stroke: var(--accent);
    stroke-width: 1.5;
}
.radial-wire.tone-in {
    stroke: rgba(255, 255, 255, 0.34);
}
.radial-head {
    stroke: none;
}
.radial-head.tone-out {
    fill: var(--accent);
}
.radial-head.tone-in {
    fill: rgba(255, 255, 255, 0.34);
}
.radial-head.tone-plain {
    fill: rgba(255, 255, 255, 0.18);
}
</style>
