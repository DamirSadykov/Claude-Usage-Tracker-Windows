import { ref, computed, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { diffLines, diffHunks, diffStat, type DiffHunk, type DiffLine } from "../../specDiff";
import { toSpecLanes, type BoardTodo, type BoardChange, type SpecSectionPayload } from "./adapt";
import type { SpecLane } from "./types";

export interface SectionEntry {
    slug: string;
    title: string;
    part: string;
    remote: boolean;
}

export interface DomainEntry {
    id: string;
    version: number | null;
    updated: string | null;
    external: { repo: string | null; path: string | null } | null;
    sections: SectionEntry[];
    error?: string;
}

export interface ProjectDir {
    project: string;
    dir: string;
    has_specs: boolean;
}

export interface SectionBlock {
    text: string;
    hash: string;
}

export interface SectionResponse {
    text?: string;
    stub?: string;
    unavailable?: string;
    available?: boolean;
    blocks?: SectionBlock[];
    entry?: {
        title?: string;
        part?: string;
        refs?: string[];
        updated?: string;
        change?: string;
    };
}

export interface SpecAnswer {
    address: string;
    verdict: string;
    note: string;
    at: string;
    blocks?: string[];
    after?: string;
}

export interface SpecSeen {
    address: string;
    hash: string;
    blocks: string[];
    text: string;
    at: string;
}

export interface SpecTodo extends Omit<BoardTodo, "spec_answers" | "spec_seen"> {
    spec_answers?: SpecAnswer[];
    spec_seen?: SpecSeen[];
}

export interface SpecChange extends BoardChange {
    migrated_from?: number;
}

export interface ChangeLike {
    id: string;
    number: number;
    title: string;
    open: boolean;
}

export interface Paragraph {
    hash: string;
    text: string;
    mark: string;
    task: string;
}

export interface Delta {
    hunks: DiffHunk[];
    lines: DiffLine[];
    stat: { added: number; removed: number };
    before: string;
    after: string;
    live: boolean;
}

export function useSpecs() {
    const projectDirs = ref<ProjectDir[]>([]);
    const dir = ref("");
    const domains = ref<DomainEntry[]>([]);
    const board = ref<SpecTodo[]>([]);
    const changes = ref<SpecChange[]>([]);
    const sectionPayloads = ref<SpecSectionPayload[]>([]);
    const selected = ref("");
    const section = ref<SectionResponse | null>(null);
    const live = ref(false);
    const loading = ref(false);
    const sectionsLoading = ref(false);
    const error = ref("");

    const dirOf = (name: string) => projectDirs.value.find((p) => p.project === name)?.dir ?? "";
    const currentDir = computed(() => projectDirs.value.find((p) => p.dir === dir.value));

    async function loadProjects() {
        try {
            projectDirs.value = await invoke<ProjectDir[]>("spec_projects");
            live.value = true;
        } catch (e) {
            projectDirs.value = [];
            error.value = String(e);
            live.value = false;
            return;
        }
        dir.value =
            dirOf(currentDir.value?.project ?? "") ||
            projectDirs.value.find((p) => p.has_specs)?.dir ||
            projectDirs.value[0]?.dir ||
            "";
    }

    async function loadBoard() {
        try {
            board.value = await invoke<SpecTodo[]>("get_todos");
        } catch {
            board.value = [];
        }
        try {
            changes.value = await invoke<SpecChange[]>("get_changes");
        } catch {
            changes.value = [];
        }
    }

    async function select(address: string) {
        selected.value = address;
        section.value = null;
        if (!dir.value) return;
        try {
            section.value = await invoke<SectionResponse>("spec_section", {
                dir: dir.value,
                address,
            });
        } catch (e) {
            section.value = { unavailable: String(e) };
        }
    }

    async function loadSectionPayloads() {
        const addresses = domains.value.flatMap((d) =>
            (d.sections ?? []).map((s) => `${d.id}#${s.slug}`),
        );
        if (!addresses.length) {
            sectionPayloads.value = [];
            return;
        }
        sectionsLoading.value = true;
        const results = await Promise.all(
            addresses.map(async (address): Promise<SpecSectionPayload | null> => {
                try {
                    const res = await invoke<SectionResponse>("spec_section", {
                        dir: dir.value,
                        address,
                    });
                    return {
                        address,
                        entry: {
                            title: res.entry?.title,
                            part: res.entry?.part,
                            updated: res.entry?.updated,
                            refs: res.entry?.refs,
                        },
                        text: res.text ?? res.stub ?? "",
                    };
                } catch {
                    return null;
                }
            }),
        );
        sectionPayloads.value = results.filter((x): x is SpecSectionPayload => !!x);
        sectionsLoading.value = false;
    }

    async function loadDomains() {
        domains.value = [];
        sectionPayloads.value = [];
        selected.value = "";
        section.value = null;
        if (!dir.value) return;
        loading.value = true;
        error.value = "";
        try {
            domains.value = await invoke<DomainEntry[]>("spec_domains", { dir: dir.value });
            const first = domains.value.find((d) => d.sections?.length);
            if (first) await select(`${first.id}#${first.sections[0].slug}`);
            await loadSectionPayloads();
        } catch (e) {
            error.value = String(e);
        } finally {
            loading.value = false;
        }
    }

    async function load() {
        await loadProjects();
        await loadBoard();
        await loadDomains();
    }

    watch(dir, loadDomains);
    onMounted(load);

    const titleOf = (address: string): string => {
        const [domainId, slug] = address.split("#");
        return (
            domains.value.find((d) => d.id === domainId)?.sections?.find((s) => s.slug === slug)
                ?.title ?? ""
        );
    };

    const sectionCount = (part?: string): number =>
        domains.value.reduce(
            (sum, d) => sum + (d.sections ?? []).filter((s) => !part || s.part === part).length,
            0,
        );

    const isOpenTodo = (t: SpecTodo): boolean => t.status !== "done";
    const isOpenChange = (c: BoardChange): boolean => !c.closed_at;

    function changeLikeFor(address: string): ChangeLike[] {
        const out: ChangeLike[] = [];
        const migratedFrom = new Set<number>();
        for (const c of changes.value) {
            if (c.migrated_from) migratedFrom.add(c.migrated_from);
            if (!(c.spec ?? []).includes(address)) continue;
            out.push({ id: c.id, number: c.number, title: c.title, open: isOpenChange(c) });
        }
        for (const t of board.value) {
            if (!t.change) continue;
            if (t.number && migratedFrom.has(t.number)) continue;
            if (!(t.spec ?? []).includes(address)) continue;
            out.push({
                id: t.id,
                number: t.number ?? 0,
                title: t.subject,
                open: isOpenTodo(t),
            });
        }
        return out.sort((a, b) => a.number - b.number);
    }

    const openChangesFor = (address: string) => changeLikeFor(address).filter((c) => c.open);
    const concurrentAt = (address: string) => openChangesFor(address).length > 1;

    const linkedTasksFor = (address: string) =>
        board.value.filter((t) => (t.spec ?? []).includes(address));

    function ownerOf(address: string, hash: string): number | null {
        for (const t of board.value)
            for (const a of t.spec_answers ?? [])
                if (a.address === address && (a.blocks ?? []).includes(hash)) return t.number ?? null;
        return null;
    }

    function paragraphsOf(sec: SectionResponse | null): Paragraph[] {
        if (!sec?.blocks) return [];
        return sec.blocks.map((b, i) => {
            const owner = ownerOf(selected.value, b.hash);
            return {
                hash: b.hash,
                text: b.text,
                mark: `§${i + 1}`,
                task: owner === null ? "" : `#${owner}`,
            };
        });
    }

    const sectionText = computed(() =>
        (section.value?.blocks ?? []).map((b) => b.text).join("\n"),
    );

    function deltaFor(t: SpecTodo, address: string): Delta | null {
        const seen = (t.spec_seen ?? []).find((s) => s.address === address);
        if (!seen?.text) return null;
        const answer = (t.spec_answers ?? []).find((a) => a.address === address);
        const after = answer?.after ?? (isOpenTodo(t) ? sectionText.value : "");
        if (!after) return null;
        const lines = diffLines(seen.text, after);
        const stat = diffStat(lines);
        if (!stat.added && !stat.removed) return null;
        return {
            hunks: diffHunks(lines),
            lines,
            stat,
            before: seen.text,
            after,
            live: !answer?.after,
        };
    }

    function deltasFor(address: string): { task: SpecTodo; delta: Delta }[] {
        const out: { task: SpecTodo; delta: Delta }[] = [];
        for (const t of board.value) {
            const delta = deltaFor(t, address);
            if (delta) out.push({ task: t, delta });
        }
        return out;
    }

    const sectionBacklinks = computed(() => {
        const m = new Map<string, string[]>();
        for (const p of sectionPayloads.value)
            for (const r of p.entry.refs ?? []) {
                if (!m.has(r)) m.set(r, []);
                m.get(r)!.push(p.address);
            }
        return m;
    });

    const specLanes = computed<SpecLane[]>(() =>
        toSpecLanes(sectionPayloads.value, board.value, changes.value),
    );

    return {
        projectDirs,
        dir,
        domains,
        board,
        changes,
        section,
        selected,
        sectionPayloads,
        live,
        loading,
        sectionsLoading,
        error,
        currentDir,
        select,
        reload: load,
        titleOf,
        sectionCount,
        isOpenTodo,
        isOpenChange,
        changeLikeFor,
        openChangesFor,
        concurrentAt,
        linkedTasksFor,
        ownerOf,
        paragraphsOf,
        deltaFor,
        deltasFor,
        sectionBacklinks,
        specLanes,
    };
}
