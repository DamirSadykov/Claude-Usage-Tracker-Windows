# Task pipeline (#88) — driving the task graph

A guide for **Claude Code sessions**: how to work the todo board as a dependency
graph (a DAG), not a flat list. The tracker's CLI is the only writer — everything
below is a `cli.mjs todos …` command. In this repo `<cli>` = `node scripts/cli.mjs`;
the SessionStart hook hands you the exact bundled path in other projects.

The CLI prints a compact, always-current version of this flow — run
`<cli> todos pipeline`. This file is the same flow with the *why* attached.

## The model in one breath

- A **task is a node.** An edge `A → B` (`A depends_on B`) means **B must be `done`
  before A can start** — B blocks A.
- Two axes, kept **orthogonal** — don't conflate them:
  - **status** (the kanban column: `backlog | queue | in_progress | review | done`)
    — where a human filed the task. This is the node **fill** in the graph.
  - **pipeline state** (`blocked | ready`) — **derived** from the graph, never
    stored. `blocked` = a prerequisite isn't `done` yet; `ready` = every prerequisite
    is `done`. This is the **corner dot** on the graph's Deps tab.
  - A task can be `in_progress` **and** `blocked` at once — that's why they're two
    axes, not one status enum.
- A node's **kind** is `auto` or `manual` (default). This is the marker that decides
  **who closes it** (see step 3). Shown as a `⚡` glyph on auto nodes.

## The flow

### 1. Create tasks

```
<cli> todos add "<subject>" [--project <name> | --global] [--kind auto|manual]
```

Each task is a node. No `--kind` → `manual`. File it against the project it belongs
to (`--project`) or the global board (`--global`); a bare add uses the current
project (cwd).

### 2. Mark the dependencies (the edges)

```
<cli> todos dep add <task> <depends-on>     # <task> waits for <depends-on>
<cli> todos dep list <task>                 # inspect a node's deps + dependents
<cli> todos dep rm  <task> <depends-on>     # remove an edge
```

Edges are **acyclic** and **within one board** (the CLI rejects a cycle or a
cross-project dep). `<task>`/`<depends-on>` accept an id, a bare number, `#N`,
or the inline task-link form `t#N`.

Not every relation is a blocking edge. `ref add <task> <target>` records a
**non-blocking reference** — "related to", allowed to cross project boards, never
part of the ready/blocked derivation. An inline `t#N` in a description/plan draws
the same non-blocking edge from the text. If B must finish before A starts, it's a
`dep`; if A merely wants B in view, it's a `ref`.

### 3. Set node type — `auto` | `manual`

```
<cli> todos set-kind <id> auto|manual
```

This is the load-bearing decision — it sets **who has the authority to close the
node**:

- **`manual`** (default) — a **human / review gate.** *You* do the work, but you
  leave the close to the user: they review it and move it `review → done`. Its
  dependents stay `blocked` until then. That red/amber downstream is the gate
  **working**, not a bug — don't "fix" it by force-closing.
- **`auto`** — a node **this session may run unattended, verify, and close itself.**
  Because an auto node is run headless and its result is checked by the main
  session, the session **has the authority to set it `done`** after that check.
  Only mark a node `auto` when a headless run can actually *verify* success
  (build/tests green, an invariant holds) — the oracle is your own verification,
  and a wrong auto-close compounds down the chain to the next manual gate.

### 4. Run the pipeline

A node is **ready** when **every task in its `depends_on` is `done`**. Note `review`
is **not** `done` — a prerequisite sitting in `review` is still a gate, so its
dependents remain blocked until it is actually marked `done`.

List the frontier — tasks workable right now — instead of computing it by hand:

```
<cli> todos ready [--project <name> | --all] [--auto | --manual] [--json]
```

`--auto` is the runnable set (nodes this session may execute + close); `--manual`
is the human gates now waiting. A dependency-free task counts as ready (nothing
blocks it). Walk the frontier in dependency order:

- **auto node** → do the work, **verify it**, then close and hand off:
  ```
  <cli> todos set-status <id> done
  <cli> todos handoff set <id> --text "<what it produced; next step; gotchas>"
  ```
  The handoff flows forward along dep edges (#141) to whatever depends on this.
- **manual node** → **stop here.** Do the work if it's yours to do, but leave the
  `review → done` move to the user. This is the review gate; don't roll past it.
  **Signal the handback:** send a system notification (the `PushNotification` tool)
  that the pipeline parked at this gate and needs their call. It **self-skips when
  the user is at the terminal** (your inline message already reached them), so it
  only pulls back a user who walked away during a long auto run — no duplicate noise.

Only `done` releases downstream. Keep advancing until the next unblocked node is
`manual` — that's where the pipeline hands back to a human.

### The done-gate

Because `done` is the **only** status that releases downstream tasks, closing a
node while its own prerequisites are unfinished would silently unblock work whose
chain never ran — the graph would show `ready` for edges that were never
satisfied. So the CLI enforces the invariant at the write:

```
<cli> todos set-status <id> done          # refused while a direct prereq isn't done
<cli> todos set-status <id> done --force  # explicit override
```

The refusal names the blocking tasks and their columns. Only **direct**
`depends_on` are checked — a satisfied direct prerequisite transitively vouches
for its own upstream (it couldn't have closed honestly otherwise). `--force` is
for the genuine exceptions (a prereq made obsolete, an out-of-band completion);
if you reach for it routinely, the graph is wrong — fix the edges instead.

### The handoff baton (#141)

A task's `handoff` is what it **produced** — files/paths, interfaces, decisions,
gotchas, the suggested next step — written for the task(s) that depend on it:

```
<cli> todos handoff set <id> --text "<what it produced; next step; gotchas>"
<cli> todos handoff <id>                  # read what <id> inherits from its prereqs
```

You don't have to ask for the baton: moving a task to `in_progress` via
`set-status` **auto-prints** the handoffs of its direct prerequisites. Only
direct ones are read — cumulative context still chains forward because a handoff
is authored prose that can itself reference upstream tasks as `t#N`.

Keep it a baton, not a log: the concrete outcome a dependent builds on, not the
task's own subject restated, not session chatter, not how you got there. Empty is
fine when there's nothing to pass on.

### Two channels, one rule

Who signals the auto→manual handback depends on who drove the auto segment:

- **You (an interactive CC session)** drove it → you hand back **in the session** and
  fire a `PushNotification` for the walked-away case. That's this section.
- **A headless/scheduled runner** drove it (the future unattended slice) → there's no
  session to await the user, so the *runner* emits the parked signal (e.g. a
  `pipeline-parked.json` the tracker watches → desktop alert), the same shape as the
  nightly-triage digest. Not built yet; it belongs with the runner.

The gate itself is identical either way — a `manual` node the pipeline never crosses
on its own.

## Worked example

A three-node chain: extract a schema (verifiable → auto), migrate the code on top
of it (verifiable → auto), then a human review of the result (manual).

```
<cli> todos add "extract settings schema" --kind auto        # → #10
<cli> todos add "migrate readers to schema" --kind auto      # → #11
<cli> todos add "review migration"                           # → #12 (manual by default)
<cli> todos dep add 11 10        # migration waits for the schema
<cli> todos dep add 12 11        # review waits for the migration
```

Driving it:

```
<cli> todos ready --auto         # → #10 (only node with all deps done)
# ... do #10, verify (tests green) ...
<cli> todos set-status 10 done
<cli> todos handoff set 10 --text "schema in src/settings-schema.ts; readers must go through parseSettings(); gotcha: legacy `pending` status folds to backlog"
<cli> todos ready --auto         # → #11 (released by #10)
<cli> todos set-status 11 in_progress    # auto-prints #10's handoff — the baton arrives
# ... do #11, verify ...
<cli> todos set-status 11 done
<cli> todos handoff set 11 --text "..."
<cli> todos ready --auto         # → (empty) — the frontier is now manual
<cli> todos ready --manual       # → #12: the human gate
# park here: move #12 to review, notify (PushNotification), stop.
```

Trying to jump the chain is refused:

```
<cli> todos set-status 12 done
# refusing: #12 depends on unfinished task(s): #11 [in_progress]
# finish those first, or override with --force
```

## Themes — a root task as the aggregator (t#255)

How a piece of work **bigger than one task** lives on the graph — as a **theme**:

- A theme is an ordinary **root task that `depends_on` all of its children.** No
  new entity: the aggregation *is* the dep edges. The root **closes last** — the
  done-gate already refuses `done` while a prerequisite is open, so the order is
  enforced, not just conventional.
- A root is **worth creating from ~4–5 nodes**; below that the children speak for
  themselves. Name it so it reads as a container (e.g. `ТЕМА: <what>`), file it on
  the same board as its children (deps are intra-board).
- **Mark the root explicitly** — `todos set-theme <id> on` (or `add --theme`).
  The stored flag is what lets consumers (the vision hook, t#252) find the vision
  deterministically: walk UP the reverse dep edges to the nearest dependent with
  `theme` on, instead of guessing which downstream task is "the" aggregator. The
  fold behaviour in the graph stays universal; the flag only marks intent.
- **The theme's vision lives in the root task's DESCRIPTION** — deliberately *not*
  a separate field (t#255): the description already travels everywhere a task
  shows (card, CLI, hooks), and a second free-text field would split the story.
  Write it as the north star for anyone working a child: what the whole chain is
  for and what "done" means for the theme.
- Direction of reading matters: the **description is read UPWARD** — working a
  child, follow the reverse edge to the root(s) that depend on it for the vision
  (the vision hook, t#252, surfaces it automatically). The root's **handoff stays
  the usual DOWNSTREAM baton** to whatever depends on the root itself.

## Plan mode — the task-forming ritual (t#253)

Plan mode is where themes COME FROM: the plan is written for the writer (and the
sessions after them), then transcribed into the tracker. Two PostToolUse hooks,
wired by the installer next to SessionStart/Stop:

- **EnterPlanMode** (`cli.mjs plan-hook enter`) injects the format before the
  plan is written: a VISION paragraph ("должно X, решили Y, потому что Z"),
  numbered STEPS where **one step = one session**, and a final ORDER line in
  arrow notation (`Порядок: 1 -> 2 -> 3; 2 -> 5`) stating REAL blockers only.
- **ExitPlanMode** (`cli.mjs plan-hook exit`) instructs the session to record
  the accepted plan: several steps → a theme root (`add --theme`, vision →
  description, full markdown → `set-plan`) plus one task per step and `dep add`
  per ORDER arrow; a one-session plan → `set-plan` on the task itself. The hook
  also runs the deterministic **match-plan** step: if `matchPlanCli` in the
  tracker's settings.json names a kb-style CLI, the plan text goes through
  `match-plan --json` and any case-warnings are injected (and asked to be
  persisted as a comment) — zero warnings stay silent, and a matcher failure
  never blocks the recording.

Plan mode is NOT mandatory — a task created or taken without it works as before;
the ORDER/vision structure just doesn't get written for free.

## Why the discipline matters

The whole point of `manual` gates is to stop unattended drift: an early wrong
auto-close silently corrupts every downstream node until a human looks. So the
conservative default is `manual`, and `auto` is opt-in for work whose success you
can *verify*, not just *produce*. When in doubt, leave it `manual`.

## Seeing it

In the tracker's graph window, **Dependencies** tab:
- node **fill** = kanban status;
- **corner dot** = pipeline state — red `blocked`, green `ready` (auto), amber
  `ready` (manual, i.e. waiting for you);
- **`⚡`** = an auto node;
- **`⊖` on a node** folds its exclusive prerequisite subtree (a theme) into the
  root — the badge shows the fold's `done/total`; click the badge to unfold;
- with a node selected, the **"Component only"** toolbar button cuts the view to
  that task's connectivity component (works on both tabs).
