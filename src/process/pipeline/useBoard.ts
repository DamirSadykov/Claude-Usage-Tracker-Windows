import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadRunLayer } from "../../board/graphModel";
import type { RunGraphNode } from "../../board/graphModel";
import { boardStore } from "../../board/boardStore";
import {
    type BoardTodo,
    type BoardChange,
    type TaskCostRow,
} from "./adapt";
import { visibleGraph } from "./visibleGraph";
import {
    lanes as mockLanes,
    links as mockLinks,
    projects as mockProjects,
    tasks as mockTasks,
} from "./mock";

export function useBoard(withPorts = false, metricChanges: string[] = []) {
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
        void loadCosts();
        const refs = metricChanges.length ? { open: metricChanges, closed: [] } : changeRefs();
        try {
            run.value = await loadRunLayer(refs.open);
        } catch {
            run.value = new Map();
        }
        if (!refs.closed.length) return;
        try {
            const closed = await loadRunLayer(refs.closed);
            run.value = new Map([...closed, ...run.value]);
        } catch {
        }
    }

    async function loadCosts() {
        try {
            const payload = await invoke<{ tasks: TaskCostRow[] } | null>("get_task_costs");
            costs.value = payload?.tasks ?? [];
        } catch {
            costs.value = [];
        }
    }

    function changeRefs() {
        const open: string[] = [];
        const closed: string[] = [];
        const openChanges = new Set(
            board.value.filter((t) => t.status !== "done" && t.change_id).map((t) => t.change_id as string),
        );
        for (const c of changes.value) (openChanges.has(c.id) ? open : closed).push(`c#${c.number}`);
        for (const t of board.value) {
            if (t.change !== true || !t.number) continue;
            (t.status !== "done" ? open : closed).push(`#${t.number}`);
        }
        return { open, closed };
    }

    const projection = computed(() =>
        visibleGraph(boardStore.revision.value, board.value, changes.value, run.value, costs.value, withPorts),
    );

    const lanes = computed(() =>
        live.value
            ? projection.value.lanes
            : mockLanes,
    );

    const tasks = computed(() =>
        live.value
            ? [...projection.value.tasks]
            : mockTasks,
    );

    const links = computed(() =>
        live.value ? [...projection.value.links] : mockLinks,
    );

    const projects = computed(() =>
        live.value
            ? projection.value.projects
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
        projection,
        nodeByLabel,
        lanes,
        tasks,
        links,
        projects,
        reload: load,
    };
}
