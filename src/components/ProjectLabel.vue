<script setup lang="ts">
// A project name plus a small link badge when the project is part of a merge
// (issue #13): either a canonical that absorbed others (badge lists the merged-in
// aliases) or an alias itself (badge names the canonical it folds into). Hovering
// or focusing the badge shows the explanation in a popover. Used everywhere a
// project name is displayed (analytics breakdown, mini panel, task cards) so
// merges read consistently.
//
// The popover is Teleported to <body> with position:fixed, placed from the
// badge's live rect — so it can't be clipped by an overflow:hidden table cell,
// bar, or card tag, and it appears instantly (no native-title delay).
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    name: string | null;
    /** Aliases merged INTO this name → it's a canonical that absorbed others. */
    aliases?: string[];
    /** Canonical this name folds into → it's an alias (e.g. a raw task project). */
    mergedInto?: string | null;
    fallback?: string;
  }>(),
  { aliases: () => [], mergedInto: null, fallback: "" },
);
const { t } = useI18n();

const label = computed(() =>
  props.name && props.name.length ? props.name : props.fallback || t("projectUnknown"),
);
const isCanonical = computed(() => props.aliases.length > 0);
// Don't double-badge: if it's a canonical, ignore any stale mergedInto.
const isAlias = computed(() => !isCanonical.value && !!props.mergedInto);
const merged = computed(() => isCanonical.value || isAlias.value);
const tipLabel = computed(() => (isCanonical.value ? t("projectMergedTip") : t("projectAliasTip")));
const tipItems = computed(() =>
  isCanonical.value ? props.aliases : props.mergedInto ? [props.mergedInto] : [],
);

const badgeEl = ref<HTMLElement | null>(null);
const open = ref(false);
const popStyle = ref<Record<string, string>>({});

function show() {
  const el = badgeEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // Anchor top-left below the badge; clamp to the viewport so a name near the
  // right edge doesn't push the popover off-screen.
  const MAXW = 260;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - MAXW - 8));
  popStyle.value = { left: `${Math.round(left)}px`, top: `${Math.round(r.bottom + 6)}px` };
  open.value = true;
}
function hide() {
  open.value = false;
}
</script>

<template>
  <span class="pl">
    <span class="pl-name">{{ label }}</span>
    <span
      v-if="merged"
      ref="badgeEl"
      class="pl-badge"
      :class="{ alias: isAlias }"
      :aria-label="`${tipLabel} ${tipItems.join(', ')}`"
      tabindex="0"
      @mouseenter="show"
      @mouseleave="hide"
      @focus="show"
      @blur="hide"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M9.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
        <path d="M14.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
      </svg>
    </span>
    <Teleport to="body">
      <span v-if="open && merged" class="pl-pop" :class="{ alias: isAlias }" :style="popStyle" role="tooltip">
        <span class="pl-pop-lbl">{{ tipLabel }}</span>
        <span class="pl-pop-items">{{ tipItems.join(", ") }}</span>
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.pl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.pl-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: var(--accent, #d97757);
  background: var(--accent-soft, rgba(217, 119, 87, 0.18));
  cursor: help;
}
/* An alias (folded INTO another) reads as secondary — muted, not accent. */
.pl-badge.alias {
  color: var(--text-3, rgba(255, 255, 255, 0.7));
  background: rgba(255, 255, 255, 0.08);
}
.pl-badge:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
</style>

<!-- Popover lives on <body> (Teleport), so its styles must be unscoped to apply. -->
<style>
.pl-pop {
  position: fixed;
  z-index: 9999;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  background: var(--card-bg, #232323);
  border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.14));
  border-left: 2px solid var(--accent, #d97757);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  font-family: var(--segoe);
  pointer-events: none;
}
.pl-pop.alias {
  border-left-color: var(--text-3, rgba(255, 255, 255, 0.7));
}
.pl-pop-lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-4, rgba(255, 255, 255, 0.5));
}
.pl-pop-items {
  font-size: 12px;
  color: var(--text, #e8e8e8);
  word-break: break-word;
}
</style>
