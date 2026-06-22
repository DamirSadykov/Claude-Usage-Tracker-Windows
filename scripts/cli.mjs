#!/usr/bin/env node
// Unified CLI for the Claude Usage Tracker. ONE entry, area modules loaded
// LAZILY so adding an area never bloats this file or the startup cost:
//
//   node cli.mjs todos  <…>    → ./cli/todos.mjs   (mutate the todo list)
//   node cli.mjs phases <…>    → ./cli/phases.mjs  (break a task into phases)
//   node cli.mjs hook          → ./cli/hook.mjs    (SessionStart hook)
//
// Each area module exports `run(args)`. Back-compat shims (cc-todos.mjs,
// cc-phases.mjs, cc-todos-hook.mjs) forward to the same modules, so existing
// wirings and muscle memory keep working. The tracker bundles this whole tree
// and the installer wires `node "<cli.mjs>" hook` into ~/.claude/settings.json.

const AREAS = {
  todos: "./cli/todos.mjs",
  phases: "./cli/phases.mjs",
  hook: "./cli/hook.mjs",
};

function usage(code) {
  process.stdout.write(
    "cli - Claude Usage Tracker\n\n" +
      "  todos   <…>   mutate the todo list (add / set-status / comment / list / …)\n" +
      "  phases  <…>   break a task into ordered phases (create / add / done / list / …)\n" +
      "  hook          SessionStart hook (wired into ~/.claude/settings.json)\n\n" +
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

try {
  const m = await import(new URL(mod, import.meta.url));
  await m.run(rest);
} catch (err) {
  // The SessionStart hook must never break a session — swallow and exit clean.
  // Any other area surfaces the error with a non-zero exit.
  if (area === "hook") process.exit(0);
  process.stderr.write(String((err && err.message) || err) + "\n");
  process.exit(1);
}
