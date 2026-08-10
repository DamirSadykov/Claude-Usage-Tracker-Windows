<script setup lang="ts">
import { computed, ref } from "vue";
import AppBar from "../../atoms/AppBar.vue";
import SegControl from "../../atoms/SegControl.vue";
import SearchField from "../../atoms/SearchField.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import Kicker from "../../atoms/Kicker.vue";
import HintBar from "../../atoms/HintBar.vue";
import PanelRow from "../../atoms/PanelRow.vue";
import ChangeQueueCard from "../../atoms/ChangeQueueCard.vue";
import SpecTreeItem from "../../atoms/SpecTreeItem.vue";
import SpecParagraph from "../../atoms/SpecParagraph.vue";
import { diffLines } from "../../../specDiff";
import { useSpecs } from "../useSpecs";
import {
    domains as mockDomains,
    reviewSection as mockReviewSection,
    reviewEdits as mockReviewEdits,
    reviewMarks as mockReviewMarks,
    readerAddress as mockReaderAddress,
    changeQueue as mockChangeQueue,
    mergeSummary as mockMergeSummary,
    partBadge,
    partTone,
    sectionCount as mockSectionCount,
    editCount as mockEditCount,
    inlineHtml,
} from "../specMock";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: true });

const emit = defineEmits<{
    (
        e: "mode",
        value: "lanes" | "wires" | "rings" | "specs" | "reader" | "review",
    ): void;
}>();

const specs = useSpecs();
const live = computed(() => specs.live.value);

const view = ref("edits");
const tab = ref("specs");
const query = ref("");
const scope = ref("edits");
const localSelected = ref(mockReaderAddress);
const verdicts = ref<Record<string, "pending" | "accepted" | "rejected">>({});
const picked = ref("");

const domains = computed(() => (live.value ? specs.domains.value : mockDomains));
const selected = computed(() => (live.value ? specs.selected.value : localSelected.value));

function pick(address: string) {
    if (live.value) specs.select(address);
    else localSelected.value = address;
}

const editsAt = (address: string) =>
    live.value ? specs.openChangesFor(address).length : mockEditCount(address);

const editedTree = computed(() =>
    domains.value
        .map((domain) => ({
            id: domain.id,
            version: domain.version,
            sections: (domain.sections ?? [])
                .map((section) => ({
                    slug: section.slug,
                    title: section.title,
                    part: section.part,
                    address: `${domain.id}#${section.slug}`,
                    edits: editsAt(`${domain.id}#${section.slug}`),
                }))
                .filter((section) => scope.value !== "edits" || section.edits > 0),
        }))
        .filter((domain) => domain.sections.length),
);

const editedCount = computed(() =>
    editedTree.value.reduce((sum, domain) => sum + domain.sections.length, 0),
);

const current = computed(() => {
    const [domainId, slug] = selected.value.split("#");
    const domain = domains.value.find((d) => d.id === domainId);
    const section = domain?.sections.find((s) => s.slug === slug);
    return {
        title: section?.title ?? (live.value ? "" : mockReviewSection.entry.title),
        part: section?.part ?? (live.value ? "" : mockReviewSection.entry.part),
        file: `docs/specs/${domainId}/spec.md`,
    };
});

const openDeltas = computed(() =>
    live.value ? specs.deltasFor(selected.value) : [],
);

const verdictOf = (id: string) => verdicts.value[id] ?? "pending";

const liveRows = computed(() =>
    openDeltas.value.map(({ task, delta }) => {
        const state = verdictOf(task.id);
        return {
            id: task.id,
            mark: task.number ? `#${task.number}` : task.id,
            taskLabel: task.number ? `#${task.number}` : "",
            state,
            delta,
            lines:
                state === "pending"
                    ? delta.lines
                    : [
                          {
                              op: " " as const,
                              text: state === "rejected" ? delta.before : delta.after,
                          },
                      ],
        };
    }),
);

const editByHash = computed(() => {
    const map = new Map<string, (typeof mockReviewEdits)[number]>();
    for (const edit of mockReviewEdits) map.set(edit.hash, edit);
    return map;
});

const mockRows = computed(() =>
    mockReviewSection.blocks.map((block) => {
        const edit = editByHash.value.get(block.hash) ?? null;
        const state = verdictOf(block.hash);
        const before = edit ? edit.before : block.text;
        const after = edit ? edit.after : block.text;
        return {
            hash: block.hash,
            mark: mockReviewMarks[block.hash] ?? "",
            edit,
            state,
            before,
            after,
            lines:
                edit && state === "pending"
                    ? diffLines(edit.before, edit.after)
                    : [
                          {
                              op: " " as const,
                              text: state === "rejected" ? before : after,
                          },
                      ],
        };
    }),
);

const acceptedParagraphs = computed(() =>
    live.value ? specs.paragraphsOf(specs.section.value) : [],
);

const mockAcceptedRows = computed(() =>
    mockRows.value
        .map((row) => ({
            hash: row.hash,
            mark: row.mark,
            text: row.state === "accepted" ? row.after : row.before,
        }))
        .filter((row) => row.text),
);

const liveWholeDiff = computed(() =>
    diffLines(
        openDeltas.value.map((d) => d.delta.before).filter(Boolean).join("\n"),
        openDeltas.value.map((d) => d.delta.after).join("\n"),
    ),
);

const mockWholeDiff = computed(() =>
    diffLines(
        mockRows.value.map((row) => row.before).filter(Boolean).join("\n"),
        mockRows.value.map((row) => row.after).join("\n"),
    ),
);

const noteOf = (id: string, fallback: string) => {
    const state = verdictOf(id);
    if (state === "accepted") return "принято";
    if (state === "rejected") return "отклонено · раздел остаётся как был";
    return fallback;
};

const mockNoteOf = (hash: string) => {
    const state = verdictOf(hash);
    if (state === "accepted") return "принято · войдёт в v6";
    if (state === "rejected") return "отклонено · раздел остаётся как был";
    return editByHash.value.get(hash)?.note ?? "";
};

function onView(value: string) {
    view.value = value;
}

function onTab(value: string) {
    if (value === "graph") {
        emit("mode", "lanes");
        return;
    }
    tab.value = value;
}

function accept(id: string) {
    verdicts.value = { ...verdicts.value, [id]: "accepted" };
}

function reject(id: string) {
    verdicts.value = { ...verdicts.value, [id]: "rejected" };
}

const changeQueue = computed(() => {
    if (!live.value) return mockChangeQueue;
    const out: { id: string; title: string; meta: string; tone: "ok" | "warn" | "muted" }[] = [];
    const migratedFrom = new Set(
        specs.changes.value.map((c) => c.migrated_from).filter((n): n is number => !!n),
    );
    for (const c of specs.changes.value) {
        if (c.closed_at) continue;
        const conflict = (c.spec ?? []).some((a) => specs.concurrentAt(a));
        out.push({
            id: c.id,
            title: c.title,
            meta: (c.spec ?? []).join(", ") || "без раздела",
            tone: conflict ? "warn" : "ok",
        });
    }
    for (const t of specs.board.value) {
        if (!t.change || t.status === "done") continue;
        if (t.number && migratedFrom.has(t.number)) continue;
        const conflict = (t.spec ?? []).some((a) => specs.concurrentAt(a));
        out.push({
            id: t.number ? `#${t.number}` : t.id,
            title: t.subject,
            meta: (t.spec ?? []).join(", ") || "без раздела",
            tone: conflict ? "warn" : "ok",
        });
    }
    return out;
});

const mergeSummary = computed(() => {
    if (!live.value) return mockMergeSummary;
    const total = changeQueue.value.length;
    const conflicts = changeQueue.value.filter((c) => c.tone === "warn").length;
    const lines: { icon: string; text: string; meta: string; tone: "ok" | "warn" | "muted" | "accent" | "crit" }[] = [
        {
            icon: total ? "⚡" : "✓",
            text: total ? `${total} открытых change'ов` : "нет открытых change'ов",
            meta: "",
            tone: total ? "accent" : "ok",
        },
    ];
    if (conflicts)
        lines.push({
            icon: "!",
            text: conflicts === 1 ? "1 раздел с конфликтом" : `${conflicts} раздела с конфликтом`,
            meta: "",
            tone: "warn",
        });
    return lines;
});
</script>

<template>
    <AppBar v-if="chrome" title="Спеки">
        <template #modes>
            <SegControl
                :model-value="view"
                :options="[
                    { id: 'accepted', label: 'Принято' },
                    { id: 'edits', label: 'С правками', count: live ? openDeltas.length : changeQueue.length },
                    { id: 'diff', label: 'Diff' },
                ]"
                @update:model-value="onView"
            />
            <span class="spec-scope">
                {{ live ? (specs.currentDir.value?.project ?? "") : "tasks v5 → v6-draft" }}
            </span>
        </template>
        <template #right>
            <SearchField v-model="query" placeholder="Поиск" :width="220" />
            <SegControl
                :model-value="tab"
                :options="[
                    { id: 'graph', label: 'Граф' },
                    { id: 'specs', label: 'Спеки' },
                ]"
                @update:model-value="onTab"
            />
            <ToolButton variant="pri">Слить готовые</ToolButton>
        </template>
    </AppBar>

    <div class="pipe-canvas plain spec-shell">
        <aside class="spec-rail">
            <div class="rail-chips">
                <MetaChip
                    class="rail-chip"
                    :tone="scope === 'edits' ? 'spec' : 'muted'"
                    @click="scope = 'edits'"
                >
                    с правками {{ editedCount }}
                </MetaChip>
                <MetaChip
                    class="rail-chip"
                    :tone="scope === 'all' ? 'spec' : 'muted'"
                    @click="scope = 'all'"
                >
                    все {{ live ? specs.sectionCount() : mockSectionCount() }}
                </MetaChip>
            </div>

            <div v-for="domain in editedTree" :key="domain.id" class="rail-domain">
                <div class="rail-domain-head">
                    <span class="rail-domain-id">{{ domain.id }}</span>
                    <span class="rail-domain-meta">v{{ domain.version }}</span>
                </div>
                <SpecTreeItem
                    v-for="section in domain.sections"
                    :key="section.slug"
                    :slug="section.slug"
                    :title="section.title"
                    :badge="scope === 'all' ? partBadge(section.part) : ''"
                    :badge-tone="partTone(section.part)"
                    :count="section.edits"
                    :active="selected === section.address"
                    @click="pick(section.address)"
                />
            </div>
            <div v-if="live && !editedTree.length" class="spec-empty">
                Ни одна задача не ссылается на раздел (todos set spec &lt;задача&gt;
                &lt;домен&gt;#&lt;слаг&gt;)
            </div>
        </aside>

        <main class="spec-doc">
            <template v-if="selected">
                <div class="doc-crumbs">
                    <span class="crumb-path">{{ current.file }}</span>
                    <span class="crumb-sep">›</span>
                    <span class="crumb-addr">{{ selected }}</span>
                    <MetaChip :text="current.part" tone="muted" />
                </div>

                <h2 class="doc-title">{{ current.title }}</h2>

                <template v-if="live">
                    <HintBar v-if="view === 'edits'" icon="⚡">
                        {{ openDeltas.length }} открыт{{ openDeltas.length === 1 ? "ый change" : "ых change'а" }}
                        меняют этот раздел. Показан текст с наложенными правками.
                    </HintBar>
                    <HintBar v-else-if="view === 'accepted'" icon="✓" tone="muted">
                        Раздел без открытых правок — так он выглядит сейчас.
                    </HintBar>
                    <HintBar v-else icon="±" tone="muted">
                        Сплошной diff раздела: слева база на момент, когда его увидела
                        первая открытая задача, справа — предлагаемый текст.
                    </HintBar>
                </template>
                <template v-else>
                    <HintBar v-if="view === 'edits'" icon="⚡">
                        4 открытых change'а меняют этот раздел. Показан текст с
                        наложенными правками — принятые попадут в v6 при слиянии.
                    </HintBar>
                    <HintBar v-else-if="view === 'accepted'" icon="✓" tone="muted">
                        Раздел без открытых правок — так он выглядит в v5 и так
                        останется, если ничего не сливать.
                    </HintBar>
                    <HintBar v-else icon="±" tone="muted">
                        Сплошной diff раздела: слева база v5, справа то, что предлагают
                        открытые change'и.
                    </HintBar>
                </template>

                <template v-if="live">
                    <div v-if="view === 'edits'" class="doc-body">
                        <SpecParagraph
                            v-for="row in liveRows"
                            :key="row.id"
                            :mark="row.mark"
                            :task="row.taskLabel"
                            :note="noteOf(row.id, row.delta.live ? 'в работе' : 'записан при закрытии')"
                            tone="change"
                        >
                            <span
                                v-for="(line, index) in row.lines"
                                :key="index"
                                class="doc-text"
                                :class="{ cut: line.op === '-' }"
                                v-html="inlineHtml(line.text)"
                            />
                            <template #actions>
                                <template v-if="row.state !== 'pending'">
                                    <ToolButton @click="verdicts[row.id] = 'pending'">
                                        Вернуть
                                    </ToolButton>
                                </template>
                                <template v-else>
                                    <ToolButton class="act-ok" @click="accept(row.id)">
                                        ✓ Принять
                                    </ToolButton>
                                    <ToolButton @click="reject(row.id)">Отклонить</ToolButton>
                                    <ToolButton @click="emit('mode', 'lanes')">
                                        Открыть задачу
                                    </ToolButton>
                                </template>
                            </template>
                        </SpecParagraph>
                        <div v-if="!liveRows.length" class="spec-empty">
                            Ни одна открытая задача не меняет этот раздел
                        </div>
                    </div>

                    <div v-else-if="view === 'accepted'" class="doc-body">
                        <SpecParagraph
                            v-for="row in acceptedParagraphs"
                            :key="row.hash"
                            :mark="row.mark"
                        >
                            <span class="doc-text" v-html="inlineHtml(row.text)" />
                        </SpecParagraph>
                    </div>

                    <div v-else class="doc-diff">
                        <div
                            v-for="(line, index) in liveWholeDiff"
                            :key="index"
                            class="diff-line"
                            :class="{ add: line.op === '+', cut: line.op === '-' }"
                        >
                            <span class="diff-op">{{ line.op }}</span>
                            <span class="diff-text">{{ line.text }}</span>
                        </div>
                        <div v-if="!liveWholeDiff.length" class="spec-empty">
                            Ни одна открытая задача не меняет этот раздел
                        </div>
                    </div>
                </template>
                <template v-else>
                    <div v-if="view === 'edits'" class="doc-body">
                        <SpecParagraph
                            v-for="row in mockRows"
                            :key="row.hash"
                            :mark="row.mark"
                            :task="row.edit ? `#${row.edit.task}` : ''"
                            :note="mockNoteOf(row.hash)"
                            :tone="row.edit ? row.edit.tone : 'plain'"
                        >
                            <span
                                v-for="(line, index) in row.lines"
                                :key="index"
                                class="doc-text"
                                :class="{ cut: line.op === '-' }"
                                v-html="inlineHtml(line.text)"
                            />
                            <template v-if="row.edit" #actions>
                                <template v-if="row.state !== 'pending'">
                                    <ToolButton @click="verdicts[row.hash] = 'pending'">
                                        Вернуть
                                    </ToolButton>
                                </template>
                                <template v-else>
                                    <ToolButton
                                        v-if="row.edit.actions.includes('accept')"
                                        class="act-ok"
                                        @click="accept(row.hash)"
                                    >
                                        ✓ Принять
                                    </ToolButton>
                                    <ToolButton
                                        v-if="row.edit.actions.includes('reject')"
                                        @click="reject(row.hash)"
                                    >
                                        Отклонить
                                    </ToolButton>
                                    <ToolButton
                                        v-if="row.edit.actions.includes('open')"
                                        @click="emit('mode', 'lanes')"
                                    >
                                        Открыть задачу
                                    </ToolButton>
                                    <ToolButton
                                        v-if="row.edit.actions.includes('compare')"
                                        variant="warn"
                                    >
                                        Сравнить
                                    </ToolButton>
                                </template>
                            </template>
                        </SpecParagraph>
                    </div>

                    <div v-else-if="view === 'accepted'" class="doc-body">
                        <SpecParagraph
                            v-for="row in mockAcceptedRows"
                            :key="row.hash"
                            :mark="row.mark"
                        >
                            <span class="doc-text" v-html="inlineHtml(row.text)" />
                        </SpecParagraph>
                    </div>

                    <div v-else class="doc-diff">
                        <div
                            v-for="(line, index) in mockWholeDiff"
                            :key="index"
                            class="diff-line"
                            :class="{ add: line.op === '+', cut: line.op === '-' }"
                        >
                            <span class="diff-op">{{ line.op }}</span>
                            <span class="diff-text">{{ line.text }}</span>
                        </div>
                    </div>
                </template>
            </template>
            <div v-else class="spec-empty">Выберите раздел слева</div>
        </main>

        <aside class="spec-panel">
            <section class="panel-group">
                <Kicker>Очередь change'ов</Kicker>
                <div class="panel-queue">
                    <ChangeQueueCard
                        v-for="card in changeQueue"
                        :key="card.id"
                        :id="card.id"
                        :title="card.title"
                        :meta="card.meta"
                        :tone="card.tone"
                        :active="picked === card.id"
                        @click="picked = card.id"
                    />
                    <div v-if="!changeQueue.length" class="spec-empty">
                        Нет открытых change'ов
                    </div>
                </div>
            </section>

            <section class="panel-group">
                <Kicker>Слияние</Kicker>
                <div class="panel-card">
                    <PanelRow
                        v-for="line in mergeSummary"
                        :key="line.text"
                        :icon="line.icon"
                        :text="line.text"
                        :meta="line.meta"
                        :tone="line.tone"
                    />
                </div>
                <ToolButton variant="pri" class="merge-button">
                    Слить готовые
                </ToolButton>
            </section>
        </aside>
    </div>
</template>

<style scoped>
.spec-scope {
    margin-left: 4px;
    font-size: 12px;
    color: var(--text-4);
}
.pipe-canvas.spec-shell {
    display: flex;
    align-items: stretch;
    overflow: hidden;
}
.spec-rail {
    flex: none;
    box-sizing: border-box;
    width: 252px;
    padding: 12px 14px 24px;
    border-right: 1px solid var(--stroke);
    background: var(--rail-bg);
    overflow-y: auto;
}
.rail-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 16px;
}
.rail-chip {
    cursor: pointer;
}
.rail-domain {
    margin-bottom: 16px;
}
.rail-domain-head {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 0 10px 6px;
}
.rail-domain-id {
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
}
.rail-domain-meta {
    font-size: 10.5px;
    color: var(--text-4);
}
.spec-doc {
    flex: 1;
    min-width: 0;
    padding: 14px 28px 40px;
    overflow-y: auto;
}
.doc-crumbs {
    display: flex;
    align-items: center;
    gap: 9px;
}
.crumb-path {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-4);
}
.crumb-sep {
    color: var(--text-4);
}
.crumb-addr {
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
}
.doc-title {
    margin: 10px 0 14px;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
}
.doc-body {
    margin-top: 14px;
    max-width: 860px;
}
.doc-text {
    display: block;
    font-size: 13.2px;
    line-height: 1.68;
}
.doc-text.cut {
    color: var(--text-4);
    text-decoration: line-through;
}
.doc-text :deep(.sp-code) {
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    font-family: var(--mono);
    font-size: 0.88em;
    color: var(--text-2);
}
.doc-text :deep(.sp-path) {
    color: var(--ok);
}
.doc-text :deep(.sp-addr) {
    color: var(--accent);
}
.doc-text.cut :deep(.sp-code) {
    color: var(--text-4);
}
.doc-text :deep(b) {
    color: var(--text);
    font-weight: 600;
}
.act-ok {
    border-color: rgba(108, 203, 95, 0.4);
    background: rgba(108, 203, 95, 0.1);
    color: var(--ok);
}
.doc-diff {
    margin-top: 14px;
    max-width: 860px;
    padding: 10px 0;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(0, 0, 0, 0.24);
}
.diff-line {
    display: flex;
    gap: 8px;
    padding: 2px 12px;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--text-3);
}
.diff-line.add {
    background: rgba(108, 203, 95, 0.1);
    color: var(--ok);
}
.diff-line.cut {
    background: rgba(248, 113, 113, 0.1);
    color: var(--crit);
}
.diff-op {
    flex: none;
    width: 10px;
    text-align: center;
    opacity: 0.7;
}
.diff-text {
    min-width: 0;
    white-space: pre-wrap;
}
.spec-panel {
    flex: none;
    box-sizing: border-box;
    width: 268px;
    padding: 12px 14px 24px;
    border-left: 1px solid var(--stroke);
    background: var(--rail-bg);
    overflow-y: auto;
}
.panel-group {
    margin-bottom: 16px;
}
.panel-queue {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
}
.panel-card {
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(0, 0, 0, 0.2);
}
.merge-button {
    width: 100%;
    margin-top: 10px;
    justify-content: center;
}
.spec-empty {
    padding: 6px 4px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-4);
}
</style>
