<script setup lang="ts">
// Standalone task manager, rendered when index.html is loaded with the `#todos`
// hash (see tauri.conf.json `todos` window). The tracker OWNS the todo list: the
// user creates/edits tasks here, they're persisted to `todos.json` in the app
// data dir, and a Claude Code SessionStart hook reads that file to surface the
// active ones for the current project. Claude only flips `status` (and edits
// details on request) by rewriting the same file.
//
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n, type Composer } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import ProjectAutocomplete from "../kernel/ProjectAutocomplete.vue";
import PipelineGraph from "../process/pipeline/PipelineGraph.vue";
import type { PipelineMode } from "../process/pipeline/modes";
import type { BoardChange, Todo } from "../contracts/board";
import { boardStore, type BoardMutation } from "../board/boardStore";
import { useProjectLinks } from "../analytics/projectLinks";
import { useHotkeys } from "../kernel/hotkeys";
import { BOARD_CURRENT_VERSION } from "../board/boardVersion";
import {
  EXT_BUCKETS,
  resolveBucket,
  bucketClass,
  STATUS_MAP_KEY,
  type StatusMap,
  type ExtBucketId,
} from "../contracts/externalStatus";
import i18n from "../kernel/i18n";
import { useSettings } from "../kernel/settingsStore";
import TodoFiltersBar from "../board/TodoFiltersBar.vue";
import TodoDetailPane from "../board/TodoDetailPane.vue";
import ChangeDetail from "../process/pipeline/ChangeDetail.vue";
import TodoTree from "../board/TodoTree.vue";
import WorkTree from "../board/WorkTree.vue";
import { buildBoardTree, findBoardTreeNode, type BoardTreeNode, type BoardTreeRow } from "../board/boardTree";
import {
  countAttention,
  defaultTodoFilters,
  localToday,
  type TodoFilters,
} from "../board/todoFilter";
import { detailSiblingPages } from "../board/detailSiblings";
import { blockingTasks, commentAttempt, commentSeverity, parseHandoff, reviewOutcome, sessionRoleCosts } from "../board/taskOverview";

const { t, locale } = useI18n();

// Apply a locale to BOTH this component's composer and the canonical global
// i18n instance. Setting only the composer's `locale` proved unreliable in this
// standalone window, so we also push it onto `i18n.global` directly.
function applyLocale(l: string | null | undefined) {
  if (l !== "en" && l !== "ru") return;
  locale.value = l;
  (i18n.global as Composer).locale.value = l;
}

// Each Tauri window is a separate WebView; vue-i18n boots from navigator language
// and doesn't see the popup's saved locale. Follow the shared settings snapshot so
// this window opens — and stays — in the language the user picked. (The main
// window also pushes `todos-locale` on open; both paths call applyLocale.)
const { settings, initSettings } = useSettings();
watch(() => settings.value.locale, (l) => applyLocale(l));

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

const todos = computed(() => boardStore.rows.value as unknown as Todo[]);
const changes = computed(() => boardStore.changes.value as unknown as BoardChange[]);
const loading = ref(true);
const errorMsg = ref("");
const detailRecord = ref<Todo | null>(null);
const detailLoading = ref(false);
const detailLoadFailed = ref(false);

type TodoMutation = BoardMutation;

async function applyTodoMutation(result: TodoMutation, refreshDetail = false) {
  boardStore.applyMutation(result);
  if (!result.row || (!refreshDetail && detailRecord.value?.id !== result.row.id)) return;
  const id = result.row.id;
  const updated = await invoke<Todo | null>("get_task_detail", { id });
  if (updated && detailId.value === id) detailRecord.value = updated;
}

interface BoardStateInfo {
  state: "ok" | "unreadable" | "future-version";
  file: string;
  backup?: string | null;
  reason?: string | null;
  version?: number | null;
}
const boardState = ref<BoardStateInfo | null>(null);
const boardRecovering = computed(
  () => boardState.value !== null && boardState.value.state !== "ok",
);

async function loadBoardState() {
  try {
    boardState.value = await invoke<BoardStateInfo>("board_state");
  } catch {
    boardState.value = null;
    return;
  }
  if (boardState.value.state !== "ok") void loadLatestBoardBackup();
}

interface TodoBackupInfo {
  name: string;
  when_ms: number;
}
const latestBoardBackup = ref<TodoBackupInfo | null>(null);
const restoringBoard = ref(false);

async function loadLatestBoardBackup() {
  try {
    latestBoardBackup.value = await invoke<TodoBackupInfo | null>("latest_todo_backup");
  } catch {
    latestBoardBackup.value = null;
  }
}

async function restoreBoardFromBackup() {
  if (restoringBoard.value || !latestBoardBackup.value) return;
  if (typeof window !== "undefined" && !window.confirm(t("migrateRestoreConfirm"))) return;
  restoringBoard.value = true;
  try {
    await invoke("restore_todo_backup", {});
    await loadTodos();
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    restoringBoard.value = false;
  }
}

const FILTER_STORAGE_KEY = "todo-board-filters-v1";
function readFilters(): TodoFilters {
  try { return { ...defaultTodoFilters(), ...JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? "{}") }; }
  catch { return defaultTodoFilters(); }
}
const filters = ref<TodoFilters>(readFilters());
watch(filters, value => { try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(value)); } catch {} }, { deep: true });
const projectFilter = computed({ get: () => filters.value.project, set: value => filters.value = { ...filters.value, project: value } });
const search = computed({ get: () => filters.value.query, set: value => filters.value = { ...filters.value, query: value } });

// Form state (doubles as create + edit). editingId === null → creating.
const editingId = ref<string | null>(null);
const fSubject = ref("");
const fDescription = ref("");
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

const SUBJECT_LIMIT = 150;
const fSubjectRemaining = computed(() => SUBJECT_LIMIT - fSubject.value.trim().length);
const fSubjectOverLimit = computed(() => fSubjectRemaining.value < 0);

// Projects the tracker has seen (from cc_usage), so the picker offers real
// projects even before any todo uses them.
const knownProjects = ref<string[]>([]);
const taskCosts = ref<Map<string, TaskCostRow>>(new Map());

// Merge-link badges (issue #13). A task's `project` is stored raw, so it may be a
// canonical (absorbed others) or an alias (folded into a canonical) — need both.
const { canonicalOf } = useProjectLinks();

// Project list for the filter/picker — RESOLVED to canonical names so a renamed
// project's tasks don't split across the old and new name. `knownProjects`
// (cc_projects) already comes canonical.
const projects = computed(() => {
  const set = new Set<string>();
  for (const t of todos.value) if (t.project) set.add(canonicalOf(t.project) ?? t.project);
  for (const p of knownProjects.value) set.add(p);
  return [...set].sort();
});
const taskProjects = computed(() => [...new Set(todos.value.flatMap((t) => t.project ? [canonicalOf(t.project) ?? t.project] : []))].sort());


const treeRows = computed<BoardTreeRow[]>(() => boardStore.rows.value.map((row) => ({
  ...row,
  cost: taskCosts.value.get(row.id)?.cost,
  filterProject: row.project ? canonicalOf(row.project) ?? row.project : null,
})));
const attentionCounts = computed(() => countAttention(
  treeRows.value,
  filters.value,
  localToday(),
  boardStore.indexes.value,
));
const TREE_FLAT_STORAGE_KEY = "todo-tree:flat";
function readTreeFlat(): boolean {
  try { return localStorage.getItem(TREE_FLAT_STORAGE_KEY) === "true"; }
  catch { return false; }
}
const flatTree = ref(readTreeFlat());
watch(flatTree, (value) => {
  try { localStorage.setItem(TREE_FLAT_STORAGE_KEY, String(value)); } catch {}
});
const tree = computed(() => buildBoardTree(treeRows.value, changes.value, filters.value, boardStore.indexes.value, { flat: flatTree.value }));
const selectedTreeNode = ref<BoardTreeNode | null>(null);
const selectedChange = computed(() => {
  const node = selectedTreeNode.value;
  return node?.kind === "change" ? changes.value.find((change) => change.id === node.id) ?? null : null;
});

function selectTreeNode(node: BoardTreeNode) {
  selectedTreeNode.value = node;
  if (node.kind === "task" || node.kind === "legacy") void openDetail(node);
  else closeDetail();
}

const detailChangeNode = computed<BoardTreeNode | null>(() => {
  const id = selectedTreeNode.value?.kind === "task" ? selectedTreeNode.value.id : null;
  if (!id) return null;
  const visit = (nodes: readonly BoardTreeNode[], change: BoardTreeNode | null): BoardTreeNode | null => {
    for (const node of nodes) {
      if (node.id === id) return change;
      const hit = visit(node.children, node.kind === "change" || node.kind === "legacy" ? node : change);
      if (hit) return hit;
    }
    return null;
  };
  return visit(tree.value, null);
});

function selectChangeTask(address: string) {
  const number = Number(address.replace(/^#/, ""));
  const row = boardStore.rows.value.find((candidate) => candidate.number === number);
  const node = row ? findBoardTreeNode(tree.value, row.id) : null;
  if (node) selectTreeNode(node);
}
function selectChangeTaskTrace(address: string) {
  const number = Number(address.replace(/^#/, ""));
  const row = boardStore.rows.value.find((candidate) => candidate.number === number);
  const node = row ? findBoardTreeNode(tree.value, row.id) : null;
  if (!node) return;
  selectTreeNode(node);
  void nextTick(() => { detailTab.value = "trace"; });
}

const openCount = computed(
  () => todos.value.filter((t) => t.status !== "done").length,
);

async function loadTodos(silent = false) {
  if (!silent) loading.value = true;
  try {
    await boardStore.start();
    if (boardStore.stale.value) await boardStore.reload();
    errorMsg.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    if (!silent) loading.value = false;
  }
  void loadBoardState();
}

function flushPendingReload() {
  if (boardStore.stale.value && !formOpen.value) {
    void boardStore.reload();
  }
}

function subjectCounterLabel(remaining: number): string {
  return remaining >= 0
    ? t("todoSubjectRemaining", { n: remaining })
    : t("todoSubjectOverLimit", { n: -remaining });
}

function resetForm() {
  editingId.value = null;
  fSubject.value = "";
  fDescription.value = "";
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
  if (!subject || subject.length > SUBJECT_LIMIT) return;
  const existing = editingId.value
    ? todos.value.find((x) => x.id === editingId.value)
    : null;
  const todo: Todo = {
    id: editingId.value ?? crypto.randomUUID(),
    subject,
    description: fDescription.value.trim(),
    status: existing?.status ?? formStatus.value,
    priority: fPriority.value || "",
    scheduled_for: fScheduled.value || null,
    plan: fPlan.value.trim(),
    project: fProject.value.trim() || null,
    comments: existing?.comments,
    links: existing?.links,
    created_by: existing?.created_by ?? "user",
    created_at: existing?.created_at ?? "",
    updated_at: existing?.updated_at ?? "",
    ext: existing?.ext,
  };
  try {
    await invoke<Todo[]>("upsert_todo", { todo });
    await boardStore.reload(true);
    resetForm();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// Move a card to a new column. Update the local list first so the card jumps
// instantly, then persist; on failure reload from disk to undo the optimism.
async function moveStatus(todo: Pick<Todo, "id" | "status">, status: string) {
  if (todo.status === status) return;
  try {
    const result = await invoke<TodoMutation>("set_todo_status", {
      id: todo.id,
      status,
    });
    await applyTodoMutation(result);
  } catch (e) {
    errorMsg.value = String(e);
    await boardStore.reload(true);
  }
}

// Deleting a task asks first (issue #21): the card's trash opens a confirm
// dialog; the actual removal happens in confirmDelete. `pendingDelete` holds the
// task awaiting confirmation (null = no dialog open).
const pendingDelete = ref<{ id: string; subject: string } | null>(null);
function removeTodo(todo: { id: string; subject: string }) {
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
    await invoke<Todo[]>("delete_todo", { id: todo.id });
    await boardStore.reload(true);
    if (editingId.value === todo.id) resetForm();
    if (detailId.value === todo.id) closeDetail();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

const view = ref<"board" | "detail">("board");
const detailId = ref<string | null>(null);

const detail = computed(() => {
  const row = todos.value.find((t) => t.id === detailId.value);
  if (!row) return null;
  return detailRecord.value?.id === row.id ? { ...row, ...detailRecord.value } : row;
});

type DetailTab = "overview" | "trace" | "comments";
const detailTab = ref<DetailTab>("overview");
const detailMenuOpen = ref(false);
const detailChange = computed<{ number: number | null; title: string } | null>(() => {
  const changeId = detail.value?.change_id;
  if (!changeId) return null;
  const change = changes.value.find((item) => item.id === changeId);
  if (change) return { number: change.number, title: change.title };
  const legacy = detailChangeNode.value;
  return legacy ? { number: legacy.number, title: legacy.title } : null;
});
const detailSiblings = computed(() => {
  const current = detail.value;
  if (!current?.change_id) return current ? [current] : [];
  return detailSiblingPages(todos.value, current.change_id, current.id, Number.MAX_SAFE_INTEGER, "change").visible;
});
type OverviewTree = { cost?: number; turns?: Array<{ calls?: Array<{ subagent?: OverviewTree | null }> }> };
type OverviewWork = {
  sessions?: Array<{ context?: { role?: "worker" | "review" | null }; tree?: OverviewTree }>;
  attempts?: Array<{ number: number; review?: { approved?: boolean; counts?: { critical: number; high: number; medium: number; low: number } | null } | null; sessions?: Array<{ context?: { role?: "worker" | "review" | null }; tree?: OverviewTree }> }>;
};
function treeModelCalls(tree?: OverviewTree | null): number {
  return (tree?.turns ?? []).reduce((total, turn) => total + 1 + (turn.calls ?? []).reduce((sum, call) => sum + treeModelCalls(call.subagent), 0), 0);
}
function workModelCalls(work: OverviewWork | null) {
  if (!work) return null;
  const sessions = [...(work.sessions ?? []), ...(work.attempts ?? []).flatMap((attempt) => attempt.sessions ?? [])];
  return sessions.reduce((total, session) => total + treeModelCalls(session.tree), 0);
}
const overviewWork = ref<OverviewWork | null>(null);
const overviewHandoff = computed(() => parseHandoff(detail.value?.handoff));
const overviewComments = computed(() => [...detailComments.value].slice(-2).reverse().map((comment) => ({
  ...comment,
  severity: commentSeverity(comment.author, comment.body),
  attempt: commentAttempt(comment.body),
})));
const overviewBlockedBy = computed(() => (detail.value?.depends_on ?? []).map((id) => todos.value.find((todo) => todo.id === id)).filter((todo): todo is Todo => !!todo));
const overviewBlocks = computed(() => detail.value ? blockingTasks(detail.value, todos.value) : []);
const overviewChange = computed(() => {
  const current = detail.value;
  if (!current?.change_id) return null;
  const change = changes.value.find((item) => item.id === current.change_id);
  if (!change) return null;
  const members = todos.value.filter((todo) => todo.change_id === change.id);
  const spent = members.reduce((sum, todo) => sum + (costOf(todo)?.cost ?? 0), 0);
  return { ...change, done: members.filter((todo) => todo.status === "done").length, total: members.length, spent };
});
const overviewRoleCosts = computed(() => sessionRoleCosts(overviewWork.value));
const overviewReview = computed(() => reviewOutcome(overviewWork.value?.attempts ?? []));
const overviewAttemptCount = computed(() => overviewWork.value?.attempts?.length ?? 0);
async function loadOverviewWork(id: string | null) {
  overviewWork.value = null;
  if (!id) return;
  try {
    const work = await invoke<OverviewWork>("get_task_work_tree", { task: id });
    if (detailId.value === id) overviewWork.value = work;
  } catch {}
}
function openOverviewTodo(todo: Todo) { void openDetail(todo); }
const detailSiblingIndex = computed(() => detailSiblings.value.findIndex((item) => item.id === detailId.value));
function openDetailSibling(offset: number) {
  const target = detailSiblings.value[detailSiblingIndex.value + offset];
  if (!target) return;
  const node = findBoardTreeNode(tree.value, target.id);
  if (node) selectedTreeNode.value = node;
  void openDetail(target);
}
function selectDetailProject() {
  if (!detail.value?.project) return;
  projectFilter.value = detail.value.project;
  closeDetail();
}

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
  handoff: string;
  project: string;
  scheduled_for: string;
  status: string;
  priority: string;
}
const draft = ref<Draft>({
  subject: "",
  description: "",
  plan: "",
  handoff: "",
  project: "",
  scheduled_for: "",
  status: "backlog",
  priority: "",
});
const draftSubjectRemaining = computed(() => SUBJECT_LIMIT - draft.value.subject.trim().length);
const draftSubjectOverLimit = computed(() => draftSubjectRemaining.value < 0);

// Handoff the open task INHERITS from its direct prerequisites (#141): the same
// view `cc-todos todos handoff <task>` gives an agent, surfaced read-only in the
// card. Only direct `depends_on` — cumulative context rides authored handoff text.
const inheritedHandoff = computed(() => {
  const cur = detail.value;
  if (!cur || !Array.isArray(cur.depends_on) || !cur.depends_on.length) return [];
  const byId = new Map(todos.value.map((t) => [t.id, t]));
  return cur.depends_on
    .map((id) => byId.get(id))
    .filter((p): p is Todo => !!p)
    .map((p) => ({
      id: p.id,
      number: p.number,
      subject: p.subject,
      status: p.status,
      handoff: (p.handoff ?? "").trim(),
    }));
});

function fillDraft(todo: Todo) {
  draft.value = {
    subject: todo.subject,
    description: todo.description ?? "",
    plan: todo.plan ?? "",
    handoff: todo.handoff ?? "",
    project: todo.project ?? "",
    scheduled_for: todo.scheduled_for ?? "",
    status: todo.status,
    priority: todo.priority ?? "",
  };
}

function clearDetailDraft() {
  draft.value = {
    subject: "",
    description: "",
    plan: "",
    handoff: "",
    project: "",
    scheduled_for: "",
    status: "backlog",
    priority: "",
  };
}

async function openDetail(todo: { id: string }) {
  detailId.value = todo.id;
  detailRecord.value = null;
  clearDetailDraft();
  detailLoading.value = true;
  detailLoadFailed.value = false;
  descMode.value = "edit";
  mention.value = null;
  saved.value = false;
  detailTab.value = "overview";
  detailMenuOpen.value = false;
  void loadOverviewWork(todo.id);
  try {
    const full = await invoke<Todo | null>("get_task_detail", { id: todo.id });
    if (full && detailId.value === todo.id) {
      detailRecord.value = full;
      fillDraft(full);
    }
  } catch {
    if (detailId.value === todo.id) detailLoadFailed.value = true;
  } finally {
    if (detailId.value === todo.id) detailLoading.value = false;
  }
}

function closeDetail() {
  detailId.value = null;
  detailRecord.value = null;
  detailLoading.value = false;
  detailLoadFailed.value = false;
  overviewWork.value = null;
}

async function saveDetail() {
  const cur = detail.value;
  if (!cur || !detailRecord.value || detailLoading.value) return;
  const id = cur.id;
  const d = draft.value;
  if (!d.subject.trim() || d.subject.trim().length > SUBJECT_LIMIT) return;
  const todo: Todo = {
    ...cur, // keep id / comments / links / created_at / updated_at
    subject: d.subject.trim(),
    description: d.description.trim(),
    plan: d.plan.trim(),
    handoff: d.handoff.trim(),
    project: d.project.trim() || null,
    scheduled_for: d.scheduled_for || null,
    status: d.status,
    priority: d.priority || "",
  };
  try {
    await invoke<Todo[]>("upsert_todo", { todo });
    await boardStore.reload(true);
    if (detailId.value === id) {
      detailRecord.value = todo;
      flashSaved();
    }
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

const detailComments = computed(() => detailRecord.value?.comments ?? []);
const renderedDetailComments = ref<Array<{ id: string; author: string; created_at: string; body: string; segments: ReturnType<typeof tokenize> }>>([]);
watch(detailRecord, (record) => {
  renderedDetailComments.value = (record?.comments ?? []).map((comment) => ({
    ...comment,
    segments: tokenize(comment.body),
  }));
});

async function addComment() {
  const body = newComment.value.trim();
  if (!body || !detail.value) return;
  try {
    const result = await invoke<TodoMutation>("add_todo_comment", {
      id: detail.value.id,
      body,
    });
    await applyTodoMutation(result, true);
    newComment.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function removeComment(id: string) {
  if (!detail.value) return;
  try {
    const result = await invoke<TodoMutation>("remove_todo_comment", {
      id: detail.value.id,
      commentId: id,
    });
    await applyTodoMutation(result, true);
  } catch (e) {
    errorMsg.value = String(e);
  }
}

function commentAuthorLabel(author: string) {
  if (author === "claude") return t("todoAuthorClaude");
  if (author === "review") return t("workRoleReviewer");
  if (author === "architect") return t("todoAuthorArchitect");
  return author === "user" || !author ? t("todoAuthorYou") : author;
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
// Split plain text into runs, marking URLs, task references (t#N) and project
// references (@name). Deliberately NOT v-html: every run renders through Vue
// text interpolation (escaped) — a crafted comment can't inject markup. Opened
// URLs go through the backend `open_url` command (http/https only); t#N/@name
// navigate inside the app.
//
// Task refs use `t#N`, NOT a bare `#N` (#63): in prose `#104` overwhelmingly means
// a GitHub PR/issue, and when its number collided with a task's the link silently
// pointed at the wrong task (even in another project). So `#N` is now plain text;
// only the explicit `t#N` form links to a task.
type Seg =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string; href: string }
  | { kind: "task"; text: string; number: number; subject: string }
  | { kind: "project"; text: string; project: string };

// One pass: URL | t#digits (task ref) | @slug. Classification by which group
// matched. The `t` is required (see above) and must not be the tail of a word
// (the lookbehind rejects `part#5`); a bare `#N` matches nothing here.
const TOKEN_RE =
  /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)|(?<![A-Za-z0-9])[tT]#(\d+)|@([A-Za-z0-9._\-]+)/g;

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
      // Only a number that maps to a real task becomes a link; otherwise the
      // `t#5` is left as plain text so it doesn't pretend to be a reference.
      if (tt) seg = { kind: "task", text: `t#${num}`, number: num, subject: tt.subject };
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

// Board vs graph view (#88): the graph is an alternative rendering of the SAME
// filtered board, toggled in place — not a separate window. It shares this
// window's `todos` and `projectFilter`.
const viewMode = ref<"board" | "graph">("board");
const graphMode = ref<PipelineMode>("bubbles");
const pipelineGraphRef = ref<InstanceType<typeof PipelineGraph> | null>(null);
const pipelineActiveHit = ref<string | null>(null);
function onSearchEnter(event?: KeyboardEvent) {
  if (viewMode.value !== "graph") return;
  pipelineGraphRef.value?.cycleHit(event?.shiftKey ? -1 : 1);
}

// Keyboard shortcuts (registry in ../hotkeys): Ctrl+F → search, Ctrl+P → project.
const searchInputRef = ref<HTMLInputElement | null>(null);
const filtersBarRef = ref<InstanceType<typeof TodoFiltersBar> | null>(null);
const treeWidth = ref(380);
function resizeTree(event: PointerEvent) {
  treeWidth.value = Math.max(260, Math.min(640, event.clientX));
}
function stopTreeResize() {
  document.removeEventListener("pointermove", resizeTree);
  document.removeEventListener("pointerup", stopTreeResize);
}
function startTreeResize() {
  document.addEventListener("pointermove", resizeTree);
  document.addEventListener("pointerup", stopTreeResize, { once: true });
}
useHotkeys({
  search: () => (viewMode.value === "board" ? filtersBarRef.value?.focusSearch() : searchInputRef.value?.focus()),
  project: () => filtersBarRef.value?.focusProject(),
});

// Clicking a graph node opens that task's card — the same detail panel the board
// uses (it overlays the graph and returns to it on close).
// The pipeline screens address a task the way a human does — "#345" — while the
// classic graph passes the uuid. Accept both so either can open the card.
function onPipelineOpen(ref: string) {
  const byRef = ref.startsWith("#")
    ? byNumber.value.get(Number(ref.slice(1)))
    : todos.value.find((x) => x.id === ref);
  if (!byRef) return;
  viewMode.value = "board";
  const node = findBoardTreeNode(tree.value, byRef.id);
  selectedTreeNode.value = node;
  void openDetail(byRef);
}

function onPipelineTrace(ref: string) {
  const byRef = ref.startsWith("#")
    ? byNumber.value.get(Number(ref.slice(1)))
    : todos.value.find((x) => x.id === ref);
  if (!byRef) return;
  viewMode.value = "board";
  const node = findBoardTreeNode(tree.value, byRef.id);
  if (!node) return;
  selectTreeNode(node);
  void nextTick(() => { detailTab.value = "trace"; });
}

// Navigate a t#N reference to that task's detail; a @name reference back to the
// board filtered to that project.
function openTask(number: number) {
  const t = byNumber.value.get(number);
  if (t) openDetail(t);
}
function openProject(name: string) {
  projectFilter.value = name;
  closeDetail();
}

// Description has an edit/preview toggle: edit = textarea, preview = the same
// text with links/references rendered. Reset to edit whenever a task opens.
const descMode = ref<"edit" | "preview">("edit");
const descSegments = computed(() => tokenize(draft.value.description));

// --- Inline-reference autocomplete (the "preview the task you mean" popup) ---
// A GitHub-style trigger menu: typing `t#` lists tasks (number + subject so you
// can tell which one), `@` lists projects. It drives plain-text insertion — the
// stored text stays `t#12` / `@proj`, resolved at render time by tokenize().
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
  trigger: "#" | "@"; // logical kind: task picker vs project picker
  query: string;
  start: number; // index of the FIRST trigger char (the `t` of `t#`, or `@`)
  prefixLen: number; // trigger length: 2 for `t#`, 1 for `@`
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
      .map((t) => ({ label: `t#${t.number}`, sub: t.subject, value: String(t.number) }));
  }
  let list = projects.value;
  if (q) list = list.filter((p) => p.toLowerCase().includes(q));
  return list.slice(0, 50).map((p) => ({ label: `@${p}`, sub: "", value: p }));
});

// A mention is a SESSION: it opens the moment a `t#` (task) or `@` (project)
// trigger is typed at line start or after whitespace, and stays open as you keep
// typing, so a `t#` query can hold the words of a task title (spaces and all),
// GitHub-style. The session ends when the trigger is deleted, the caret leaves it,
// a newline/oversized/`@`-with-space query appears, or you pick/escape. Picking
// inserts `t#<number>` / `@<project>`, not the title. A bare `#` does NOT trigger
// the task picker (#63): `#N` is prose (a PR/issue), only `t#N` is a task ref.
const MENTION_MAX_QUERY = 60;
// True if position `i` is a word start — index 0 or preceded by whitespace — so a
// `t#`/`@` mid-word (e.g. `art#5`, `email@host`) isn't hijacked into a picker.
const atWordStart = (text: string, i: number) => i === 0 || /\s/.test(text[i - 1]);
function onMentionInput(target: "desc" | "comment", e: Event) {
  const el = e.target as HTMLTextAreaElement;
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const m = mention.value;
  // Continue an open session while its trigger prefix is still intact.
  const prefixIntact = (s: MentionState) =>
    s.trigger === "@"
      ? text[s.start] === "@"
      : /[tT]/.test(text[s.start] ?? "") && text[s.start + 1] === "#";
  if (m && m.target === target && caret >= m.start + m.prefixLen && prefixIntact(m)) {
    const query = text.slice(m.start + m.prefixLen, caret);
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
  // Open a new session only when a trigger was JUST completed at the caret: `@`
  // (1 char) or `t#` (2 chars, the `#` just typed after a word-start `t`).
  const prev = text[caret - 1];
  if (prev === "@" && atWordStart(text, caret - 1)) {
    mention.value = { target, trigger: "@", query: "", start: caret - 1, prefixLen: 1, caret, sel: 0 };
  } else if (
    prev === "#" &&
    /[tT]/.test(text[caret - 2] ?? "") &&
    atWordStart(text, caret - 2)
  ) {
    mention.value = { target, trigger: "#", query: "", start: caret - 2, prefixLen: 2, caret, sel: 0 };
  } else if (mention.value && mention.value.target === target) {
    mention.value = null;
  }
}

async function pickMention(item: MentionItem) {
  const m = mention.value;
  if (!m) return;
  const insert = (m.trigger === "#" ? `t#${item.value}` : `@${item.value}`) + " ";
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

// --- External tasks (readonly mirror; plan External-integration-public-side, ph6) ---
// The tracker OWNS todos (above); external tasks are a READONLY mirror folded on the
// backend into external_tasks.json and surfaced via get_external_tasks / poll_external
// + the `external-tasks-updated` event. They carry SOURCE-NATIVE status strings (not
// our 5 columns), so they live in a separate "External" mode — a grouped-by-source
// list, never the kanban board — and are never editable/draggable here.
interface ExternalTask {
  task_id: string;
  source: string;
  title: string;
  status: string;
  url: string;
  updated_at: string;
  priority?: string | null;
  assignee?: string | null;
  // Forward-compat DTO: the private side will start sending these (project now,
  // description maybe). Optional so today's payloads (without them) stay valid;
  // the UI renders them only when present.
  description?: string | null;
  project?: string | null;
  last_event_ts: string;
  last_event_kind: string;
}
interface ExternalTasksCache {
  tasks: ExternalTask[];
  last_poll_at?: string | null;
}
interface StatusChange {
  task_id: string;
  source: string;
  to: string;
}
interface ExternalTasksUpdate {
  tasks: ExternalTask[];
  changes: StatusChange[];
}

// Top-level view mode: the owned board ("local") vs the readonly mirror ("external").
const taskMode = ref<"local" | "external">("local");
const externalTasks = ref<ExternalTask[]>([]);
const externalLastPoll = ref<string | null>(null);
const externalRefreshing = ref(false);
// Whether this device is enrolled — drives the empty tab's "connect a resolver"
// prompt vs the plain "nothing mirrored yet" message.
const externalBound = ref(false);
// Keys (source::task_id) whose status changed during this session, so the list can
// badge "изменилось" until the user leaves the tab (then they've been seen).
const externalChanged = ref<Set<string>>(new Set());

function extKey(source: string, taskId: string): string {
  return `${source}::${taskId}`;
}
function externalIsChanged(t: ExternalTask): boolean {
  return externalChanged.value.has(extKey(t.source, t.task_id));
}

const externalCount = computed(() => externalTasks.value.length);

// User-owned status→bucket overrides (Settings → Integrations), read from
// settings.json. Empty = fall back to the keyword heuristic in externalStatus.ts.
const statusMap = ref<StatusMap>({});
async function loadStatusMap() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    statusMap.value = (await store.get<StatusMap>(STATUS_MAP_KEY)) ?? {};
  } catch {
    // store missing / not under Tauri → keep the heuristic defaults
  }
}

// Pill colour follows the SAME resolution as the column, so a remapped status
// recolours to match its new column.
function extStatusClass(status: string): string {
  return bucketClass(resolveBucket(status, statusMap.value));
}

// Readonly kanban: fixed columns, source statuses resolved to a bucket via the user
// map (heuristic default). Cards DON'T drag — status is owned upstream. The "other"
// column only appears when something landed there. Tasks keep the backend's
// freshest-first order within each column.
interface ExtColumn {
  id: ExtBucketId;
  label: string;
  dot: string;
  tasks: ExternalTask[];
}
const externalColumns = computed<ExtColumn[]>(() => {
  const buckets: Record<ExtBucketId, ExternalTask[]> = { open: [], active: [], done: [], other: [] };
  for (const tk of externalTasks.value) buckets[resolveBucket(tk.status, statusMap.value)].push(tk);
  const cols: ExtColumn[] = [];
  for (const b of EXT_BUCKETS) {
    // "other" is a catch-all — show it only when non-empty; the three real
    // columns always render (even empty) so the board reads as a kanban.
    if (b.id === "other" && !buckets.other.length) continue;
    cols.push({ id: b.id, label: t(b.labelKey), dot: b.dot, tasks: buckets[b.id] });
  }
  return cols;
});

// Read the persisted mirror without polling (fast, offline-friendly). Also drives
// the "External · N" count chip while in local mode.
async function loadExternalTasks() {
  try {
    const cache = await invoke<ExternalTasksCache>("get_external_tasks");
    externalTasks.value = cache.tasks ?? [];
    externalLastPoll.value = cache.last_poll_at ?? null;
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// Enrolled? poll_external returns null when not bound; we read enrollment_status so
// the empty tab can point at Settings → Integrations instead of looking broken.
async function refreshExternalBound() {
  try {
    const status = await invoke<{ account: string | null }>("enrollment_status");
    externalBound.value = !!status?.account;
  } catch {
    externalBound.value = false;
  }
}

function applyExternalUpdate(update: ExternalTasksUpdate) {
  externalTasks.value = update.tasks ?? [];
  for (const c of update.changes ?? []) externalChanged.value.add(extKey(c.source, c.task_id));
  externalBound.value = true;
}

// Manual refresh (the tab's Refresh button). null = not enrolled.
async function refreshExternal() {
  if (externalRefreshing.value) return;
  externalRefreshing.value = true;
  try {
    const update = await invoke<ExternalTasksUpdate | null>("poll_external");
    if (update) applyExternalUpdate(update);
    else externalBound.value = false;
    await loadExternalTasks(); // pick up the fresh last_poll_at
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    externalRefreshing.value = false;
  }
}

function switchMode(m: "local" | "external") {
  taskMode.value = m;
  if (m === "external") {
    void refreshExternalBound();
    void loadExternalTasks();
    void loadStatusMap();
  } else {
    // Left the tab → the "изменилось" badges have been seen; clear them, and drop
    // any open detail so re-entering the tab lands on the list.
    externalChanged.value = new Set();
    externalDetailKey.value = null;
  }
}

async function openExternal(url: string) {
  if (url) await openLink(url);
}

// --- External detail (readonly card) ---
// Opening an external task shows a readonly detail of what the mirror KNOWS: the
// contract deliberately omits the raw description (sanitised away on the private
// side; the `url` is the door to the full task), so there's no editable body — this
// is a metadata + provenance view, keyed by source::task_id so a live poll that
// updates the task re-renders it in place.
const externalDetailKey = ref<string | null>(null);
const externalDetailTask = computed<ExternalTask | null>(() => {
  if (!externalDetailKey.value) return null;
  return (
    externalTasks.value.find(
      (t) => extKey(t.source, t.task_id) === externalDetailKey.value,
    ) ?? null
  );
});
function openExternalDetail(t: ExternalTask) {
  externalDetailKey.value = extKey(t.source, t.task_id);
}
function closeExternalDetail() {
  externalDetailKey.value = null;
}

// Human label for an envelope `type` (contract §1.1: the four fixed event forms).
function eventKindLabel(kind: string): string {
  switch (kind) {
    case "task_created":
      return t("extEventCreated");
    case "task_status_changed":
      return t("extEventStatus");
    case "task_moved":
      return t("extEventMoved");
    case "task_comment_added":
      return t("extEventComment");
    default:
      return kind;
  }
}

// Absolute timestamp for the detail meta (relTime gives the relative one).
function fmtDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale.value === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Open the shared settings window on the Integrations tab (the enrollment screen).
async function openIntegrations() {
  await invoke("open_settings_window", { tab: "integrations" });
}

// "just now" / "N min ago" / "N h ago" for a recent RFC3339 timestamp; older or
// unparseable falls back to the absolute fmtTime.
function relTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return t("todoJustNow");
  if (min < 60) return `${min}${t("minShort")} ${t("todoAgo")}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}${t("hourShort")} ${t("todoAgo")}`;
  return fmtTime(iso);
}

let unlistenLocale: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let unlistenExternal: (() => void) | null = null;
let unlistenTaskCosts: (() => void) | null = null;

// Refresh the project picker from cc_usage. The todos window is a persisted
// webview (created once at startup, then shown/hidden), so `onMounted` runs a
// single time — without re-pulling, a project first used after launch never
// reaches the picker. We also kick a background ingest (like the Analytics
// window) so a brand-new project lands in cc_usage even if Analytics was never
// opened this session.
// ── tokens-per-task (t#87) ────────────────────────────────────────────────────
// The backend joins the transcript-derived session→task attribution with the
// per-session token totals (get_task_costs). Conservative by design: a session
// counts toward a task only when the evidence names exactly one task, so a
// missing chip means "not attributable", not "free".
interface TaskCostRow {
  id: string;
  number: number;
  sessions: number;
  direct_sessions: number;
  interval_sessions: number;
  explicit_sessions: number;
  auto_sessions: number;
  total_tokens: number;
  cost: number;
}
interface TaskCostsPayload {
  generated_at: string;
  tasks: TaskCostRow[];
  ambiguous_sessions: number;
  ambiguous_tokens: number;
  ambiguous_cost: number;
}
async function loadTaskCosts() {
  try {
    const res = await invoke<TaskCostsPayload | null>("get_task_costs");
    const m = new Map<string, TaskCostRow>();
    for (const r of res?.tasks ?? []) m.set(r.id, r);
    taskCosts.value = m;
  } catch {
    // keep whatever we had — the chip is best-effort decoration
  }
}

function costOf(todo: Todo | null | undefined): TaskCostRow | null {
  if (!todo) return null;
  return taskCosts.value.get(todo.id) ?? null;
}

const fmtCost = (c: number) => "$" + (c >= 100 ? String(Math.round(c)) : c.toFixed(2));

// ── cost by block (t#298) ─────────────────────────────────────────────────────
// A block = this task worked by ONE session over ONE stretch of time, from the
// binding journal (`todos take` / a status move). The per-task total above is
// per-SESSION and older than the journal, so the two disagree by design: work
// between blocks belongs to no task, and pre-journal sessions have no blocks at
// all. That difference is shown rather than hidden — see `blocksOutside`.
interface TaskBlockRow {
  task: string;
  number: number;
  subject: string;
  session: string;
  from: string;
  to: string;
  explicit: boolean;
  source: string;
  project?: string;
  cost: number;
  total_tokens: number;
  messages: number;
  tool_calls: number;
  tool_errors: number;
}
interface TaskBlocksPayload {
  blocks: TaskBlockRow[];
  explicit_blocks: number;
  auto_blocks: number;
}

const taskBlocks = ref<TaskBlockRow[]>([]);

async function loadTaskBlocks(id: string | null) {
  if (!id) {
    taskBlocks.value = [];
    return;
  }
  try {
    const res = await invoke<TaskBlocksPayload | null>("get_task_blocks", { task: id });
    taskBlocks.value = res?.blocks ?? [];
  } catch {
    taskBlocks.value = [];
  }
}

const blocksSum = computed(() =>
  taskBlocks.value.reduce((acc, b) => acc + (b.cost || 0), 0),
);

const detailTraceCalls = computed(() =>
  workModelCalls(overviewWork.value) ?? taskBlocks.value.reduce((total, block) => total + block.tool_calls, 0),
);

const blocksOutside = computed(() => {
  const total = detail.value ? (costOf(detail.value)?.cost ?? 0) : 0;
  return Math.max(0, total - blocksSum.value);
});

watch(detailId, (id) => {
  void loadTaskBlocks(id);
});

function blockSpan(b: TaskBlockRow): string {
  const ms = new Date(b.to).getTime() - new Date(b.from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
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
  await initSettings();
  applyLocale(settings.value.locale);
  // The main window pushes its current locale here whenever it opens this
  // window — this is a separate WebView that may detect a different navigator
  // language and have no saved locale to read from the store.
  const { listen } = await import("@tauri-apps/api/event");
  unlistenLocale = await listen<string>("todos-locale", (e) => {
    applyLocale(e.payload);
  });
  // A poll folded new external events; refresh the mirror + flag changed tasks.
  // Fires whether or not the External tab is open, so the count chip stays live.
  unlistenExternal = await listen<ExternalTasksUpdate>("external-tasks-updated", (e) => {
    applyExternalUpdate(e.payload);
  });
  // The background publisher re-derived the session→task attribution (t#87);
  // re-read the joined costs so the ⚡ chips stay current.
  unlistenTaskCosts = await listen("task-costs-updated", () => {
    void loadTaskCosts();
  });
  await loadTodos();
  void loadTaskCosts();
  // Populate the "External · N" count chip even while in local mode.
  void loadExternalTasks();
  void loadStatusMap();
  await refreshKnownProjects();
  // Persisted webview: refresh the picker each time the window is brought to
  // front, so a project used since the last view (now in cc_usage) shows up.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) {
      void refreshKnownProjects();
      // Pick up a status remap done in the Settings → Integrations window.
      void loadStatusMap();
      void loadExternalTasks();
      if (boardStore.stale.value) void boardStore.reload();
    }
  });
});

onUnmounted(() => {
  stopTreeResize();
  if (unlistenLocale) unlistenLocale();
  if (unlistenFocus) unlistenFocus();
  if (unlistenExternal) unlistenExternal();
  if (unlistenTaskCosts) unlistenTaskCosts();
});
</script>

<template>
  <div class="tw-root">
    <!-- BOARD VIEW (owned todos) -->
    <template v-if="taskMode === 'local' && view === 'board'">
    <header class="tw-head">
      <div class="tw-title">
        <h1>{{ t("tasksTitle") }}</h1>
        <div class="tw-modes">
          <button class="tw-mode active" @click="switchMode('local')">
            {{ t("todoModeLocal") }}
          </button>
          <button class="tw-mode" @click="switchMode('external')">
            {{ t("todoModeExternal") }}<span v-if="externalCount" class="tw-mode-count">{{ externalCount }}</span>
          </button>
        </div>
        <span class="tw-open">{{ openCount }} {{ t("todoOpenItems") }}</span>
      </div>
      <div class="tw-spacer"></div>
      <TodoFiltersBar
        v-if="viewMode === 'board'"
        ref="filtersBarRef"
        v-model="filters"
        :projects="taskProjects"
        :attention-counts="attentionCounts"
      />
      <div v-else class="tw-search">
        <input ref="searchInputRef" v-model="search" class="tw-search-input" :placeholder="t('graphSearch')" @keydown.enter="onSearchEnter" @keydown.esc="search = ''" />
      </div>
      <div class="tw-viewtoggle" role="tablist">
        <button
          class="tw-vt"
          :class="{ active: viewMode === 'board' }"
          role="tab"
          :aria-selected="viewMode === 'board'"
          :title="t('viewBoard')"
          @click="viewMode = 'board'"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="1.5" y="2.5" width="3.6" height="11" rx="1" />
            <rect x="6.2" y="2.5" width="3.6" height="7.5" rx="1" />
            <rect x="10.9" y="2.5" width="3.6" height="9.5" rx="1" />
          </svg>
          {{ t("viewBoard") }}
        </button>
        <button
          class="tw-vt"
          :class="{ active: viewMode === 'graph' }"
          role="tab"
          :aria-selected="viewMode === 'graph'"
          :title="t('viewGraph')"
          @click="viewMode = 'graph'"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="4" cy="4" r="2" />
            <circle cx="12" cy="4" r="2" />
            <circle cx="8" cy="12.5" r="2" />
            <path d="M5.6 5.4 8 10.6M10.4 5.4 8 10.6" />
          </svg>
          {{ t("viewGraph") }}
        </button>
      </div>
      <button class="tw-guide" :title="t('todoGuideHint')" @click="openGuide">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 3.2c1.8-.6 3.7-.6 5.5.3 1.8-.9 3.7-.9 5.5-.3v8.6c-1.8-.6-3.7-.6-5.5.3-1.8-.9-3.7-.9-5.5-.3z" />
          <path d="M8 3.5v8.6" />
        </svg>
        {{ t("todoGuide") }}
      </button>
      <button class="tw-guide" :title="t('settings')" @click="openSettings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.18.42.43.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3-1.07-3-3.5s1.07-3.5 3-3.5 3 1.07 3 3.5-1.07 3.5-3 3.5z" />
        </svg>
        {{ t("settings") }}
      </button>
      <button class="tw-add" @click="startNew('backlog')">+ {{ t("todoAdd") }}</button>
    </header>

    <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

    <div v-if="boardRecovering" class="tw-recovery">
      <span class="tw-recovery-text">
        <template v-if="boardState?.state === 'unreadable'">
          {{ t("boardUnreadable", { reason: boardState.reason }) }}
          {{ boardState.backup ? t("boardBackupAt", { path: boardState.backup }) : t("boardNoBackup") }}
        </template>
        <template v-else-if="boardState?.state === 'future-version'">
          {{ t("boardFutureVersion", { version: boardState.version, current: BOARD_CURRENT_VERSION }) }}
        </template>
        <template v-if="latestBoardBackup">
          {{ t("boardRestorePeriodicBackup", { path: latestBoardBackup.name }) }}
        </template>
      </span>
      <button
        v-if="latestBoardBackup"
        class="tw-recovery-restore"
        :disabled="restoringBoard"
        @click="restoreBoardFromBackup"
      >
        {{ restoringBoard ? t("migrateRestoring") : t("migrateRestore") }}
      </button>
    </div>

    <div v-if="loading" class="tw-empty">{{ t("loading") }}</div>

    <!-- Task links, rendered as bubbles or rings. -->
    <PipelineGraph
      ref="pipelineGraphRef"
      v-else-if="viewMode === 'graph'"
      :query="search"
      :filters="filters"
      v-model:mode="graphMode"
      v-model:active-hit="pipelineActiveHit"
      @open="onPipelineOpen"
      @trace="onPipelineTrace"
    />

    <div v-else class="tw-tree-layout" :style="{ '--tree-width': `${detailTab === 'trace' ? 300 : treeWidth}px` }">
      <TodoTree
        v-model:flat="flatTree"
        :tree="tree"
        :selected-id="selectedTreeNode?.id"
        :searching="Boolean(filters.query.trim())"
        @select="selectTreeNode"
        @open="selectTreeNode($event)"
      />
      <div class="tw-tree-resize" @pointerdown.prevent="startTreeResize"></div>
      <div v-if="detailId" class="tw-tree-detail">
        <section v-if="detail && detailRecord && !detailLoading" class="tw-detail-main">
          <nav class="tw-detail-crumbs" :aria-label="t('todoBreadcrumbs')">
            <button class="tw-crumb" :disabled="!detail.project" @click="selectDetailProject">{{ detail.project || t('todoNoProject') }}</button>
            <span class="tw-crumb-separator">›</span>
            <button v-if="detailChange" class="tw-crumb tw-crumb-change" @click="detailChangeNode && selectTreeNode(detailChangeNode)">c#{{ detailChange.number }} {{ detailChange.title }}</button>
            <span v-if="detailChange" class="tw-crumb-separator">›</span>
            <button class="tw-crumb tw-crumb-current" @click="openDetail(detail)">#{{ detail.number }}</button>
            <div class="tw-detail-pager">
              <button :disabled="detailSiblingIndex <= 0" :aria-label="t('todoPreviousTask')" @click="openDetailSibling(-1)">‹</button>
              <span>{{ detailSiblingIndex + 1 }} / {{ detailSiblings.length }}</span>
              <button :disabled="detailSiblingIndex < 0 || detailSiblingIndex >= detailSiblings.length - 1" :aria-label="t('todoNextTask')" @click="openDetailSibling(1)">›</button>
            </div>
          </nav>
          <div class="tw-detail-pane-head">
            <h2><span v-if="detail.number" class="tw-detail-num">#{{ detail.number }}</span>{{ detail.subject }}</h2>
            <div class="tw-detail-menu-wrap">
              <button class="tw-detail-menu-button" :aria-label="t('todoMore')" @click="detailMenuOpen = !detailMenuOpen">⋯</button>
              <div v-if="detailMenuOpen" class="tw-detail-menu">
                <button @click="detailMenuOpen = false; removeTodo(detail)">{{ t('todoDelete') }}</button>
              </div>
            </div>
          </div>
          <div class="tw-detail-meta">
            <div class="tw-status-segments" :aria-label="t('todoStatus')">
              <button v-for="column in COLUMNS" :key="column.id" :class="['tw-status-segment', { active: detail.status === column.id, done: column.id === 'done', progress: column.id === 'in_progress' }]" @click="moveStatus(detail, column.id)">{{ t(column.labelKey) }}</button>
            </div>
            <span v-if="detail.priority" class="tw-detail-chip">{{ priorityLabel(detail.priority) }}</span>
            <span v-if="detail.kind" class="tw-detail-chip">{{ detail.kind }}</span>
            <span v-if="costOf(detail)" class="tw-detail-chip tw-detail-cost">{{ fmtCost(costOf(detail)!.cost) }}</span>
            <span v-if="overviewAttemptCount" class="tw-detail-chip">{{ overviewAttemptCount }} {{ t('todoAttempts') }} · {{ overviewReview ? t(overviewReview === 'approved' ? 'todoReviewApproved' : 'todoReviewFindings') : t('todoReviewPending') }}</span>
          </div>
          <div class="tw-detail-tabs" role="tablist">
            <button :class="{ active: detailTab === 'overview' }" @click="detailTab = 'overview'">{{ t('todoOverview') }}</button>
            <button :class="{ active: detailTab === 'trace' }" @click="detailTab = 'trace'">{{ t('todoTrace') }} <span>{{ detailTraceCalls }} {{ t('todoBlocksCalls') }}</span> <span v-if="costOf(detail)">{{ fmtCost(costOf(detail)!.cost) }}</span></button>
            <button :class="{ active: detailTab === 'comments' }" @click="detailTab = 'comments'">{{ t('todoComments') }} <span>{{ detailComments.length }}</span></button>
          </div>
          <template v-if="detailTab === 'overview'">
            <div class="tw-overview">
              <div class="tw-overview-main">
                <section class="tw-overview-section"><h3>{{ t('todoDescription') }}</h3><div class="tw-overview-description">{{ detail.description || t('todoNoDescription') }}</div></section>
                <section class="tw-overview-section"><h3>{{ t('todoHandoff') }}</h3><div v-if="overviewHandoff.parts.length" class="tw-handoff-card"><div v-for="part in overviewHandoff.parts" :key="part.part" class="tw-handoff-row"><b>{{ overviewHandoff.fallback ? t('todoHandoff') : t(`todoHandoff${part.part[0].toUpperCase()}${part.part.slice(1)}`) }}</b><span>{{ part.text }}</span></div></div><div v-else class="tw-overview-empty">{{ t('todoNoDescription') }}</div></section>
                <section class="tw-overview-section"><h3>{{ t('todoRecentComments') }}</h3><div v-if="!overviewComments.length" class="tw-overview-empty">{{ t('todoCommentsEmpty') }}</div><ul v-else class="tw-overview-comments"><li v-for="comment in overviewComments" :key="comment.id"><div><b>{{ commentAuthorLabel(comment.author) }}</b><span v-if="comment.severity" :class="['tw-severity', comment.severity]">{{ comment.severity }}</span><span v-if="comment.attempt !== null" class="tw-attempt-chip">{{ t('todoAttempt') }} {{ comment.attempt }} / {{ overviewAttemptCount || 1 }} · {{ t('todoReview') }}</span></div><p>{{ comment.body }}</p></li></ul></section>
              </div>
              <aside class="tw-overview-side">
                <section v-if="overviewChange" class="tw-overview-card"><h3>c#{{ overviewChange.number }} {{ overviewChange.title }}</h3><div class="tw-overview-stat"><span>{{ overviewChange.done }} / {{ overviewChange.total }}</span><span>{{ fmtCost(overviewChange.spent) }}<template v-if="overviewChange.budget_usd != null"> / {{ fmtCost(overviewChange.budget_usd) }}</template></span></div><div class="tw-overview-bar"><i :style="{ width: `${overviewChange.total ? overviewChange.done / overviewChange.total * 100 : 0}%` }"></i></div></section>
                <section class="tw-overview-section"><h3>{{ t('todoDependsOn') }}</h3><button v-for="todo in overviewBlockedBy" :key="todo.id" class="tw-relation" @click="openOverviewTodo(todo)"><i :class="todo.status"></i>#{{ todo.number }} {{ todo.subject }}</button><div v-if="!overviewBlockedBy.length" class="tw-overview-empty">—</div></section>
                <section class="tw-overview-section"><h3>{{ t('todoBlocksTasks') }}</h3><button v-for="todo in overviewBlocks" :key="todo.id" class="tw-relation" @click="openOverviewTodo(todo)"><i :class="todo.status"></i>#{{ todo.number }} {{ todo.subject }}</button><div v-if="!overviewBlocks.length" class="tw-overview-empty">—</div></section>
                <section class="tw-overview-section"><h3>{{ t('todoSessionCost') }}</h3><div class="tw-role-cost"><span>{{ t('workRoleWorker') }}</span><b>{{ fmtCost(overviewRoleCosts.worker) }}</b></div><div class="tw-role-cost"><span>{{ t('workRoleReviewer') }}</span><b>{{ fmtCost(overviewRoleCosts.review) }}</b></div><div class="tw-role-bar"><i :style="{ width: `${(overviewRoleCosts.worker + overviewRoleCosts.review) ? overviewRoleCosts.worker / (overviewRoleCosts.worker + overviewRoleCosts.review) * 100 : 0}%` }"></i></div></section>
              </aside>
            </div>
          </template>
          <WorkTree v-else-if="detailTab === 'trace'" :task="detail.id" :heading="t('workTree')" />
          <div v-else class="tw-comments">
            <div v-if="!detailComments.length" class="tw-comments-empty">{{ t('todoCommentsEmpty') }}</div>
            <ul v-else class="tw-comment-list"><li v-for="comment in renderedDetailComments" :key="comment.id" class="tw-comment"><div class="tw-comment-head"><span class="tw-comment-author">{{ commentAuthorLabel(comment.author) }}</span><span class="tw-comment-time">{{ fmtTime(comment.created_at) }}</span></div><p class="tw-comment-body">{{ comment.body }}</p></li></ul>
            <div class="tw-comment-compose"><textarea v-model="newComment" class="tw-input tw-area" :placeholder="t('todoCommentPlaceholder')" rows="2" @keydown.ctrl.enter="addComment" @keydown.meta.enter="addComment"></textarea><button class="tw-btn" :disabled="!newComment.trim()" @click="addComment">{{ t('todoCommentAdd') }}</button></div>
          </div>
        </section>
        <section v-else class="tw-detail-main tw-detail-empty">{{ detailLoading ? t('loading') : t('todoDetailLoadFailed') }}</section>
      </div>
      <ChangeDetail
        v-if="selectedChange && selectedTreeNode"
        :address="`c#${selectedChange.number}`"
        show-heading
        @open="selectChangeTask"
        @trace="selectChangeTaskTrace"
      />
      <div v-if="!detailId && !selectedChange" class="tw-empty">{{ t("tasks") }}</div>
    </div>
    </template>

    <!-- DETAIL VIEW: master-detail editor (left = project siblings, right = fields) -->
    <template v-else-if="taskMode === 'local'">
      <header class="tw-head">
        <button class="tw-back" @click="closeDetail">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg>
          {{ t("todoBack") }}
        </button>
        <div class="tw-title">
          <h1><span v-if="detail?.number" class="tw-detail-num">#{{ detail.number }}</span>{{ detail?.subject || t("todoNew") }}</h1>
          <span v-if="detail && detail.created_by === 'claude'" class="tw-ai" :title="t('todoAiHint')">{{ t("todoAi") }}</span>
        </div>
        <div class="tw-spacer"></div>
        <transition name="tw-fade">
          <span v-if="saved" class="tw-saved">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
            {{ t("todoSaved") }}
          </span>
        </transition>
        <button class="tw-btn" :disabled="detailLoading || !detailRecord || !draft.subject.trim() || draftSubjectOverLimit" @click="saveDetail">{{ t("save") }}</button>
      </header>

      <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

      <TodoDetailPane
        :rows="todos"
        :detail="detail"
        :active-id="detailId"
        :project-label="detail?.project || t('todoNoProject')"
        :more-label="t('todoMore')"
        :ai-label="t('todoAi')"
        :ai-hint="t('todoAiHint')"
        :column-color="columnColor"
        @open="openDetail"
      >
        <section v-if="detail && detailRecord && !detailLoading" class="tw-detail-main">
          <label class="tw-field">
            <span>{{ t("todoSubject") }}</span>
            <input v-model="draft.subject" class="tw-input" maxlength="200" />
            <span
              v-if="draftSubjectRemaining < 30"
              class="tw-subject-counter"
              :class="{ crit: draftSubjectOverLimit }"
            >{{ subjectCounterLabel(draftSubjectRemaining) }}</span>
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
          <!-- The plan (t#253 field roles): HOW only — the STEPS + ORDER part of an
               accepted plan; the vision lives in the description. -->
          <label class="tw-field">
            <span>{{ t("todoPlan") }} <em class="tw-hint">{{ t("todoPlanHint") }}</em></span>
            <textarea v-model="draft.plan" class="tw-input tw-area" rows="5"></textarea>
          </label>

          <!-- Handoff (#141): what this task hands forward to whatever depends on it.
               Written here or by the cc-todos CLI; a session on a dependent task reads it. -->
          <label class="tw-field">
            <span>{{ t("todoHandoff") }} <em class="tw-hint">{{ t("todoHandoffHint") }}</em></span>
            <textarea v-model="draft.handoff" class="tw-input tw-area" rows="4"></textarea>
          </label>

          <!-- Inherited handoff: read-only, what the tasks THIS one depends on left
               off. Mirrors `cc-todos todos handoff <task>`. -->
          <div v-if="inheritedHandoff.length" class="tw-field tw-handoff-in">
            <span class="tw-handoff-in-hd">{{ t("todoHandoffInherited") }}</span>
            <div v-for="p in inheritedHandoff" :key="p.id" class="tw-handoff-item">
              <div class="tw-handoff-item-hd">t#{{ p.number }} · {{ p.subject }}</div>
              <p v-if="p.handoff" class="tw-handoff-item-body">{{ p.handoff }}</p>
              <p v-else class="tw-handoff-item-empty">{{ t("todoHandoffItemEmpty") }}</p>
            </div>
          </div>

          <div class="tw-form-actions">
            <transition name="tw-fade">
              <span v-if="saved" class="tw-saved">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
                {{ t("todoSaved") }}
              </span>
            </transition>
            <button type="button" class="tw-btn ghost" @click="closeDetail">{{ t("todoBack") }}</button>
            <button type="button" class="tw-btn" :disabled="detailLoading || !detailRecord || !draft.subject.trim() || draftSubjectOverLimit" @click="saveDetail">{{ t("save") }}</button>
          </div>

          <!-- Cost by block: the task's spend split by (session x interval) -->
          <div class="tw-blocks">
            <div class="tw-blocks-hd" :title="t('todoBlocksHint')">
              {{ t("todoBlocks") }}
              <span v-if="taskBlocks.length" class="tw-comments-n">{{ taskBlocks.length }}</span>
            </div>
            <div v-if="!taskBlocks.length" class="tw-comments-empty">{{ t("todoBlocksEmpty") }}</div>
            <template v-else>
              <ul class="tw-block-list">
                <li v-for="(b, i) in taskBlocks" :key="b.session + b.from + i" class="tw-block">
                  <span class="tw-block-when">{{ fmtTime(b.from) }}</span>
                  <span class="tw-block-span">{{ blockSpan(b) }}</span>
                  <span class="tw-block-cost">{{ fmtCost(b.cost) }}</span>
                  <span class="tw-block-msgs">{{ b.tool_calls }} {{ t("todoBlocksCalls") }}</span>
                  <span v-if="b.tool_errors" class="tw-block-errs">{{ b.tool_errors }} {{ t("todoBlocksErrors") }}</span>
                  <span
                    class="tw-block-kind"
                    :class="{ auto: !b.explicit }"
                    :title="b.explicit ? b.source : t('todoBlocksAutoHint')"
                  >{{ b.explicit ? t("todoBlocksExplicit") : t("todoBlocksAuto") }}</span>
                </li>
              </ul>
              <div class="tw-blocks-foot">
                <span>{{ t("todoBlocksSum") }}: <b>{{ fmtCost(blocksSum) }}</b></span>
                <span v-if="blocksOutside > 0.005" class="tw-blocks-outside" :title="t('todoBlocksOutsideHint')">
                  {{ t("todoBlocksOutside") }}: <b>{{ fmtCost(blocksOutside) }}</b>
                </span>
              </div>
            </template>
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
                v-for="c in renderedDetailComments"
                :key="c.id"
                class="tw-comment"
                :class="{ ai: c.author !== 'user' }"
              >
                <div class="tw-comment-head">
                  <span class="tw-comment-author" :class="{ ai: c.author !== 'user' }">{{ commentAuthorLabel(c.author) }}</span>
                  <span v-if="fmtTime(c.created_at)" class="tw-comment-time">{{ fmtTime(c.created_at) }}</span>
                  <button class="tw-comment-del" :title="t('todoDelete')" @click="removeComment(c.id)">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </div>
                <p class="tw-comment-body"
                  ><template v-for="(s, i) in c.segments" :key="i"
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
        <section v-else class="tw-detail-main tw-detail-empty">{{ detailLoading ? t("loading") : (detailLoadFailed ? t("todoDetailLoadFailed") : t("todoColEmpty")) }}</section>
      </TodoDetailPane>
    </template>

    <!-- EXTERNAL VIEW: readonly mirror of external tasks, grouped by source (ph6) -->
    <template v-else>
      <!-- LIST sub-view: grouped readonly cards -->
      <template v-if="!externalDetailTask">
      <header class="tw-head">
        <div class="tw-title">
          <h1>{{ t("tasksTitle") }}</h1>
          <div class="tw-modes">
            <button class="tw-mode" @click="switchMode('local')">
              {{ t("todoModeLocal") }}
            </button>
            <button class="tw-mode active" @click="switchMode('external')">
              {{ t("todoModeExternal") }}<span v-if="externalCount" class="tw-mode-count">{{ externalCount }}</span>
            </button>
          </div>
        </div>
        <div class="tw-spacer"></div>
        <span v-if="externalLastPoll" class="tw-ext-poll">
          {{ t("todoExtLastPoll") }} {{ relTime(externalLastPoll) }}
        </span>
        <button class="tw-guide" :disabled="externalRefreshing" @click="refreshExternal">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2.5v3h-3" />
          </svg>
          {{ externalRefreshing ? t("todoExtRefreshing") : t("todoExtRefresh") }}
        </button>
        <button class="tw-guide" :title="t('settings')" @click="openSettings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.18.42.43.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3-1.07-3-3.5s1.07-3.5 3-3.5 3 1.07 3 3.5-1.07 3.5-3 3.5z" />
          </svg>
          {{ t("settings") }}
        </button>
      </header>

      <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

      <!-- Not enrolled: nothing to mirror until a resolver is connected. -->
      <div v-if="!externalBound && !externalCount" class="tw-empty tw-ext-empty">
        <p>{{ t("todoExtNotBound") }}</p>
        <button class="tw-btn" @click="openIntegrations">{{ t("todoExtOpenSettings") }}</button>
      </div>
      <!-- Enrolled but the mirror is still empty. -->
      <div v-else-if="!externalCount" class="tw-empty">{{ t("todoExtEmpty") }}</div>

      <main v-else class="tw-ext-board">
        <section v-for="col in externalColumns" :key="col.id" class="tw-col tw-ext-col">
          <div class="tw-col-head">
            <span class="tw-col-dot" :style="{ background: col.dot }"></span>
            <span class="tw-col-name">{{ col.label }}</span>
            <span class="tw-col-count">{{ col.tasks.length }}</span>
          </div>
          <div class="tw-col-body scroll">
            <article
              v-for="tk in col.tasks"
              :key="tk.source + '::' + tk.task_id"
              class="tw-ext-card"
              :class="{ changed: externalIsChanged(tk) }"
              role="button"
              tabindex="0"
              @click="openExternalDetail(tk)"
              @keyup.enter="openExternalDetail(tk)"
            >
              <div class="tw-ext-row">
                <span class="tw-ext-source-badge">{{ tk.source }}</span>
                <span v-if="externalIsChanged(tk)" class="tw-ext-changed" :title="t('todoExtChanged')">•</span>
                <a class="tw-ext-link" :title="tk.url" @click.stop.prevent="openExternal(tk.url)">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 3H3.5v9.5h9.5V10" />
                    <path d="M9 3h4v4M13 3l-6 6" />
                  </svg>
                </a>
              </div>
              <div class="tw-ext-card-title">{{ tk.title }}</div>
              <div class="tw-ext-card-foot">
                <span class="tw-ext-status" :class="extStatusClass(tk.status)">{{ tk.status }}</span>
                <span v-if="tk.assignee" class="tw-ext-assignee">{{ tk.assignee }}</span>
              </div>
            </article>
            <div v-if="!col.tasks.length" class="tw-col-empty">—</div>
          </div>
        </section>
      </main>
      </template>

      <!-- DETAIL sub-view: readonly metadata + provenance for one external task -->
      <template v-else-if="externalDetailTask">
        <header class="tw-head">
          <button class="tw-back" @click="closeExternalDetail">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg>
            {{ t("todoBack") }}
          </button>
          <div class="tw-title">
            <span class="tw-ext-detail-source">{{ externalDetailTask.source }}</span>
          </div>
        </header>

        <main class="tw-ext-detail">
          <div class="tw-ext-detail-card">
            <div class="tw-ext-detail-top">
              <span class="tw-ext-status" :class="extStatusClass(externalDetailTask.status)">
                {{ externalDetailTask.status }}
              </span>
              <span v-if="externalIsChanged(externalDetailTask)" class="tw-ext-changed">
                • {{ t("todoExtChanged") }}
              </span>
            </div>
            <h1 class="tw-ext-detail-title">{{ externalDetailTask.title }}</h1>

            <dl class="tw-ext-detail-meta">
              <div class="tw-ext-detail-row">
                <dt>{{ t("extfSource") }}</dt>
                <dd>{{ externalDetailTask.source }}</dd>
              </div>
              <div v-if="externalDetailTask.project" class="tw-ext-detail-row">
                <dt>{{ t("extfProject") }}</dt>
                <dd>{{ externalDetailTask.project }}</dd>
              </div>
              <div v-if="externalDetailTask.assignee" class="tw-ext-detail-row">
                <dt>{{ t("extfAssignee") }}</dt>
                <dd>{{ externalDetailTask.assignee }}</dd>
              </div>
              <div v-if="externalDetailTask.priority" class="tw-ext-detail-row">
                <dt>{{ t("extfPriority") }}</dt>
                <dd>{{ priorityLabel(externalDetailTask.priority) }}</dd>
              </div>
              <div class="tw-ext-detail-row">
                <dt>{{ t("extfUpdated") }}</dt>
                <dd>{{ fmtDateTime(externalDetailTask.updated_at) }}</dd>
              </div>
              <div v-if="externalDetailTask.last_event_kind" class="tw-ext-detail-row">
                <dt>{{ t("extfLastEvent") }}</dt>
                <dd>
                  {{ eventKindLabel(externalDetailTask.last_event_kind) }}
                  <span v-if="relTime(externalDetailTask.last_event_ts)" class="tw-ext-detail-dim">
                    · {{ relTime(externalDetailTask.last_event_ts) }}
                  </span>
                </dd>
              </div>
            </dl>

            <!-- Sanitised description, once the source provides it (DTO groundwork). -->
            <div v-if="externalDetailTask.description" class="tw-ext-detail-desc">
              {{ externalDetailTask.description }}
            </div>

            <button class="tw-btn" @click="openExternal(externalDetailTask.url)">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px">
                <path d="M6 3H3.5v9.5h9.5V10" />
                <path d="M9 3h4v4M13 3l-6 6" />
              </svg>
              {{ t("todoExtOpenSource") }}
            </button>

            <p class="tw-ext-detail-note">{{ t("todoExtDescNote") }}</p>
          </div>
        </main>
      </template>
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
        <span
          v-if="fSubjectRemaining < 30"
          class="tw-subject-counter"
          :class="{ crit: fSubjectOverLimit }"
        >{{ subjectCounterLabel(fSubjectRemaining) }}</span>
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
          <button type="submit" class="tw-btn" :disabled="!fSubject.trim() || fSubjectOverLimit">{{ t("save") }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<!-- These rules style the extracted board/card components too. The `tw-` prefix
     is exclusive to this window, so they can safely cross component boundaries. -->
<style>
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
.tw-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tw-filter-date {
  max-width: 126px;
  background: var(--card-bg);
  color: var(--text-2);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
  font-family: var(--segoe);
  color-scheme: dark;
}
.tw-more {
  width: 100%;
  margin-top: 8px;
  padding: 6px;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  color: var(--text-2);
  background: var(--card-bg);
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
/* Segmented Board/Graph view switch (#88). */
.tw-viewtoggle {
  display: inline-flex;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  overflow: hidden;
}
.tw-vt {
  display: flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: var(--card-bg);
  color: var(--text-3);
  padding: 6px 10px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
.tw-vt + .tw-vt {
  border-left: 1px solid var(--stroke-strong);
}
.tw-vt:hover {
  color: var(--text);
}
.tw-vt.active {
  background: var(--accent);
  color: #06283b;
}
.tw-vt svg {
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
.tw-recovery {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #f2b90c;
  background: rgba(242, 185, 12, 0.1);
  border: 1px solid rgba(242, 185, 12, 0.3);
  border-radius: 6px;
  font-size: 12px;
  word-break: break-word;
  margin: 8px 16px 0;
  padding: 8px 10px;
  flex-shrink: 0;
}
.tw-recovery-text {
  flex: 1;
}
.tw-recovery-restore {
  flex-shrink: 0;
  border: 1px solid rgba(242, 185, 12, 0.4);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--segoe);
}
.tw-recovery-restore:disabled {
  opacity: 0.5;
  cursor: default;
}
.tw-recovery-restore:not(:disabled):hover {
  background: rgba(242, 185, 12, 0.15);
}
.tw-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}

/* Mode switcher: owned board vs readonly external mirror (ph6). */
.tw-modes {
  display: inline-flex;
  gap: 2px;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 7px;
  padding: 2px;
}
.tw-mode {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 5px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.tw-mode:hover {
  color: var(--text);
}
.tw-mode:not(.active):hover {
  background: rgba(255, 255, 255, 0.05);
}
/* Theme-proof active state: a translucent accent tint (sits dark over the card) with
   white text — readable under ANY accent (blue/purple/claude/mint), unlike a dark
   on-accent text that only worked for the light-blue default. */
.tw-mode.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--accent-soft);
}
.tw-mode-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.14);
  color: inherit;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* External (readonly mirror) — kanban board */
.tw-ext-poll {
  font-size: 11.5px;
  color: var(--text-4);
  white-space: nowrap;
}
.tw-ext-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 360px;
  margin: 0 auto;
  line-height: 1.5;
}
/* Board layout mirrors the local one (.tw-board), so external tasks read as a
   familiar kanban — but the cards are readonly (no drag: status is owned upstream). */
.tw-ext-board {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
}
.tw-ext-card {
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-left: 3px solid var(--stroke-strong);
  border-radius: 6px;
  padding: 9px 11px;
  cursor: pointer;
  transition: border-color 120ms, background 120ms;
}
.tw-ext-card:hover {
  border-color: var(--accent);
  background: var(--card-bg-hover, rgba(255, 255, 255, 0.03));
}
.tw-ext-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.tw-ext-card.changed {
  border-left-color: var(--accent);
}
.tw-ext-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tw-ext-source-badge {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw-ext-changed {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  color: var(--accent);
}
.tw-ext-link {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--text-4);
  cursor: pointer;
  transition: color 120ms;
}
.tw-ext-link:hover {
  color: var(--accent);
}
.tw-ext-card-title {
  margin: 6px 0 8px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
}
.tw-ext-card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tw-ext-status {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-3);
  white-space: nowrap;
}
.tw-ext-status.s-done {
  background: rgba(108, 203, 95, 0.16);
  color: #6ccb5f;
}
.tw-ext-status.s-active {
  background: rgba(76, 194, 255, 0.16);
  color: #4cc2ff;
}
.tw-ext-status.s-open {
  background: rgba(154, 160, 170, 0.16);
  color: #b6bcc6;
}
.tw-ext-assignee {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* External detail (readonly metadata + provenance) */
.tw-ext-detail-source {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tw-ext-detail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.tw-ext-detail-card {
  max-width: 560px;
  margin: 0 auto;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 8px;
  padding: 18px 20px;
}
.tw-ext-detail-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.tw-ext-detail-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.35;
  margin: 0 0 16px;
}
.tw-ext-detail-meta {
  margin: 0 0 18px;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.tw-ext-detail-row {
  display: flex;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--stroke-weak, rgba(255, 255, 255, 0.05));
  font-size: 13px;
}
.tw-ext-detail-row:last-child {
  border-bottom: none;
}
.tw-ext-detail-row dt {
  flex: 0 0 120px;
  color: var(--text-4);
}
.tw-ext-detail-row dd {
  flex: 1;
  margin: 0;
  color: var(--text-2);
}
.tw-ext-detail-dim {
  color: var(--text-4);
}
.tw-ext-detail-desc {
  margin: 0 0 16px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  white-space: pre-wrap;
}
.tw-ext-detail-note {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-4);
}
.tw-ext-detail-card .tw-btn {
  display: inline-flex;
  align-items: center;
}

/* Board */
.tw-tree-layout {
  display: grid;
  flex: 1;
  grid-template-columns: var(--tree-width, 380px) 6px minmax(0, 1fr);
  min-height: 0;
}
.tw-tree-layout > :first-child { border-right: 1px solid var(--stroke-strong); }
.tw-tree-layout > :last-child { min-height: 0; overflow: auto; padding: 14px 16px; }
.tw-tree-detail { display: flex; flex-direction: column; gap: 10px; }
.tw-tree-detail > .tw-back { align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-detail-crumbs { align-items: center; border-bottom: 1px solid var(--stroke); display: flex; flex: 0 0 30px; gap: 6px; min-width: 0; }
.tw-crumb { background: transparent; border: 0; color: var(--text-3); cursor: pointer; font-family: var(--mono); font-size: 12px; overflow: hidden; padding: 3px 0; text-overflow: ellipsis; white-space: nowrap; }
.tw-crumb:hover:not(:disabled) { background: var(--layer); color: var(--text); }
.tw-crumb:disabled { cursor: default; }
.tw-crumb-change { color: var(--theme); max-width: 45%; }
.tw-crumb-current { color: var(--text); }
.tw-crumb-separator { color: var(--text-4); }
.tw-detail-pager { align-items: center; display: flex; gap: 5px; margin-left: auto; font-family: var(--mono); font-size: 12px; white-space: nowrap; }
.tw-detail-pager button, .tw-detail-menu-button { background: var(--layer); border: 1px solid var(--stroke); border-radius: 4px; color: var(--text-2); cursor: pointer; height: 24px; min-width: 26px; }
.tw-detail-pager button:disabled { color: var(--text-4); cursor: default; }
.tw-detail-pane-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.tw-detail-pane-head h2 { margin: 0; }
.tw-detail-menu-wrap { position: relative; }
.tw-detail-menu { background: var(--layer); border: 1px solid var(--stroke-strong); border-radius: 6px; padding: 4px; position: absolute; right: 0; top: 28px; z-index: 2; }
.tw-detail-menu button { background: transparent; border: 0; color: var(--crit); cursor: pointer; font-family: var(--segoe); padding: 6px 10px; text-align: left; white-space: nowrap; }
.tw-detail-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.tw-status-segments { display: flex; flex-wrap: wrap; }
.tw-status-segment { background: var(--layer); border: 1px solid var(--stroke); color: var(--text-3); cursor: pointer; font-family: var(--segoe); font-size: 11px; padding: 5px 8px; }
.tw-status-segment:first-child { border-radius: 5px 0 0 5px; }
.tw-status-segment:last-child { border-radius: 0 5px 5px 0; }
.tw-status-segment.active { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }
.tw-status-segment.active.done { background: var(--theme-bg-2); border-color: var(--ok); }
.tw-detail-chip { background: var(--layer); border: 1px solid var(--stroke); border-radius: 999px; color: var(--text-2); font-size: 11px; padding: 4px 8px; }
.tw-detail-cost { color: var(--tree-cost); font-family: var(--mono); }
.tw-detail-tabs { border-bottom: 1px solid var(--stroke); display: flex; gap: 16px; }
.tw-detail-tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--text-3); cursor: pointer; font-family: var(--segoe); padding: 8px 1px; }
.tw-detail-tabs button.active { border-bottom-color: var(--accent); color: var(--text); }
.tw-detail-tabs span { color: var(--text-4); font-family: var(--mono); }
.tw-overview { display: grid; gap: 22px; grid-template-columns: minmax(0, 1fr) 300px; padding-top: 8px; }
.tw-overview-main, .tw-overview-side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.tw-overview-section h3, .tw-overview-card h3 { color: var(--text-2); font-size: 13px; margin: 0 0 8px; }
.tw-overview-description { color: var(--text-2); font-size: 13.5px; line-height: 1.62; max-width: 780px; white-space: pre-wrap; }
.tw-handoff-card, .tw-overview-card { background: var(--layer); border: 1px solid var(--stroke); border-radius: var(--r-card); padding: 10px 12px; }
.tw-handoff-row { display: grid; gap: 10px; grid-template-columns: 78px minmax(0, 1fr); padding: 5px 0; }
.tw-handoff-row b { color: var(--text-3); font-size: 12px; }
.tw-handoff-row span { color: var(--text-2); font-size: 13px; white-space: pre-wrap; }
.tw-overview-empty { color: var(--text-4); font-size: 12px; }
.tw-overview-comments { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 0; }
.tw-overview-comments li { border-left: 2px solid var(--stroke-strong); padding: 7px 10px; }
.tw-overview-comments b { color: var(--text-2); font-size: 12px; }
.tw-overview-comments p { color: var(--text-3); font-size: 12px; line-height: 1.45; margin: 5px 0 0; white-space: pre-wrap; }
.tw-severity, .tw-attempt-chip { border-radius: var(--r-pill); display: inline-block; font-family: var(--mono); font-size: 10px; margin-left: 6px; padding: 2px 5px; }
.tw-severity { background: var(--layer-2); color: var(--text-3); }
.tw-severity.critical { color: var(--crit); }.tw-severity.high { color: var(--high); }.tw-severity.medium { color: var(--warn); }.tw-severity.low { color: var(--accent-2); }
.tw-attempt-chip { background: var(--accent-soft); color: var(--text-3); }
.tw-overview-stat, .tw-role-cost { color: var(--text-3); display: flex; font-family: var(--mono); font-size: 11px; justify-content: space-between; }
.tw-overview-stat { margin-bottom: 8px; }.tw-role-cost + .tw-role-cost { margin-top: 6px; }.tw-role-cost b { color: var(--tree-cost); font-weight: 400; }
.tw-overview-bar, .tw-role-bar { background: var(--track); border-radius: var(--r-pill); height: 5px; overflow: hidden; }
.tw-overview-bar i, .tw-role-bar i { background: var(--ok); display: block; height: 100%; }.tw-role-bar i { background: var(--accent-2); }
.tw-relation { align-items: center; background: transparent; border: 0; color: var(--text-3); cursor: pointer; display: flex; font-family: var(--segoe); font-size: 12px; gap: 7px; padding: 4px 0; text-align: left; width: 100%; }.tw-relation:hover { color: var(--text); }
.tw-relation i { background: var(--text-4); border-radius: 50%; height: 6px; width: 6px; }.tw-relation i.done { background: var(--ok); }.tw-relation i.in_progress { background: var(--accent-2); }.tw-relation i.review { background: var(--tree-review); }
.tw-tree-resize { cursor: col-resize; margin-left: -3px; position: relative; width: 6px; z-index: 1; }
.tw-tree-resize::after { background: var(--stroke-strong); content: ""; inset: 0 2px; position: absolute; }
@media (max-width: 720px) {
  .tw-tree-layout { grid-template-columns: 1fr; grid-template-rows: minmax(180px, 40%) minmax(0, 1fr); }
  .tw-tree-layout > :first-child { border-bottom: 1px solid var(--stroke-strong); border-right: 0; }
  .tw-tree-resize { display: none; }
  .tw-overview { grid-template-columns: 1fr; }
}
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

/* Inherited handoff (#141): read-only summary of what upstream deps left off. */
.tw-handoff-in {
  gap: 6px;
}
.tw-handoff-in-hd {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3, #7a808a);
}
.tw-handoff-item {
  border-left: 2px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  background: var(--card-bg);
  border-radius: 4px;
  padding: 6px 9px;
}
.tw-handoff-item + .tw-handoff-item {
  margin-top: 4px;
}
.tw-handoff-item-hd {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-handoff-item-body {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-2);
  white-space: pre-wrap;
}
.tw-handoff-item-empty {
  margin: 3px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--text-3, #7a808a);
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
.tw-tag .pl {
  max-width: 100%;
}
.tw-tag .pl-name {
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
/* Task that arrived via a board import (#181) — in particular a fork, whose local
   twin is still on the board, so the two need to be told apart at a glance. */
.tw-imported {
  color: #d29922;
  background: rgba(210, 153, 34, 0.14);
  padding: 1px 7px;
  border-radius: 8px;
}
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
.tw-subject-counter {
  align-self: flex-end;
  font-size: 11px;
  color: var(--text-4);
}
.tw-subject-counter.crit {
  color: var(--crit);
  font-weight: 600;
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
.tw-blocks {
  border-top: 1px solid var(--stroke-strong);
  padding-top: 14px;
  margin-top: 2px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tw-blocks-hd {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: help;
}
.tw-block-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tw-block {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 4px 8px;
  border-radius: 7px;
  background: var(--track);
}
.tw-block-when {
  min-width: 108px;
  color: var(--text-2);
}
.tw-block-span {
  min-width: 46px;
  font-variant-numeric: tabular-nums;
}
.tw-block-cost {
  min-width: 56px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-weight: 600;
}
.tw-block-msgs {
  min-width: 76px;
  font-variant-numeric: tabular-nums;
}
.tw-block-errs {
  color: var(--danger, #d9534f);
}
.tw-block-kind {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  color: var(--text-3);
}
.tw-block-kind.auto {
  border-style: dashed;
  cursor: help;
}
.tw-blocks-foot {
  display: flex;
  gap: 16px;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 0 8px;
}
.tw-blocks-outside {
  cursor: help;
}
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

/* Inline references (t#N task, @name project) */
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
