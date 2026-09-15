import { ref, computed, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadRunGraph, type RunGraph } from "../../graphModel";
import {
    blockersFor,
    changeAddress,
    changeIsOpen,
    changeMembers,
    changeProgress,
    costFor,
    historyFor,
    passedFor,
    sortedByRecency,
    specEditsCount,
    specSummaryFor,
    waitingFor,
    type ChangeRecord,
    type ChangeTask,
} from "./changeAdapt";
import { mockChange, mockTasks, mockNodes } from "./changeMock";

const EMPTY_GRAPH: RunGraph = { nodes: [], edges: [], groups: [], mermaid: "" };

const selected = ref("");

export function selectChange(address: string) {
    selected.value = address;
}

export function useChange() {
    const board = ref<ChangeTask[]>([]);
    const changesRaw = ref<ChangeRecord[]>([]);
    const live = ref(false);
    const error = ref("");
    const graph = ref<RunGraph>(EMPTY_GRAPH);
    const graphLoading = ref(false);
    const closing = ref(false);
    const closeError = ref("");

    const changes = computed(() =>
        live.value ? sortedByRecency(changesRaw.value) : sortedByRecency([mockChange]),
    );
    const effectiveBoard = computed(() => (live.value ? board.value : mockTasks));

    function pickDefault() {
        if (selected.value) return;
        const open = changes.value.find((c) => changeIsOpen(changeMembers(effectiveBoard.value, c)));
        const pick = open ?? changes.value[0];
        if (pick) selected.value = changeAddress(pick);
    }

    async function load() {
        try {
            board.value = await invoke<ChangeTask[]>("get_todos");
            live.value = true;
        } catch (e) {
            error.value = String(e);
            live.value = false;
            board.value = [];
        }
        if (live.value) {
            try {
                changesRaw.value = await invoke<ChangeRecord[]>("get_changes");
            } catch {
                changesRaw.value = [];
            }
        }
        pickDefault();
    }

    async function loadGraph() {
        if (!live.value) {
            graph.value = { nodes: mockNodes, edges: [], groups: [], mermaid: "" };
            return;
        }
        if (!selected.value) {
            graph.value = EMPTY_GRAPH;
            return;
        }
        graphLoading.value = true;
        graph.value = await loadRunGraph(selected.value);
        graphLoading.value = false;
    }

    watch(selected, loadGraph);
    onMounted(async () => {
        await load();
        await loadGraph();
    });

    const current = computed(
        () => changes.value.find((c) => changeAddress(c) === selected.value) ?? null,
    );
    const members = computed(() =>
        current.value ? changeMembers(effectiveBoard.value, current.value) : [],
    );
    const progress = computed(() => changeProgress(members.value));
    const open = computed(() => changeIsOpen(members.value));

    const blockers = computed(() =>
        current.value ? blockersFor(current.value, members.value, changes.value, effectiveBoard.value) : [],
    );
    const waiting = computed(() => waitingFor(members.value));
    const cost = computed(() => costFor(members.value, graph.value.nodes));
    const passed = computed(() =>
        current.value ? passedFor(current.value, members.value, blockers.value, graph.value.nodes) : [],
    );
    const history = computed(() => (current.value ? historyFor(current.value, members.value) : []));
    const specSummary = computed(() =>
        current.value
            ? specSummaryFor(current.value, members.value, changes.value, effectiveBoard.value)
            : [],
    );
    const edits = computed(() => specEditsCount(members.value));

    function select(address: string) {
        selected.value = address;
    }

    async function reload() {
        await load();
        await loadGraph();
    }

    async function closeChange() {
        if (!current.value || !live.value) return;
        closing.value = true;
        closeError.value = "";
        try {
            await invoke<string>("close_change", { change: changeAddress(current.value) });
            await reload();
        } catch (e) {
            closeError.value = String(e);
        } finally {
            closing.value = false;
        }
    }

    return {
        live,
        error,
        changes,
        current,
        members,
        progress,
        open,
        selected,
        select,
        blockers,
        waiting,
        passed,
        history,
        specSummary,
        edits,
        cost,
        graph,
        graphLoading,
        closing,
        closeError,
        closeChange,
        reload,
    };
}
