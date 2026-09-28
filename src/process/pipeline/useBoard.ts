import { ref, computed, onMounted } from "vue";
import { loadRunLayer } from "../../board/graphModel";
import type { RunGraphNode } from "../../board/graphModel";
import { boardStore } from "../../board/boardStore";
import {
    laneIndex,
    normalizeShares,
    toLanes,
    toProjectBands,
    toTaskLinks,
    toTaskNodes,
    wavesOf,
    type BoardTodo,
    type BoardChange,
    type TaskCostRow,
} from "./adapt";
import {
    lanes as mockLanes,
    links as mockLinks,
    projects as mockProjects,
    tasks as mockTasks,
} from "./mock";

export function useBoard(withPorts = false, metricChanges: string[] = []) {
    // These are the shared compact board rows. A pipeline view must not parse its
    // own full board (or eagerly measure every change) just because it mounted.
    const board = computed(() => boardStore.rows.value as unknown as BoardTodo[]);
    const changes = computed(() => boardStore.changes.value as BoardChange[]);
    const costs = ref<TaskCostRow[]>([]);
    const run = ref<Map<string, RunGraphNode>>(new Map());
    const live = ref(false);
    const error = ref("");

    async function load() {
        await boardStore.start();
        live.value = boardStore.error.value === "";
        error.value = boardStore.error.value;
        // Graph metrics are deliberately opt-in: callers pass only changes that
        // are actually visible or expanded in their viewport.
        try {
            run.value = await loadRunLayer(metricChanges);
        } catch {
            run.value = new Map();
        }
    }

    const index = computed(() => laneIndex(board.value, changes.value));

    const edges = computed(() =>
        board.value.flatMap((t) =>
            (t.depends_on ?? []).map((dep) => ({ from: dep, to: t.id })),
        ),
    );

    const waves = computed(() =>
        wavesOf(
            board.value.map((t) => t.id),
            edges.value,
        ),
    );

    const lanes = computed(() =>
        live.value
            ? toLanes(board.value, run.value, index.value, waves.value)
            : mockLanes,
    );

    const tasks = computed(() =>
        live.value
            ? normalizeShares(
                  toTaskNodes(
                      board.value,
                      run.value,
                      index.value,
                      waves.value,
                      withPorts,
                  ),
              )
            : mockTasks,
    );

    const links = computed(() =>
        live.value ? toTaskLinks(board.value, index.value) : mockLinks,
    );

    const projects = computed(() =>
        live.value
            ? toProjectBands(board.value, costs.value, index.value)
            : mockProjects,
    );

    const nodeByLabel = computed(() => {
        const out = new Map<string, RunGraphNode>();
        for (const todo of board.value) {
            const node = run.value.get(todo.id);
            if (node && todo.number) out.set(`#${todo.number}`, node);
        }
        return out;
    });

    onMounted(() => void load());

    return {
        live,
        error,
        board,
        changes,
        run,
        index,
        nodeByLabel,
        lanes,
        tasks,
        links,
        projects,
        reload: load,
    };
}
