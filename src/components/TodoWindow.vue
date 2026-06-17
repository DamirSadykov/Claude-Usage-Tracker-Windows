<script setup lang="ts">
// Standalone task manager, rendered when index.html is loaded with the `#todos`
// hash (see tauri.conf.json `todos` window). The tracker OWNS the todo list: the
// user creates/edits tasks here, they're persisted to `todos.json` in the app
// data dir, and a Claude Code SessionStart hook reads that file to surface the
// active ones for the current project. Claude only flips `status` (and edits
// details on request) by rewriting the same file.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n, type Composer } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
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

export interface Todo {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  estimate_minutes?: number | null;
  scheduled_for?: string | null;
  plan: string;
  project?: string | null;
  created_at: string;
  updated_at: string;
}

const todos = ref<Todo[]>([]);
const loading = ref(true);
const errorMsg = ref("");

// Filters
const projectFilter = ref<string>(""); // "" = all
const showDone = ref(true);

// Form state (doubles as create + edit). editingId === null → creating.
const editingId = ref<string | null>(null);
const fSubject = ref("");
const fDescription = ref("");
const fEstimate = ref<number | null>(null);
const fScheduled = ref("");
const fPlan = ref("");
const fProject = ref("");
const formOpen = ref(false);

const STATUSES = ["pending", "in_progress", "done"] as const;

// Projects the tracker has seen (from cc_usage), so the picker offers real
// projects even before any todo uses them.
const knownProjects = ref<string[]>([]);
const projects = computed(() => {
  const set = new Set<string>();
  for (const t of todos.value) if (t.project) set.add(t.project);
  for (const p of knownProjects.value) set.add(p);
  return [...set].sort();
});

// Project-field autocomplete: filtered dropdown of known projects as you type.
const projectFocus = ref(false);
const projectSel = ref(-1);
const projectSuggestions = computed(() => {
  const q = fProject.value.trim().toLowerCase();
  const list = q
    ? projects.value.filter(
        (p) => p.toLowerCase().includes(q) && p.toLowerCase() !== q,
      )
    : projects.value;
  return list.slice(0, 8);
});
function selectProject(p: string) {
  fProject.value = p;
  projectFocus.value = false;
  projectSel.value = -1;
}
function onProjectBlur() {
  // Delay so a mousedown on a suggestion registers before the list closes.
  setTimeout(() => {
    projectFocus.value = false;
    projectSel.value = -1;
  }, 120);
}
function moveProjectSel(step: number) {
  const n = projectSuggestions.value.length;
  if (!n) return;
  projectFocus.value = true;
  projectSel.value = (projectSel.value + step + n) % n;
}
function pickProjectSel() {
  const s = projectSuggestions.value;
  if (projectSel.value >= 0 && projectSel.value < s.length)
    selectProject(s[projectSel.value]);
}

const visible = computed(() => {
  let list = todos.value.slice();
  if (projectFilter.value) {
    list = list.filter((t) => (t.project ?? "") === projectFilter.value);
  }
  if (!showDone.value) list = list.filter((t) => t.status !== "done");
  // Sort: in_progress first, then pending, then done; within a group by
  // scheduled date (unscheduled last), then most recently updated.
  const rank = (s: string) =>
    s === "in_progress" ? 0 : s === "pending" ? 1 : 2;
  return list.sort((a, b) => {
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    const da = a.scheduled_for || "9999-99-99";
    const db = b.scheduled_for || "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
});

const counts = computed(() => ({
  pending: todos.value.filter((t) => t.status === "pending").length,
  in_progress: todos.value.filter((t) => t.status === "in_progress").length,
  done: todos.value.filter((t) => t.status === "done").length,
}));

async function loadTodos() {
  loading.value = true;
  try {
    todos.value = await invoke<Todo[]>("get_todos");
    errorMsg.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
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
  formOpen.value = false;
}

function startNew() {
  resetForm();
  if (projectFilter.value) fProject.value = projectFilter.value;
  formOpen.value = true;
}

function startEdit(todo: Todo) {
  editingId.value = todo.id;
  fSubject.value = todo.subject;
  fDescription.value = todo.description;
  fEstimate.value = todo.estimate_minutes ?? null;
  fScheduled.value = todo.scheduled_for ?? "";
  fPlan.value = todo.plan;
  fProject.value = todo.project ?? "";
  formOpen.value = true;
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
    status: existing?.status ?? "pending",
    estimate_minutes:
      fEstimate.value === null || Number.isNaN(fEstimate.value)
        ? null
        : Math.max(0, Math.round(fEstimate.value)),
    scheduled_for: fScheduled.value || null,
    plan: fPlan.value.trim(),
    project: fProject.value.trim() || null,
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

async function setStatus(todo: Todo, status: string) {
  try {
    todos.value = await invoke<Todo[]>("set_todo_status", {
      id: todo.id,
      status,
    });
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function removeTodo(todo: Todo) {
  try {
    todos.value = await invoke<Todo[]>("delete_todo", { id: todo.id });
    if (editingId.value === todo.id) resetForm();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

function statusLabel(s: string) {
  return s === "in_progress"
    ? t("statusInProgress")
    : s === "done"
      ? t("statusDone")
      : t("statusPending");
}

function fmtEstimate(min: number | null | undefined) {
  if (min === null || min === undefined) return "";
  if (min < 60) return `${min} ${t("minShort")}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}${t("hourShort")} ${m}${t("minShort")}` : `${h}${t("hourShort")}`;
}

let unlistenLocale: (() => void) | null = null;

onMounted(async () => {
  await loadLocaleFromStore();
  // The main window pushes its current locale here whenever it opens this
  // window — this is a separate WebView that may detect a different navigator
  // language and have no saved locale to read from the store.
  const { listen } = await import("@tauri-apps/api/event");
  unlistenLocale = await listen<string>("todos-locale", (e) => {
    applyLocale(e.payload);
  });
  await loadTodos();
  try {
    knownProjects.value = await invoke<string[]>("get_cc_projects");
  } catch {
    // analytics never ingested → fall back to projects already used in todos
  }
});

onUnmounted(() => {
  if (unlistenLocale) unlistenLocale();
});
</script>

<template>
  <div class="tw-root">
    <header class="tw-head">
      <h1>{{ t("tasksTitle") }}</h1>
      <div class="tw-counts">
        <span class="tw-chip ip">{{ counts.in_progress }} {{ t("statusInProgress") }}</span>
        <span class="tw-chip pd">{{ counts.pending }} {{ t("statusPending") }}</span>
        <span class="tw-chip dn">{{ counts.done }} {{ t("statusDone") }}</span>
      </div>
      <div class="tw-spacer"></div>
      <select v-model="projectFilter" class="tw-select" :title="t('todoProject')">
        <option value="">{{ t("todoFilterAll") }}</option>
        <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
      </select>
      <label class="tw-toggle">
        <input type="checkbox" v-model="showDone" />
        {{ t("todoShowDone") }}
      </label>
      <button class="tw-add" @click="startNew">+ {{ t("todoAdd") }}</button>
    </header>

    <main class="tw-main">
      <div v-if="errorMsg" class="tw-error">{{ errorMsg }}</div>

      <!-- Create / edit form -->
      <form v-if="formOpen" class="tw-form" @submit.prevent="submitForm">
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
        <div class="tw-row">
          <label class="tw-field">
            <span>{{ t("todoEstimate") }}</span>
            <input v-model.number="fEstimate" class="tw-input" type="number" min="0" step="5" />
          </label>
          <label class="tw-field">
            <span>{{ t("todoScheduledFor") }}</span>
            <input v-model="fScheduled" class="tw-input" type="date" />
          </label>
          <label class="tw-field tw-ac">
            <span>{{ t("todoProject") }}</span>
            <input
              v-model="fProject"
              class="tw-input"
              :placeholder="t('todoProjectPlaceholder')"
              autocomplete="off"
              @focus="projectFocus = true"
              @input="projectFocus = true; projectSel = -1"
              @blur="onProjectBlur"
              @keydown.down.prevent="moveProjectSel(1)"
              @keydown.up.prevent="moveProjectSel(-1)"
              @keydown.enter.prevent="pickProjectSel"
              @keydown.escape="projectFocus = false"
            />
            <ul
              v-if="projectFocus && projectSuggestions.length"
              class="tw-ac-list"
            >
              <li
                v-for="(p, i) in projectSuggestions"
                :key="p"
                class="tw-ac-item"
                :class="{ sel: i === projectSel }"
                @mousedown.prevent="selectProject(p)"
              >
                {{ p }}
              </li>
            </ul>
          </label>
        </div>
        <label class="tw-field">
          <span>{{ t("todoPlan") }} <em class="tw-hint">{{ t("todoPlanHint") }}</em></span>
          <textarea v-model="fPlan" class="tw-input tw-area" rows="3"></textarea>
        </label>
        <div class="tw-form-actions">
          <button type="button" class="tw-btn ghost" @click="resetForm">{{ t("todoCancel") }}</button>
          <button type="submit" class="tw-btn" :disabled="!fSubject.trim()">{{ t("save") }}</button>
        </div>
      </form>

      <div v-if="loading" class="tw-empty">{{ t("loading") }}</div>
      <div v-else-if="!visible.length" class="tw-empty">{{ t("todoEmpty") }}</div>

      <ul v-else class="tw-list">
        <li
          v-for="todo in visible"
          :key="todo.id"
          class="tw-item"
          :class="todo.status"
        >
          <div class="tw-item-main">
            <div class="tw-item-top">
              <span class="tw-subject">{{ todo.subject }}</span>
              <span v-if="todo.project" class="tw-tag">{{ todo.project }}</span>
              <span v-if="todo.scheduled_for" class="tw-meta">📅 {{ todo.scheduled_for }}</span>
              <span v-if="todo.estimate_minutes != null" class="tw-meta">⏱ {{ fmtEstimate(todo.estimate_minutes) }}</span>
            </div>
            <p v-if="todo.description" class="tw-desc">{{ todo.description }}</p>
            <pre v-if="todo.plan" class="tw-plan">{{ todo.plan }}</pre>
          </div>
          <div class="tw-item-actions">
            <select
              :value="todo.status"
              class="tw-select sm"
              :class="todo.status"
              @change="setStatus(todo, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
            <button class="tw-icon" :title="t('todoEdit')" @click="startEdit(todo)">✎</button>
            <button class="tw-icon danger" :title="t('todoDelete')" @click="removeTodo(todo)">🗑</button>
          </div>
        </li>
      </ul>
    </main>
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
}
.tw-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--stroke-strong);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.tw-head h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.tw-spacer {
  flex: 1;
}
.tw-counts {
  display: flex;
  gap: 6px;
}
.tw-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--text-2);
  background: var(--track);
}
.tw-chip.ip {
  color: var(--accent);
  background: var(--accent-soft);
}
.tw-chip.dn {
  color: var(--text-4);
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
}
.tw-select.in_progress {
  color: var(--accent);
  border-color: var(--accent);
}
.tw-select.done {
  color: var(--text-4);
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
.tw-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tw-error {
  color: #f87171;
  font-size: 12px;
  word-break: break-word;
}
.tw-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}

/* Form */
.tw-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--card-radius);
  background: var(--card-bg);
}
.tw-form-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tw-input {
  background: var(--flyout-bg);
  color: var(--text);
  border: 1px solid var(--stroke-strong);
  border-radius: 5px;
  padding: 7px 9px;
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
.tw-ac {
  position: relative;
}
.tw-ac-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin: 2px 0 0;
  padding: 4px;
  list-style: none;
  background: var(--card-bg);
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  max-height: 184px;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.tw-ac-item {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-2);
  border-radius: 4px;
  cursor: pointer;
}
.tw-ac-item:hover,
.tw-ac-item.sel {
  background: var(--accent-soft);
  color: var(--text);
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

/* List */
.tw-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tw-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--stroke-strong);
  border-left: 3px solid var(--text-4);
  border-radius: var(--card-radius);
  background: var(--card-bg);
}
.tw-item.in_progress {
  border-left-color: var(--accent);
}
.tw-item.done {
  opacity: 0.6;
}
.tw-item.done .tw-subject {
  text-decoration: line-through;
}
.tw-item-main {
  flex: 1;
  min-width: 0;
}
.tw-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tw-subject {
  font-size: 14px;
  font-weight: 500;
}
.tw-tag {
  font-size: 11px;
  color: var(--text-3);
  background: var(--track);
  padding: 1px 7px;
  border-radius: 8px;
}
.tw-meta {
  font-size: 11px;
  color: var(--text-3);
}
.tw-desc {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.tw-plan {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
  background: var(--flyout-bg);
  border: 1px solid var(--stroke);
  border-radius: 4px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--segoe);
}
.tw-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.tw-icon {
  background: transparent;
  border: 1px solid var(--stroke-strong);
  color: var(--text-3);
  border-radius: 5px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  font-size: 13px;
}
.tw-icon:hover {
  background: var(--card-bg-hover);
  color: var(--text);
}
.tw-icon.danger:hover {
  border-color: #f87171;
  color: #f87171;
}
</style>
