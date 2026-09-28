<script setup lang="ts">
import { ref } from "vue"; import TodoColumn from "./TodoColumn.vue"; import type { TodoProjection, TodoCardRow, TodoStatus } from "./todoFilter";
const props = defineProps<{ projection: TodoProjection<TodoCardRow>; showDone: boolean; doneLimit: number }>();
const emit = defineEmits<{ add: [string]; move: [TodoCardRow, string]; open: [TodoCardRow]; remove: [TodoCardRow]; openSpec: [string]; moreDone: [] }>();
const columns: { id: TodoStatus; labelKey: string; dot: string }[] = [{id:"backlog",labelKey:"colBacklog",dot:"#9aa0aa"},{id:"queue",labelKey:"colQueue",dot:"#ffc107"},{id:"in_progress",labelKey:"statusInProgress",dot:"#4cc2ff"},{id:"review",labelKey:"colReview",dot:"#b388ff"},{id:"done",labelKey:"statusDone",dot:"#6ccb5f"}];
const draggingId = ref<string | null>(null), overColumn = ref<string | null>(null);
function dragStart(todo: TodoCardRow, event: DragEvent) { draggingId.value = todo.id; event.dataTransfer?.setData("text/plain", todo.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }
function dragEnd() { draggingId.value = null; overColumn.value = null; }
function dragOver(id: string, event: DragEvent) { if (!draggingId.value) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; overColumn.value = id; }
function dragLeave(id: string, event: DragEvent) { const related = event.relatedTarget as Node | null; if (!related || !(event.currentTarget as HTMLElement).contains(related)) if (overColumn.value === id) overColumn.value = null; }
function drop(status: string) { const todo = props.projection.visible.find(row => row.id === draggingId.value); dragEnd(); if (todo) emit("move", todo, status); }
function todosFor(status: TodoStatus) { return props.projection.columns[status]; }
</script>
<template><main class="tw-board"><TodoColumn v-for="column in columns.filter(c => showDone || c.id !== 'done')" :key="column.id" v-bind="column" :todos="todosFor(column.id)" :dragging-id="draggingId" :over="overColumn === column.id" :done-limit="doneLimit" @add="emit('add', column.id)" @dragstart="dragStart" @dragend="dragEnd" @dragover="dragOver(column.id, $event)" @dragleave="dragLeave(column.id, $event)" @drop="drop(column.id)" @move="(todo, status) => emit('move', todo, status)" @open="emit('open', $event)" @remove="emit('remove', $event)" @open-spec="emit('openSpec', $event)" @more="emit('moreDone')" /></main></template>
