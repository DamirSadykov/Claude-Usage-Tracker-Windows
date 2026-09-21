// What is ACTUALLY wired in Claude Code's own settings, as opposed to what this
// build's installer would wire. The two diverge the moment a user upgrades the
// tracker without re-running the installer: `install_cc_hook` gained the
// PreToolUse/ExitPlanMode guard, and every settings.json written before that
// still has no guard in it. A session told "the architect checks your plan" by a
// map that never looked at settings.json is told something false.
//
// Read-only and forgiving in the same way as settings.mjs: a missing file,
// unreadable JSON or an unexpected shape yields an empty set, never a throw.

import { readFileSync } from "node:fs";
import path from "node:path";

export function claudeSettingsPaths(cwd = process.cwd()) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return [
    home ? path.join(home, ".claude", "settings.json") : "",
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ].filter(Boolean);
}

function commandsIn(root) {
  const out = [];
  const events = root && typeof root === "object" ? root.hooks : null;
  if (!events || typeof events !== "object") return out;
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const hook of hooks) {
        if (hook && typeof hook.command === "string") out.push(hook.command);
      }
    }
  }
  return out;
}

// The CLI subcommand a wired command ends in — `… cli.mjs" plan-hook exit` →
// "plan-hook exit". Anything that is not this tracker's CLI is not ours to read.
function area(command) {
  const marker = 'cli.mjs"';
  const at = command.indexOf(marker);
  if (at < 0 || !command.includes("claude-usage-tracker")) return "";
  return command.slice(at + marker.length).trim();
}

export function wiredHookAreas(cwd = process.cwd()) {
  const areas = new Set();
  for (const file of claudeSettingsPaths(cwd)) {
    let root;
    try {
      root = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const command of commandsIn(root)) {
      const name = area(command);
      if (name) areas.add(name);
    }
  }
  return areas;
}

export function planGuardWired(cwd = process.cwd(), areas = wiredHookAreas(cwd)) {
  return areas.has("plan-guard");
}
