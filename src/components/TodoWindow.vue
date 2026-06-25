<script setup lang="ts">
// Standalone task manager, rendered when index.html is loaded with the `#todos`
// hash (see tauri.conf.json `todos` window). The tracker OWNS the todo list: the
// user creates/edits tasks here, they're persisted to `todos.json` in the app
// data dir, and a Claude Code SessionStart hook reads that file to surface the
// active ones for the current project. Claude only flips `status` (and edits
// details on request) by rewriting the same file.
//
// The view is a kanban board: one column per status, cards drag between columns
// (which persists the new status). Columns mirror `todos.rs::STATUSES`.
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n, type Composer } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import ProjectAutocomplete from "./ProjectAutocomplete.vue";
import ProjectLabel from "./ProjectLabel.vue";
import { useProjectLinks } from "../projectLinks";
import i18n from "../i18n";
import type { TriageDigest, DigestItem } from "../App.vue";

const { t, locale } = useI18n();

// Apply a locale to BOTH this component's composer and the canonical global
// i18n instance. Setting only the composer's `locale` proved unreliable in this
// standalone window, so we also push it onto `i18n.global` directly.
function applyLocale(l: string | null | undefined) {
  if (l !== "en" && l !== "ru") return;
  locale.value = l;
  (i18n.global as Composer).locale.value = l;
}

// Each Tauri window is a separate WebView; vue-i18n boots from navigator
// language and doesn't see the popup's saved locale. Read it from the shared
// store so this window opens in the same language the user picked.
async function loadLocaleFromStore() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    applyLocale(await store.get<string>("locale"));
  } catch {
    // store missing or unreadable → keep detected default
  }
}

export interface Comment {
  id: string;
  author: string; // "user" | "claude"
  body: string;
  created_at: string;
}
export interface Todo {
  id: string;
  number?: number; // stable human-facing number for inline #N references
  subject: string;
  description: string;
  status: string;
  priority?: string; // "high" | "medium" | "low" | "" (unset) — drives hook context
  estimate_minutes?: number | null;
  scheduled_for?: string | null;
  plan: string;
  project?: string | null;
  from?: string | null; // project this task was filed from (cross-project; issue #13)
  comments?: Comment[];
  links?: string[];
  created_by?: string; // "user" | "claude" ("" / absent = user, no AI badge)
  created_at: string;
  updated_at: string;
}

// Phase plans (issue #16) authored by the cc-phases CLI and read from each
// project's `.claude/phases/<N>.md`. Read-only here: the board shows a task's
// phases as checkboxes (done → struck through); the CLI is the only writer.
export interface Subphase {
  num: number;
  title: string;
  text: string;
  done: boolean;
}
export interface Phase {
  num: number;
  title: string;
  desc: string;
  done: boolean;
  subs: Subphase[];
}
export interface PhasePlan {
  task_number: number;
  project: string;
  // The plan's north star (README `## Vision`), surfaced read-only above the
  // phase checklist. null when the section is empty / still the placeholder.
  vision: string | null;
  phases: Phase[];
}

// Kanban columns, left to right — must match `todos.rs::STATUSES`. `dot` is the
// column's accent colour, also used for each card's left stripe.
interface Column {
  id: string;
  labelKey: string;
  dot: string;
}
const COLUMNS: Column[] = [
  { id: "backlog", labelKey: "colBacklog", dot: "#9aa0aa" },
  { id: "queue", labelKey: "colQueue", dot: "#ffc107" },
  { id: "in_progress", labelKey: "statusInProgress", dot: "#4cc2ff" },
  { id: "review", labelKey: "colReview", dot: "#b388ff" },
  { id: "done", labelKey: "statusDone", dot: "#6ccb5f" },
];
const COL_BY_ID: Record<string, Column> = Object.fromEntries(
  COLUMNS.map((c) => [c.id, c]),
);

const todos = ref<Todo[]>([]);
const loading = ref(true);
const errorMsg = ref("");

// Filters
const projectFilter = ref<string>(""); // "" = all
const showDone = ref(false);
const search = ref("");

// Drag-and-drop state: id of the card being dragged + id of the column hovered.
const dragId = ref<string | null>(null);
const overCol = ref<string | null>(null);

// Live reload: a watcher in the backend emits `todos-file-changed` when
// todos.json changes on disk (CLI / Claude / hand-edit). We defer the reload
// while a drag or the form is open so it never yanks state from under the user.
const pendingReload = ref(false);

// Form state (doubles as create + edit). editingId === null → creating.
const editingId = ref<string | null>(null);
const fSubject = ref("");
const fDescription = ref("");
const fEstimate = ref<number | null>(null);
const fScheduled = ref("");
const fPlan = ref("");
const fProject = ref("");
// Column a freshly created task lands in (set by the column's "+" button).
const formStatus = ref("backlog");
// Priority bucket for the new-task form; "" = unset. Mirrors todos.rs::PRIORITIES.
const fPriority = ref("");
const formOpen = ref(false);

// Priority buckets, most→least important; "" = unset. The <select>s offer these
// plus an empty option. Kept in lockstep with todos.rs / the cc-todos CLI.
const PRIORITY_LEVELS = ["high", "medium", "low"] as const;

// Projects the tracker has seen (from cc_usage), so the picker offers real
// projects even before any todo uses them.
const knownProjects = ref<string[]>([]);

// Phase plans keyed by `${project}::${task_number}` for O(1) lookup per card.
// Read-only: authored by the cc-phases CLI in each project's .claude/phases/.
const phasePlans = ref<Map<string, PhasePlan>>(new Map());

// UI toggle (Settings → Updates, issue #16): when off, hide all phase UI. Stored
// straight in settings.json by the settings panel; read here on mount/focus.
const phasesEnabled = ref(true);

// Merge-link badges (issue #13). A task's `project` is stored raw, so it may be a
// canonical (absorbed others) or an alias (folded into a canonical) — need both.
const { aliasesOf, canonicalOf } = useProjectLinks();

// Project list for the filter/picker — RESOLVED to canonical names so a renamed
// project's tasks don't split across the old and new name. `knownProjects`
// (cc_projects) already comes canonical.
const projects = computed(() => {
  const set = new Set<string>();
  for (const t of todos.value) if (t.project) set.add(canonicalOf(t.project) ?? t.project);
  for (const p of knownProjects.value) set.add(p);
  return [...set].sort();
});


// Todos passing the active filters (project + search + show-done), the pool the
// board draws from. Per-column ordering is applied in `itemsFor`.
const visible = computed(() => {
  let list = todos.value.slice();
  if (projectFilter.value) {
    // Resolve through merge links so the canonical filter also catches tasks
    // still tagged with a merged-away alias name.
    list = list.filter((t) => (canonicalOf(t.project) ?? t.project ?? "") === projectFilter.value);
  }
  if (!showDone.value) list = list.filter((t) => t.status !== "done");
  const q = search.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (t) =>
        t.subject.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.project ?? "").toLowerCase().includes(q),
    );
  }
  return list;
});

// Hide the Done column when "show done" is off — there's nothing to show there.
const boardColumns = computed(() =>
  showDone.value ? COLUMNS : COLUMNS.filter((c) => c.id !== "done"),
);

// Cards for one column, scheduled-first then most-recently-updated.
function itemsFor(colId: string): Todo[] {
  return visible.value
    .filter((t) => t.status === colId)
    .sort((a, b) => {
      const da = a.scheduled_for || "9999-99-99";
      const db = b.scheduled_for || "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
}

const openCount = computed(
  () => todos.value.filter((t) => t.status !== "done").length,
);

async function loadTodos(silent = false) {
  if (!silent) loading.value = true;
  try {
    todos.value = await invoke<Todo[]>("get_todos");
    errorMsg.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    if (!silent) loading.value = false;
  }
}

// Reload now if it's safe; otherwise mark it pending until the drag/form ends.
function requestReload() {
  if (dragId.value || formOpen.value) {
    pendingReload.value = true;
    return;
  }
  void loadTodos(true);
}
// Run a deferred reload once the user is no longer mid-interaction.
function flushPendingReload() {
  if (pendingReload.value && !dragId.value && !formOpen.value) {
    pendingReload.value = false;
    void loadTodos(true);
  }
}

function resetForm() {
  editingId.value = null;
  fSubject.value = "";
  fDescription.value = "";
  fEstimate.value = null;
  fScheduled.value = "";
  fPlan.value = "";
  fProject.value = "";
  formStatus.value = "backlog";
  fPriority.value = "";
  formOpen.value = false;
  flushPendingReload();
}

function startNew(colId = "backlog") {
  resetForm();
  formStatus.value = colId;
  if (projectFilter.value) fProject.value = projectFilter.value;
  formOpen.value = true;
  // Pull fresh in case the window was already focused when a new project landed.
  void refreshKnownProjects();
}

async function submitForm() {
  const subject = fSubject.value.trim();
  if (!subject) return;
  const existing = editingId.value
    ? todos.value.find((x) => x.id === editingId.value)
    : null;
  const todo: Todo = {
    id: editingId.value ?? crypto.randomUUID(),
    subject,
    description: fDescription.value.trim(),
    status: existing?.status ?? formStatus.value,
    priority: fPriority.value || "",
    estimate_minutes:
      fEstimate.value === null || Number.isNaN(fEstimate.value)
        ? null
        : Math.max(0, Math.round(fEstimate.value)),
    scheduled_for: fScheduled.value || null,
    plan: fPlan.value.trim(),
    project: fProject.value.trim() || null,
    comments: existing?.comments,
    links: existing?.links,
    created_by: existing?.created_by ?? "user",
    created_at: existing?.created_at ?? "",
    updated_at: existing?.updated_at ?? "",
  };
  try {
    todos.value = await invoke<Todo[]>("upsert_todo", { todo });
    resetForm();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// Move a card to a new column. Update the local list first so the card jumps
// instantly, then persist; on failure reload from disk to undo the optimism.
async function moveStatus(todo: Todo, status: string) {
  if (todo.status === status) return;
  todos.value = todos.value.map((t) =>
    t.id === todo.id ? { ...t, status } : t,
  );
  try {
    todos.value = await invoke<Todo[]>("set_todo_status", {
      id: todo.id,
      status,
    });
  } catch (e) {
    errorMsg.value = String(e);
    await loadTodos();
  }
}

// Deleting a task asks first (issue #21): the card's trash opens a confirm
// dialog; the actual removal happens in confirmDelete. `pendingDelete` holds the
// task awaiting confirmation (null = no dialog open).
const pendingDelete = ref<Todo | null>(null);
function removeTodo(todo: Todo) {
  pendingDelete.value = todo;
}
function cancelDelete() {
  pendingDelete.value = null;
}
async function confirmDelete() {
  const todo = pendingDelete.value;
  if (!todo) return;
  pendingDelete.value = null;
  try {
    todos.value = await invoke<Todo[]>("delete_todo", { id: todo.id });
    if (editingId.value === todo.id) resetForm();
    if (detailId.value === todo.id) closeDetail();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// --- Detail view (master-detail editor) ---
// The board swaps to a full-screen detail editor: left rail lists the open
// task's project siblings, right panel edits its fields. `draft` is an isolated
// editable copy, so an external live-reload of `todos` never clobbers an in-
// progress edit; `saveDetail` merges the draft back over the existing todo
// (preserving id / comments / links / created_at) and persists via `upsert_todo`.
const view = ref<"board" | "detail">("board");
const detailId = ref<string | null>(null);
const detail = computed(() => todos.value.find((t) => t.id === detailId.value) ?? null);

// Transient "Saved ✓" confirmation shown after a successful detail save.
const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved() {
  saved.value = true;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.value = false), 2000);
}

interface Draft {
  subject: string;
  description: string;
  plan: string;
  project: string;
  estimate_minutes: number | null;
  scheduled_for: string;
  status: string;
  priority: string;
}
const draft = ref<Draft>({
  subject: "",
  description: "",
  plan: "",
  project: "",
  estimate_minutes: null,
  scheduled_for: "",
  status: "backlog",
  priority: "",
});

function rankStatus(s: string): number {
  const i = COLUMNS.findIndex((c) => c.id === s);
  return i < 0 ? COLUMNS.length : i;
}
// Left-rail tasks: same project as the open task (project-less tasks group
// together), ordered by board column so the rail reads like a mini board.
const detailSiblings = computed(() => {
  const p = detail.value?.project ?? null;
  return todos.value
    .filter((t) => (t.project ?? null) === p)
    .slice()
    .sort((a, b) => rankStatus(a.status) - rankStatus(b.status));
});

function openDetail(todo: Todo) {
  detailId.value = todo.id;
  draft.value = {
    subject: todo.subject,
    description: todo.description ?? "",
    plan: todo.plan ?? "",
    project: todo.project ?? "",
    estimate_minutes: todo.estimate_minutes ?? null,
    scheduled_for: todo.scheduled_for ?? "",
    status: todo.status,
    priority: todo.priority ?? "",
  };
  descMode.value = "edit";
  mention.value = null;
  saved.value = false;
  view.value = "detail";
}

function closeDetail() {
  view.value = "board";
  detailId.value = null;
}

async function saveDetail() {
  const cur = detail.value;
  if (!cur) return;
  const d = draft.value;
  if (!d.subject.trim()) return;
  const todo: Todo = {
    ...cur, // keep id / comments / links / created_at / updated_at
    subject: d.subject.trim(),
    description: d.description.trim(),
    plan: d.plan.trim(),
    project: d.project.trim() || null,
    estimate_minutes:
      d.estimate_minutes === null || Number.isNaN(d.estimate_minutes)
        ? null
        : Math.max(0, Math.round(d.estimate_minutes)),
    scheduled_for: d.scheduled_for || null,
    status: d.status,
    priority: d.priority || "",
  };
  try {
    todos.value = await invoke<Todo[]>("upsert_todo", { todo });
    flashSaved();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// --- Comments (discussion thread on the open task) ---
// A comment is posted independently of the field draft: appending one persists
// immediately (it's a discrete action, not part of the "Save" of edited fields),
// so a pending draft edit is left untouched. `detail.value` is the persisted
// todo, so we merge onto that — never onto the draft.
const newComment = ref("");

const detailComments = computed(() => detail.value?.comments ?? []);

async function persistComments(comments: Comment[]) {
  const cur = detail.value;
  if (!cur) return;
  try {
    todos.value = await invoke<Todo[]>("upsert_todo", {
      todo: { ...cur, comments },
    });
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function addComment() {
  const body = newComment.value.trim();
  if (!body || !detail.value) return;
  const comment: Comment = {
    id: crypto.randomUUID(),
    author: "user",
    body,
    created_at: new Date().toISOString(),
  };
  await persistComments([...(detail.value.comments ?? []), comment]);
  newComment.value = "";
}

async function removeComment(id: string) {
  if (!detail.value) return;
  await persistComments(
    (detail.value.comments ?? []).filter((c) => c.id !== id),
  );
}

function commentAuthorLabel(author: string) {
  return author === "claude" ? t("todoAuthorClaude") : t("todoAuthorYou");
}

// Format an ISO timestamp for a comment line. Empty/garbage → "" so a hand-
// edited comment without a date just shows no time rather than "Invalid Date".
function fmtTime(iso: string | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale.value === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Mini editor: inline links & references (GitHub-style) ---
// Split plain text into runs, marking URLs, task references (#N) and project
// references (@name). Deliberately NOT v-html: every run renders through Vue
// text interpolation (escaped) — a crafted comment can't inject markup. Opened
// URLs go through the backend `open_url` command (http/https only); #N/@name
// navigate inside the app.
type Seg =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string; href: string }
  | { kind: "task"; text: string; number: number; subject: string }
  | { kind: "project"; text: string; project: string };

// One pass: URL | #digits | @slug. Classification by which group matched.
const TOKEN_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)|#(\d+)|@([A-Za-z0-9._\-]+)/g;

// Stable lookups for resolving references while rendering.
const byNumber = computed(() => {
  const m = new Map<number, Todo>();
  for (const t of todos.value) if (t.number) m.set(t.number, t);
  return m;
});
const projectSet = computed(() => new Set(projects.value));

// Strip trailing prose punctuation that almost certainly isn't part of the URL
// ("see https://x.com." → drop the period), while keeping a closing bracket that
// actually balances one inside the URL (e.g. a /wiki/Foo_(bar) link).
function trimUrlTail(url: string): string {
  let u = url;
  while (u.length) {
    const ch = u[u.length - 1];
    if (".,;:!?'\"«»".includes(ch)) {
      u = u.slice(0, -1);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const opens = u.split(open).length - 1;
      const closes = u.split(ch).length - 1;
      if (closes > opens) {
        u = u.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return u;
}

function tokenize(text: string): Seg[] {
  const out: Seg[] = [];
  if (!text) return out;
  const byNum = byNumber.value;
  const projs = projectSet.value;
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    let seg: Seg | null = null;
    let consumed = m[0].length;
    if (m[1]) {
      const url = trimUrlTail(m[1]);
      if (url) {
        const href = url.startsWith("www.") ? `https://${url}` : url;
        seg = { kind: "url", text: url, href };
        consumed = url.length;
      }
    } else if (m[2]) {
      const num = parseInt(m[2], 10);
      const tt = byNum.get(num);
      // Only a number that maps to a real task becomes a link; otherwise it's
      // left as plain text so a stray "#5" doesn't pretend to be a reference.
      if (tt) seg = { kind: "task", text: `#${num}`, number: num, subject: tt.subject };
    } else if (m[3]) {
      let proj = m[3];
      if (!projs.has(proj)) {
        const trimmed = proj.replace(/[._\-]+$/, "");
        proj = projs.has(trimmed) ? trimmed : "";
      }
      if (proj) {
        seg = { kind: "project", text: `@${proj}`, project: proj };
        consumed = 1 + proj.length;
      }
    }
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    if (seg) {
      out.push(seg);
      last = start + consumed;
    } else {
      // Unresolved token → emit verbatim as text (trailing punct rejoins later).
      out.push({ kind: "text", text: m[0] });
      last = start + m[0].length;
    }
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

async function openLink(href: string) {
  try {
    await invoke("open_url", { url: href });
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// User-facing guide (how tasks & analytics work). Published as the repo wiki's
// Home page, so the short `/wiki` URL is stable regardless of page naming.
const GUIDE_URL =
  "https://github.com/DamirSadykov/Claude-Usage-Tracker-Windows/wiki";
function openGuide() {
  openLink(GUIDE_URL);
}

// Open the shared settings window on the Tasks tab (issue #45).
async function openSettings() {
  await invoke("open_settings_window", { tab: "tasks" });
}

// Navigate a #N reference to that task's detail; a @name reference back to the
// board filtered to that project.
function openTask(number: number) {
  const t = byNumber.value.get(number);
  if (t) openDetail(t);
}
function openProject(name: string) {
  projectFilter.value = name;
  closeDetail();
}

// --- Nightly-triage digest (#35) ---
// The latest digest the triage agent published (read-only; null until a run has
// happened, or if the file is unreadable). Shown as a chip beside the open-task
// count, expanding to a popover whose #N references jump to the task card. The
// triage agent owns writes via the cc-triage CLI; we only ever read.
const triageDigest = ref<TriageDigest | null>(null);
const triageOpen = ref(false);

async function loadTriageDigest() {
  try {
    triageDigest.value =
      (await invoke<TriageDigest | null>("get_triage_digest")) ?? null;
  } catch {
    // not under Tauri, or no digest yet
  }
}

// Display order: most urgent finding first, advisory suggestions last. The kinds
// mirror triage.rs::KINDS; the order here is a UI choice.
const TRIAGE_KIND_ORDER = ["overdue", "stale", "no_priority", "suggestion"] as const;
const TRIAGE_KIND_LABEL: Record<string, string> = {
  overdue: "triageKindOverdue",
  stale: "triageKindStale",
  no_priority: "triageKindNoPriority",
  suggestion: "triageKindSuggestion",
  other: "triageKindOther",
};

// Items bucketed by kind in display order, empty buckets dropped. A kind the
// tracker doesn't know (a newer writer) falls into a trailing "other" bucket so
// nothing silently disappears.
const triageGroups = computed<{ kind: string; items: DigestItem[] }[]>(() => {
  const d = triageDigest.value;
  if (!d) return [];
  const out: { kind: string; items: DigestItem[] }[] = [];
  const known = new Set<string>(TRIAGE_KIND_ORDER);
  for (const kind of TRIAGE_KIND_ORDER) {
    const items = d.items.filter((i) => i.kind === kind);
    if (items.length) out.push({ kind, items });
  }
  const rest = d.items.filter((i) => !known.has(i.kind));
  if (rest.length) out.push({ kind: "other", items: rest });
  return out;
});

const triageHeadline = computed(() => {
  const h = triageDigest.value?.headline?.trim();
  if (h) return h;
  // A digest with no headline → "ready"; no digest at all → the schedule label,
  // so the always-visible chip reads sensibly before the first run.
  return triageDigest.value ? t("triageAlertEmpty") : t("triageSchedule");
});

function triageKindLabel(kind: string): string {
  const key = TRIAGE_KIND_LABEL[kind];
  return key ? t(key) : kind;
}

// Empty/garbage timestamp → "" (mirrors fmtTime) so a hand-edited digest shows
// no time rather than "Invalid Date".
const triageGeneratedLabel = computed(() => {
  const iso = triageDigest.value?.generated_at;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale.value === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
});

// A digest #N is a live link only if it maps to a real task on the board.
function triageHasTask(num?: number): boolean {
  return num != null && byNumber.value.has(num);
}

// Jump from a digest reference to that task's card, closing the popover.
function triageGoToTask(num?: number) {
  if (!triageHasTask(num)) return;
  triageOpen.value = false;
  openTask(num as number);
}

// --- Nightly-triage SCHEDULE controls (#35) ---
// The in-app scheduler runs a headless `claude -p` triage once a day (backend
// `spawn_triage_scheduler`). These controls just read/write its config; the digest
// it produces is shown by the popover above.
interface TriageSchedule {
  enabled: boolean;
  time: string;
  model: string;
  last_run: string | null;
  last_error: string | null;
}
const schedEnabled = ref(false);
const schedTime = ref("08:00");
const schedModel = ref("haiku");
const schedLastRun = ref<string | null>(null);
const schedLastError = ref<string | null>(null);
const triageRunning = ref(false);

async function loadTriageSchedule() {
  try {
    const s = await invoke<TriageSchedule>("get_triage_schedule");
    schedEnabled.value = s.enabled;
    schedTime.value = s.time || "08:00";
    schedModel.value = s.model || "haiku";
    schedLastRun.value = s.last_run;
    schedLastError.value = s.last_error;
  } catch {
    // not under Tauri
  }
}

// Persist the toggle/time/model; the backend validates and echoes the normalized
// values back (e.g. zero-padded time), so we reflect those.
async function saveTriageSchedule() {
  try {
    const s = await invoke<TriageSchedule>("set_triage_schedule", {
      enabled: schedEnabled.value,
      time: schedTime.value,
      model: schedModel.value,
    });
    schedTime.value = s.time;
    schedModel.value = s.model;
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// Run the triage immediately. Awaits the headless run, then refreshes the digest
// + schedule state (so last_run/last_error update).
async function runTriageNow() {
  if (triageRunning.value) return;
  triageRunning.value = true;
  schedLastError.value = null;
  try {
    await invoke("run_triage_now");
    await loadTriageDigest();
  } catch (e) {
    schedLastError.value = String(e);
  } finally {
    triageRunning.value = false;
    await loadTriageSchedule();
  }
}

// Distinct other tasks this one references inline (#N) across its description and
// comments — drives the card's link chip. Uses tokenize so it counts exactly
// what renders as a reference (a #frag inside a URL isn't one) and only resolved
// numbers.
function refCount(todo: Todo): number {
  const nums = new Set<number>();
  const scan = (text: string | undefined) => {
    if (!text) return;
    for (const s of tokenize(text)) {
      if (s.kind === "task" && s.number !== todo.number) nums.add(s.number);
    }
  };
  scan(todo.description);
  for (const c of todo.comments ?? []) scan(c.body);
  return nums.size;
}

// Description has an edit/preview toggle: edit = textarea, preview = the same
// text with links/references rendered. Reset to edit whenever a task opens.
const descMode = ref<"edit" | "preview">("edit");
const descSegments = computed(() => tokenize(draft.value.description));

// --- Inline-reference autocomplete (the "preview the task you mean" popup) ---
// A GitHub-style trigger menu: typing `#` lists tasks (number + subject so you
// can tell which one), `@` lists projects. It drives plain-text insertion — the
// stored text stays `#12` / `@proj`, resolved at render time by tokenize().
const descTextarea = ref<HTMLTextAreaElement | null>(null);
const commentTextarea = ref<HTMLTextAreaElement | null>(null);
const descMenuEl = ref<HTMLUListElement | null>(null);
const commentMenuEl = ref<HTMLUListElement | null>(null);

// Keep the keyboard-highlighted item visible as the menu scrolls.
async function scrollSelIntoView() {
  await nextTick();
  const m = mention.value;
  if (!m) return;
  const ul = m.target === "desc" ? descMenuEl.value : commentMenuEl.value;
  const li = ul?.children[m.sel] as HTMLElement | undefined;
  li?.scrollIntoView({ block: "nearest" });
}
interface MentionState {
  target: "desc" | "comment";
  trigger: "#" | "@";
  query: string;
  start: number; // index of the trigger char in the text
  caret: number; // caret index (end of the query)
  sel: number; // highlighted candidate
}
const mention = ref<MentionState | null>(null);

interface MentionItem {
  label: string;
  sub: string;
  value: string;
}
const mentionItems = computed<MentionItem[]>(() => {
  const m = mention.value;
  if (!m) return [];
  // Trim so a trailing space (still typing a multi-word title) doesn't break the
  // number-prefix match; the list scrolls, so we keep a generous cap.
  const q = m.query.trim().toLowerCase();
  if (m.trigger === "#") {
    let list = todos.value.filter((t) => t.number && t.id !== detailId.value);
    if (q) {
      // GitHub-style: match by number prefix OR anywhere in the title text, so
      // you can find a task by typing "#" then words from its subject.
      list = list.filter(
        (t) =>
          String(t.number).startsWith(q) ||
          t.subject.toLowerCase().includes(q),
      );
    }
    return list
      .slice()
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .slice(0, 50)
      .map((t) => ({ label: `#${t.number}`, sub: t.subject, value: String(t.number) }));
  }
  let list = projects.value;
  if (q) list = list.filter((p) => p.toLowerCase().includes(q));
  return list.slice(0, 50).map((p) => ({ label: `@${p}`, sub: "", value: p }));
});

// A mention is a SESSION: it opens the moment a `#`/`@` is typed (at line start
// or after whitespace) and stays open as you keep typing, so a `#` query can hold
// the words of a task title (spaces and all), GitHub-style. The session ends when
// the trigger is deleted, the caret leaves it, a newline/oversized/`@`-with-space
// query appears, or you pick/escape. Picking inserts the NUMBER, not the title.
const MENTION_MAX_QUERY = 60;
function onMentionInput(target: "desc" | "comment", e: Event) {
  const el = e.target as HTMLTextAreaElement;
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const m = mention.value;
  // Continue an open session while its trigger char is still in place.
  if (m && m.target === target && caret > m.start && text[m.start] === m.trigger) {
    const query = text.slice(m.start + 1, caret);
    const ok =
      !query.includes("\n") &&
      query.length <= MENTION_MAX_QUERY &&
      (m.trigger === "#"
        ? !/\s{2,}/.test(query) // a double space ends a title search
        : /^[A-Za-z0-9._\-]*$/.test(query)); // project names have no spaces
    if (ok) {
      m.query = query;
      m.caret = caret;
      m.sel = 0; // reset highlight to the top result as the query changes
      return;
    }
    mention.value = null;
  }
  // Open a new session only when the trigger char was JUST typed (the char right
  // before the caret), so a `#` from elsewhere in the text isn't hijacked.
  const prev = text[caret - 1];
  if (
    (prev === "#" || prev === "@") &&
    (caret - 1 === 0 || /\s/.test(text[caret - 2]))
  ) {
    mention.value = { target, trigger: prev, query: "", start: caret - 1, caret, sel: 0 };
  } else if (mention.value && mention.value.target === target) {
    mention.value = null;
  }
}

async function pickMention(item: MentionItem) {
  const m = mention.value;
  if (!m) return;
  const insert = (m.trigger === "#" ? `#${item.value}` : `@${item.value}`) + " ";
  const apply = (text: string) =>
    text.slice(0, m.start) + insert + text.slice(m.caret);
  if (m.target === "desc") draft.value.description = apply(draft.value.description);
  else newComment.value = apply(newComment.value);
  const newCaret = m.start + insert.length;
  mention.value = null;
  await nextTick();
  const el = m.target === "desc" ? descTextarea.value : commentTextarea.value;
  if (el) {
    el.focus();
    el.setSelectionRange(newCaret, newCaret);
  }
}

function onMentionKeydown(target: "desc" | "comment", e: KeyboardEvent) {
  const m = mention.value;
  if (!m || m.target !== target) return;
  if (e.key === "Escape") {
    e.preventDefault();
    mention.value = null;
    return;
  }
  const items = mentionItems.value;
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    m.sel = (m.sel + 1) % items.length;
    void scrollSelIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    m.sel = (m.sel - 1 + items.length) % items.length;
    void scrollSelIntoView();
  } else if (
    (e.key === "Enter" && !e.ctrlKey && !e.metaKey) ||
    e.key === "Tab"
  ) {
    // Plain Enter/Tab picks the highlighted item; Ctrl/Cmd+Enter is left for
    // "post comment", so it falls through to that handler.
    e.preventDefault();
    void pickMention(items[Math.min(m.sel, items.length - 1)]);
  }
}

// Close the menu on blur, deferred so a mousedown on an item still registers.
function onMentionBlur() {
  setTimeout(() => {
    mention.value = null;
  }, 120);
}

// --- Drag and drop (native HTML5) ---
function onDragStart(todo: Todo, e: DragEvent) {
  dragId.value = todo.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Some browsers require data to be set for the drag to start at all.
    e.dataTransfer.setData("text/plain", todo.id);
  }
}
function onDragEnd() {
  dragId.value = null;
  overCol.value = null;
  flushPendingReload();
}
function onColDragOver(colId: string, e: DragEvent) {
  if (!dragId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (overCol.value !== colId) overCol.value = colId;
}
function onColDragLeave(colId: string, e: DragEvent) {
  // Ignore leaves into child elements of the same column body.
  const related = e.relatedTarget as Node | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  if (overCol.value === colId) overCol.value = null;
}
function onColDrop(colId: string) {
  const id = dragId.value;
  overCol.value = null;
  dragId.value = null;
  if (!id) return;
  const todo = todos.value.find((t) => t.id === id);
  if (todo) void moveStatus(todo, colId);
}

function statusLabel(s: string) {
  const c = COL_BY_ID[s];
  return c ? t(c.labelKey) : s;
}
function columnColor(s: string) {
  return COL_BY_ID[s]?.dot ?? "var(--text-4)";
}

// Localized label for a priority bucket ("" → the "no priority" option).
function priorityLabel(p: string | null | undefined): string {
  if (p === "high") return t("todoPriorityHigh");
  if (p === "medium") return t("todoPriorityMedium");
  if (p === "low") return t("todoPriorityLow");
  return t("todoPriorityNone");
}

function fmtEstimate(min: number | null | undefined) {
  if (min === null || min === undefined) return "";
  if (min < 60) return `${min} ${t("minShort")}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}${t("hourShort")} ${m}${t("minShort")}` : `${h}${t("hourShort")}`;
}

let unlistenLocale: (() => void) | null = null;
let unlistenTodos: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let unlistenTriage: (() => void) | null = null;

// Refresh the project picker from cc_usage. The todos window is a persisted
// webview (created once at startup, then shown/hidden), so `onMounted` runs a
// single time — without re-pulling, a project first used after launch never
// reaches the picker. We also kick a background ingest (like the Analytics
// window) so a brand-new project lands in cc_usage even if Analytics was never
// opened this session.
// Read the phases UI toggle from the shared settings store (Settings → Updates).
async function loadPhasesEnabled() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const v = await store.get<boolean>("phasesEnabled");
    if (typeof v === "boolean") phasesEnabled.value = v;
  } catch {
    // store missing / unreadable → keep default (on)
  }
}

// Pull the phase plans the tracker can find (across projects) and key them for
// per-card lookup. Best-effort: a missing command / no plans leaves cards bare.
async function refreshPhasePlans() {
  try {
    const plans = await invoke<PhasePlan[]>("get_phase_plans");
    const m = new Map<string, PhasePlan>();
    for (const p of plans) m.set(`${p.project}::${p.task_number}`, p);
    phasePlans.value = m;
  } catch {
    // command unavailable / nothing to read → keep what we have
  }
}

// The phase plan for a task, if one exists (matched by project basename + number).
// Accepts the nullable `detail` ref as well as a concrete card todo.
function phasesFor(todo: Todo | null | undefined): PhasePlan | null {
  if (!todo || !todo.project || !todo.number) return null;
  return phasePlans.value.get(`${todo.project}::${todo.number}`) ?? null;
}

// "done/total" phase count; "" when the task has no plan.
function phaseProgress(todo: Todo | null | undefined): string {
  const plan = phasesFor(todo);
  if (!plan) return "";
  return `${plan.phases.filter((p) => p.done).length}/${plan.phases.length}`;
}

async function refreshKnownProjects() {
  try {
    knownProjects.value = await invoke<string[]>("get_cc_projects");
  } catch {
    // analytics never ingested → keep the todo-derived fallback
  }
  invoke("ingest_cc_usage")
    .then(async (n) => {
      if (typeof n === "number" && n > 0) {
        try {
          knownProjects.value = await invoke<string[]>("get_cc_projects");
        } catch {}
      }
    })
    .catch(() => {});
}

onMounted(async () => {
  await loadLocaleFromStore();
  // The main window pushes its current locale here whenever it opens this
  // window — this is a separate WebView that may detect a different navigator
  // language and have no saved locale to read from the store.
  const { listen } = await import("@tauri-apps/api/event");
  unlistenLocale = await listen<string>("todos-locale", (e) => {
    applyLocale(e.payload);
  });
  // Live reload: the backend watcher fires this whenever todos.json changes on
  // disk (CLI / Claude / hand-edit), so the board stays in sync without a manual
  // refresh.
  unlistenTodos = await listen("todos-file-changed", () => {
    requestReload();
    // A todos.json change often coincides with phase edits (same session);
    // re-read plans too. There's no separate phase-file watcher yet (PR2).
    void refreshPhasePlans();
  });
  // A fresh nightly-triage digest landed (the backend broadcasts to all
  // windows); refresh the chip so it reflects the latest run.
  unlistenTriage = await listen("triage-alert", () => {
    void loadTriageDigest();
    void loadTriageSchedule();
  });
  await loadTodos();
  await refreshKnownProjects();
  void loadPhasesEnabled();
  void refreshPhasePlans();
  void loadTriageDigest();
  void loadTriageSchedule();
  // Persisted webview: refresh the picker each time the window is brought to
  // front, so a project used since the last view (now in cc_usage) shows up.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) {
      void refreshKnownProjects();
      void loadPhasesEnabled();
      void refreshPhasePlans();
      void loadTriageDigest();
      void loadTriageSchedule();
    }
  });
});

onUnmounted(() => {
  if (unlistenLocale) unlistenLocale();
  if (unlistenTodos) unlistenTodos();
  if (unlistenFocus) unlistenFocus();
  if (unlistenTriage) unlistenTriage();
});
</script>

<template>
  <div class="tw-root">
    <!-- BOARD VIEW -->
    <template v-if="view === 'board'">
    <header class="tw-head">
      <div class="tw-title">
        <h1>{{ t("tasksTitle") }}</h1>
        <span class="tw-open">{{ openCount }} {{ t("todoOpenItems") }}</span>
        <div class="tw-triage">
          <button
            class="tw-triage-chip"
            :class="{ open: triageOpen }"
            :title="t('triageAlertTitle')"
            @click="triageOpen = !triageOpen"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5.5 2.5h5l2 2v9h-9v-11z" />
              <path d="M6 7.5h4M6 10h2.5" />
            </svg>
            <span class="tw-triage-headline">{{ triageHeadline }}</span>
            <span class="tw-triage-caret">›</span>
          </button>

          <template v-if="triageOpen">
            <div class="tw-triage-backdrop" @click="triageOpen = false"></div>
            <div class="tw-triage-pop">
              <div class="tw-triage-pop-head">
                <span class="tw-triage-pop-title">{{ t("triageAlertTitle") }}</span>
                <span class="tw-triage-meta" v-if="triageDigest">
                  <span v-if="triageDigest.project">{{ triageDigest.project }}</span>
                  <span v-if="triageGeneratedLabel">{{ triageGeneratedLabel }}</span>
                </span>
              </div>
              <!-- Schedule controls FIRST, so they're reachable without scrolling
                   past a long digest (#35); always shown. -->
              <div class="tw-triage-sched" :class="{ 'has-digest': triageDigest }">
                <label class="tw-sched-toggle">
                  <input
                    type="checkbox"
                    v-model="schedEnabled"
                    @change="saveTriageSchedule"
                  />
                  <span>{{ t("triageScheduleEnable") }}</span>
                </label>
                <div v-if="schedEnabled" class="tw-sched-row">
                  <input
                    type="time"
                    class="tw-sched-time"
                    v-model="schedTime"
                    @change="saveTriageSchedule"
                  />
                  <select
                    class="tw-sched-model"
                    v-model="schedModel"
                    @change="saveTriageSchedule"
                  >
                    <option value="haiku">Haiku</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                  </select>
                </div>
                <div class="tw-sched-actions">
                  <button
                    type="button"
                    class="tw-btn tw-sched-run"
                    :disabled="triageRunning"
                    @click="runTriageNow"
                  >
                    {{ triageRunning ? t("triageRunning") : t("triageRunNow") }}
                  </button>
                  <span
                    v-if="schedLastRun && !schedLastError"
                    class="tw-sched-status"
                    >{{ t("triageLastRun", { date: schedLastRun }) }}</span
                  >
                </div>
                <div v-if="schedLastError" class="tw-sched-err">
                  {{ t("triageRunFailed") }}
                </div>
              </div>
              <template v-if="triageDigest">
                <p v-if="triageDigest.summary" class="tw-triage-summary">
                  {{ triageDigest.summary }}
                </p>
                <div v-if="!triageGroups.length" class="tw-triage-clean">
                  {{ t("triageCardClean") }}
                </div>
                <div v-for="g in triageGroups" :key="g.kind" class="tw-triage-group">
                  <div class="tw-triage-group-head" :class="`k-${g.kind}`">
                    <span class="tw-triage-dot"></span>
                    <span>{{ triageKindLabel(g.kind) }}</span>
                    <span class="tw-triage-count">{{ g.items.length }}</span>
                  </div>
                  <ul class="tw-triage-list">
                    <li v-for="(it, i) in g.items" :key="i" class="tw-triage-item">
                      <div class="tw-triage-line">
                        <a
                          v-if="triageHasTask(it.number)"
                          class="tw-ref tw-triage-ref"
                          @click.prevent="triageGoToTask(it.number)"
                          >#{{ it.number }}</a
                        ><span v-else-if="it.number != null" class="tw-triage-num"
                          >#{{ it.number }}</span
                        ><span class="tw-triage-subject">{{ it.subject }}</span>
                      </div>
                      <div v-if="it.note" class="tw-triage-note">{{ it.note }}</div>
                    </li>
                  </ul>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
      <div class="tw-spacer"></div>
      <div class="tw-search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" stroke-linecap="round" />
        </svg>
        <input v-model="search" class="tw-search-input" :placeholder="t('todoSearch')" />
      </div>
      <ProjectAutocomplete
        v-model="projectFilter"
        :options="projects"
        :placeholder="t('todoFilterAll')"
        clearable
        commit-on="select"
        width="170px"
      />
      <label class="tw-toggle">
        <input type="checkbox" v-model="showDone" />
        {{ t("todoShowDone") }}
      </label>
      <button class="tw-guide" :title="t('todoGuideHint')" @click="openGuide">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 3.2c1.8-.6 3.7-.6 5.5.3 1.8-.9 3.7-.9 5.5-.3v8.6c-1.8-.6-3.7-.6-5.5.3-1.8-.9-3.7-.9-5.5-.3z" />
          <path d="M8 3.5v8.6" />
        </svg>
        {{ t("todoGuide") }}
      </button>
      <button class="tw-guide" :title="t('settings')" @click="openSettings">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke-linecap="round" />
        </svg>
        {{ t("settings") }}
      </button>
      <button class="tw-add" @click="startNew('backlog')">+ {{ t("todoAdd") }}</button>
    </header>

    <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

    <div v-if="loading" class="tw-empty">{{ t("loading") }}</div>

    <!-- Kanban board -->
    <main v-else class="tw-board">
      <section
        v-for="col in boardColumns"
        :key="col.id"
        class="tw-col"
        :class="{ over: overCol === col.id }"
        @dragover="onColDragOver(col.id, $event)"
        @dragleave="onColDragLeave(col.id, $event)"
        @drop.prevent="onColDrop(col.id)"
      >
        <div class="tw-col-head">
          <span class="tw-col-dot" :style="{ background: col.dot }"></span>
          <span class="tw-col-name">{{ t(col.labelKey) }}</span>
          <span class="tw-col-count">{{ itemsFor(col.id).length }}</span>
          <button class="tw-col-add" :title="t('todoAdd')" @click="startNew(col.id)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>

        <div class="tw-col-body scroll">
          <div v-if="!itemsFor(col.id).length" class="tw-col-empty">
            {{ overCol === col.id ? t("todoDropHere") : t("todoColEmpty") }}
          </div>

          <article
            v-for="todo in itemsFor(col.id)"
            :key="todo.id"
            class="tw-card"
            :class="{ dragging: dragId === todo.id, done: todo.status === 'done' }"
            :style="{ borderLeftColor: columnColor(todo.status) }"
            draggable="true"
            @dragstart="onDragStart(todo, $event)"
            @dragend="onDragEnd"
          >
            <div class="tw-card-title"><span v-if="todo.number" class="tw-card-num">#{{ todo.number }}</span>{{ todo.subject }}</div>
            <p v-if="todo.description" class="tw-card-desc">{{ todo.description }}</p>

            <div class="tw-card-meta">
              <span
                v-if="todo.priority"
                class="tw-chip tw-prio"
                :class="'tw-prio-' + todo.priority"
                :title="t('todoPriority')"
                >{{ priorityLabel(todo.priority) }}</span
              >
              <span v-if="todo.created_by === 'claude'" class="tw-ai sm" :title="t('todoAiHint')">{{ t("todoAi") }}</span>
              <span v-if="todo.project" class="tw-tag">
                <ProjectLabel
                  :name="todo.project"
                  :aliases="aliasesOf(todo.project)"
                  :merged-into="canonicalOf(todo.project)"
                />
              </span>
              <span
                v-if="todo.from && todo.from !== todo.project"
                class="tw-chip tw-from"
                :title="t('todoFromHint')"
              >↘ {{ t("todoFrom") }} {{ todo.from }}</span>
              <span v-if="todo.estimate_minutes != null" class="tw-chip">⏱ {{ fmtEstimate(todo.estimate_minutes) }}</span>
              <span v-if="todo.scheduled_for" class="tw-chip">📅 {{ todo.scheduled_for }}</span>
              <span v-if="todo.plan" class="tw-chip" :title="todo.plan">📝</span>
              <span v-if="phasesEnabled && phasesFor(todo)" class="tw-chip" :title="t('phasesLabel')">☑ {{ phaseProgress(todo) }}</span>
              <span v-if="refCount(todo)" class="tw-chip" :title="t('todoRefs')">🔗 {{ refCount(todo) }}</span>
            </div>

            <div class="tw-card-foot">
              <select
                :value="todo.status"
                class="tw-select sm"
                @click.stop
                @mousedown.stop
                @change="moveStatus(todo, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="c in COLUMNS" :key="c.id" :value="c.id">{{ statusLabel(c.id) }}</option>
              </select>
              <div class="tw-card-actions">
                <button class="tw-icon" :title="t('todoEdit')" @click.stop="openDetail(todo)" @mousedown.stop>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z" />
                    <path d="M10.5 3.5l2 2" />
                  </svg>
                </button>
                <button class="tw-icon danger" :title="t('todoDelete')" @click.stop="removeTodo(todo)" @mousedown.stop>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 4.5h10" />
                    <path d="M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3" />
                    <path d="M4.3 4.5l.5 8a1 1 0 0 0 1 .95h4.4a1 1 0 0 0 1-.95l.5-8" />
                    <path d="M6.6 7v4M9.4 7v4" />
                  </svg>
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </main>
    </template>

    <!-- DETAIL VIEW: master-detail editor (left = project siblings, right = fields) -->
    <template v-else>
      <header class="tw-head">
        <button class="tw-back" @click="closeDetail">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg>
          {{ t("todoBack") }}
        </button>
        <div class="tw-title">
          <h1><span v-if="detail?.number" class="tw-detail-num">#{{ detail.number }}</span>{{ draft.subject || t("todoNew") }}</h1>
          <span v-if="detail && detail.created_by === 'claude'" class="tw-ai" :title="t('todoAiHint')">{{ t("todoAi") }}</span>
        </div>
        <div class="tw-spacer"></div>
        <transition name="tw-fade">
          <span v-if="saved" class="tw-saved">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
            {{ t("todoSaved") }}
          </span>
        </transition>
        <button class="tw-btn" :disabled="!draft.subject.trim()" @click="saveDetail">{{ t("save") }}</button>
      </header>

      <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

      <div class="tw-detail">
        <aside class="tw-detail-list">
          <div class="tw-detail-list-hd">{{ detail && detail.project ? detail.project : t("todoNoProject") }}</div>
          <button
            v-for="td in detailSiblings"
            :key="td.id"
            class="tw-detail-item"
            :class="{ active: td.id === detailId }"
            @click="openDetail(td)"
          >
            <span class="tw-detail-item-dot" :style="{ background: columnColor(td.status) }"></span>
            <span class="tw-detail-item-subj" :class="{ done: td.status === 'done' }"><span v-if="td.number" class="tw-detail-item-num">#{{ td.number }}</span>{{ td.subject }}</span>
            <span v-if="td.created_by === 'claude'" class="tw-ai sm" :title="t('todoAiHint')">{{ t("todoAi") }}</span>
          </button>
        </aside>

        <section v-if="detail" class="tw-detail-main">
          <label class="tw-field">
            <span>{{ t("todoSubject") }}</span>
            <input v-model="draft.subject" class="tw-input" maxlength="200" />
          </label>
          <div class="tw-row">
            <label class="tw-field">
              <span>{{ t("todoStatus") }}</span>
              <select v-model="draft.status" class="tw-select">
                <option v-for="c in COLUMNS" :key="c.id" :value="c.id">{{ t(c.labelKey) }}</option>
              </select>
            </label>
            <label class="tw-field">
              <span>{{ t("todoPriority") }}</span>
              <select v-model="draft.priority" class="tw-select">
                <option value="">{{ t("todoPriorityNone") }}</option>
                <option v-for="p in PRIORITY_LEVELS" :key="p" :value="p">{{ priorityLabel(p) }}</option>
              </select>
            </label>
          </div>
          <label class="tw-field">
            <span>{{ t("todoProject") }}</span>
            <ProjectAutocomplete
              v-model="draft.project"
              :options="projects"
              :placeholder="t('todoNoProject')"
              clearable
            />
          </label>
          <div
            v-if="detail?.from && detail.from !== draft.project"
            class="tw-from-note"
            :title="t('todoFromHint')"
          >
            ↘ {{ t("todoFrom") }} <strong>{{ detail.from }}</strong>
          </div>
          <div class="tw-row">
            <label class="tw-field">
              <span>{{ t("todoEstimate") }}</span>
              <input v-model.number="draft.estimate_minutes" class="tw-input" type="number" min="0" step="5" />
            </label>
            <label class="tw-field">
              <span>{{ t("todoScheduledFor") }}</span>
              <input v-model="draft.scheduled_for" class="tw-input" type="date" />
            </label>
          </div>
          <label class="tw-field">
            <span class="tw-field-row">
              {{ t("todoDescription") }}
              <button
                type="button"
                class="tw-mode"
                @click="descMode = descMode === 'edit' ? 'preview' : 'edit'"
              >
                {{ descMode === "edit" ? t("todoPreview") : t("todoEditField") }}
              </button>
            </span>
            <div v-if="descMode === 'edit'" class="tw-mention-wrap">
              <textarea
                ref="descTextarea"
                v-model="draft.description"
                class="tw-input tw-area"
                rows="7"
                @input="onMentionInput('desc', $event)"
                @keydown="onMentionKeydown('desc', $event)"
                @blur="onMentionBlur"
              ></textarea>
              <ul v-if="mention && mention.target === 'desc' && mentionItems.length" ref="descMenuEl" class="tw-mention">
                <li
                  v-for="(it, i) in mentionItems"
                  :key="it.value"
                  class="tw-mention-item"
                  :class="{ sel: i === mention.sel }"
                  @mousedown.prevent="pickMention(it)"
                >
                  <span class="tw-mention-key">{{ it.label }}</span>
                  <span v-if="it.sub" class="tw-mention-sub">{{ it.sub }}</span>
                </li>
              </ul>
            </div>
            <div v-else class="tw-richtext">
              <template v-if="draft.description.trim()"
                ><template v-for="(s, i) in descSegments" :key="i"
                  ><a v-if="s.kind === 'url'" class="tw-link" @click.prevent="openLink(s.href)">{{ s.text }}</a
                  ><a v-else-if="s.kind === 'task'" class="tw-ref" :title="s.subject" @click.prevent="openTask(s.number)">{{ s.text }}<span class="tw-ref-title">{{ s.subject }}</span></a
                  ><a v-else-if="s.kind === 'project'" class="tw-ref tw-ref-proj" @click.prevent="openProject(s.project)">{{ s.text }}</a
                  ><span v-else>{{ s.text }}</span></template
                ></template
              >
              <span v-else class="tw-richtext-empty">{{ t("todoNoDescription") }}</span>
            </div>
          </label>
          <!-- The free-form plan note. Hidden once the task has a structured phase
               plan (Vision + phases below ARE the plan) — kept only if it still holds
               legacy text, so nothing is silently dropped. -->
          <label v-if="!(phasesEnabled && phasesFor(detail)) || !!detail?.plan" class="tw-field">
            <span>{{ t("todoPlan") }} <em class="tw-hint">{{ t("todoPlanHint") }}</em></span>
            <textarea v-model="draft.plan" class="tw-input tw-area" rows="5"></textarea>
          </label>

          <!-- Phase plan (issue #16): read-only checkboxes; done → struck through.
               The cc-phases CLI is the only writer; here it's display-only. -->
          <div v-if="phasesEnabled && phasesFor(detail)" class="tw-field tw-phases">
            <div class="tw-phases-hd">
              <span>{{ t("todoPlan") }}</span>
              <span class="tw-phases-prog">{{ phaseProgress(detail) }}</span>
            </div>
            <!-- The plan's north star (README ## Vision), read-only here; the
                 cc-phases CLI / hook is the writer. Holds every phase to intent. -->
            <div v-if="phasesFor(detail)?.vision" class="tw-vision">
              <span class="tw-vision-label">★ {{ t("visionLabel") }}</span>
              <p class="tw-vision-text">{{ phasesFor(detail)?.vision }}</p>
            </div>
            <ul class="tw-phase-list">
              <li v-for="ph in phasesFor(detail)?.phases ?? []" :key="ph.num" class="tw-phase">
                <div class="tw-phase-row" :class="{ done: ph.done }">
                  <span class="tw-cbx" :class="{ on: ph.done }"></span>
                  <span class="tw-phase-t">{{ ph.num }}. {{ ph.title }}<span v-if="ph.desc" class="tw-phase-d"> — {{ ph.desc }}</span></span>
                </div>
                <ul v-if="ph.subs.length" class="tw-sub-list">
                  <li
                    v-for="s in ph.subs"
                    :key="s.num"
                    class="tw-sub-row"
                    :class="{ done: s.done }"
                  >
                    <span class="tw-cbx sm" :class="{ on: s.done }"></span>
                    <span class="tw-sub-t">{{ ph.num }}.{{ s.num }} {{ s.title }}<span v-if="s.text" class="tw-phase-d"> — {{ s.text }}</span></span>
                  </li>
                </ul>
              </li>
            </ul>
          </div>

          <div class="tw-form-actions">
            <transition name="tw-fade">
              <span v-if="saved" class="tw-saved">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
                {{ t("todoSaved") }}
              </span>
            </transition>
            <button type="button" class="tw-btn ghost" @click="closeDetail">{{ t("todoBack") }}</button>
            <button type="button" class="tw-btn" :disabled="!draft.subject.trim()" @click="saveDetail">{{ t("save") }}</button>
          </div>

          <!-- Comments thread (posted independently of the field draft) -->
          <div class="tw-comments">
            <div class="tw-comments-hd">
              {{ t("todoComments") }}
              <span v-if="detailComments.length" class="tw-comments-n">{{ detailComments.length }}</span>
            </div>
            <div v-if="!detailComments.length" class="tw-comments-empty">{{ t("todoCommentsEmpty") }}</div>
            <ul v-else class="tw-comment-list">
              <li
                v-for="c in detailComments"
                :key="c.id"
                class="tw-comment"
                :class="{ ai: c.author === 'claude' }"
              >
                <div class="tw-comment-head">
                  <span class="tw-comment-author" :class="{ ai: c.author === 'claude' }">{{ commentAuthorLabel(c.author) }}</span>
                  <span v-if="fmtTime(c.created_at)" class="tw-comment-time">{{ fmtTime(c.created_at) }}</span>
                  <button class="tw-comment-del" :title="t('todoDelete')" @click="removeComment(c.id)">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </div>
                <p class="tw-comment-body"
                  ><template v-for="(s, i) in tokenize(c.body)" :key="i"
                    ><a v-if="s.kind === 'url'" class="tw-link" @click.prevent="openLink(s.href)">{{ s.text }}</a
                    ><a v-else-if="s.kind === 'task'" class="tw-ref" :title="s.subject" @click.prevent="openTask(s.number)">{{ s.text }}<span class="tw-ref-title">{{ s.subject }}</span></a
                    ><a v-else-if="s.kind === 'project'" class="tw-ref tw-ref-proj" @click.prevent="openProject(s.project)">{{ s.text }}</a
                    ><span v-else>{{ s.text }}</span></template
                  ></p
                >
              </li>
            </ul>
            <div class="tw-comment-compose">
              <div class="tw-mention-wrap">
                <textarea
                  ref="commentTextarea"
                  v-model="newComment"
                  class="tw-input tw-area"
                  :placeholder="t('todoCommentPlaceholder')"
                  rows="2"
                  @input="onMentionInput('comment', $event)"
                  @keydown="onMentionKeydown('comment', $event)"
                  @keydown.ctrl.enter="addComment"
                  @keydown.meta.enter="addComment"
                  @blur="onMentionBlur"
                ></textarea>
                <ul v-if="mention && mention.target === 'comment' && mentionItems.length" ref="commentMenuEl" class="tw-mention up">
                  <li
                    v-for="(it, i) in mentionItems"
                    :key="it.value"
                    class="tw-mention-item"
                    :class="{ sel: i === mention.sel }"
                    @mousedown.prevent="pickMention(it)"
                  >
                    <span class="tw-mention-key">{{ it.label }}</span>
                    <span v-if="it.sub" class="tw-mention-sub">{{ it.sub }}</span>
                  </li>
                </ul>
              </div>
              <button class="tw-btn" :disabled="!newComment.trim()" @click="addComment">{{ t("todoCommentAdd") }}</button>
            </div>
          </div>
        </section>
        <section v-else class="tw-detail-main tw-detail-empty">{{ t("todoColEmpty") }}</section>
      </div>
    </template>

    <!-- Delete confirmation (issue #21) -->
    <div v-if="pendingDelete" class="tw-modal" @click.self="cancelDelete">
      <div class="tw-form tw-confirm">
        <div class="tw-form-title">{{ t("todoDeleteConfirmTitle") }}</div>
        <p class="tw-confirm-body">
          {{ t("todoDeleteConfirmBody") }} <strong>{{ pendingDelete.subject }}</strong>
        </p>
        <div class="tw-form-actions">
          <button type="button" class="tw-btn ghost" @click="cancelDelete">{{ t("todoCancel") }}</button>
          <button type="button" class="tw-btn danger" @click="confirmDelete">{{ t("todoDelete") }}</button>
        </div>
      </div>
    </div>

    <!-- Create / edit form (modal overlay) -->
    <div v-if="formOpen" class="tw-modal" @click.self="resetForm">
      <form class="tw-form" @submit.prevent="submitForm">
        <div class="tw-form-title">
          {{ editingId ? t("todoEdit") : t("todoNew") }}
        </div>
        <input
          v-model="fSubject"
          class="tw-input"
          :placeholder="t('todoSubjectPlaceholder')"
          maxlength="200"
          autofocus
        />
        <textarea
          v-model="fDescription"
          class="tw-input tw-area"
          :placeholder="t('todoDescription')"
          rows="2"
        ></textarea>
        <label class="tw-field">
          <span>{{ t("todoProject") }}</span>
          <ProjectAutocomplete
            v-model="fProject"
            :options="projects"
            :placeholder="t('todoProjectPlaceholder')"
          />
        </label>
        <label class="tw-field">
          <span>{{ t("todoPriority") }}</span>
          <select v-model="fPriority" class="tw-select">
            <option value="">{{ t("todoPriorityNone") }}</option>
            <option v-for="p in PRIORITY_LEVELS" :key="p" :value="p">{{ priorityLabel(p) }}</option>
          </select>
        </label>
        <div class="tw-row">
          <label class="tw-field">
            <span>{{ t("todoEstimate") }}</span>
            <input v-model.number="fEstimate" class="tw-input" type="number" min="0" step="5" />
          </label>
          <label class="tw-field">
            <span>{{ t("todoScheduledFor") }}</span>
            <input v-model="fScheduled" class="tw-input" type="date" />
          </label>
        </div>
        <label class="tw-field">
          <span>{{ t("todoPlan") }} <em class="tw-hint">{{ t("todoPlanHint") }}</em></span>
          <textarea v-model="fPlan" class="tw-input tw-area" rows="4"></textarea>
        </label>
        <div class="tw-form-actions">
          <button type="button" class="tw-btn ghost" @click="resetForm">{{ t("todoCancel") }}</button>
          <button type="submit" class="tw-btn" :disabled="!fSubject.trim()">{{ t("save") }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.tw-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--flyout-bg, #1c1c1c);
  color: var(--text);
  font-family: var(--segoe);
  overflow: hidden;
}
.tw-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--stroke-strong);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.tw-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tw-title h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.tw-detail-num {
  margin-right: 7px;
  color: var(--text-3);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tw-open {
  font-size: 12px;
  color: var(--text-3);
}
.tw-spacer {
  flex: 1;
}
.tw-search {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  padding: 0 9px;
  color: var(--text-3);
}
.tw-search:focus-within {
  border-color: var(--accent);
}
.tw-search-input {
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: var(--segoe);
  padding: 6px 0;
  width: 150px;
}
.tw-select {
  background: var(--card-bg);
  color: var(--text-2);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--segoe);
}
.tw-select.sm {
  padding: 3px 6px;
  font-size: 11px;
  max-width: 110px;
}
.tw-toggle {
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.tw-guide {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--stroke-strong);
  background: var(--card-bg);
  color: var(--text-3);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--segoe);
  transition: color 120ms, border-color 120ms;
}
.tw-guide:hover {
  color: var(--text);
  border-color: var(--accent);
}
.tw-guide svg {
  opacity: 0.85;
}
.tw-add {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #06283b;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--segoe);
}
.tw-add:hover {
  filter: brightness(1.1);
}
.tw-error {
  color: #f87171;
  font-size: 12px;
  word-break: break-word;
  padding: 8px 16px 0;
  flex-shrink: 0;
}
.tw-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}

/* Board */
.tw-board {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
}
.tw-col {
  flex: 1 1 0;
  min-width: 188px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--stroke);
  border-radius: 10px;
  transition: border-color 120ms, background 120ms;
}
.tw-col.over {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.tw-col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  flex-shrink: 0;
}
.tw-col-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tw-col-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-col-count {
  font-size: 12px;
  color: var(--text-3);
  background: var(--track);
  border-radius: 9px;
  padding: 1px 7px;
  min-width: 18px;
  text-align: center;
}
.tw-col-add {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 2px;
  border-radius: 4px;
}
.tw-col-add:hover {
  color: var(--text);
  background: var(--card-bg-hover);
}
.tw-col-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tw-col-empty {
  color: var(--text-4);
  font-size: 12px;
  text-align: center;
  padding: 18px 6px;
  border: 1px dashed var(--stroke-strong);
  border-radius: 8px;
  margin: 2px;
}

/* Card */
.tw-card {
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-left: 3px solid var(--text-4);
  border-radius: var(--card-radius);
  padding: 10px 11px;
  cursor: grab;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.tw-card:hover {
  background: var(--card-bg-hover);
}
.tw-card.dragging {
  opacity: 0.4;
  cursor: grabbing;
}
.tw-card.done .tw-card-title {
  text-decoration: line-through;
  color: var(--text-3);
}
.tw-card-title {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.35;
  word-break: break-word;
}
.tw-card-num {
  margin-right: 6px;
  color: var(--text-3);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tw-card-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* Phase plan checklist on a card (issue #16). Read-only: the cc-phases CLI
   writes the markdown; here a filled box + strike-through just reflects state. */
.tw-phases {
  border-top: 1px solid var(--stroke-strong);
  margin-top: 6px;
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tw-phases-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.tw-phases-prog {
  font-variant-numeric: tabular-nums;
  color: var(--text-4);
  background: var(--track);
  border-radius: 8px;
  padding: 0 6px;
}
.tw-vision {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-left: 2px solid var(--accent);
  background: var(--card-bg);
  border-radius: 4px;
  padding: 6px 9px;
  margin: 2px 0 4px;
}
.tw-vision-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
}
.tw-vision-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-2);
  white-space: pre-wrap;
}
.tw-phase-list,
.tw-sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tw-sub-list {
  margin: 3px 0 2px 18px;
}
.tw-phase-row,
.tw-sub-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.tw-phase-row {
  font-size: 12.5px;
  color: var(--text);
}
.tw-sub-row {
  font-size: 12px;
  color: var(--text-2);
}
.tw-phase-t,
.tw-sub-t {
  line-height: 1.35;
  word-break: break-word;
}
.tw-phase-d {
  color: var(--text-3);
  font-weight: 400;
}
/* Done item: bright text with a SEPARATE strike line drawn as a pseudo-element,
   so the line stays subtle (its own colour) while the text reads at full
   brightness — decoupled, unlike text-decoration which ties the line to the
   text colour. Done text keeps the base row colour (--text / --text-2). */
.tw-phase-row.done .tw-phase-t,
.tw-sub-row.done .tw-sub-t {
  position: relative;
}
.tw-phase-row.done .tw-phase-t::after,
.tw-sub-row.done .tw-sub-t::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: var(--text-4);
  pointer-events: none;
}
/* Hover a done item to drop the strike line and read it cleanly. */
.tw-phase-row.done:hover .tw-phase-t::after,
.tw-sub-row.done:hover .tw-sub-t::after {
  display: none;
}
.tw-cbx {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  margin-top: 1px;
  border: 1.4px solid var(--stroke-strong);
  border-radius: 3px;
  box-sizing: border-box;
  position: relative;
}
.tw-cbx.sm {
  width: 12px;
  height: 12px;
}
.tw-cbx.on {
  background: var(--accent);
  border-color: var(--accent);
}
.tw-cbx.on::after {
  content: "";
  position: absolute;
  left: 3.5px;
  top: 1px;
  width: 3.5px;
  height: 6.5px;
  border: solid #06283b;
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(45deg);
}
.tw-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.tw-tag {
  font-size: 12px;
  color: var(--text-2);
  background: var(--track);
  padding: 1px 7px;
  border-radius: 8px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
/* In the card, a long project name should wrap inside the tag rather than be
   ellipsised (ProjectLabel truncates by default for table cells). */
.tw-tag :deep(.pl) {
  max-width: 100%;
}
.tw-tag :deep(.pl-name) {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  overflow-wrap: anywhere;
}
.tw-chip {
  font-size: 12px;
  color: var(--text-3);
  max-width: 100%;
  overflow-wrap: anywhere;
}
/* Priority chip — colour-coded by bucket (high red, medium amber, low muted). */
.tw-prio {
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  text-transform: capitalize;
}
.tw-prio-high {
  color: #d4453a;
  background: rgba(212, 69, 58, 0.13);
}
.tw-prio-medium {
  color: #c07c19;
  background: rgba(192, 124, 25, 0.14);
}
.tw-prio-low {
  color: var(--text-3);
  background: var(--track);
}
/* Provenance chip — "↘ from <project>" for a cross-project task. */
.tw-from {
  color: var(--text-2);
  background: var(--track);
  padding: 1px 7px;
  border-radius: 8px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
/* Same provenance, shown read-only in the detail/edit view. */
.tw-from-note {
  font-size: 13px;
  color: var(--text-3);
}
.tw-from-note strong {
  color: var(--text);
  font-weight: 600;
}
.tw-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 1px;
}
.tw-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.tw-icon {
  background: transparent;
  border: 1px solid var(--stroke-strong);
  color: var(--text-3);
  border-radius: 5px;
  width: 26px;
  height: 26px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tw-icon:hover {
  background: var(--card-bg-hover);
  color: var(--text);
}
.tw-icon.danger:hover {
  border-color: #f87171;
  color: #f87171;
}

/* Modal form */
.tw-modal {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 32px 20px;
  overflow-y: auto;
}
.tw-form {
  width: 100%;
  max-width: 680px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 22px;
  border: 1px solid var(--stroke-strong);
  border-radius: 10px;
  background: var(--flyout-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}
.tw-form-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 2px;
}
.tw-input {
  background: var(--card-bg);
  color: var(--text);
  border: 1px solid var(--stroke-strong);
  border-radius: 5px;
  padding: 9px 11px;
  font-size: 13px;
  font-family: var(--segoe);
  width: 100%;
  /* Render native controls in dark theme so the <input type="date"> calendar
     picker icon (and its popup) isn't a dark-on-dark, near-invisible glyph on
     Windows/WebView2 — same fix the settings selects already use. */
  color-scheme: dark;
}
.tw-input:focus {
  outline: none;
  border-color: var(--accent);
}
.tw-area {
  resize: vertical;
  min-height: 36px;
  line-height: 1.6;
}
.tw-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.tw-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
  min-width: 140px;
}
.tw-hint {
  color: var(--text-4);
  font-style: italic;
  font-weight: 400;
}
.tw-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.tw-btn {
  border: none;
  background: var(--accent);
  color: #06283b;
  border-radius: 5px;
  padding: 7px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--segoe);
}
.tw-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.tw-btn.ghost {
  background: transparent;
  color: var(--text-3);
  border: 1px solid var(--stroke-strong);
}
.tw-btn.danger {
  background: #e0524a;
  color: #fff;
}
.tw-btn.danger:hover {
  background: #d4453a;
}
/* Delete-confirmation dialog: a narrow .tw-form panel with a short question. */
.tw-confirm {
  max-width: 360px;
}
.tw-confirm-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  word-break: break-word;
}

/* AI-authored badge — violet so it can't be mistaken for a status colour. */
.tw-ai {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #c4a7ff;
  background: rgba(179, 136, 255, 0.16);
  border: 1px solid rgba(179, 136, 255, 0.5);
  border-radius: 6px;
  padding: 1px 6px;
  line-height: 1.5;
  flex-shrink: 0;
}
.tw-ai.sm {
  font-size: 10.5px;
  padding: 0 5px;
}

/* "Saved ✓" confirmation */
.tw-saved {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--success, #6ccb5f);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.tw-fade-enter-active,
.tw-fade-leave-active {
  transition: opacity 200ms ease;
}
.tw-fade-enter-from,
.tw-fade-leave-to {
  opacity: 0;
}

/* Detail view (master-detail editor) */
.tw-back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--stroke-strong);
  color: var(--text-2);
  border-radius: 6px;
  padding: 5px 11px 5px 8px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
}
.tw-back:hover {
  background: var(--card-bg-hover);
  color: var(--text);
}
.tw-detail {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  padding: 14px 16px;
  overflow: hidden;
}
.tw-detail-list {
  flex: 0 0 264px;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--stroke);
  border-radius: 10px;
  padding: 8px;
}
.tw-detail-list-hd {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  padding: 4px 6px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw-detail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 8px;
  color: var(--text-2);
  cursor: pointer;
  font-family: var(--segoe);
  font-size: 13px;
}
.tw-detail-item:hover {
  background: var(--card-bg-hover);
}
.tw-detail-item.active {
  background: var(--accent-soft);
  color: var(--text);
}
.tw-detail-item-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tw-detail-item-subj {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw-detail-item-subj.done {
  text-decoration: line-through;
  color: var(--text-3);
}
.tw-detail-item-num {
  margin-right: 5px;
  color: var(--text-3);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tw-detail-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 13px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--stroke);
  border-radius: 10px;
  padding: 18px 20px;
}
.tw-detail-main .tw-select {
  width: 100%;
}
.tw-detail-empty {
  align-items: center;
  justify-content: center;
  color: var(--text-4);
  font-size: 13px;
}

/* Comments thread */
.tw-comments {
  border-top: 1px solid var(--stroke-strong);
  padding-top: 14px;
  margin-top: 2px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tw-comments-hd {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 7px;
}
.tw-comments-n {
  font-size: 11.5px;
  color: var(--text-3);
  background: var(--track);
  border-radius: 9px;
  padding: 1px 7px;
  min-width: 18px;
  text-align: center;
}
.tw-comments-empty {
  font-size: 13px;
  color: var(--text-4);
}
.tw-comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tw-comment {
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-left: 3px solid var(--text-4);
  border-radius: var(--card-radius);
  padding: 8px 11px;
}
/* Claude comments get the same violet accent as the AI badge. */
.tw-comment.ai {
  border-left-color: #b388ff;
}
.tw-comment-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.tw-comment-author {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-comment-author.ai {
  color: #c4a7ff;
}
.tw-comment-time {
  font-size: 11.5px;
  color: var(--text-4);
}
.tw-comment-del {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-4);
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 2px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 120ms;
}
.tw-comment:hover .tw-comment-del {
  opacity: 1;
}
.tw-comment-del:hover {
  color: #f87171;
  background: var(--card-bg-hover);
}
.tw-comment-body {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tw-comment-compose {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}
.tw-comment-compose .tw-area {
  width: 100%;
}

/* Mini editor: clickable links + edit/preview toggle */
.tw-link {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
  word-break: break-all;
}
.tw-link:hover {
  text-decoration: underline;
}
.tw-field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tw-mode {
  background: transparent;
  border: none;
  color: var(--accent);
  font-family: var(--segoe);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 4px;
}
.tw-mode:hover {
  background: var(--card-bg-hover);
}
.tw-richtext {
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 5px;
  padding: 9px 11px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 36px;
}
.tw-richtext-empty {
  color: var(--text-4);
  font-style: italic;
}

/* Inline references (#N task, @name project) */
.tw-ref {
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 0 4px;
  cursor: pointer;
  font-weight: 600;
  white-space: nowrap;
}
.tw-ref:hover {
  text-decoration: underline;
}
.tw-ref-title {
  font-weight: 400;
  opacity: 0.8;
  margin-left: 4px;
}
.tw-ref-proj {
  color: #c4a7ff;
  background: rgba(179, 136, 255, 0.16);
}

/* Nightly-triage digest (#35): a chip beside the open-task count that expands
   to a read-only popover; #N references inside jump to the task card. */
.tw-triage {
  position: relative;
  display: inline-flex;
}
.tw-triage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 3px 9px;
  border: 1px solid var(--stroke-strong);
  border-radius: 999px;
  background: var(--card-bg);
  color: var(--text-2);
  font-family: var(--segoe);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 120ms,
    border-color 120ms;
}
.tw-triage-chip:hover,
.tw-triage-chip.open {
  background: var(--card-bg-hover);
  border-color: var(--accent);
}
.tw-triage-chip svg {
  flex: none;
  color: var(--text-3);
}
.tw-triage-headline {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw-triage-caret {
  flex: none;
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
  transition: transform 120ms;
}
.tw-triage-chip.open .tw-triage-caret {
  transform: rotate(90deg);
}
.tw-triage-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.tw-triage-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 41;
  width: 340px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 12px;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tw-triage-pop-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.tw-triage-pop-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.tw-triage-meta {
  display: inline-flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-4);
  white-space: nowrap;
}
.tw-triage-summary {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-2);
}
.tw-triage-clean {
  font-size: 12px;
  color: var(--text-3);
}
.tw-triage-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tw-triage-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-2);
}
.tw-triage-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex: none;
}
.tw-triage-group-head.k-overdue .tw-triage-dot {
  background: #f87171;
}
.tw-triage-group-head.k-stale .tw-triage-dot {
  background: var(--warning);
}
.tw-triage-group-head.k-no_priority .tw-triage-dot {
  background: var(--text-3);
}
.tw-triage-group-head.k-suggestion .tw-triage-dot {
  background: var(--accent);
}
.tw-triage-count {
  color: var(--text-4);
  font-weight: 400;
}
.tw-triage-list {
  margin: 0;
  padding: 0 0 0 13px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tw-triage-item {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-2);
}
.tw-triage-num {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  margin-right: 5px;
}
.tw-triage-ref {
  margin-right: 5px;
}
.tw-triage-note {
  color: var(--text-3);
  margin-top: 1px;
  padding-left: 16px;
  position: relative;
}
.tw-triage-note::before {
  content: "→";
  position: absolute;
  left: 2px;
  color: var(--text-4);
}

/* Nightly-triage schedule controls (#35), in the digest popover footer. */
.tw-triage-sched {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* Controls sit above the digest; when one follows, divide them from it. */
.tw-triage-sched.has-digest {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--stroke-strong);
}
.tw-sched-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.tw-sched-toggle input {
  cursor: pointer;
}
.tw-sched-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tw-sched-time,
.tw-sched-model {
  font-family: var(--segoe);
  font-size: 12px;
  padding: 3px 6px;
  background: var(--card-bg);
  color: var(--text);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  /* Render the native time-picker icon + spinners light on the dark theme
     (was black-on-black). The app is dark-only. */
  color-scheme: dark;
}
.tw-sched-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tw-sched-run {
  font-size: 12px;
}
.tw-sched-status {
  font-size: 11px;
  color: var(--text-4);
}
.tw-sched-err {
  font-size: 11px;
  color: var(--warning);
}

/* Inline-reference autocomplete menu */
.tw-mention-wrap {
  position: relative;
  width: 100%;
}
.tw-mention {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 30;
  margin: 3px 0 0;
  padding: 4px;
  list-style: none;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  max-height: 220px;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.tw-mention.up {
  top: auto;
  bottom: 100%;
  margin: 0 0 3px;
}
.tw-mention-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.tw-mention-item:hover,
.tw-mention-item.sel {
  background: var(--accent-soft);
}
.tw-mention-key {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.tw-mention-sub {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
