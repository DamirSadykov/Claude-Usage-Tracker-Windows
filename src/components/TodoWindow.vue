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
  estimate_minutes?: number | null;
  scheduled_for?: string | null;
  plan: string;
  project?: string | null;
  comments?: Comment[];
  links?: string[];
  created_by?: string; // "user" | "claude" ("" / absent = user, no AI badge)
  created_at: string;
  updated_at: string;
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
const showDone = ref(true);
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
const formOpen = ref(false);

// Projects the tracker has seen (from cc_usage), so the picker offers real
// projects even before any todo uses them.
const knownProjects = ref<string[]>([]);
const projects = computed(() => {
  const set = new Set<string>();
  for (const t of todos.value) if (t.project) set.add(t.project);
  for (const p of knownProjects.value) set.add(p);
  return [...set].sort();
});

// Merge-link badges (issue #13). A task's `project` is stored raw, so it may be a
// canonical (absorbed others) or an alias (folded into a canonical) — need both.
const { aliasesOf, canonicalOf } = useProjectLinks();


// Todos passing the active filters (project + search + show-done), the pool the
// board draws from. Per-column ordering is applied in `itemsFor`.
const visible = computed(() => {
  let list = todos.value.slice();
  if (projectFilter.value) {
    list = list.filter((t) => (t.project ?? "") === projectFilter.value);
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

async function removeTodo(todo: Todo) {
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
}
const draft = ref<Draft>({
  subject: "",
  description: "",
  plan: "",
  project: "",
  estimate_minutes: null,
  scheduled_for: "",
  status: "backlog",
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

// Refresh the project picker from cc_usage. The todos window is a persisted
// webview (created once at startup, then shown/hidden), so `onMounted` runs a
// single time — without re-pulling, a project first used after launch never
// reaches the picker. We also kick a background ingest (like the Analytics
// window) so a brand-new project lands in cc_usage even if Analytics was never
// opened this session.
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
  unlistenTodos = await listen("todos-file-changed", () => requestReload());
  await loadTodos();
  await refreshKnownProjects();
  // Persisted webview: refresh the picker each time the window is brought to
  // front, so a project used since the last view (now in cc_usage) shows up.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void refreshKnownProjects();
  });
});

onUnmounted(() => {
  if (unlistenLocale) unlistenLocale();
  if (unlistenTodos) unlistenTodos();
  if (unlistenFocus) unlistenFocus();
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
            <div class="tw-card-title">{{ todo.subject }}</div>
            <p v-if="todo.description" class="tw-card-desc">{{ todo.description }}</p>

            <div class="tw-card-meta">
              <span v-if="todo.created_by === 'claude'" class="tw-ai sm" :title="t('todoAiHint')">{{ t("todoAi") }}</span>
              <span v-if="todo.project" class="tw-tag">
                <ProjectLabel
                  :name="todo.project"
                  :aliases="aliasesOf(todo.project)"
                  :merged-into="canonicalOf(todo.project)"
                />
              </span>
              <span v-if="todo.estimate_minutes != null" class="tw-chip">⏱ {{ fmtEstimate(todo.estimate_minutes) }}</span>
              <span v-if="todo.scheduled_for" class="tw-chip">📅 {{ todo.scheduled_for }}</span>
              <span v-if="todo.plan" class="tw-chip" :title="todo.plan">📝</span>
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
          <h1>{{ draft.subject || t("todoNew") }}</h1>
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
            <span class="tw-detail-item-subj" :class="{ done: td.status === 'done' }">{{ td.subject }}</span>
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
              <span>{{ t("todoProject") }}</span>
              <ProjectAutocomplete
                v-model="draft.project"
                :options="projects"
                :placeholder="t('todoNoProject')"
                clearable
              />
            </label>
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
          <label class="tw-field">
            <span>{{ t("todoPlan") }} <em class="tw-hint">{{ t("todoPlanHint") }}</em></span>
            <textarea v-model="draft.plan" class="tw-input tw-area" rows="5"></textarea>
          </label>
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
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-col-count {
  font-size: 11px;
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
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  word-break: break-word;
}
.tw-card-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.tw-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.tw-tag {
  font-size: 10.5px;
  color: var(--text-2);
  background: var(--track);
  padding: 1px 7px;
  border-radius: 8px;
}
.tw-chip {
  font-size: 10.5px;
  color: var(--text-3);
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
  font-size: 15px;
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
}
.tw-input:focus {
  outline: none;
  border-color: var(--accent);
}
.tw-area {
  resize: vertical;
  min-height: 36px;
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

/* AI-authored badge — violet so it can't be mistaken for a status colour. */
.tw-ai {
  font-size: 9.5px;
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
  font-size: 9px;
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
  font-size: 11px;
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
  font-size: 12.5px;
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
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 7px;
}
.tw-comments-n {
  font-size: 10.5px;
  color: var(--text-3);
  background: var(--track);
  border-radius: 9px;
  padding: 1px 7px;
  min-width: 18px;
  text-align: center;
}
.tw-comments-empty {
  font-size: 12px;
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
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-comment-author.ai {
  color: #c4a7ff;
}
.tw-comment-time {
  font-size: 10.5px;
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
  font-size: 12.5px;
  line-height: 1.45;
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
  line-height: 1.5;
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
