/** Shared, deterministic find navigation for the scroll-based pipeline views. */
export interface GraphSearchNode {
    id: string;
    title: string;
}

function numberOf(id: string) {
    const value = Number(id.replace(/^#/, ""));
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** IDs matching a task number or its visible title, in stable graph order. */
export function graphHits(nodes: readonly GraphSearchNode[], query: string): string[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const numeric = needle.replace(/^#/, "");
    const isNumber = /^\d+$/.test(numeric);
    return nodes
        .filter((node) =>
            node.title.toLocaleLowerCase().includes(needle) ||
            node.id.toLocaleLowerCase().includes(needle) ||
            (isNumber && node.id.replace(/^#/, "").includes(numeric)),
        )
        .map((node) => node.id)
        .sort((left, right) => numberOf(left) - numberOf(right) || left.localeCompare(right));
}

/** Return the next (or previous) hit, wrapping at either end. */
export function stepGraphHit(
    hits: readonly string[],
    activeHit: string | null | undefined,
    direction: 1 | -1 = 1,
): string | null {
    if (!hits.length) return null;
    const current = activeHit ? hits.indexOf(activeHit) : -1;
    const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
    return hits[(start + direction + hits.length) % hits.length] ?? null;
}
