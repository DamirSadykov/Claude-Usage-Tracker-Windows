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
cross-project dep). `<task>`/`<depends-on>` accept an id, a bare number, or `#N`.

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
