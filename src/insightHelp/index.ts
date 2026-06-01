// Bundles every help file in this directory at build time. Filenames must
// follow `<kind>.<locale>.md`. Adding a new help page is just dropping a file
// here — no extra registration needed.

import { renderInsightHelp } from "./render";

const RAW_FILES = import.meta.glob("./*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// path "./cache_churn.ru.md" → key "cache_churn.ru"
const RAW_BY_KEY: Record<string, string> = {};
for (const [path, content] of Object.entries(RAW_FILES)) {
  const m = path.match(/^\.\/(.+)\.md$/);
  if (m) RAW_BY_KEY[m[1]] = content;
}

const RENDERED_CACHE = new Map<string, string>();

function pickRaw(kind: string, locale: string): string | null {
  return RAW_BY_KEY[`${kind}.${locale}`] ?? RAW_BY_KEY[`${kind}.en`] ?? null;
}

export function hasInsightHelp(kind: string, locale: string): boolean {
  return pickRaw(kind, locale) !== null;
}

export function getInsightHelpHtml(kind: string, locale: string): string {
  const key = `${kind}.${locale}`;
  const cached = RENDERED_CACHE.get(key);
  if (cached !== undefined) return cached;
  const raw = pickRaw(kind, locale);
  const html = raw ? renderInsightHelp(raw) : "";
  RENDERED_CACHE.set(key, html);
  return html;
}
