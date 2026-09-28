<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TodoFilters } from "./todoFilter";

const props = defineProps<{ modelValue: TodoFilters; projects: string[] }>();
const emit = defineEmits<{ "update:modelValue": [TodoFilters] }>();
const { t } = useI18n();
const queryInput = ref(props.modelValue.query);
let timer: ReturnType<typeof setTimeout> | undefined;
const value = computed({ get: () => props.modelValue, set: (next) => emit("update:modelValue", next) });
function set(key: keyof TodoFilters, next: string | boolean) { value.value = { ...value.value, [key]: next }; }
watch(() => props.modelValue.query, q => { if (q !== queryInput.value) queryInput.value = q; });
watch(queryInput, q => { clearTimeout(timer); timer = setTimeout(() => set("query", q), 200); });
const searchEl = ref<HTMLInputElement | null>(null);
const projectEl = ref<HTMLSelectElement | null>(null);
defineExpose({ focusSearch: () => searchEl.value?.focus(), focusProject: () => projectEl.value?.focus() });
</script>

<template>
  <div class="tw-filters">
    <div class="tw-search"><input ref="searchEl" v-model="queryInput" class="tw-search-input" :placeholder="t('todoSearch')" /></div>
    <select :value="value.status" class="tw-select sm" @change="set('status', ($event.target as HTMLSelectElement).value)"><option value="">{{ t('todoFilterStatus') }}</option><option value="backlog">{{ t('colBacklog') }}</option><option value="queue">{{ t('colQueue') }}</option><option value="in_progress">{{ t('statusInProgress') }}</option><option value="review">{{ t('colReview') }}</option><option value="done">{{ t('statusDone') }}</option></select>
    <select ref="projectEl" :value="value.project" class="tw-select sm" @change="set('project', ($event.target as HTMLSelectElement).value)"><option value="">{{ t('todoFilterAll') }}</option><option v-for="project in projects" :key="project" :value="project">{{ project }}</option></select>
    <select :value="value.priority" class="tw-select sm" @change="set('priority', ($event.target as HTMLSelectElement).value)"><option value="">{{ t('todoPriority') }}</option><option value="high">{{ t('todoPriorityHigh') }}</option><option value="medium">{{ t('todoPriorityMedium') }}</option><option value="low">{{ t('todoPriorityLow') }}</option></select>
    <select :value="value.createdBy" class="tw-select sm" @change="set('createdBy', ($event.target as HTMLSelectElement).value)"><option value="">{{ t('todoFilterAuthor') }}</option><option value="user">{{ t('todoAuthorYou') }}</option><option value="claude">{{ t('todoAuthorClaude') }}</option></select>
    <select :value="value.change" class="tw-select sm" @change="set('change', ($event.target as HTMLSelectElement).value)"><option value="">{{ t('todoFilterChange') }}</option><option value="change">{{ t('todoFilterChanges') }}</option><option value="task">{{ t('todoFilterTasks') }}</option></select>
    <input :value="value.createdFrom" class="tw-filter-date" type="date" :title="t('todoFilterCreatedFrom')" @change="set('createdFrom', ($event.target as HTMLInputElement).value)" />
    <input :value="value.createdTo" class="tw-filter-date" type="date" :title="t('todoFilterCreatedTo')" @change="set('createdTo', ($event.target as HTMLInputElement).value)" />
    <label class="tw-toggle"><input :checked="value.showDone" type="checkbox" @change="set('showDone', ($event.target as HTMLInputElement).checked)" />{{ t('todoShowDone') }}</label>
  </div>
</template>
