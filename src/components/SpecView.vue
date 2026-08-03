<script setup lang="ts">
// Specs tab of the Tasks window (t#346) — the three levels of the model in one
// place: the spec section (long-lived state), the changes hanging off it, and
// each change's task graph.
//
// They are shown together because the failure the genre died of was the gap
// BETWEEN them: code moved and the section stayed put, and nothing put the two
// in the same field of view (t#338). The board already shows the graph; what it
// never showed is what the graph was supposed to be changing.
//
// The registry is not re-implemented here — `spec_domains`/`spec_section` shell
// out to `cli spec … --json`, the same parser the hooks read through. Where a
// project lives comes from `spec_projects` (Rust reads it back out of the
// transcripts, since a board's `project` is a basename, not a path).
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { renderInsightHelp } from "../insightHelp/render";
import { diffLines, diffHunks, diffStat, type DiffHunk } from "../specDiff";
import type { Todo } from "./TodoWindow.vue";

const { t, locale } = useI18n();

// `target` is a jump from a task card: an address plus the project that task
// belongs to, since the address alone does not say which registry it is in.
const props = defineProps<{
  todos: Todo[];
  project: string;
  target?: { address: string; project: string } | null;
}>();
const emit = defineEmits<{ (e: "open", id: string): void }>();

interface SectionEntry {
  slug: string;
  title: string;
  part: string;
  remote: boolean;
}
interface DomainEntry {
  id: string;
  version: number | null;
  updated: string | null;
  external: { repo: string | null; path: string | null } | null;
  sections: SectionEntry[];
  error?: string;
}
interface ProjectDir {
  project: string;
  dir: string;
  has_specs: boolean;
}
// What `spec show --json` hands back for one address (spec.mjs::showSection).
interface SectionBlock {
  text: string;
  hash: string;
}
interface SectionResponse {
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

const projectDirs = ref<ProjectDir[]>([]);
const dir = ref("");
const domains = ref<DomainEntry[]>([]);
const selected = ref("");
const section = ref<SectionResponse | null>(null);
const loading = ref(false);
const errorMsg = ref("");

const dirOf = (name: string) => projectDirs.value.find((p) => p.project === name)?.dir ?? "";

async function loadProjects() {
  try {
    projectDirs.value = await invoke<ProjectDir[]>("spec_projects");
  } catch (e) {
    projectDirs.value = [];
    errorMsg.value = String(e);
  }
  // The transcripts know every directory a session ever ran in — a `src-tauri`,
  // a scratchpad, someone's `node_modules`. Falling back to whatever sorted
  // first opened the tab on a temp directory and reported "no specs" about a
  // project holding two domains, so the fallback is the first project that
  // actually HAS a registry.
  dir.value =
    dirOf(props.target?.project ?? "") ||
    dirOf(props.project) ||
    projectDirs.value.find((p) => p.has_specs)?.dir ||
    projectDirs.value[0]?.dir ||
    "";
}

const currentDir = computed(() => projectDirs.value.find((p) => p.dir === dir.value));

async function loadDomains() {
  domains.value = [];
  selected.value = "";
  section.value = null;
  if (!dir.value) return;
  loading.value = true;
  errorMsg.value = "";
  try {
    domains.value = await invoke<DomainEntry[]>("spec_domains", { dir: dir.value });
    // A jump from a task card wins over "first section of the first domain":
    // the reader came here to see THAT section. An address the registry does
    // not hold falls back rather than opening on nothing.
    const wanted = props.target?.address;
    const known =
      wanted &&
      domains.value.some((d) => d.sections?.some((s) => `${d.id}#${s.slug}` === wanted));
    if (known) {
      select(wanted);
      return;
    }
    const first = domains.value.find((d) => d.sections?.length);
    if (first) select(`${first.id}#${first.sections[0].slug}`);
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function select(address: string) {
  selected.value = address;
  section.value = null;
  try {
    section.value = await invoke<SectionResponse>("spec_section", { dir: dir.value, address });
  } catch (e) {
    section.value = { unavailable: String(e) };
  }
}

watch(dir, loadDomains);
watch(() => props.project, () => {
  const d = dirOf(props.project);
  if (d) dir.value = d;
});
// A second jump while the tab is already open: same project → just select,
// different project → switching `dir` reloads and the target is honoured there.
watch(
  () => props.target,
  (target) => {
    if (!target) return;
    const d = dirOf(target.project);
    if (d && d !== dir.value) dir.value = d;
    else if (selected.value !== target.address) select(target.address);
  },
);
onMounted(async () => {
  await loadProjects();
  await loadDomains();
});

// --- the section's own text ---------------------------------------------------
//
// `showSection` hands back heading + metadata lines + prose as one block. The
// heading and the metadata are rendered as chips above, so they are stripped
// here rather than shown twice — a display concern only, which is why the
// VALUES come from `entry` (parsed by the registry) and never from this strip.
function proseOf(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = lines[0]?.startsWith("## ") ? 1 : 0;
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length && /^[a-zA-Z][\w-]*:\s/.test(lines[i])) i++;
  return lines.slice(i).join("\n").trim();
}

// Spec text is real markdown — tables, nested bullets, code spans — so it goes
// through `marked` rather than the app's insight-help mini-renderer, which was
// written for four constructs and would silently flatten a table. The input is
// the project's own `docs/specs`, read through the same registry the hooks use;
// it is repo content, not user input, and is not sanitised for the same reason
// the CLI prints it verbatim.
marked.setOptions({ gfm: true, breaks: false });
const sectionHtml = computed(() => {
  const src = section.value?.text ?? section.value?.stub ?? "";
  if (!src.trim()) return "";
  return marked.parse(proseOf(src), { async: false }) as string;
});

// --- who wrote THIS bullet ----------------------------------------------------
//
// The section-level link says "these six tasks are about this section" and
// leaves you no better off when you are looking at one bullet. Each answer of
// `updated` records the hashes of the blocks it actually moved, so the section
// can be rendered block by block with its own margin mark.
//
// Rendering per block instead of in one pass costs a little visual polish
// (markdown cannot see across a block boundary) and buys the only attribution
// that answers the question actually being asked.
const blockOwners = computed(() => {
  const m = new Map<string, Todo[]>();
  if (!selected.value) return m;
  for (const x of props.todos)
    for (const a of x.spec_answers ?? [])
      if (a.address === selected.value)
        for (const h of a.blocks ?? []) {
          if (!m.has(h)) m.set(h, []);
          if (!m.get(h)!.some((t) => t.id === x.id)) m.get(h)!.push(x);
        }
  return m;
});

const renderedBlocks = computed(() =>
  (section.value?.blocks ?? []).map((b) => ({
    hash: b.hash,
    html: marked.parse(b.text, { async: false }) as string,
    owners: blockOwners.value.get(b.hash) ?? [],
  })),
);

// Nothing to attribute (a fresh registry, or a section nobody has answered for)
// → render the section in one pass, which reads better.
const anyOwner = computed(() => renderedBlocks.value.some((b) => b.owners.length));

// A block can carry more than one mark, and that is not an edge case: two
// changes taking their baseline before either answers will both record the
// bullet they each added, and a bullet deleted and retyped verbatim hashes back
// to the same identity. So marks stack rather than overwrite, and the warning
// about concurrent changes is the same fact seen from the section's end.
const markedTasks = computed(() => {
  const seen = new Map<string, Todo>();
  for (const b of renderedBlocks.value) for (const o of b.owners) seen.set(o.id, o);
  return [...seen.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
});

// Colour is a BINDING cue, not a name: it is what makes the mark in the margin,
// the row in the change list and the chip in the legend read as one change
// without the eye having to match three-digit numbers. The number stays on the
// mark, because the colour alone is unlearnable — nothing in the board, the
// commits or the prose calls a change "the teal one".
//
// The hue comes off the task number by the golden angle, so neighbouring
// numbers — which is exactly what the tasks of one change are — land far apart
// on the wheel instead of shading into each other.
function hueOf(n: number): number {
  return Math.round(((n || 0) * 137.508) % 360);
}
function tagStyle(x: Todo) {
  const h = hueOf(x.number ?? 0);
  const open = isOpen(x);
  return {
    color: `hsl(${h} 72% ${open ? 76 : 62}%)`,
    borderColor: `hsl(${h} 55% ${open ? 46 : 34}%)`,
    background: `hsl(${h} 45% ${open ? 20 : 15}%)`,
  };
}
const ruleStyle = (owners: Todo[]) =>
  owners.length ? { borderLeftColor: `hsl(${hueOf(owners[0].number ?? 0)} 60% 45%)` } : {};

// Focus: standing on one change and dimming every bullet it did not write. The
// section-level link could only ever say "these six tasks are about this
// section"; this says which four lines out of ninety one of them is.
const focus = ref("");
const toggleFocus = (id: string) => (focus.value = focus.value === id ? "" : id);
watch(selected, () => (focus.value = ""));
const dimmed = (owners: Todo[]) => !!focus.value && !owners.some((o) => o.id === focus.value);
// A change with no recorded blocks cannot be focused — there is nothing to
// light up, and dimming the whole section would read as "it touched nothing".
const focusable = (id: string) => markedTasks.value.some((x) => x.id === id);

// --- what the change did to the section ---------------------------------------
//
// The marks say which bullets a change wrote; they cannot say what those
// bullets REPLACED, and a spec delta is usually a rewrite — the old wording is
// half the story and survives nowhere else once the file is saved. So a change
// carries its own diff of the section, the way a commit does.
//
// Two sources, and the difference between them matters enough to be labelled:
//   frozen — the task answered `updated`, so the after-side was recorded then.
//            Reading it off the live file instead would answer a different
//            question every time the spec moves on.
//   live   — the task is still open: no answer yet, so the after-side is the
//            file as it stands. This is the "what is about to change" view, and
//            it moves under you, which is exactly right while the work is open.
//
// Built the same way `spec_seen.text` is (todos.mjs::recordSpecBaseline) —
// blocks joined by a newline — or the two sides would differ by whitespace
// alone and every section would read as rewritten.
const sectionText = computed(() =>
  (section.value?.blocks ?? []).map((b) => b.text).join("\n"),
);

interface Delta {
  hunks: DiffHunk[];
  stat: { added: number; removed: number };
  live: boolean;
}

const deltas = computed(() => {
  const m = new Map<string, Delta>();
  if (!selected.value) return m;
  for (const x of props.todos) {
    const seen = (x.spec_seen ?? []).find((s) => s.address === selected.value);
    if (!seen?.text) continue;
    const answer = (x.spec_answers ?? []).find((a) => a.address === selected.value);
    const after = answer?.after ?? (isOpen(x) ? sectionText.value : "");
    if (!after) continue;
    const lines = diffLines(seen.text, after);
    const stat = diffStat(lines);
    if (!stat.added && !stat.removed) continue;
    m.set(x.id, { hunks: diffHunks(lines), stat, live: !answer?.after });
  }
  return m;
});

const openDiff = ref("");
const toggleDiff = (id: string) => (openDiff.value = openDiff.value === id ? "" : id);
watch(selected, () => (openDiff.value = ""));

// --- per-block help (the `?` triggers) ----------------------------------------
//
// Same affordance and same text pipeline as the analytics tiles: a short
// markdown string in i18n through the shared insight renderer. Inline rather
// than a floating popover — this pane already scrolls, so expanding in place
// costs nothing and needs no positioning maths.
const HELP_CACHE = new Map<string, string>();
const openHelp = ref("");
function helpHtml(key: string): string {
  const cacheKey = `${key}.${locale.value}`;
  const cached = HELP_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const html = renderInsightHelp(t(key));
  HELP_CACHE.set(cacheKey, html);
  return html;
}
const toggleHelp = (key: string) => (openHelp.value = openHelp.value === key ? "" : key);

const byId = computed(() => {
  const m = new Map<string, Todo>();
  for (const x of props.todos) m.set(x.id, x);
  return m;
});

// --- which change touches which section --------------------------------------
//
// Reading the section told you what the state is; nothing told you what is
// being DONE to it right now. So the changes pointing at a section are shown
// alongside it — the margin-marker idea, borrowed from documents with comments.
//
// The links themselves are still section-granular: a task points at a section,
// never at a line. What is line-granular is the ATTRIBUTION above, recovered
// from the block hashes each answer recorded.
const isOpen = (t: Todo) => t.status !== "done";

const linkedBySection = computed(() => {
  const m = new Map<string, Todo[]>();
  for (const x of props.todos)
    for (const a of x.spec ?? []) {
      if (!m.has(a)) m.set(a, []);
      m.get(a)!.push(x);
    }
  return m;
});

const marksFor = (address: string) =>
  (linkedBySection.value.get(address) ?? [])
    .slice()
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));

// The list answers "what changes touch this section". The question that stayed
// unanswered is the OTHER one — "which section does this change go to" — and no
// amount of marking sections answers it, because the reader is starting from
// the change. So the sidebar groups both ways and the direction is a toggle.
const groupMode = ref<"sections" | "changes">("sections");

const changeGroups = computed(() => {
  const groups = props.todos
    .filter((x) => (x.spec ?? []).length)
    .map((task) => ({ task, addresses: task.spec ?? [] }));
  return groups.sort((a, b) => {
    const open = Number(isOpen(b.task)) - Number(isOpen(a.task));
    if (open) return open;
    const root = Number(!!b.task.change) - Number(!!a.task.change);
    if (root) return root;
    return (a.task.number ?? 0) - (b.task.number ?? 0);
  });
});

// A section's title for the change-grouped list — the address alone reads as a
// slug, and the reader here has not seen the section yet.
const titleOf = (address: string) => {
  const [domain, slug] = address.split("#");
  return domains.value.find((d) => d.id === domain)?.sections?.find((s) => s.slug === slug)?.title ?? "";
};

// Two or more OPEN changes on one section: the second stamp overwrites the
// first's provenance silently. `spec lint` warns about it too — this is the
// same fact where the eye already is.
const concurrent = (address: string) =>
  marksFor(address).filter((t) => t.change && isOpen(t)).length > 1;

// Tasks whose OWN `spec` names the selected section. A change root among them
// is rendered with its children under it — that is the third level, and it is
// drawn from the same dependency edges the board's graph uses.
const linked = computed(() => {
  if (!selected.value) return [];
  return props.todos.filter((x) => (x.spec ?? []).includes(selected.value));
});

const childrenOf = (root: Todo) =>
  (root.depends_on ?? []).map((id) => byId.value.get(id)).filter((x): x is Todo => !!x);

// Every answer ever given about this section, newest first — the log §9 of the
// genre rules asks to be able to review: a section answered `unchanged` five
// times in the same words is the same rot on a new layer, and that is only
// visible when the answers sit side by side.
const answers = computed(() => {
  if (!selected.value) return [];
  const out: { task: Todo; verdict: string; note: string; at: string }[] = [];
  for (const x of props.todos)
    for (const a of x.spec_answers ?? [])
      if (a.address === selected.value)
        out.push({ task: x, verdict: a.verdict, note: a.note, at: a.at });
  return out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
});

const shortDate = (iso: string) => (iso || "").slice(0, 10);
</script>

<template>
  <div class="sv-root">
    <aside class="sv-side">
      <div class="sv-pick">
        <select v-model="dir" class="sv-select" :title="dir">
          <option v-for="p in projectDirs" :key="p.dir" :value="p.dir" :title="p.dir">
            {{ p.has_specs ? "" : "· " }}{{ p.project }}
          </option>
        </select>
        <button class="sv-refresh" :title="t('specRefresh')" @click="loadDomains">↻</button>
        <button
          class="sv-help"
          :title="t(openHelp === 'specHelpRegistry' ? 'hideHelp' : 'showHelp')"
          :aria-expanded="openHelp === 'specHelpRegistry'"
          @click="toggleHelp('specHelpRegistry')"
        >?</button>
      </div>
      <div
        v-if="openHelp === 'specHelpRegistry'"
        class="sv-help-body"
        v-html="helpHtml('specHelpRegistry')"
      ></div>

      <div v-if="loading" class="sv-empty">{{ t("loading") }}</div>
      <div v-else-if="errorMsg" class="sv-error">{{ errorMsg }}</div>
      <!-- Naming the directory that was searched: "no specs" is otherwise
           indistinguishable from "you are looking at the wrong project". -->
      <div v-else-if="!domains.length" class="sv-empty">
        {{ t("specNoDomains") }}
        <div class="sv-where">{{ dir || "—" }}</div>
        <div v-if="projectDirs.some((p) => p.has_specs) && !currentDir?.has_specs" class="sv-where">
          {{ t("specTryThese") }}
          {{ projectDirs.filter((p) => p.has_specs).map((p) => p.project).join(", ") }}
        </div>
      </div>

      <div v-if="domains.length" class="sv-group" role="tablist">
        <button
          class="sv-group-btn"
          :class="{ active: groupMode === 'sections' }"
          role="tab"
          :aria-selected="groupMode === 'sections'"
          @click="groupMode = 'sections'"
        >{{ t("specBySection") }}</button>
        <button
          class="sv-group-btn"
          :class="{ active: groupMode === 'changes' }"
          role="tab"
          :aria-selected="groupMode === 'changes'"
          @click="groupMode = 'changes'"
        >{{ t("specByChange") }}</button>
      </div>

      <template v-if="groupMode === 'sections'">
        <div v-for="d in domains" :key="d.id" class="sv-domain">
          <div class="sv-domain-head">
            <span class="sv-domain-id">{{ d.id }}</span>
            <span v-if="d.version != null" class="sv-domain-v">v{{ d.version }}</span>
            <span v-if="d.external" class="sv-ext">{{ t("specExternal") }}</span>
          </div>
          <div v-if="d.error" class="sv-error">{{ d.error }}</div>
          <button
            v-for="s in d.sections"
            :key="s.slug"
            class="sv-section"
            :class="{ active: selected === `${d.id}#${s.slug}` }"
            @click="select(`${d.id}#${s.slug}`)"
          >
            <span class="sv-section-top">
              <span class="sv-slug">{{ s.slug }}</span>
              <span
                v-if="concurrent(`${d.id}#${s.slug}`)"
                class="sv-mark-warn"
                :title="t('specConcurrent')"
              >⚠</span>
              <span class="sv-part" :class="`p-${s.part}`">{{ s.part }}</span>
            </span>
            <span class="sv-title">{{ s.title }}</span>
          </button>
        </div>
      </template>

      <!-- The same links read from the other end: a change, then the sections it
           is a delta of. The section-first list can never answer this — the
           reader starts from the change and does not know where to look. -->
      <template v-else>
        <div v-if="!changeGroups.length" class="sv-empty">{{ t("specNoChanges") }}</div>
        <div v-for="g in changeGroups" :key="g.task.id" class="sv-cgroup">
          <button
            class="sv-cgroup-head"
            :class="{ closed: !isOpen(g.task) }"
            :style="{ borderLeftColor: `hsl(${hueOf(g.task.number ?? 0)} 60% 45%)` }"
            @click="emit('open', g.task.id)"
          >
            <span class="sv-badge" :class="`st-${g.task.status}`">{{ g.task.status }}</span>
            <span v-if="g.task.change" class="sv-chip">change</span>
            <span class="sv-num" :style="{ color: tagStyle(g.task).color }">#{{ g.task.number }}</span>
            <span class="sv-subject">{{ g.task.subject }}</span>
          </button>
          <button
            v-for="a in g.addresses"
            :key="a"
            class="sv-section sv-cgroup-sec"
            :class="{ active: selected === a }"
            @click="select(a)"
          >
            <span class="sv-slug">{{ a }}</span>
            <span class="sv-title">{{ titleOf(a) }}</span>
          </button>
        </div>
      </template>
    </aside>

    <main class="sv-main">
      <div v-if="!selected" class="sv-empty">{{ t("specPickSection") }}</div>
      <template v-else>
        <header class="sv-head">
          <span class="sv-address">{{ selected }}</span>
          <span v-if="section?.entry?.part" class="sv-part" :class="`p-${section.entry.part}`">
            {{ section.entry.part }}
          </span>
          <span class="sv-spacer"></span>
          <span v-if="section?.entry?.updated" class="sv-prov">
            {{ section.entry.updated }}
            <template v-if="section.entry.change"> · {{ section.entry.change }}</template>
          </span>
          <button
            class="sv-help"
            :title="t(openHelp === 'specHelpSection' ? 'hideHelp' : 'showHelp')"
            :aria-expanded="openHelp === 'specHelpSection'"
            @click="toggleHelp('specHelpSection')"
          >?</button>
        </header>
        <h2 v-if="section?.entry?.title" class="sv-h2">{{ section.entry.title }}</h2>
        <div
          v-if="openHelp === 'specHelpSection'"
          class="sv-help-body"
          v-html="helpHtml('specHelpSection')"
        ></div>

        <div v-if="section?.entry?.refs?.length" class="sv-refs">
          <span class="sv-refs-lbl">refs</span>
          <button
            v-for="r in section.entry.refs"
            :key="r"
            class="sv-refchip"
            @click="select(r)"
          >{{ r }}</button>
        </div>

        <div v-if="section?.unavailable" class="sv-note">{{ section.unavailable }}</div>

        <!-- Block by block, each with the task that last moved it in the
             margin. Falls back to one pass when nothing is attributed yet. -->
        <div v-if="anyOwner" class="sv-legend">
          <button
            v-for="x in markedTasks"
            :key="x.id"
            class="sv-tag sv-legend-tag"
            :class="{ closed: !isOpen(x), on: focus === x.id, off: focus && focus !== x.id }"
            :style="tagStyle(x)"
            :title="t('specFocus')"
            @click="toggleFocus(x.id)"
          >
            <span class="sv-tag-n">#{{ x.number }}</span>
            <span class="sv-legend-subj">{{ x.subject }}</span>
          </button>
          <button v-if="focus" class="sv-clear" @click="focus = ''">{{ t("specFocusOff") }}</button>
        </div>
        <div v-if="anyOwner" class="sv-blocks">
          <div
            v-for="b in renderedBlocks"
            :key="b.hash"
            class="sv-block-row"
            :class="{ owned: b.owners.length, dim: dimmed(b.owners) }"
            :style="ruleStyle(b.owners)"
          >
            <div class="sv-block-mark">
              <button
                v-for="o in b.owners"
                :key="o.id"
                class="sv-tag"
                :class="{ closed: !isOpen(o), on: focus === o.id }"
                :style="tagStyle(o)"
                :title="`#${o.number} ${o.subject} [${o.status}] — ${t('specFocus')}`"
                @click="toggleFocus(o.id)"
              >#{{ o.number }}</button>
            </div>
            <div class="sv-md" v-html="b.html"></div>
          </div>
        </div>
        <article v-else-if="sectionHtml" class="sv-md" v-html="sectionHtml"></article>

        <section class="sv-block">
          <h3>
            {{ t("specChanges") }}
            <button
              class="sv-help"
              :title="t(openHelp === 'specHelpChanges' ? 'hideHelp' : 'showHelp')"
              :aria-expanded="openHelp === 'specHelpChanges'"
              @click="toggleHelp('specHelpChanges')"
            >?</button>
          </h3>
          <div
            v-if="openHelp === 'specHelpChanges'"
            class="sv-help-body"
            v-html="helpHtml('specHelpChanges')"
          ></div>
          <div v-if="concurrent(selected)" class="sv-warn">⚠ {{ t("specConcurrent") }}</div>
          <div v-if="!linked.length" class="sv-empty">{{ t("specNoChanges") }}</div>
          <div
            v-for="x in linked"
            :key="x.id"
            class="sv-change"
            :class="{ on: focus === x.id }"
            :style="{ borderLeftColor: `hsl(${hueOf(x.number ?? 0)} 60% 45%)` }"
          >
            <div class="sv-change-row">
              <button class="sv-task" @click="emit('open', x.id)">
                <span class="sv-badge" :class="`st-${x.status}`">{{ x.status }}</span>
                <span v-if="x.change" class="sv-chip">change</span>
                <span class="sv-num" :style="{ color: tagStyle(x).color }">#{{ x.number }}</span>
                <span class="sv-subject">{{ x.subject }}</span>
              </button>
              <!-- Only a change that recorded blocks can be focused: dimming the
                   whole section for one that recorded none would read as a
                   claim that it touched nothing, which is not what it means. -->
              <button
                v-if="focusable(x.id)"
                class="sv-focus"
                :class="{ on: focus === x.id }"
                :title="t('specFocus')"
                @click="toggleFocus(x.id)"
              >◉</button>
            </div>
            <!-- The delta itself. `live` is not a caveat in small print: an
                 open change's diff moves under the reader, and calling it
                 anything else would be a lie about what is being looked at. -->
            <button
              v-if="deltas.get(x.id)"
              class="sv-diff-toggle"
              :class="{ on: openDiff === x.id }"
              @click="toggleDiff(x.id)"
            >
              <span class="sv-diff-add">+{{ deltas.get(x.id)!.stat.added }}</span>
              <span class="sv-diff-del">−{{ deltas.get(x.id)!.stat.removed }}</span>
              <span class="sv-diff-lbl">
                {{ deltas.get(x.id)!.live ? t("specDiffLive") : t("specDiffFrozen") }}
              </span>
            </button>
            <div v-if="openDiff === x.id" class="sv-diff">
              <div v-for="(h, hi) in deltas.get(x.id)!.hunks" :key="hi" class="sv-hunk">
                <div class="sv-hunk-head">@@ −{{ h.beforeStart }} +{{ h.afterStart }} @@</div>
                <div
                  v-for="(l, li) in h.lines"
                  :key="li"
                  class="sv-dline"
                  :class="{ add: l.op === '+', del: l.op === '-' }"
                ><span class="sv-dop">{{ l.op }}</span>{{ l.text }}</div>
              </div>
            </div>
            <div v-if="x.change" class="sv-children">
              <button
                v-for="c in childrenOf(x)"
                :key="c.id"
                class="sv-task sv-child"
                @click="emit('open', c.id)"
              >
                <span class="sv-badge" :class="`st-${c.status}`">{{ c.status }}</span>
                <span class="sv-num">#{{ c.number }}</span>
                <span class="sv-subject">{{ c.subject }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="sv-block">
          <h3>
            {{ t("specAnswers") }}
            <button
              class="sv-help"
              :title="t(openHelp === 'specHelpAnswers' ? 'hideHelp' : 'showHelp')"
              :aria-expanded="openHelp === 'specHelpAnswers'"
              @click="toggleHelp('specHelpAnswers')"
            >?</button>
          </h3>
          <div
            v-if="openHelp === 'specHelpAnswers'"
            class="sv-help-body"
            v-html="helpHtml('specHelpAnswers')"
          ></div>
          <div v-if="!answers.length" class="sv-empty">{{ t("specNoAnswers") }}</div>
          <div v-for="(a, i) in answers" :key="i" class="sv-answer">
            <span class="sv-verdict" :class="`v-${a.verdict}`">{{ a.verdict }}</span>
            <button
              class="sv-num sv-link"
              :style="{ color: tagStyle(a.task).color }"
              @click="emit('open', a.task.id)"
            >#{{ a.task.number }}</button>
            <span class="sv-at">{{ shortDate(a.at) }}</span>
            <span class="sv-answer-note">{{ a.note }}</span>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.sv-root {
  display: flex;
  gap: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.sv-side {
  flex: 0 0 300px;
  overflow-y: auto;
  border-right: 1px solid var(--tw-border, #2a2f3a);
  padding: 10px 10px 24px 14px;
}
.sv-pick {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  position: sticky;
  top: -10px;
  padding: 10px 0 8px;
  margin-top: -10px;
  background: var(--tw-bg, #12151c);
  z-index: 2;
}
.sv-select {
  flex: 1;
  min-width: 0;
  background: var(--tw-input-bg, #1a1e27);
  color: inherit;
  border: 1px solid var(--tw-border, #2a2f3a);
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 12px;
}
.sv-refresh,
.sv-help {
  background: none;
  border: 1px solid var(--tw-border, #2a2f3a);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  padding: 0 8px;
  opacity: 0.6;
  font-size: 12px;
  line-height: 1.7;
}
.sv-refresh:hover,
.sv-help:hover,
.sv-help[aria-expanded="true"] {
  opacity: 1;
  border-color: #4cc2ff;
}
.sv-help-body {
  border-left: 2px solid #4cc2ff;
  padding: 2px 0 2px 10px;
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.9;
}
.sv-help-body :deep(p) {
  margin: 0 0 6px;
}
.sv-help-body :deep(ul) {
  margin: 0 0 6px;
  padding-left: 16px;
}
.sv-help-body :deep(code) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
  opacity: 0.9;
}
.sv-domain {
  margin-bottom: 16px;
}
.sv-domain-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  opacity: 0.75;
  margin-bottom: 5px;
  padding-left: 8px;
}
.sv-domain-id {
  font-weight: 600;
  opacity: 1;
  letter-spacing: 0.02em;
}
.sv-domain-v,
.sv-ext {
  font-size: 10px;
  opacity: 0.7;
}
.sv-ext {
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
}
.sv-section {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  color: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 0 5px 5px 0;
}
.sv-section:hover {
  background: var(--tw-hover, #1e2330);
}
.sv-section.active {
  background: var(--tw-hover, #1e2330);
  border-left-color: #4cc2ff;
}
.sv-section-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.sv-slug {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.sv-title {
  display: block;
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Margin marks: one dot per change touching the section, coloured by task
   number so the same change reads as the same colour in the list, in the header
   and in the block below. A closed one keeps its place but stops shouting. */
.sv-marks {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  margin-right: 4px;
}
.sv-mark {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 9.5px;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, #4cc2ff 18%, transparent);
  color: #9fd8f5;
  flex: 0 0 auto;
}
.sv-mark.root {
  background: color-mix(in srgb, #ffb454 20%, transparent);
  color: #ffd39a;
}
.sv-mark.closed {
  background: none;
  color: inherit;
  opacity: 0.35;
}
.sv-group {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.sv-group-btn {
  flex: 1;
  background: none;
  border: 1px solid var(--tw-border, #2a2f3a);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  padding: 3px 6px;
  font-size: 11.5px;
  opacity: 0.6;
}
.sv-group-btn.active {
  opacity: 1;
  border-color: #4cc2ff;
}
.sv-cgroup {
  margin-bottom: 12px;
}
.sv-cgroup-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  color: inherit;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 0 5px 5px 0;
  font-size: 12px;
}
.sv-cgroup-head:hover {
  background: var(--tw-hover, #1e2330);
}
.sv-cgroup-head.closed {
  opacity: 0.5;
}
.sv-cgroup-sec {
  margin-left: 14px;
  width: calc(100% - 14px);
  border-left: 1px solid var(--tw-border, #2a2f3a);
}
.sv-mark-warn {
  font-size: 10px;
  color: #ffb454;
}
/* Colour identifies the change, the number names it — both on every mark, so
   the margin can be scanned by colour and still read out loud by number. */
.sv-tag {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10.5px;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 0 5px;
  cursor: pointer;
  white-space: nowrap;
}
.sv-tag.closed {
  opacity: 0.55;
}
.sv-tag.on {
  box-shadow: 0 0 0 1px currentColor;
}
.sv-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin: 0 0 12px;
  max-width: 78ch;
}
.sv-legend-tag {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  max-width: 30ch;
}
.sv-legend-tag.off {
  opacity: 0.4;
}
.sv-legend-subj {
  font-family: inherit;
  font-size: 11px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-clear {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
  font-size: 11px;
  text-decoration: underline;
}
.sv-clear:hover {
  opacity: 1;
}
.sv-focus {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.3;
  cursor: pointer;
  font-size: 11px;
  padding: 0 4px;
}
.sv-focus:hover,
.sv-focus.on {
  opacity: 1;
  color: #4cc2ff;
}
.sv-warn {
  border-left: 2px solid #ffb454;
  padding: 5px 10px;
  margin-bottom: 8px;
  font-size: 12px;
}
.sv-part {
  font-size: 9.5px;
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
  background: #333a48;
  opacity: 0.85;
}
.p-требования {
  background: #24455c;
}
.p-устройство {
  background: #3a3550;
}
.p-инварианты {
  background: #4c3a24;
}
.sv-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 20px 32px;
}
.sv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: -10px;
  padding: 10px 0 6px;
  margin-top: -10px;
  background: var(--tw-bg, #12151c);
  z-index: 2;
}
.sv-spacer {
  flex: 1;
}
.sv-address {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  opacity: 0.65;
}
.sv-prov {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.45;
}
.sv-h2 {
  font-size: 17px;
  font-weight: 600;
  margin: 2px 0 10px;
}
.sv-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}
.sv-refs-lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.45;
}
.sv-refchip {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  background: none;
  border: 1px solid var(--tw-border, #2a2f3a);
  border-radius: 5px;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
  padding: 1px 6px;
}
.sv-refchip:hover {
  opacity: 1;
  border-color: #4cc2ff;
}
.sv-note {
  border-left: 2px solid #ffc107;
  padding: 6px 10px;
  margin-bottom: 12px;
  font-size: 12px;
}
/* Margin attribution: a narrow gutter for the task marks, the block itself to
   its right. Blocks nobody has claimed keep the gutter empty so the text stays
   on one left edge instead of jumping. */
.sv-blocks {
  margin: 0 0 22px;
  max-width: 78ch;
}
.sv-block-row {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 8px;
  align-items: start;
  border-left: 2px solid transparent;
  padding-left: 4px;
  transition: opacity 0.12s;
}
/* Only a rule in the gutter, no fill: a section written end to end by one
   change would otherwise be one solid tinted rectangle, which says nothing.
   The rule takes the colour of the first mark; the rest are read off the tags. */
.sv-block-row:hover {
  background: color-mix(in srgb, #4cc2ff 5%, transparent);
}
.sv-block-row.dim {
  opacity: 0.24;
}
.sv-block-row.dim:hover {
  opacity: 0.55;
}
.sv-block-mark {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding-top: 2px;
}
.sv-block-row .sv-md {
  margin-bottom: 0;
}
.sv-block-row .sv-md :deep(p:last-child),
.sv-block-row .sv-md :deep(ul:last-child) {
  margin-bottom: 6px;
}
.sv-md {
  font-size: 13px;
  line-height: 1.62;
  max-width: 78ch;
  margin: 0 0 22px;
}
.sv-md :deep(p) {
  margin: 0 0 10px;
}
.sv-md :deep(ul),
.sv-md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}
.sv-md :deep(li) {
  margin: 0 0 5px;
}
.sv-md :deep(li > ul) {
  margin-top: 5px;
}
.sv-md :deep(code) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.9em;
  background: var(--tw-input-bg, #1a1e27);
  border-radius: 4px;
  padding: 1px 4px;
}
.sv-md :deep(pre) {
  background: var(--tw-input-bg, #161a22);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
}
.sv-md :deep(pre code) {
  background: none;
  padding: 0;
}
.sv-md :deep(table) {
  border-collapse: collapse;
  margin: 0 0 12px;
  font-size: 12.5px;
  display: block;
  overflow-x: auto;
}
.sv-md :deep(th),
.sv-md :deep(td) {
  border: 1px solid var(--tw-border, #2a2f3a);
  padding: 4px 9px;
  text-align: left;
  vertical-align: top;
}
.sv-md :deep(th) {
  background: var(--tw-input-bg, #1a1e27);
  font-weight: 600;
}
.sv-md :deep(blockquote) {
  border-left: 2px solid var(--tw-border, #2a2f3a);
  margin: 0 0 10px;
  padding-left: 12px;
  opacity: 0.8;
}
.sv-md :deep(a) {
  color: #4cc2ff;
}
.sv-block h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.55;
  margin: 0 0 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--tw-border, #2a2f3a);
}
.sv-block h3 .sv-help {
  text-transform: none;
  letter-spacing: 0;
}
.sv-block {
  margin-bottom: 22px;
  max-width: 78ch;
}
/* The same colour the change wears in the margin, so a row here and a mark up
   there are recognisably one thing without reading either number. */
.sv-change {
  border-left: 2px solid transparent;
  padding-left: 6px;
  margin-bottom: 4px;
}
.sv-change.on {
  background: color-mix(in srgb, #4cc2ff 6%, transparent);
}
.sv-change-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sv-task {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 4px 5px;
  border-radius: 5px;
  font-size: 12.5px;
}
.sv-task:hover {
  background: var(--tw-hover, #1e2330);
}
.sv-diff-toggle {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.6;
  padding: 0 5px 3px 5px;
}
.sv-diff-toggle:hover,
.sv-diff-toggle.on {
  opacity: 1;
}
.sv-diff-add {
  color: #6fbf73;
}
.sv-diff-del {
  color: #e07c7c;
}
.sv-diff-lbl {
  font-family: inherit;
  font-size: 10px;
  opacity: 0.6;
}
.sv-diff {
  border: 1px solid var(--tw-border, #2a2f3a);
  border-radius: 6px;
  margin: 2px 0 8px;
  padding: 4px 0;
  overflow-x: auto;
  background: var(--tw-input-bg, #161a22);
}
.sv-hunk + .sv-hunk {
  border-top: 1px solid var(--tw-border, #2a2f3a);
  margin-top: 4px;
  padding-top: 4px;
}
.sv-hunk-head {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  opacity: 0.35;
  padding: 0 10px 2px;
}
.sv-dline {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  padding: 0 10px 0 0;
  opacity: 0.65;
}
.sv-dline.add {
  background: color-mix(in srgb, #6fbf73 12%, transparent);
  opacity: 1;
}
.sv-dline.del {
  background: color-mix(in srgb, #e07c7c 12%, transparent);
  opacity: 1;
}
.sv-dop {
  display: inline-block;
  width: 18px;
  text-align: center;
  opacity: 0.55;
}
.sv-children {
  margin-left: 20px;
  border-left: 1px solid var(--tw-border, #2a2f3a);
  padding-left: 8px;
}
.sv-badge {
  font-size: 9.5px;
  border-radius: 4px;
  padding: 1px 5px;
  background: #333a48;
  white-space: nowrap;
}
.st-in_progress {
  background: #1d4f6b;
}
.st-review {
  background: #4a3a6b;
}
.st-done {
  background: #2f5a2a;
}
.sv-chip {
  font-size: 9.5px;
  border-radius: 4px;
  padding: 1px 5px;
  background: #5a4a1d;
}
.sv-num {
  font-family: ui-monospace, Consolas, monospace;
  opacity: 0.7;
  white-space: nowrap;
}
.sv-link {
  background: none;
  border: none;
  color: #4cc2ff;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
}
.sv-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-answer {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  padding: 4px 5px;
  border-bottom: 1px solid color-mix(in srgb, var(--tw-border, #2a2f3a) 55%, transparent);
}
.sv-answer:last-child {
  border-bottom: none;
}
.sv-verdict {
  font-size: 9.5px;
  border-radius: 4px;
  padding: 1px 5px;
  background: #333a48;
  white-space: nowrap;
}
.v-updated {
  background: #2f5a2a;
}
.v-unchanged {
  background: #3a4150;
}
.sv-at {
  opacity: 0.45;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  white-space: nowrap;
}
.sv-answer-note {
  opacity: 0.85;
  line-height: 1.45;
}
.sv-where {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
  margin-top: 4px;
  word-break: break-all;
}
.sv-empty,
.sv-error {
  font-size: 12px;
  opacity: 0.6;
  padding: 6px 2px;
}
.sv-error {
  color: #ff8a8a;
  opacity: 1;
}
</style>
