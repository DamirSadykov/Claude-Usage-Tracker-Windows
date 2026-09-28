<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";

interface WireLink {
    from: string;
    to: string;
    tone?: string;
    dashed?: boolean;
    [key: string]: unknown;
}

interface Segment {
    key: string;
    d: string;
    mid: { x: number; y: number };
    link: WireLink;
    tone: string;
    dashed: boolean;
}

const props = withDefaults(
    defineProps<{
        container: HTMLElement | null;
        links: readonly WireLink[];
        attr?: string;
        markers?: boolean;
    }>(),
    { attr: "data-node", markers: true },
);

const size = ref({ w: 0, h: 0 });
const segments = ref<Segment[]>([]);
const uid = Math.random().toString(36).slice(2, 8);

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let io: IntersectionObserver | null = null;
let frame = 0;
const elements = new Map<string, HTMLElement>();
const visible = new Set<string>();

function scrollViewport(host: HTMLElement) {
    return host.closest<HTMLElement>(".lane-body") ?? host;
}

function observeVisible(host: HTMLElement) {
    io?.disconnect();
    visible.clear();
    io = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const id = (entry.target as HTMLElement).getAttribute(props.attr);
                if (!id) continue;
                if (entry.isIntersecting) visible.add(id);
                else visible.delete(id);
            }
            schedule();
        },
        { root: scrollViewport(host) },
    );
}

function refreshElements(host: HTMLElement) {
    elements.clear();
    visible.clear();
    io?.disconnect();
    host.querySelectorAll<HTMLElement>(`[${props.attr}]`).forEach((el) => {
        const id = el.getAttribute(props.attr);
        if (!id) return;
        elements.set(id, el);
        io?.observe(el);
    });
}

function rectOf(el: HTMLElement, host: HTMLElement) {
    const r = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return {
        x: r.left - h.left + host.scrollLeft,
        y: r.top - h.top + host.scrollTop,
        w: r.width,
        h: r.height,
    };
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
        if (!visible.has(link.from) || !visible.has(link.to)) continue;
        const a = elements.get(link.from);
        const b = elements.get(link.to);
        if (!a || !b) continue;
        const ra = rectOf(a, host);
        const rb = rectOf(b, host);
        const x1 = ra.x + ra.w;
        const y1 = ra.y + ra.h / 2;
        const x2 = rb.x - 7;
        const y2 = rb.y + rb.h / 2;
        const dx = Math.max(26, (x2 - x1) * 0.45);
        const c1x = x1 + dx;
        const c2x = x2 - dx;
        out.push({
            key: `${link.from}->${link.to}`,
            d: `M${x1} ${y1} C${c1x} ${y1} ${c2x} ${y2} ${x2} ${y2}`,
            mid: {
                x: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
                y: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
            },
            link,
            tone: String(link.tone ?? "dep"),
            dashed: Boolean(link.dashed),
        });
    }
    segments.value = out;
    if (ro) {
        ro.disconnect();
        ro.observe(host);
        elements.forEach((el) => ro!.observe(el));
    }
}

function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
}

onMounted(async () => {
    ro = new ResizeObserver(schedule);
    if (props.container) observeVisible(props.container);
    mo = new MutationObserver(() => {
        if (props.container) refreshElements(props.container);
        schedule();
    });
    await nextTick();
    if (props.container) {
        refreshElements(props.container);
        mo.observe(props.container, { childList: true, subtree: true });
        scrollViewport(props.container).addEventListener("scroll", schedule, { passive: true });
    }
    window.addEventListener("resize", schedule);
    schedule();
    if (document.fonts?.ready) document.fonts.ready.then(schedule);
});

onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    ro?.disconnect();
    mo?.disconnect();
    io?.disconnect();
    window.removeEventListener("resize", schedule);
    if (props.container) scrollViewport(props.container).removeEventListener("scroll", schedule);
});

watch(() => props.links, schedule, { deep: true });
watch(
    () => props.container,
    async (host, previousHost) => {
        await nextTick();
        if (previousHost) scrollViewport(previousHost).removeEventListener("scroll", schedule);
        if (host && mo) {
            mo.disconnect();
            mo.observe(host, { childList: true, subtree: true });
            observeVisible(host);
            refreshElements(host);
            scrollViewport(host).addEventListener("scroll", schedule, { passive: true });
        }
        schedule();
    },
);

watch(
    () => props.container?.childElementCount,
    () => { if (props.container) refreshElements(props.container); },
);

defineExpose({ remeasure: schedule });
</script>

<template>
    <svg
        class="wire-layer"
        :width="size.w"
        :height="size.h"
        :viewBox="`0 0 ${size.w} ${size.h}`"
        preserveAspectRatio="none"
    >
        <defs>
            <marker
                v-if="markers"
                :id="`wire-arrow-${uid}`"
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
            >
                <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
            </marker>
        </defs>
        <path
            v-for="s in segments"
            :key="s.key"
            class="wire"
            :class="[`tone-${s.tone}`, { dashed: s.dashed }]"
            :d="s.d"
            :marker-end="markers ? `url(#wire-arrow-${uid})` : undefined"
        />
    </svg>
    <slot :segments="segments" />
</template>

<style scoped>
.wire-layer {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 0;
}
.wire {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    color: rgba(255, 255, 255, 0.22);
}
.wire.dashed {
    stroke-dasharray: 3 4;
}
.wire.tone-spec {
    color: rgba(76, 194, 255, 0.45);
}
.wire.tone-file {
    color: rgba(108, 203, 95, 0.4);
}
.wire.tone-run {
    color: rgba(217, 119, 87, 0.45);
}
.wire.tone-after {
    color: rgba(255, 255, 255, 0.16);
}
</style>
