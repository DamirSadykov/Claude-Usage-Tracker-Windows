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
import {
    domains,
    reviewSection,
    reviewEdits,
    reviewMarks,
    readerAddress,
    changeQueue,
    mergeSummary,
    partBadge,
    partTone,
    sectionCount,
    editCount,
    inlineHtml,
} from "../specMock";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: true });

const emit = defineEmits<{
    (
        e: "mode",
        value: "lanes" | "wires" | "rings" | "specs" | "reader" | "review",
    ): void;
}>();

const view = ref("edits");
const tab = ref("specs");
const query = ref("");
const scope = ref("edits");
const selected = ref(readerAddress);
const verdicts = ref<Record<string, "pending" | "accepted" | "rejected">>({});
const picked = ref("#350");

const editedTree = computed(() =>
    domains
        .map((domain) => ({
            id: domain.id,
            version: domain.version,
            sections: domain.sections
                .map((section) => ({
                    slug: section.slug,
                    title: section.title,
                    part: section.part,
                    address: `${domain.id}#${section.slug}`,
                    edits: editCount(`${domain.id}#${section.slug}`),
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
    const domain = domains.find((d) => d.id === domainId);
    const section = domain?.sections.find((s) => s.slug === slug);
    return {
        title: section?.title ?? reviewSection.entry.title,
        part: section?.part ?? reviewSection.entry.part,
        file: `docs/specs/${domainId}/spec.md`,
    };
});

const editByHash = computed(() => {
    const map = new Map<string, (typeof reviewEdits)[number]>();
    for (const edit of reviewEdits) map.set(edit.hash, edit);
    return map;
});

const verdictOf = (hash: string) => verdicts.value[hash] ?? "pending";

const rows = computed(() =>
    reviewSection.blocks.map((block) => {
        const edit = editByHash.value.get(block.hash) ?? null;
        const state = verdictOf(block.hash);
        const before = edit ? edit.before : block.text;
        const after = edit ? edit.after : block.text;
        return {
            hash: block.hash,
            mark: reviewMarks[block.hash] ?? "",
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

const acceptedRows = computed(() =>
    rows.value
        .map((row) => ({
            hash: row.hash,
            mark: row.mark,
            text: row.state === "accepted" ? row.after : row.before,
        }))
        .filter((row) => row.text),
);

const wholeDiff = computed(() =>
    diffLines(
        rows.value.map((row) => row.before).filter(Boolean).join("\n"),
        rows.value.map((row) => row.after).join("\n"),
    ),
);

const noteOf = (hash: string) => {
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

function accept(hash: string) {
    verdicts.value = { ...verdicts.value, [hash]: "accepted" };
}

function reject(hash: string) {
    verdicts.value = { ...verdicts.value, [hash]: "rejected" };
}
</script>

<template>
    <AppBar v-if="chrome" title="Спеки">
        <template #modes>
            <SegControl
                :model-value="view"
                :options="[
                    { id: 'accepted', label: 'Принято' },
                    { id: 'edits', label: 'С правками', count: changeQueue.length },
                    { id: 'diff', label: 'Diff' },
                ]"
                @update:model-value="onView"
            />
            <span class="spec-scope">tasks v5 → v6-draft</span>
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
            <ToolButton variant="pri">Слить 2 готовых</ToolButton>
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
                    все {{ sectionCount() }}
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
                    @click="selected = section.address"
                />
            </div>
        </aside>

        <main class="spec-doc">
            <div class="doc-crumbs">
                <span class="crumb-path">{{ current.file }}</span>
                <span class="crumb-sep">›</span>
                <span class="crumb-addr">{{ selected }}</span>
                <MetaChip :text="current.part" tone="muted" />
            </div>

            <h2 class="doc-title">{{ current.title }}</h2>

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

            <div v-if="view === 'edits'" class="doc-body">
                <SpecParagraph
                    v-for="row in rows"
                    :key="row.hash"
                    :mark="row.mark"
                    :task="row.edit ? `#${row.edit.task}` : ''"
                    :note="noteOf(row.hash)"
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
                    v-for="row in acceptedRows"
                    :key="row.hash"
                    :mark="row.mark"
                >
                    <span class="doc-text" v-html="inlineHtml(row.text)" />
                </SpecParagraph>
            </div>

            <div v-else class="doc-diff">
                <div
                    v-for="(line, index) in wholeDiff"
                    :key="index"
                    class="diff-line"
                    :class="{ add: line.op === '+', cut: line.op === '-' }"
                >
                    <span class="diff-op">{{ line.op }}</span>
                    <span class="diff-text">{{ line.text }}</span>
                </div>
            </div>
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
                </div>
            </section>

            <section class="panel-group">
                <Kicker>Слияние в v6</Kicker>
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
                    Слить готовые → v6
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
</style>
