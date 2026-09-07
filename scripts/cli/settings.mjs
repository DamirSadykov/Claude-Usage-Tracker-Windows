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


// `hookContextEnabled`: master switch — when false the SessionStart hook injects
// nothing. Default true.
export function hookContextEnabled(appData) {
  const v = readSettings(appData).hookContextEnabled;
  return typeof v === "boolean" ? v : true;
}

// `taskHandoffGuard`: which tasks owe a baton before a session ends —
// off|submitted|unfinished|both. Default both.
const TASK_GUARD_MODES = ["off", "submitted", "unfinished", "both"];
export function taskHandoffGuard(appData) {
  const v = readSettings(appData).taskHandoffGuard;
  return typeof v === "string" && TASK_GUARD_MODES.includes(v) ? v : "both";
}

// `specDeltaGuard`: does closing a task that carries a `spec` link demand an
// explicit answer per addressed section (docs/specs/README.md §8, t#341) —
// on|off. Default on: the guard is inert for a board that links no specs, so
// it costs nothing until the link is made deliberately.
export function specDeltaGuard(appData) {
  const v = readSettings(appData).specDeltaGuard;
  return v === "off" || v === false ? "off" : "on";
}

// `matchPlanCli`: absolute path to a kb-style CLI that turns task/plan text into
// case-warnings. Two calls make up the contract, both optional to implement:
//   match-plan --text "<plan>" --json   — the ExitPlanMode hook (t#253)
//   match-warn --todo <id> --event <add|queue|in_progress> --tracker-cli <path>
//                                       — the task-event notify (t#250); the CLI
//                                         owns matching, dedup and comment posting
// Empty/absent (the default) disables both — the tracker itself carries no
// dependency on any knowledge base. Set by hand in settings.json; the UI's
// plugin-store writes per key, so a hand-added key survives its saves.
export function matchPlanCli(appData) {
  const v = readSettings(appData).matchPlanCli;
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

// `specRoot`: where the spec registry (t#339) looks for `<domain>/spec.md`
// catalogs, relative to the project the CLI is invoked from unless it is an
// absolute path. The tracker serves several projects, and each keeps its own
// spec tree at its own place, so this is a project-side default with a
// tracker-side override — same shape as `matchPlanCli`. Default `docs/specs`
// (this project's layout, docs/specs/README.md). Set by hand in settings.json.
export function specRoot(appData) {
  const v = readSettings(appData).specRoot;
  return typeof v === "string" && v.trim() ? v.trim() : "docs/specs";
}

// `specRepos`: map of `repo` key (as named by a section's `location.repo` in
// spec.md frontmatter, docs/specs/README.md §4) to that repo's absolute local
// path, for sections whose text lives outside this repository. An unlisted key
// or a listed path that does not exist on disk both mean "not available on
// this machine" — the registry reports that as its own answer (§4/§6), never
// as a dangling reference. Empty/absent (the default) means no external repo
// is reachable from here. Set by hand in settings.json.
export function specRepoPath(repoKey, appData) {
  const repos = readSettings(appData).specRepos;
  if (!repos || typeof repos !== "object") return "";
  const v = repos[repoKey];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}
