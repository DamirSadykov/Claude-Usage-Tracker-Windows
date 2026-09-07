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
<cli> todos set kind <id> auto|manual
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
  and a wrong auto-close compounds down the chain to the next manual gate. An
  `auto` node with no declared `verify` is accepted but only warns — the
  headless runner then treats it as a gate anyway (`isGate` in `run.mjs`): the
  authority to close comes from the check itself, not from the flag alone.

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
  <cli> todos set status <id> done
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
<cli> todos set status <id> done          # refused while a direct prereq isn't done
<cli> todos set status <id> done --force  # explicit override
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
`set status` **auto-prints** the handoffs of its direct prerequisites. Only
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
<cli> todos set status 10 done
<cli> todos handoff set 10 --text "schema in src/settings-schema.ts; readers must go through parseSettings(); gotcha: legacy `pending` status folds to backlog"
<cli> todos ready --auto         # → #11 (released by #10)
<cli> todos set status 11 in_progress    # auto-prints #10's handoff — the baton arrives
# ... do #11, verify ...
<cli> todos set status 11 done
<cli> todos handoff set 11 --text "..."
<cli> todos ready --auto         # → (empty) — the frontier is now manual
<cli> todos ready --manual       # → #12: the human gate
# park here: move #12 to review, notify (PushNotification), stop.
```

Trying to jump the chain is refused:

```
<cli> todos set status 12 done
# refusing: #12 depends on unfinished task(s): #11 [in_progress]
# finish those first, or override with --force
```

## Changes — a record of its own, addressed `c#N` (t#255 → renamed at t#345 → made a record at c#9)

How a piece of work **bigger than one task** lives on the board — as a
**change**. It was a *theme*, then a root TASK marked with a flag; since c#9 it
is a **record in its own right**, kept in the `changes` section of the board
file and addressed `c#N`. See `tasks#changes` for the invariants behind this;
here is how you drive it:

- `c#N` has its **own counter, independent of task numbers** — `c#1` and `#1`
  are unrelated, so never pass a task number where an address is expected.
- **Open one, then put tasks in it:**

  ```
  <cli> change new "<title>" [--delta "<what this round changes and why now>"]
  <cli> todos set change <task> c#N        # membership is a FIELD, not an edge
  <cli> change list | change show c#N
  ```

  In plan mode you do not do this by hand: `todos apply` opens the change from
  the plan and files every step into it.
- **Membership is the `change_id` field**, not a dep edge. It used to be an edge
  and that was the reason for the rewrite: one edge type meant both "blocks me"
  and "is part of me", and a forgotten edge silently dropped a task out of its
  change, because "no edge" is a legal state of the graph.
- **A change is worth opening from ~4–5 nodes**; below that the tasks speak for
  themselves. Name it so it reads as a container (e.g. `CHANGE: <what>`).
- **The status is not stored: a change is open while any of its tasks is open.**
  Do not look for a flag — ask the membership. `change close` refuses while a
  task is still open and stamps the moment it was declared finished; that stamp
  is a date for the history, never the answer to "is it open".
- **The change's DELTA — what this round changes and why now** — lives on the
  record (`change set delta c#N "…"`), not on any task. Vision is not a delta:
  it lives in the spec the change points at (`docs/specs/README.md` §1). The
  spec is the long-lived "what should exist and why"; a change is a temporary
  delta against it and dies with its tasks.
- Direction of reading matters: the **delta is read UPWARD** — working a task,
  it arrives on its own. `set status <id> in_progress` prints the delta of the
  change the task belongs to next to the inherited handoff, the SessionStart
  hook re-surfaces it for every in_progress task, and `todos vision <task>`
  re-reads it on demand.
- The ceilings of the group — `budget_usd` and `parallel_limit` — belong to the
  record (`change set budget|parallel c#N …`); the runner reads them there.
- A change points at the spec section(s) it is a delta of with
  `change set spec c#N <domain>#<slug>`; a single task narrows that to its own
  step with `todos set spec <task> <domain>#<slug>` — see `tasks#spec-registry`.
- **A board written before the migration still reads.** An old root task
  carrying the `change` (or the even older `theme`) flag is understood as a
  change with the address `t#N`, its members found by walking the dep edges up.
  Nothing is ever written back in that shape — migrate such a board with
  `<cli> change migrate`.
- **Setting it puts a gate at the other end.** Moving a linked task to
  `review`/`done` will not let the session stop until it has answered for each
  addressed section:

  ```
  <cli> spec answer <task> unchanged --text "why the section still holds"
  <cli> spec answer <task> updated   --text "what moved in it"   # edit the section FIRST
  ```

  The Stop hook prints the section in full and asks about THAT, because the way
  the genre rotted was spot edits made without rereading (t#338). `updated`
  stamps the section's `updated`/`change` for you. One answer covering two
  sections, or a sentence copied from the answer you just gave, is refused.
- **Never write `t#N` into a spec section.** A spec is the state that outlives
  the tasks; a task number in it goes stale the moment the task closes, and the
  section stops being readable without the board open next to it. Say WHAT was
  decided without the number — who and when is `git blame` plus the section's
  `change` stamp, which the machine writes. `spec lint` and `spec answer
  updated` both refuse a section that carries one.

## Plan mode — the task-forming ritual (t#253, rebuilt as a file format at t#314/t#321)

Plan mode is where changes COME FROM, but **the plan is not a ritual you
transcribe by hand any more.** A plan is a YAML file in the tracker's own
process-graph language — one step per task — documented in full in
`docs/plan-format.md` (read it once per session, not once per plan; §4 there is
a complete worked example). This section is the short version of how the hooks
carry it; the invariants themselves are `tasks#plan-mode`.

The shape, in brief (full rules in `docs/plan-format.md`):

```yaml
change: "CHANGE: <name>"   # optional; without it the steps land rootless
vision: |                  # the WHAT & WHY paragraph — becomes the change's description
parallel: <N>              # steps the runner may drive at once
budget: <usd>              # the group's ceiling
steps:
  <n>:
    title: <phrase>         # or: task: <N>  — continue a task already on the board
    why: |                  # what this step rests on, its risk — becomes the task's description
    needs: [<n>, <n>]       # REAL blockers only — the only place order lives
    produces: [<path>]
    verify: <cmd>
    retry: <M>
    on-issue: <n>
    kind: auto|manual
    budget: <usd>
```

Three hooks, wired by the installer next to SessionStart/Stop:

- **EnterPlanMode / a prompt sent while in plan mode** (`cli.mjs plan-hook
  enter|prompt`) points you at `docs/plan-format.md` instead of repeating the
  format inline — once per session (a marker file dedupes `enter` and `prompt`
  firing in the same session).
- **PreToolUse on ExitPlanMode** (`cli.mjs plan-guard`) — **the gate that
  actually enforces the language.** It checks the plan text **before the user
  ever sees the confirmation prompt**: a text that isn't readable as the graph
  language, or that is but breaks a rule (a cycle in `needs`, an `on-issue`
  with no `retry`, a `needs`/`on-issue` pointing at a step that doesn't exist,
  a step with neither `title` nor `task`, a `task` naming no task on the board
  or one already bound to an earlier step, …), is refused with the broken rule
  named, and the prompt never appears. The one declared
  way out is a first line `discussion: <what is being settled, and why it opens
  no task>` — for plan-mode use that only thinks a question through and starts
  no work; it passes untouched and records nothing. A bare `discussion: true`,
  a reason too short to name anything, or a plan mixing `discussion:` with real
  steps is refused. These are the same rules `todos apply`/`todos lint` run, so
  the wording never drifts between the three.
- **PostToolUse on ExitPlanMode** (`cli.mjs plan-hook exit`) — **records an
  approved plan itself; there is no manual step to run.** It reads the plan
  text and the harness's approved/rejected verdict off the tool payload, runs
  `applyDocument` (the same engine behind `todos apply <plan>.yaml --go`), and
  reports back which tasks were created/matched. A plan the user turned down
  records nothing. It also runs the deterministic **match-plan** step: if
  `matchPlanCli` in the tracker's settings.json names a kb-style CLI, the plan
  text goes through `match-plan --json` and any case-warnings are injected
  (and asked to be persisted as a comment) — zero warnings stay silent, and a
  matcher failure never blocks the recording. **Currently broken and silent**:
  this branch reads the plan from `tool_input.plan`, which the harness leaves
  empty (recording works because it reads `tool_response` instead), so the
  warnings never arrive and their absence is indistinguishable from "nothing to
  say" — t#271. Do not read a quiet plan mode as a clean one.

`todos apply <plan>.yaml [--go]` and `todos lint [<change>] [--json]` are what
is **left over** for a plan the exit hook could not read as a document (prose,
or a plan written outside plan mode) — that instruction is the fallback path,
not the normal one — and for checking the recorded graph afterward. Re-applying
the same file **updates** the graph instead of forking it: a step is matched to
its task by `task: <N>` first, by title otherwise (children of the change
first, then the rest of the project's board).

### Field roles — one line each (t#253 review, updated at t#345)

Four text fields, four roles; the same sentence never lives in two of them:

| Field | Role |
|---|---|
| `description` | WHAT & WHY of the change itself. A change root's description **is the change's DELTA** — what this round changes and why now, not a vision meant to outlive it (vision lives in the spec, `docs/specs/README.md` §1). |
| `plan` | HOW only: the STEPS/ORDER text, when a plan was recorded onto a single task instead of a change root; rewritten on re-plan. |
| `handoff` | The RESULT baton passed down the dep graph (what was produced; next move; gotchas). |
| `comments` | The journal: decisions, scope changes, gotchas along the way; append-only. |

The v2 load migration in `todos.rs` (`migrate_plan_roles`) heals data recorded
before this split: a `plan` that was just a phases-dir pointer is archived as a
comment; a ritual-recorded plan sitting on an empty description is split (intro
→ description, steps stay in `plan`).

Plan mode is NOT mandatory — a task created or taken without it works as before;
the declarations (`produces`/`verify`/…) and dep edges just don't get written
for free.

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
- **an expanded change draws as an accordion section**, not a plain node: a
  frame around its exclusive prerequisite subtree, the root as the section's
  header card on the left, its members laid out as an ordinary pipeline on the
  right — member→root edges are not drawn (the frame shows membership instead),
  edges crossing the section's border draw as usual. Click **`⊖`** on the root
  card to fold the whole section into one card showing `done/total`; click the
  folded badge to unfold again. A change nested inside another change is drawn
  as a plain node — only the outermost root gets the section treatment.
- with a node selected, the **"Component only"** toolbar button cuts the view to
  that task's connectivity component (works on both tabs).

See `tasks#ui` for the rest of the graph window (the Ref tab, search, hotkeys).
