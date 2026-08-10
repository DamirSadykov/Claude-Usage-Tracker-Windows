<script setup lang="ts">
import { computed, ref } from "vue";
import AppBar from "../../atoms/AppBar.vue";
import SegControl from "../../atoms/SegControl.vue";
import SearchField from "../../atoms/SearchField.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import Kicker from "../../atoms/Kicker.vue";
import FileRow from "../../atoms/FileRow.vue";
import FocusRowItem from "../../atoms/FocusRowItem.vue";
import SpecTreeItem from "../../atoms/SpecTreeItem.vue";
import SpecParagraph from "../../atoms/SpecParagraph.vue";
import PanelRow from "../../atoms/PanelRow.vue";
import { useSpecs } from "../useSpecs";
import { selectChange } from "../useChange";
import {
    domains as mockDomains,
    readerSection as mockReaderSection,
    readerAddress as mockReaderAddress,
    specProject as mockSpecProject,
    sectionState as mockSectionState,
    mentionedFiles as mockMentionedFiles,
    sectionRefs as mockSectionRefs,
    openChanges as mockOpenChanges,
    paragraphsOf as mockParagraphsOf,
    partBadge,
    partTone,
    sectionCount as mockSectionCount,
    linkCount as mockLinkCount,
    editCount as mockEditCount,
    inlineHtml,
    SECTION_LINE_CEILING,
} from "../specMock";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: true });

const emit = defineEmits<{
    (
        e: "mode",
        value: "lanes" | "wires" | "rings" | "specs" | "reader" | "review" | "change",
    ): void;
}>();

const specs = useSpecs();
const live = computed(() => specs.live.value);

const scope = ref("sections");
const tab = ref("specs");
const query = ref("");
const railQuery = ref("");
const part = ref("");
const localSelected = ref(mockReaderAddress);

const parts = [
    { id: "", label: "все" },
    { id: "требования", label: "требования" },
    { id: "устройство", label: "устройство" },
    { id: "инварианты", label: "инварианты" },
];

const domains = computed(() => (live.value ? specs.domains.value : mockDomains));
const selected = computed(() => (live.value ? specs.selected.value : localSelected.value));

function pick(address: string) {
    if (live.value) specs.select(address);
    else localSelected.value = address;
}

const tree = computed(() =>
    domains.value
        .map((domain) => ({
            id: domain.id,
            version: domain.version,
            total: (domain.sections ?? []).length,
            sections: (domain.sections ?? []).filter((section) => {
                if (part.value && section.part !== part.value) return false;
                const q = railQuery.value.trim().toLowerCase();
                if (!q) return true;
                return (
                    section.slug.toLowerCase().includes(q) ||
                    section.title.toLowerCase().includes(q)
                );
            }),
        }))
        .filter((domain) => domain.sections.length),
);

const current = computed(() => {
    const [domainId, slug] = selected.value.split("#");
    const domain = domains.value.find((d) => d.id === domainId);
    const section = domain?.sections.find((s) => s.slug === slug);
    return {
        domainId,
        slug,
        title: section?.title ?? (live.value ? "" : mockReaderSection.entry.title),
        part: section?.part ?? (live.value ? "" : mockReaderSection.entry.part),
        file: `docs/specs/${domainId}/spec.md`,
    };
});

const paragraphs = computed(() =>
    live.value ? specs.paragraphsOf(specs.section.value) : mockParagraphsOf(mockReaderSection),
);

const changes = computed(() =>
    live.value
        ? specs
              .openChangesFor(selected.value)
              .map((c) => ({ id: c.address, title: c.title, record: c.record }))
        : mockOpenChanges(mockReaderAddress).map((c) => ({ ...c, record: false })),
);

function openChange(address: string) {
    selectChange(address);
    emit("mode", "change");
}

const linkCount = computed(() =>
    live.value ? specs.linkedTasksFor(selected.value).length : mockLinkCount(mockReaderAddress),
);

const markedAt = (address: string) =>
    live.value ? specs.openChangesFor(address).length > 1 : mockEditCount(address) > 1;

const sectionRefs = computed(() => {
    if (!live.value)
        return mockSectionRefs.map((r) => ({
            ...r,
            kind: r.id.includes("t#") ? ("task" as const) : ("spec" as const),
        }));
    const addr = selected.value;
    const tasks = specs.linkedTasksFor(addr).map((t) => ({
        id: t.number ? `#${t.number}` : t.id,
        title: t.subject,
        state: t.status,
        kind: "task" as const,
    }));
    const specSections = (specs.sectionBacklinks.value.get(addr) ?? []).map((a) => ({
        id: a,
        title: specs.titleOf(a),
        state: "раздел",
        kind: "spec" as const,
    }));
    return [...tasks, ...specSections];
});

const sectionState = computed(() => {
    if (!live.value) return mockSectionState;
    const addr = selected.value;
    const open = specs.openChangesFor(addr).length;
    const conflict = specs.concurrentAt(addr);
    const lines: { icon: string; text: string; meta: string; tone: "ok" | "warn" | "muted" | "accent" | "crit" }[] = [
        { icon: "§", text: `${paragraphs.value.length} абзацев`, meta: "", tone: "muted" },
    ];
    if (open)
        lines.push({
            icon: conflict ? "⚠" : "⚡",
            text: open === 1 ? "1 открытый change" : `${open} открытых change'а`,
            meta: conflict ? "конфликт" : "",
            tone: conflict ? "warn" : "accent",
        });
    else lines.push({ icon: "✓", text: "нет открытых change'ов", meta: "", tone: "ok" });
    return lines;
});

const totals = computed(() => ({
    all: live.value ? specs.sectionCount() : mockSectionCount(),
    требования: live.value ? specs.sectionCount("требования") : mockSectionCount("требования"),
    устройство: live.value ? specs.sectionCount("устройство") : mockSectionCount("устройство"),
    инварианты: live.value ? specs.sectionCount("инварианты") : mockSectionCount("инварианты"),
}));

function onScope(value: string) {
    if (value === "changes") {
        emit("mode", "review");
        return;
    }
    scope.value = value;
}

function onTab(value: string) {
    if (value === "graph") {
        emit("mode", "lanes");
        return;
    }
    tab.value = value;
}
</script>

<template>
    <AppBar v-if="chrome" title="Спеки">
        <template #modes>
            <SegControl
                :model-value="scope"
                :options="[
                    { id: 'sections', label: 'Разделы' },
                    { id: 'changes', label: 'Change\'и' },
                ]"
                @update:model-value="onScope"
            />
            <span class="spec-scope">
                {{ live ? specs.currentDir.value?.project ?? "" : mockSpecProject }}
                · {{ totals.all }} раздела
            </span>
        </template>
        <template #right>
            <SearchField
                v-model="query"
                placeholder="Поиск по тексту спек · Ctrl+P"
                :width="240"
            />
            <SegControl
                :model-value="tab"
                :options="[
                    { id: 'graph', label: 'Граф' },
                    { id: 'specs', label: 'Спеки' },
                ]"
                @update:model-value="onTab"
            />
            <ToolButton variant="icon">⚙</ToolButton>
        </template>
    </AppBar>

    <div class="pipe-canvas plain spec-shell">
        <aside class="spec-rail">
            <SearchField
                v-model="railQuery"
                placeholder="Фильтр разделов"
                :width="220"
            />

            <div v-if="live && specs.loading.value" class="spec-empty">Загрузка…</div>
            <div v-else-if="live && !domains.length" class="spec-empty">
                В проекте нет спек — реестр ищет &lt;домен&gt;/spec.md внутри specRoot
                <div class="spec-where">{{ specs.dir.value || "—" }}</div>
            </div>

            <div class="rail-chips">
                <MetaChip
                    v-for="option in parts"
                    :key="option.id"
                    class="rail-chip"
                    :tone="part === option.id ? 'spec' : 'muted'"
                    @click="part = option.id"
                >
                    {{ option.label }}
                    {{ option.id ? totals[option.id as keyof typeof totals] : totals.all }}
                </MetaChip>
            </div>

            <div v-for="domain in tree" :key="domain.id" class="rail-domain">
                <div class="rail-domain-head">
                    <span class="rail-domain-id">{{ domain.id }}</span>
                    <span class="rail-domain-meta">
                        v{{ domain.version }} · {{ domain.total }} разделов
                    </span>
                </div>
                <SpecTreeItem
                    v-for="section in domain.sections"
                    :key="section.slug"
                    :slug="section.slug"
                    :title="section.title"
                    :badge="partBadge(section.part)"
                    :badge-tone="partTone(section.part)"
                    :marked="markedAt(`${domain.id}#${section.slug}`)"
                    :active="selected === `${domain.id}#${section.slug}`"
                    @click="pick(`${domain.id}#${section.slug}`)"
                />
            </div>
        </aside>

        <main class="spec-doc">
            <template v-if="selected">
                <div class="doc-crumbs">
                    <span class="crumb-path">{{ current.file }}</span>
                    <span class="crumb-sep">›</span>
                    <span class="crumb-addr">{{ selected }}</span>
                    <MetaChip :text="current.part" tone="muted" />
                    <span class="doc-gap" />
                    <ToolButton variant="ghost">⧉ копировать адрес</ToolButton>
                </div>

                <h2 class="doc-title">{{ current.title }}</h2>

                <div class="doc-meta">
                    <template v-if="!live">
                        <span class="doc-lint">● lint чист</span>
                        <span class="doc-sep">·</span>
                    </template>
                    <span>обновлён</span>
                    <span class="doc-mono">
                        {{ live ? specs.section.value?.entry?.updated ?? "—" : mockReaderSection.entry.updated }}
                    </span>
                    <template v-if="live ? specs.section.value?.entry?.change : true">
                        <span class="doc-sep">·</span>
                        <span class="doc-mono">
                            {{ live ? specs.section.value?.entry?.change : mockReaderSection.entry.change }}
                        </span>
                    </template>
                    <span class="doc-sep">·</span>
                    <span>{{ changes.length }} открытых change'а</span>
                    <span class="doc-sep">·</span>
                    <span>{{ linkCount }} задач ссылаются</span>
                    <template v-if="!live">
                        <span class="doc-sep">·</span>
                        <span class="doc-mono">112 / {{ SECTION_LINE_CEILING }}</span>
                        <span>строк прозы</span>
                    </template>
                </div>

                <div class="doc-body">
                    <SpecParagraph
                        v-for="item in paragraphs"
                        :key="item.hash"
                        :mark="item.mark"
                        :task="item.task"
                    >
                        <span class="doc-text" v-html="inlineHtml(item.text)" />
                    </SpecParagraph>
                    <div v-if="live && !paragraphs.length" class="spec-empty">
                        Раздел найден, но текст пуст
                    </div>
                </div>
            </template>
            <div v-else class="spec-empty">Выберите раздел слева</div>
        </main>

        <aside class="spec-panel">
            <section class="panel-group">
                <Kicker>Состояние раздела</Kicker>
                <div class="panel-card">
                    <PanelRow
                        v-for="line in sectionState"
                        :key="line.text"
                        :icon="line.icon"
                        :text="line.text"
                        :meta="line.meta"
                        :tone="line.tone"
                    />
                </div>
            </section>

            <section class="panel-group">
                <Kicker>Открытые change'и</Kicker>
                <div class="panel-card">
                    <FocusRowItem
                        v-for="change in changes"
                        :key="change.id"
                        :id="change.id"
                        :title="change.title"
                        :count="change.record ? 'открыть карточку' : 'старый корень'"
                        kind="spec"
                        @click="change.record && openChange(change.id)"
                    />
                    <div v-if="!changes.length" class="spec-empty">
                        Ни одна задача не ссылается на раздел (todos set spec &lt;задача&gt;
                        &lt;домен&gt;#&lt;слаг&gt;)
                    </div>
                </div>
            </section>

            <section v-if="!live" class="panel-group">
                <Kicker>Упомянутые файлы</Kicker>
                <div class="panel-files">
                    <FileRow
                        v-for="file in mockMentionedFiles"
                        :key="file.path"
                        :path="file.path"
                        :exists="file.exists"
                    />
                </div>
            </section>

            <section class="panel-group">
                <Kicker>Ссылаются на раздел</Kicker>
                <div class="panel-card">
                    <FocusRowItem
                        v-for="link in sectionRefs"
                        :key="link.id"
                        :id="link.id"
                        :title="link.title"
                        :count="link.state"
                        :kind="link.kind"
                    />
                    <div v-if="!sectionRefs.length" class="spec-empty">
                        По этому разделу ещё никто не отвечал
                    </div>
                </div>
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
    overflow-x: hidden;
    overflow-y: auto;
}
.rail-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 10px 0 16px;
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
.doc-gap {
    flex: 1;
}
.doc-title {
    margin: 10px 0 8px;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
}
.doc-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-4);
}
.doc-lint {
    color: var(--ok);
}
.doc-sep {
    opacity: 0.5;
}
.doc-mono {
    font-family: var(--mono);
}
.doc-body {
    margin-top: 18px;
    max-width: 860px;
    border-top: 1px solid var(--stroke);
    padding-top: 8px;
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
.doc-text :deep(b) {
    color: var(--text);
    font-weight: 600;
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
.panel-card {
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(0, 0, 0, 0.2);
}
.panel-files {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 8px;
    padding: 8px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: rgba(0, 0, 0, 0.2);
}
.spec-empty {
    padding: 6px 4px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-4);
}
.spec-where {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 10.5px;
    word-break: break-all;
}
</style>
