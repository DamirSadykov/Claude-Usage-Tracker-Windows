import type { RunGraphNode } from "../../board/graphModel";
import {
    laneIndex,
    normalizeShares,
    toLanes,
    toProjectBands,
    toTaskLinks,
    toTaskNodes,
    wavesOf,
    type BoardChange,
    type BoardTodo,
    type TaskCostRow,
} from "./adapt";
import type { Lane, ProjectBand, TaskLink, TaskNode } from "./types";

export interface LaneProjection {
    revision: number;
    lanes: readonly Lane[];
    tasks: readonly TaskNode[];
    links: readonly TaskLink[];
    projects: readonly ProjectBand[];
    byId: ReadonlyMap<string, TaskNode>;
    tasksByLane: ReadonlyMap<string, readonly TaskNode[]>;
    tasksByLaneWave: ReadonlyMap<string, ReadonlyMap<number, readonly TaskNode[]>>;
    wavesByLane: ReadonlyMap<string, readonly number[]>;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
    readonly [Symbol.toStringTag] = "ImmutableMap";
    readonly #values: Map<K, V>;
    constructor(entries: Iterable<readonly [K, V]>) {
        this.#values = new Map(entries);
        Object.freeze(this);
    }
    get size() { return this.#values.size; }
    get(key: K) { return this.#values.get(key); }
    has(key: K) { return this.#values.has(key); }
    entries() { return this.#values.entries(); }
    keys() { return this.#values.keys(); }
    values() { return this.#values.values(); }
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
        this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
    }
    [Symbol.iterator]() { return this.entries(); }
}

function immutable<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
    const copy = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, immutable(item)]),
    );
    return Object.freeze(copy) as T;
}

function immutableArray<T>(items: readonly T[]): readonly T[] {
    return Object.freeze([...items]);
}

export function visibleGraph(
    revision: number,
    board: readonly BoardTodo[],
    changes: readonly BoardChange[] = [],
    run: ReadonlyMap<string, RunGraphNode> = new Map(),
    costs: readonly TaskCostRow[] = [],
    withPorts = false,
): LaneProjection {
    const rows = board as BoardTodo[];
    const index = laneIndex(rows, changes as BoardChange[]);
    const edges = rows.flatMap((task) =>
        (task.depends_on ?? []).map((from) => ({ from, to: task.id })),
    );
    const waves = wavesOf(rows.map((task) => task.id), edges);
    const tasks = immutable(normalizeShares(toTaskNodes(rows, run as Map<string, RunGraphNode>, index, waves, withPorts)));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const mutableByLane = new Map<string, TaskNode[]>();
    const mutableByLaneWave = new Map<string, Map<number, TaskNode[]>>();
    for (const task of tasks) {
        const laneTasks = mutableByLane.get(task.lane) ?? [];
        laneTasks.push(task);
        mutableByLane.set(task.lane, laneTasks);
        const waveMap = mutableByLaneWave.get(task.lane) ?? new Map<number, TaskNode[]>();
        const waveTasks = waveMap.get(task.wave) ?? [];
        waveTasks.push(task);
        waveMap.set(task.wave, waveTasks);
        mutableByLaneWave.set(task.lane, waveMap);
    }
    const tasksByLane = new ImmutableMap(
        [...mutableByLane].map(([lane, items]) => [lane, immutableArray(items)] as const),
    );
    const tasksByLaneWaveEntries: [string, ReadonlyMap<number, readonly TaskNode[]>][] = [];
    const wavesByLaneEntries: [string, readonly number[]][] = [];
    for (const [lane, byWave] of mutableByLaneWave) {
        tasksByLaneWaveEntries.push([lane, new ImmutableMap(
            [...byWave].map(([wave, items]) => [wave, immutableArray(items)] as const),
        )]);
        wavesByLaneEntries.push([lane, immutable([...byWave.keys()].sort((a, b) => a - b))]);
    }
    return Object.freeze({
        revision,
        lanes: immutable(toLanes(rows, run as Map<string, RunGraphNode>, index, waves)),
        tasks,
        links: immutable(toTaskLinks(rows, index)),
        projects: immutable(toProjectBands(rows, costs as TaskCostRow[], index)),
        byId: new ImmutableMap(byId),
        tasksByLane,
        tasksByLaneWave: new ImmutableMap(tasksByLaneWaveEntries),
        wavesByLane: new ImmutableMap(wavesByLaneEntries),
    });
}
