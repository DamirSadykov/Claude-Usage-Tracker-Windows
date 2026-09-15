// Central hotkey registry — the ONE list of keyboard shortcuts and what they do.
// Add a new binding HERE (a `combo` + a `label`); each window then wires only the
// actions it actually supports via `useHotkeys({ … })`. Keeping the combos in one
// place means a shortcut reads the same in every window and a future "shortcuts
// cheatsheet" can render straight from `HOTKEYS`.
import { onMounted, onBeforeUnmount } from "vue";

export interface HotkeyCombo {
  /** true → requires the platform modifier: Ctrl on Win/Linux, ⌘ on macOS. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Main key, matched case-insensitively against KeyboardEvent.key. */
  key: string;
}

export interface HotkeyDef {
  combo: HotkeyCombo;
  /** Human-readable label — for docs / a future shortcuts overlay. */
  label: string;
}

// ── The registry. Add new shortcuts here. ──────────────────────────────────
export const HOTKEYS = {
  search: { combo: { mod: true, key: "f" }, label: "Focus search" },
  project: { combo: { mod: true, key: "p" }, label: "Focus project filter" },
} satisfies Record<string, HotkeyDef>;

export type HotkeyId = keyof typeof HOTKEYS;

function matches(e: KeyboardEvent, c: HotkeyCombo): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return (
    e.key.toLowerCase() === c.key.toLowerCase() &&
    mod === !!c.mod &&
    e.shiftKey === !!c.shift &&
    e.altKey === !!c.alt
  );
}

// Bind window-scoped hotkeys. Pass only the actions this window supports; on a
// match the handler runs and the browser/webview default is prevented (so Ctrl+F
// doesn't open the find bar, Ctrl+P doesn't print). The listener lives for the
// calling component's lifetime.
export function useHotkeys(
  handlers: Partial<Record<HotkeyId, (e: KeyboardEvent) => void>>,
): void {
  function onKey(e: KeyboardEvent) {
    for (const id of Object.keys(handlers) as HotkeyId[]) {
      const def = HOTKEYS[id];
      const handler = handlers[id];
      if (def && handler && matches(e, def.combo)) {
        e.preventDefault();
        handler(e);
        return;
      }
    }
  }
  onMounted(() => window.addEventListener("keydown", onKey));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
}
