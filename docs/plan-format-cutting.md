# Plan format — cutting the plan and its steps

Open this supplement when the linter warns that a step is large or when the
runner decision card offers to split the work. The base graph language is in
[`plan-format.md`](plan-format.md).

## 6. Cutting the plan

**Build a graph or not.** Build one when the work does not fit one session, has
more than three steps, or has parts that can run in parallel. Work that fits one
session is one step, not a plan of five; a one-node graph adds upkeep and nothing
else.

**One step = one session of work.** A step that needs two arrives in the next
session half-done, and its state has to be rebuilt from scraps. Too large: more
than one `produces` with no shared edit between them. Too small: its `verify` is
the same as its neighbour's.

**Edges are real blockers only.** `needs` is the only place order lives, and
parallelism is the absence of an edge. Add an edge only when the step cannot
start without a file, interface or decision the other step produces. The test:
remove the edge in your head and ask what breaks at the moment of start. "Nothing,
the order just reads oddly" means the edge is false. `parallel: <N>` on the change
caps concurrency; it does not declare it.

**A step is the executor's assignment.** `produces` is the list of files the
executor edits; two steps sharing a path must not run at once — add an edge or
make one step (`apply` warns, the runner never puts them in one wave). `verify`
is what the executor must pass before handing over; a command that is already
green before the work proves nothing. `why` is the failure the step exists to
prevent, and it goes into the executor's brief verbatim. A step that cannot be
stated in these three fields is a topic, not work — rewrite it before the run.

**Registry files** (CLI command registration, `generate_handler` in `lib.rs`,
`bundle.resources` in `tauri.conf.json`) are touched by almost every step: declare
them in `produces` of the step that needs them, and put a new module and its first
import in the same step — `resources.test.mjs` treats a bundled module nothing
imports as stale.
