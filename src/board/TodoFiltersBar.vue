<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ProjectAutocomplete from "../kernel/ProjectAutocomplete.vue";
import { isNotDoneFilter, type AttentionCounts, type TodoFilterField, type TodoFilters } from "./todoFilter";

type FilterKey = TodoFilterField | "date";
const props = defineProps<{ modelValue: TodoFilters; projects: string[]; attentionCounts: AttentionCounts }>();
const emit = defineEmits<{ "update:modelValue": [TodoFilters] }>();
const { t } = useI18n();
const queryInput = ref(props.modelValue.query);
const open = ref<FilterKey | "">("");
let timer: ReturnType<typeof setTimeout> | undefined;
const value = computed({ get: () => props.modelValue, set: (next) => emit("update:modelValue", next) });
const searchEl = ref<HTMLInputElement | null>(null);
const projectEl = ref<InstanceType<typeof ProjectAutocomplete> | null>(null);
const toggle = (key: FilterKey) => { open.value = open.value === key ? "" : key; };
const set = (key: keyof TodoFilters, next: string | boolean) => { value.value = { ...value.value, [key]: next }; };
const clear = (key: keyof TodoFilters) => set(key, typeof value.value[key] === "boolean" ? false : "");
const select = (key: keyof TodoFilters, next: string) => { set(key, next); open.value = ""; };
const clearStatus = () => {
  if (value.value.status) clear("status");
  else set("showDone", true);
};
const showAllStatuses = () => { value.value = { ...value.value, status: "", showDone: true }; open.value = ""; };
const statusLabel = computed(() => ({ backlog: t("colBacklog"), queue: t("colQueue"), in_progress: t("statusInProgress"), review: t("colReview"), done: t("statusDone") }[value.value.status] ?? ""));
const hasStatusFilter = computed(() => !!value.value.status || isNotDoneFilter(value.value));
const displayedStatusLabel = computed(() => statusLabel.value || t("todoFilterNotDone"));
const priorityLabel = computed(() => ({ high: t("todoPriorityHigh"), medium: t("todoPriorityMedium"), low: t("todoPriorityLow") }[value.value.priority] ?? ""));
const authorLabel = computed(() => ({ user: t("todoAuthorYou"), claude: t("todoAuthorClaude") }[value.value.createdBy] ?? ""));
const changeLabel = computed(() => value.value.change === "change" ? t("todoFilterChanges") : value.value.change === "task" ? t("todoFilterTasks") : "");
const attentionLabel = computed(() => {
  switch (value.value.attention) {
    case "overdue": return t("todoAttentionOverdue");
    case "stale": return t("todoAttentionStale");
    case "no_priority": return t("todoAttentionNoPriority");
    default: return "";
  }
});
const dateLabel = computed(() => value.value.createdFrom || value.value.createdTo ? `${value.value.createdFrom || "…"} — ${value.value.createdTo || "…"}` : "");
const statusOptions = computed(() => [
  ["backlog", t("colBacklog")], ["queue", t("colQueue")], ["in_progress", t("statusInProgress")], ["review", t("colReview")], ["done", t("statusDone")],
] as const);
const priorityOptions = computed(() => [["high", t("todoPriorityHigh")], ["medium", t("todoPriorityMedium")], ["low", t("todoPriorityLow")]] as const);
const attentionOptions = computed(() => [["overdue", t("todoAttentionOverdue")], ["stale", t("todoAttentionStale")], ["no_priority", t("todoAttentionNoPriority")]] as const);
watch(() => props.modelValue.query, q => { if (q !== queryInput.value) queryInput.value = q; });
watch(queryInput, q => { clearTimeout(timer); timer = setTimeout(() => set("query", q), 200); });
function clearQuery() { queryInput.value = ""; clearTimeout(timer); set("query", ""); searchEl.value?.focus(); }
defineExpose({ focusSearch: () => searchEl.value?.focus(), focusProject: () => projectEl.value?.focus() });
</script>

<template>
  <div class="tw-filters">
    <div class="tw-search"><input ref="searchEl" v-model="queryInput" class="tw-search-input" :placeholder="t('todoSearch')" @keydown.esc="clearQuery" /><button v-if="queryInput" class="tw-search-clear" type="button" :title="t('todoSearchClear')" @click="clearQuery">×</button></div>
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: hasStatusFilter }" type="button" @click="toggle('status')">{{ hasStatusFilter ? `${t('todoStatus')}: ${displayedStatusLabel}` : `+ ${t('todoFilterStatus')}` }}<span v-if="hasStatusFilter" class="tw-filter-clear" @click.stop="clearStatus">×</span></button><div v-if="open === 'status'" class="tw-filter-options"><button type="button" @click="showAllStatuses">{{ t('todoFilterStatus') }}</button><button v-for="[status, label] in statusOptions" :key="status" type="button" @click="select('status', status)">{{ label }}</button></div></div>
    <ProjectAutocomplete ref="projectEl" class="tw-project-filter" :model-value="value.project" :options="projects" :placeholder="t('allProjects')" :max-suggestions="projects.length" clearable commit-on="select" width="150px" @update:model-value="set('project', $event)" />
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: !!value.priority }" type="button" @click="toggle('priority')">{{ priorityLabel ? `${t('todoPriority')}: ${priorityLabel}` : `+ ${t('todoPriority')}` }}<span v-if="priorityLabel" class="tw-filter-clear" @click.stop="clear('priority')">×</span></button><div v-if="open === 'priority'" class="tw-filter-options"><button v-for="[priority, label] in priorityOptions" :key="priority" type="button" @click="select('priority', priority)">{{ label }}</button></div></div>
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: !!value.attention }" type="button" @click="toggle('attention')">{{ attentionLabel ? `${t('todoAttention')}: ${attentionLabel}` : `+ ${t('todoAttention')}` }}<span v-if="attentionLabel" class="tw-filter-clear" @click.stop="clear('attention')">×</span></button><div v-if="open === 'attention'" class="tw-filter-options"><button v-for="[attention, label] in attentionOptions" :key="attention" type="button" @click="select('attention', attention)"><span>{{ label }}</span><span class="tw-filter-count">{{ props.attentionCounts[attention] }}</span></button></div></div>
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: !!value.createdBy }" type="button" @click="toggle('createdBy')">{{ authorLabel ? `${t('todoFilterAuthor')}: ${authorLabel}` : `+ ${t('todoFilterAuthor')}` }}<span v-if="authorLabel" class="tw-filter-clear" @click.stop="clear('createdBy')">×</span></button><div v-if="open === 'createdBy'" class="tw-filter-options"><button type="button" @click="select('createdBy', 'user')">{{ t('todoAuthorYou') }}</button><button type="button" @click="select('createdBy', 'claude')">{{ t('todoAuthorClaude') }}</button></div></div>
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: !!value.change }" type="button" @click="toggle('change')">{{ changeLabel ? `${t('todoFilterChange')}: ${changeLabel}` : `+ ${t('todoFilterChange')}` }}<span v-if="changeLabel" class="tw-filter-clear" @click.stop="clear('change')">×</span></button><div v-if="open === 'change'" class="tw-filter-options"><button type="button" @click="select('change', 'change')">{{ t('todoFilterChanges') }}</button><button type="button" @click="select('change', 'task')">{{ t('todoFilterTasks') }}</button></div></div>
    <div class="tw-filter-menu"><button class="tw-filter-chip" :class="{ active: !!dateLabel }" type="button" @click="toggle('date')">{{ dateLabel || `+ ${t('todoFilterCreatedFrom')}` }}<span v-if="dateLabel" class="tw-filter-clear" @click.stop="clear('createdFrom'); clear('createdTo')">×</span></button><div v-if="open === 'date'" class="tw-filter-options tw-filter-dates"><label>{{ t('todoFilterCreatedFrom') }}<input :value="value.createdFrom" type="date" @change="set('createdFrom', ($event.target as HTMLInputElement).value)" /></label><label>{{ t('todoFilterCreatedTo') }}<input :value="value.createdTo" type="date" @change="set('createdTo', ($event.target as HTMLInputElement).value)" /></label></div></div>
  </div>
</template>

<style scoped>
.tw-filters { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tw-filter-menu { position: relative; }
.tw-filter-chip { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; padding: 4px 8px; border: 1px dashed var(--stroke-strong); border-radius: var(--r-ctl); background: transparent; color: var(--text-3); font: 11px/1 var(--segoe); cursor: pointer; }
.tw-filter-chip.active { border-style: solid; border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.tw-project-filter :deep(.pa-input) { padding: 4px 8px; border-radius: var(--r-ctl); font: 11px/1 var(--segoe); }
.tw-project-filter :deep(.pa-input.clearable) { padding-right: 22px; }
.tw-filter-clear { font-size: 15px; line-height: 10px; }
.tw-search-clear { padding: 0 2px; border: 0; background: transparent; color: var(--text-3); font-size: 15px; line-height: 1; cursor: pointer; }
.tw-search-clear:hover { color: var(--text); }
.tw-filter-options { position: absolute; z-index: 10; top: calc(100% + 5px); left: 0; display: grid; min-width: max-content; padding: 4px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: var(--layer); box-shadow: 0 6px 16px var(--canvas-bg); }
.tw-filter-options button { padding: 5px 7px; border: 0; border-radius: 3px; background: transparent; color: var(--text-2); font: 11px/1.2 var(--segoe); text-align: left; cursor: pointer; }
.tw-filter-options button:hover { background: var(--layer-hover); color: var(--text); }
.tw-filter-options button { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.tw-filter-count { color: var(--text-4); font-variant-numeric: tabular-nums; }
.tw-filter-dates { gap: 6px; padding: 7px; }
.tw-filter-dates label { display: grid; gap: 3px; color: var(--text-3); font: 10px/1 var(--segoe); }
.tw-filter-dates input { border: 1px solid var(--stroke-strong); border-radius: 3px; background: var(--input-bg); color: var(--text-2); color-scheme: dark; font: 11px/1 var(--segoe); padding: 3px 5px; }
</style>
