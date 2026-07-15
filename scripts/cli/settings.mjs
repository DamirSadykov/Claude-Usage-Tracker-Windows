// Single read layer for the tracker's settings.json, for the Node CLI side (the
// SessionStart/Stop hooks). Mirrors src/settingsStore.ts on the UI side: one place
// that knows the file path, does the read+parse, and applies each setting's
// forgiving default. The hooks used to inline the same
// `readFileSync(appData/com.claude-usage-tracker.app/settings.json) + JSON.parse`
// block per setting (3× in hook.mjs, 2× in stop-hook.mjs), each re-deriving the
// path and the default — this centralizes that.
//
// Contract (unchanged from the inlined versions): every getter is read-only and
// forgiving — a missing file, bad JSON, or absent/invalid key yields the default,
// never throws. `appData` is the Roaming base (process.env.APPDATA); pass it in so
// callers that already resolved it don't re-derive, or omit it to resolve here.

import { readFileSync } from "node:fs";
import path from "node:path";

// The Roaming base that holds the app's data dir. Windows: %APPDATA%, with a
// USERPROFILE fallback for the rare case APPDATA is unset.
export function roamingBase(appData) {
  return (
    appData ||
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming")
  );
}

// Read + parse settings.json ONCE into a plain object. Never throws: any failure
// (file absent, unreadable, or not valid JSON) → {}. Callers read fields off the
// result and apply their own defaults, or use the typed getters below.
export function readSettings(appData) {
  try {
    const raw = readFileSync(
      path.join(roamingBase(appData), "com.claude-usage-tracker.app", "settings.json"),
      "utf8",
    );
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// --- Typed getters (each = one setting's key + type-guard + default) ---

// `taskContextPriority`: the LOWEST priority a task must have to reach a session,
// mapped to a min rank. all|low|medium|high → 0|1|2|3. Default medium (2).
export function taskContextMinRank(appData) {
  const MIN = { all: 0, low: 1, medium: 2, high: 3 };
  const v = readSettings(appData).taskContextPriority;
  return typeof v === "string" && v in MIN ? MIN[v] : MIN.medium;
}

// `sessionContext`: what a mid-plan session leads with — "phase" (default) or
// "tasks" (always the board).
export function sessionContextMode(appData) {
  const v = readSettings(appData).sessionContext;
  return v === "tasks" || v === "phase" ? v : "phase";
}

// `hookContextEnabled`: master switch — when false the SessionStart hook injects
// nothing. Default true.
export function hookContextEnabled(appData) {
  const v = readSettings(appData).hookContextEnabled;
  return typeof v === "boolean" ? v : true;
}

// `phaseHandoffGuard`: the Stop hook's plan-baton off-switch. Default true (guard on).
export function phaseHandoffGuard(appData) {
  const v = readSettings(appData).phaseHandoffGuard;
  return typeof v === "boolean" ? v : true;
}

// `taskHandoffGuard`: which tasks owe a baton before a session ends —
// off|submitted|unfinished|both. Default both.
const TASK_GUARD_MODES = ["off", "submitted", "unfinished", "both"];
export function taskHandoffGuard(appData) {
  const v = readSettings(appData).taskHandoffGuard;
  return typeof v === "string" && TASK_GUARD_MODES.includes(v) ? v : "both";
}
