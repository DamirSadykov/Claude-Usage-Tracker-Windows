<script setup lang="ts">
// A project name plus small badges describing its links (issue #13):
//   • merge — a canonical that absorbed others (lists the merged-in aliases) or an
//     alias itself (names the canonical it folds into); see stats::project_links.
//   • group — works-with associations (lists the related projects); see
//     project_groups.rs. Peer relationship, not a stat merge.
// Hovering/focusing a badge shows the explanation in a popover. Teleported to
// <body> with position:fixed so it isn't clipped by an overflow:hidden table cell,
// bar, or card tag, and appears instantly (no native-title delay). Used everywhere
// a project name is shown so links read consistently.
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    name: string | null;
    /** Aliases merged INTO this name → it's a canonical that absorbed others. */
    aliases?: string[];
    /** Canonical this name folds into → it's an alias (e.g. a raw task project). */
    mergedInto?: string | null;
    /** Projects this one works WITH (association co-members). */
    related?: string[];
    fallback?: string;
  }>(),
  { aliases: () => [], mergedInto: null, related: () => [], fallback: "" },
);
const { t } = useI18n();

const label = computed(() =>
  props.name && props.name.length ? props.name : props.fallback || t("projectUnknown"),
);
const isCanonical = computed(() => props.aliases.length > 0);
// Don't double-badge merge: if it's a canonical, ignore any stale mergedInto.
const isAlias = computed(() => !isCanonical.value && !!props.mergedInto);

interface Mark {
  kind: "merge" | "alias" | "group";
  lbl: string;
  items: string[];
}
const marks = computed<Mark[]>(() => {
  const m: Mark[] = [];
  if (isCanonical.value) m.push({ kind: "merge", lbl: t("projectMergedTip"), items: props.aliases });
  else if (isAlias.value && props.mergedInto)
    m.push({ kind: "alias", lbl: t("projectAliasTip"), items: [props.mergedInto] });
  if (props.related.length) m.push({ kind: "group", lbl: t("projectGroupTip"), items: props.related });
  return m;
});

const open = ref(false);
const popStyle = ref<Record<string, string>>({});
const popMark = ref<Mark | null>(null);

function show(e: Event, mark: Mark) {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const MAXW = 260;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - MAXW - 8));
  popStyle.value = { left: `${Math.round(left)}px`, top: `${Math.round(r.bottom + 6)}px` };
  popMark.value = mark;
  open.value = true;
}
function hide() {
  open.value = false;
  popMark.value = null;
}
</script>

<template>
  <span class="pl">
    <span class="pl-name">{{ label }}</span>
    <span
      v-for="(m, i) in marks"
      :key="m.kind + i"
      class="pl-badge"
      :class="m.kind"
      :aria-label="`${m.lbl} ${m.items.join(', ')}`"
      tabindex="0"
      @mouseenter="show($event, m)"
      @mouseleave="hide"
      @focus="show($event, m)"
      @blur="hide"
    >
      <!-- group → cluster glyph; merge/alias → link glyph -->
      <svg
        v-if="m.kind === 'group'"
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="7" cy="8.5" r="3" />
        <circle cx="17" cy="8.5" r="3" />
        <circle cx="12" cy="16" r="3" />
      </svg>
      <svg
        v-else
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
      <span v-if="open && popMark" class="pl-pop" :class="popMark.kind" :style="popStyle" role="tooltip">
        <span class="pl-pop-lbl">{{ popMark.lbl }}</span>
        <span class="pl-pop-items">{{ popMark.items.join(", ") }}</span>
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
/* A group (works-with) badge — distinct cluster glyph, calmer tint. */
.pl-badge.group {
  color: var(--text-2, rgba(255, 255, 255, 0.85));
  background: rgba(255, 255, 255, 0.1);
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
.pl-pop.group {
  border-left-color: var(--text-2, rgba(255, 255, 255, 0.85));
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
