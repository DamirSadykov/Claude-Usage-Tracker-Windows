import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadRunLayer } from "../../graphModel";
import type { RunGraphNode } from "../../graphModel";
import {
    laneIndex,
    normalizeShares,
    toLanes,
    toProjectBands,
    toTaskLinks,
    toTaskNodes,
    wavesOf,
    type BoardTodo,
    type TaskCostRow,
} from "./adapt";
import {
    lanes as mockLanes,
    links as mockLinks,
    projects as mockProjects,
    tasks as mockTasks,
} from "./mock";

export function useBoard(withPorts = false) {
    const board = ref<BoardTodo[]>([]);
    const costs = ref<TaskCostRow[]>([]);
    const run = ref<Map<string, RunGraphNode>>(new Map());
    const live = ref(false);
    const error = ref("");

    async function load() {
        try {
            board.value = await invoke<BoardTodo[]>("get_todos");
            live.value = true;
        } catch (e) {
            error.value = String(e);
            live.value = false;
            return;
        }
        try {
            const payload = await invoke<{ tasks: TaskCostRow[] } | null>(
                "get_task_costs",
            );
            costs.value = payload?.tasks ?? [];
        } catch {
            costs.value = [];
        }
        try {
            const changes = board.value
                .filter((t) => t.change === true && t.number)
                .map((t) => `#${t.number}`);
            run.value = await loadRunLayer(changes);
        } catch {
            run.value = new Map();
        }
    }

    const index = computed(() => laneIndex(board.value));

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

    onMounted(load);

    return {
        live,
        error,
        board,
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
