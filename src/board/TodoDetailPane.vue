<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Todo } from "../contracts/board";
import { createDetailSiblingPager, DETAIL_SIBLING_PAGE_SIZE } from "./detailSiblings";

const props = defineProps<{
  rows: readonly Todo[];
  detail: Todo | null;
  activeId: string | null;
  projectLabel: string;
  moreLabel: string;
  aiLabel: string;
  aiHint: string;
  columnColor: (status: string) => string;
}>();
const emit = defineEmits<{ open: [Todo] }>();
const doneLimit = ref(DETAIL_SIBLING_PAGE_SIZE);
const rail = ref<HTMLElement | null>(null);
const pager = createDetailSiblingPager<Todo>();
const pages = computed(() => pager.pages(props.rows, props.detail?.project, props.activeId, doneLimit.value));

watch(() => props.activeId, async () => {
  doneLimit.value = DETAIL_SIBLING_PAGE_SIZE;
  await nextTick();
  rail.value?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest" });
}, { flush: "post", immediate: true });
</script>
<template>
  <div class="tw-detail">
    <aside ref="rail" class="tw-detail-list">
      <div class="tw-detail-list-hd">{{ projectLabel }}</div>
      <button
        v-for="todo in pages.visible"
        :key="todo.id"
        class="tw-detail-item"
        :class="{ active: todo.id === activeId }"
        @click="emit('open', todo)"
      >
        <span class="tw-detail-item-dot" :style="{ background: columnColor(todo.status) }"></span>
        <span class="tw-detail-item-subj" :class="{ done: todo.status === 'done' }"><span v-if="todo.number" class="tw-detail-item-num">#{{ todo.number }}</span>{{ todo.subject }}</span>
        <span v-if="todo.created_by === 'claude'" class="tw-ai sm" :title="aiHint">{{ aiLabel }}</span>
      </button>
      <button v-if="pages.hasMoreDone" class="tw-more" @click="doneLimit += DETAIL_SIBLING_PAGE_SIZE">{{ moreLabel }}</button>
    </aside>
    <slot />
  </div>
</template>
