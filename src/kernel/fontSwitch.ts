// UI font selection. The chosen font overrides the global `--segoe` CSS
// variable (every component reads it) and sets a `data-font` attribute on
// :root so per-font size tweaks can target each face (see style.css).
//
// Persistence model (mirrors how `locale` works):
//   - Tauri store (settings.json) is the source of truth, read/written in
//     App.vue alongside the other settings.
//   - localStorage is a fast cache so main.ts can apply the font *before*
//     paint (no flash) without awaiting the async store. App.vue keeps the
//     cache in sync whenever it loads/saves the store value.

export interface FontOption {
  id: string;
  /** Display name (proper noun — not translated). */
  name: string;
  /** font-family stack applied to --segoe. */
  stack: string;
  /** Monospace candidate — wider glyphs, gets size tweaks in style.css. */
  mono?: boolean;
  /** The built-in system default (label gets a translated prefix). */
  system?: boolean;
}

export const DEFAULT_FONT_ID = "segoe";

// The default Segoe stack mirrors style.css so picking the default restores it.
const SEGOE_STACK =
  '"Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif';

export const FONT_OPTIONS: FontOption[] = [
  { id: "segoe", name: "Segoe UI", stack: SEGOE_STACK, system: true },
  { id: "montserrat", name: "Montserrat", stack: '"Montserrat", ' + SEGOE_STACK },
  { id: "fira-code", name: "Fira Code", stack: '"Fira Code", "Cascadia Code", monospace', mono: true },
  { id: "jetbrains-mono", name: "JetBrains Mono", stack: '"JetBrains Mono", "Cascadia Code", monospace', mono: true },
];

export function optionFor(id: string): FontOption {
  return FONT_OPTIONS.find((o) => o.id === id) ?? FONT_OPTIONS[0];
}

/** Apply a font to the current document: override --segoe and set data-font.
 *  Pure visual side-effect — persistence is handled by the caller. */
export function applyFont(id: string): void {
  const opt = optionFor(id);
  const root = document.documentElement;
  root.style.setProperty("--segoe", opt.stack);
  root.dataset.font = opt.id;
}

// --- localStorage fast-cache (FOUC avoidance) -------------------------------

const CACHE_KEY = "uiFont";

export function readCachedFontId(): string {
  try {
    return localStorage.getItem(CACHE_KEY) ?? DEFAULT_FONT_ID;
  } catch {
    return DEFAULT_FONT_ID;
  }
}

export function writeCachedFontId(id: string): void {
  try {
    localStorage.setItem(CACHE_KEY, id);
  } catch {
    /* ignore storage failures */
  }
}
