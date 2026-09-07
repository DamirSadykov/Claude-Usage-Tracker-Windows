#!/usr/bin/env node
// Unified CLI for the Claude Usage Tracker. ONE entry, area modules loaded
// LAZILY so adding an area never bloats this file or the startup cost:
//
//   node cli.mjs todos  <…>    → ./cli/todos.mjs   (mutate the todo list)
//   node cli.mjs triage <…>    → ./cli/triage.mjs  (publish the nightly digest)
//   node cli.mjs spec   <…>    → ./cli/spec.mjs    (spec registry, t#339)
//   node cli.mjs hook          → ./cli/hook.mjs    (SessionStart hook)
//   node cli.mjs stop-hook     → ./cli/stop-hook.mjs (Stop hook: HANDOFF guard)
//   node cli.mjs plan-guard    → ./cli/plan-guard.mjs (PreToolUse: plan format guard)
//
// Each area module exports `run(args)`. The tracker bundles this whole tree
// and the installer wires the hooks into ~/.claude/settings.json.
// (The `phases` area was removed with the phases entity, t#254 — a big task is
// now a CHANGE on the task graph (renamed from `theme` at t#345): root + dep
// chain; see docs/task-pipeline.md.)

import fs from "node:fs";
import path from "node:path";

const AREAS = {
  todos: "./cli/todos.mjs",
  change: "./cli/change.mjs",
  triage: "./cli/triage.mjs",
  corrections: "./cli/corrections.mjs",
  "task-cost": "./cli/task-cost.mjs",
  spec: "./cli/spec.mjs",
  hook: "./cli/hook.mjs",
  "stop-hook": "./cli/stop-hook.mjs",
  "plan-hook": "./cli/plan-hook.mjs",
  "plan-guard": "./cli/plan-guard.mjs",
};

// Hook areas run inside Claude Code's session lifecycle: a crash there must never
// break the session, so an unexpected throw exits clean instead of surfacing.
// (A DELIBERATE block from the Stop guard is process.exit(2) inside the module —
// exit doesn't throw, so it never reaches the catch below.)
const HOOK_AREAS = new Set(["hook", "stop-hook", "plan-hook", "plan-guard"]);

// A directory marked `.claude-sandbox` (in it or anywhere above) is a measurement
// rig: the task board, the plan ritual and the handoff guard would all arrive in
// that session's context as an outside source and contaminate what is being
// measured. Hook areas stay SILENT there; ordinary CLI use (`todos …`) is
// unaffected — a person asking for the board still gets it.
//
// The check lives here rather than in a shared library on purpose: the marker is
// a convention two separate repos honour, and this one must not take a dependency
// on the other. Keep it in step with the sibling implementation if the convention
// changes.
const SANDBOX_MARKER = ".claude-sandbox";

function inSandbox(from) {
  try {
    let dir = path.resolve(from || process.cwd());
    for (;;) {
      if (fs.existsSync(path.join(dir, SANDBOX_MARKER))) return true;
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  } catch {
    return false; // can't tell → behave normally
  }
}

function usage(code) {
  process.stdout.write(
    "cli - Claude Usage Tracker\n\n" +
      "  todos   <…>   mutate the todo list (add / set / comment / list / …)\n" +
      "  change  <…>   changes as records (new / list / show / close); a task points at one\n" +
      "  triage  <…>   publish/read the nightly-triage digest (publish / show / clear)\n" +
      "  corrections <…> user-corrections outcome metric, layer 1 (scan / label-template / eval)\n" +
      "  task-cost <…> session->task attribution for tokens-per-task (scan / publish)\n" +
      "  spec    <…>   spec registry (t#339): domains / show / refs / lint over docs/specs\n" +
      "  hook          SessionStart hook (wired into ~/.claude/settings.json)\n" +
      "  stop-hook     Stop hook — blocks a stop that leaves a worked task without a handoff baton\n" +
      "  plan-hook     plan-mode hooks (enter/prompt = format, exit = record + match-plan)\n" +
      "  plan-guard    PreToolUse hook on ExitPlanMode — refuses a plan that is not a valid graph file\n\n" +
      "Run `cli <area> --help` for an area's commands.\n",
  );
  process.exit(code);
}

const [area, ...rest] = process.argv.slice(2);

if (area === undefined || area === "-h" || area === "--help" || area === "help") {
  usage(area === undefined ? 1 : 0);
}

const mod = AREAS[area];
if (!mod) {
  process.stderr.write(`unknown area: ${area}\n`);
  usage(1);
}

// Measurement rig → hooks stay silent (see inSandbox above). Checked before the
// area module is even loaded, so a sandboxed session pays nothing.
//
// TRACKER_HOOKS_IGNORE_SANDBOX=1 lets one back in: a rig whose SUBJECT is a hook
// of ours needs that hook to fire, while everything else stays muted. Set it in
// the rig's own .claude/settings.json, on that hook's command only — never
// globally, or the sandbox stops meaning anything.
if (HOOK_AREAS.has(area) && inSandbox() && process.env.TRACKER_HOOKS_IGNORE_SANDBOX !== "1") {
  process.exit(0);
}

try {
  const m = await import(new URL(mod, import.meta.url));
  await m.run(rest);
} catch (err) {
  // A hook must never break a session — swallow and exit clean. Any other area
  // surfaces the error with a non-zero exit.
  if (HOOK_AREAS.has(area)) process.exit(0);
  process.stderr.write(String((err && err.message) || err) + "\n");
  process.exit(1);
}
