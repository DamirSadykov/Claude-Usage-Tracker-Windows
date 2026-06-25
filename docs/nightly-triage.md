# Nightly task triage

A once-a-day, **read-only** pass over the task board that publishes a *triage
digest* — what's overdue, stale, unprioritised, plus a few suggestions — shown in
the Tasks window (a chip beside the active-task count). Nothing it does changes a
task; the digest is advisory.

It runs **inside the tracker**: a background scheduler runs one pass at a time you
choose. No OS scheduled task, no scripts. The LLM only sits in the middle of a
deterministic pipeline — the tracker exports the board and publishes the result
itself — so a headless `claude -p` whose only tools are `Read` and `Write` never
raises an interactive prompt and can't touch your board.

## Turn it on

1. Open the **Tasks** window.
2. Click the **triage chip** (top, beside the open-task count) to open its popover.
3. Under **Nightly triage** at the bottom:
   - tick **Run automatically every day**,
   - set the **time** (local) and **model** — Haiku is the cheap default,
   - or hit **Run now** to trigger it immediately.

## How it works

- The tracker keeps a one-minute scheduler loop. Once a day, after your chosen
  time, if it hasn't already run today, it runs one pass in three steps:
  1. **Export** — the tracker runs `cli.mjs todos list --json` into a staging file
     (`triage-tmp/board.json`).
  2. **Reason** — it spawns `claude -p` over `scripts/triage-prompt.md` (baked into
     the app, with the board/staging paths + today's date substituted in). The
     agent's only tools are `Read` and `Write`: it reads `board.json` and writes its
     digest to `triage-tmp/triage-staging.json`. No shell, no network.
  3. **Publish** — the tracker runs `cli.mjs triage publish` on what the agent
     wrote; the existing watcher surfaces it and raises the desktop notification.
- **Catch-up:** a run missed while the app or PC was off fires the moment the app
  is next open past the scheduled time (gated on "already ran today?", not an exact
  tick).
- **Read-only by construction:** export and publish are the tracker's own CLI calls;
  the agent itself can only Read the exported board and Write a scratch file, so it
  cannot mutate a task. Suggestions are advisory — you act on them via the app.

## Requirements & files

- The `claude` CLI installed (the tracker finds it in `~/.local/bin` or on PATH).
- The tracker running — it lives in the tray, so this is the usual state.
- Config + a per-run log live beside the board in
  `%APPDATA%\com.claude-usage-tracker.app\`: `triage-schedule.json` (enabled / time
  / model / last run) and `triage-runs.log` (each run's output, for debugging).

Tune thresholds or wording in `scripts/triage-prompt.md` (rebuild to bake the
change into the app).
