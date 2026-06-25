---
name: phases
description: Break a large, multi-session task into ordered phases and work one phase per session. Each plan is a folder under .claude/phases (named by an English title) with one file per phase; it links to a tracker task via `CC-task: #N` and shows up as checkboxes in the Claude Usage Tracker. Use when a task is too big for one session and progress must survive between sessions.
---

# phases — work a big task one phase per session

A large task rarely fits one session: context fills up, and what you figured out
is gone when the session ends. This skill keeps the plan **in the project** and
has you work it **one phase at a time**, so each session stays small and the next
one picks up cleanly.

## When to use
- The task spans many files/layers, or will take more than one session.
- Fits one sitting? Skip this — just do it.

## The model
- A **plan** is a folder: `.claude/phases/<Plan-Title>/`. The title is the folder
  name, so it must be **English** (letters/digits/space/_/-); the CLI validates it.
- Inside the folder:
  - `README.md` — the plan's tracker link (`CC-task: #N`), a **`## Vision`** section
    (the north star: the goal and the intended flow — the SessionStart hook surfaces
    it into **every** session so phases can't quietly drift from the plan's intent),
    plus **your notes** (context, decisions, gotchas). Set the Vision with
    `phases vision "<text>"` (or edit the section by hand); the rest of the README is
    yours — the CLI scaffolds it once and never touches anything outside `## Vision`.
  - `Phase-1.md`, `Phase-2.md`, … — one file per phase (title, description, done
    state, and the phase's subphase checklist). **Source of truth; never hand-edit —
    go through the CLI** (the tracker parses these to draw the checkboxes).
  - `HANDOFF.md` — the CLI-managed baton for the next session (see below). Optional.
- A **phase** is a chunk you can finish *and verify* in one session (locator `N`).
- A **subphase** is a checklist item inside a phase (locator `N.k`).

## The CLI
Everything is one unified entry: **`cli.mjs phases <cmd>`**. Run it with Node, from
the project root — it writes to that project's `.claude/phases/`. (It ships with the
Claude Usage Tracker; in this repo it's `scripts/cli.mjs`. The SessionStart hook
hands you the exact bundled path.)

    node <cli> phases create "Plan title" --task <N> [--vision "<text>"]   # title → folder; links the card
    node <cli> phases add "<phase title>" "<what done looks like>"
    node <cli> phases add-sub "<title>" "<detail>"     # → last phase (or --phase <N>)
    node <cli> phases done <loc>          # loc = N (a phase) or N.k (a subphase)
    node <cli> phases reopen <loc>
    node <cli> phases edit <loc> --title "…" --desc "…"
    node <cli> phases delete <loc> [--force]    # a phase with subphases needs --force
    node <cli> phases vision "<text>"     # the plan's north star (README ## Vision; --clear to reset)
    node <cli> phases handoff "<baton>"   # leave a note for the next session (--clear to drop)
    node <cli> phases verify              # integrity self-check (run after edits)
    node <cli> phases list                # current state

`--task <N>` is the tracker task number; without it the plan won't appear on a
card. `--plan <slug>` (the folder name) picks the plan; it can be omitted when the
project has exactly one plan. `done`/`reopen` on a phase cover its subphases.

## Decompose — once, at the start
1. `create "<Title>" --task <N>` — make the plan folder.
2. **Write the Vision FIRST** — `phases vision "<the goal and the intended flow>"`
   (or pass `--vision` to `create`, or edit the README's `## Vision` section): the
   goal and the FLOW exactly as the task/spec describes it — the faithful intent,
   not a paraphrase. This is the north star; the SessionStart hook surfaces it into
   every session, so a phase that drifts from the flow gets caught. Decomposing
   before the vision is written is how phases quietly redefine the task (and `add`
   warns you when you start without one).
3. `add` each phase (size each to **one session**; split if it needs more), then
   `add-sub` its subphases. Each phase should trace back to a step of the Vision.
4. `verify` (warns if the Vision is still empty), and jot any nuance/gotcha into the
   README's `## Notes`.

## Work one phase per session
1. `list` — find the first unfinished phase. (The SessionStart hook also surfaces
   it automatically, with the plan's Vision, the next subphase, and the last handoff.)
2. Work **only that phase**, and keep it true to the Vision — if the phase seems to
   pull away from the plan's intent, stop and flag it rather than drifting. Do NOT
   start the next one — that is a fresh session.
3. Tick items as you finish them: `done 1.2`.
4. When the phase is complete: `done 1`, run `verify`, and **STOP**. Don't roll
   into the next phase — one phase per session is what keeps context small.

## Hand off to the next session
Before you stop, leave a short baton for whoever picks up the next phase — what's
done, any decision or gotcha, the concrete next step. The CLI stores it in the
plan's `HANDOFF.md`, and the **SessionStart hook surfaces it next session** along
with the current phase:

    node <cli> phases handoff "phase 1 done; <finding>; next: <step>"

Keep it short — a baton, not a log. (You can also drop a longer note in the plan's
`README.md`, or post it on the tracker task with `cli.mjs todos comment add`.)
