import { ref, computed, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadRunGraph, type RunGraph } from "../../board/graphModel";
import { boardStore } from "../../board/boardStore";
import {
    blockersFor,
    changeAddress,
    changeIsOpen,
    changeMembers,
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
import { changeHeaderSummary } from "./changeSelectors";

const EMPTY_GRAPH: RunGraph = { nodes: [], edges: [], groups: [], mermaid: "" };

const selected = ref("");

export function selectChange(address: string) {
    selected.value = address;
}

export function useChange() {
    const board = computed(() => boardStore.rows.value as unknown as ChangeTask[]);
    const changesRaw = computed(() => boardStore.changes.value as ChangeRecord[]);
    const live = ref(false);
    const error = ref("");
    const graph = ref<RunGraph>(EMPTY_GRAPH);
    const graphLoading = ref(false);
    const activeTab = ref("delta");
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
        await boardStore.start();
        live.value = boardStore.error.value === "";
        error.value = boardStore.error.value;
        pickDefault();
    }

    onMounted(async () => {
        await load();
    });

    const current = computed(
        () => changes.value.find((c) => changeAddress(c) === selected.value) ?? null,
    );

    let metricRequest = 0;
    async function loadVisibleMetrics(change: ChangeRecord | null) {
        const request = ++metricRequest;
        if (!live.value) {
            graph.value = { nodes: mockNodes, edges: [], groups: [], mermaid: "" };
            return;
        }
        if (!change) {
            graph.value = EMPTY_GRAPH;
            return;
        }
        graphLoading.value = true;
        try {
            const loaded = await loadRunGraph(changeAddress(change));
            if (request === metricRequest) graph.value = loaded;
        } finally {
            if (request === metricRequest) graphLoading.value = false;
        }
    }

    watch(current, (change) => { void loadVisibleMetrics(change); }, { immediate: true });
    const members = computed(() =>
        current.value ? changeMembers(effectiveBoard.value, current.value) : [],
    );
    const header = computed(() => changeHeaderSummary(current.value, effectiveBoard.value));
    const progress = computed(() => ({ total: header.value.total, done: header.value.done }));
    const open = computed(() => header.value.open);

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

    function setActiveTab(tab: string) {
        activeTab.value = tab;
    }

    async function reload() {
        await load();
    }

    async function closeChange() {
        if (!current.value || !live.value) return;
        closing.value = true;
        closeError.value = "";
        try {
            await invoke<string>("close_change", { change: changeAddress(current.value) });
            // close_change is CLI-backed rather than a compact mutation response.
            // Refresh once; its watcher echo is revision-gated by the store.
            await boardStore.reload(true);
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
        setActiveTab,
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
