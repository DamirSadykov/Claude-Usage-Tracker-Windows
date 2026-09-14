<script setup lang="ts">
// Reusable project picker: a free-text combobox with a filtered suggestion
// dropdown. Used everywhere a project is chosen (analytics filter, project-merge
// form, task filter / task project field).
//
// v-model holds the committed string (empty = none / all, by the caller's
// convention). `clearable` adds a × to reset to "" — used by the filters where
// empty means "all projects".
//
// `commitOn` controls WHEN typing is published upward:
//   • "input"  (default) — emit on every keystroke. For free-text fields where a
//     brand-new name is valid (merge target, a task's project).
//   • "select" — emit only when an option is picked, cleared, or the typed text
//     exactly matches a known option. The input keeps a local buffer while typing
//     so a partial query doesn't drive an expensive reload / empty a filtered
//     view; an unmatched buffer reverts on blur.
import { ref, computed, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    placeholder?: string;
    clearable?: boolean;
    commitOn?: "input" | "select";
    maxSuggestions?: number;
    width?: string;
  }>(),
  {
    placeholder: "",
    clearable: false,
    commitOn: "input",
    maxSuggestions: 8,
    width: "100%",
  },
);
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const focused = ref(false);
const sel = ref(-1);
// Local text buffer — what's shown in the input. In "input" mode it tracks the
// committed value; in "select" mode it can hold an uncommitted partial query.
const text = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    text.value = v;
  },
);

// Substring match (case-insensitive). An exact full match still shows — hiding it
// made a typed-in-full short name vanish while its longer sibling stayed.
const suggestions = computed(() => {
  const q = text.value.trim().toLowerCase();
  const list = q
    ? props.options.filter((p) => p.toLowerCase().includes(q))
    : props.options;
  return list.slice(0, props.maxSuggestions);
});

function commit(v: string) {
  if (v !== props.modelValue) emit("update:modelValue", v);
}
function exactOption(): string | undefined {
  const q = text.value.trim().toLowerCase();
  return props.options.find((o) => o.toLowerCase() === q);
}

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value;
  focused.value = true;
  sel.value = -1;
  if (props.commitOn === "input") commit(text.value);
}
function pick(v: string) {
  text.value = v;
  commit(v);
  focused.value = false;
  sel.value = -1;
}
function onBlur() {
  // Delay so a mousedown on a suggestion registers before the list closes.
  setTimeout(() => {
    focused.value = false;
    sel.value = -1;
    if (props.commitOn === "select") {
      // Commit a full-name match typed without clicking; otherwise discard the
      // partial query so the committed value (and any filtered view) is stable.
      const exact = exactOption();
      if (exact) {
        text.value = exact;
        commit(exact);
      } else {
        text.value = props.modelValue;
      }
    }
  }, 120);
}
function move(step: number) {
  const n = suggestions.value.length;
  if (!n) return;
  focused.value = true;
  sel.value = (sel.value + step + n) % n;
}
function enter() {
  const s = suggestions.value;
  if (sel.value >= 0 && sel.value < s.length) {
    pick(s[sel.value]);
    return;
  }
  if (props.commitOn === "select") {
    const exact = exactOption();
    if (exact) pick(exact);
    else focused.value = false;
  } else {
    commit(text.value); // accept the typed text as-is
    focused.value = false;
  }
}
function clear() {
  text.value = "";
  commit("");
  focused.value = false;
  sel.value = -1;
}

// Expose focus() so a parent hotkey (Ctrl+P) can move focus into the picker.
const inputEl = ref<HTMLInputElement | null>(null);
function focus() {
  inputEl.value?.focus();
  inputEl.value?.select();
}
defineExpose({ focus });
</script>

<template>
  <div class="pa-root" :style="{ width }">
    <input
      ref="inputEl"
      :value="text"
      class="pa-input"
      :class="{ clearable: clearable && text }"
      :placeholder="placeholder"
      autocomplete="off"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="enter"
      @keydown.escape="focused = false"
    />
    <button
      v-if="clearable && text"
      type="button"
      class="pa-clear"
      tabindex="-1"
      @mousedown.prevent="clear"
    >
      ×
    </button>
    <ul v-if="focused && suggestions.length" class="pa-list">
      <li
        v-for="(p, i) in suggestions"
        :key="p"
        class="pa-item"
        :class="{ sel: i === sel }"
        @mousedown.prevent="pick(p)"
      >
        {{ p }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pa-root {
  position: relative;
  display: inline-block;
}
.pa-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--card-bg, #232323);
  color: var(--text, #e8e8e8);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: var(--card-radius, 6px);
  padding: 7px 10px;
  font-size: 13px;
  font-family: var(--segoe);
  /* Dark popup hint for the platform-painted parts. */
  color-scheme: dark;
}
.pa-input.clearable {
  padding-right: 24px;
}
.pa-input:focus {
  outline: none;
  border-color: var(--accent);
}
.pa-clear {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.pa-clear:hover {
  color: var(--text, #e8e8e8);
}
.pa-list {
  position: absolute;
  top: 100%;
  left: 0;
  /* Grow to fit the longest suggestion (like the native <select> this replaced
     in #70), but never narrower than the input. Cap so a very long name can't
     run off the window; only past the cap does the item ellipsis kick in. */
  min-width: 100%;
  width: max-content;
  max-width: min(480px, 90vw);
  z-index: 50;
  margin: 2px 0 0;
  padding: 4px;
  list-style: none;
  background: var(--card-bg, #232323);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  max-height: 184px;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.pa-item {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-item:hover,
.pa-item.sel {
  background: var(--accent-soft, rgba(217, 119, 87, 0.18));
  color: var(--text, #e8e8e8);
}
</style>
