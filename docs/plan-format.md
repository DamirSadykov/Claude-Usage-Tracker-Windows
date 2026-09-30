# Plan format — the plan IS the graph file

A guide for **Claude Code sessions** in plan mode. The plan-mode hooks
(`cli.mjs plan-hook enter|prompt|exit`) point here instead of repeating the
format in every injection: read this file once per session, not once per plan.

A plan here is not a report for the user. It is recorded in the task tracker and
read by the sessions that come after — including headless runs, which have no
conversation to fall back on. So the plan is **written as the file the tracker
records**: YAML, one step per task. There is no prose version to be translated
afterwards, and nothing is decided twice.

Prose does not disappear — it moves inside. `vision` carries what should exist
and why; each step's `why` carries what that step rests on and where its risk
is. Those are the parts a later session cannot reconstruct, so they are fields,
not commentary.

**§4 is a complete example.** If you read one section, read that one.

## 1. The shape

```yaml
change: "CHANGE: <name>"  # the delta this plan makes to a spec; without it steps land rootless
vision: |                 # WHAT & WHY — the paragraph that opens a plan
  <...>
out:                      # durable decisions not to do: every item has what: and why:
  - what: <excluded scope>
    why: <reason it is excluded>
    ref: <c#N|t#N|KB path> # optional: decision or evidence this exclusion rests on
measure:                  # user-facing measures: every item has what: and how:
  - what: <exact thing being measured, not an assessment of the whole change>
    how: <how it is measured>
    target: <desired result> # optional
    actual: <observed result> # optional; useful when a plan continues a change
parallel: <N>             # steps of the group the runner may drive at once
budget: <usd>             # the group's ceiling
steps:
  <n>:
    title: <third-person statement about the system or impersonal action, without «я»; becomes the task subject VERBATIM>
    task: <N>             # this step IS task #N, already on the board
    why: |                # what this step rests on, and where its risk is
      <...>
    needs: [<n>, <n>]     # REAL blockers only: the step cannot start before them
    produces: [<path|interface|record>]
    verify: <cmd>         # exit 0 = ok, non-zero = issue
    retry: <M>            # critical/high review repeats before the node parks
    on-issue: <n>         # where a repeatable critical/high review issue goes
    kind: auto|manual     # manual = only a human closes it; auto needs a verify
    budget: <usd>
    red: <cmd>            # bug-fix gate: MUST fail on the base commit — proves red-tests catches it
    red-tests: [<path>]   # the regression test file(s) red is proved against; needs red, and vice versa
    risk: high            # routes worker/review to agents.json's routes.high, when configured — the only value accepted
```

Rules that are not visible in the shape:

- **One step = one session of work.** A step that needs two reaches the next
  session half-done; a plan that fits one session is one step (see §3).
- **Continuing existing work? Say which task.** `task: 318` (also `#318`, `t#318`
  or a uuid) binds the step to the task already on the board — its declarations
  land there instead of on a new row. With it, `title` is optional, and a title
  that disagrees with the board does not rename the task.
- **`needs` is the only place order lives.** Parallelism is the absence of an
  edge — two steps with the same `needs` run side by side. An edge added because
  the sequence reads nicely is a false edge, and parallel work stops looking
  parallel.
- **Declare only what the plan decides.** An absent field means *not declared*:
  never a default the runner fills in, never a value copied from a neighbour.
- **`vision` is written in meaning blocks, not one solid paragraph.** It is
  the «Зачем» of the change card. Use 2–5 short paragraphs separated by a
  blank line, each opening with a bold label: `**Задача.**` what is wrong and
  what should exist; `**Модель.**` or `**Решение.**` how it works;
  `**Хранение.**` where the data lives; `**Пример.**` on a concrete task;
  `**Риск.**`. Formulas, paths and identifiers go in backticks, parameter
  lists go in a markdown list.
- **`out` records a decision not to do something.** Every item has a non-empty
  `what` and `why`; `ref` is optional and points at the change/task or KB
  decision that explains it. Do not leave an exclusion only in `vision`:
  `out` is the durable, scannable record.
- **`measure` is the user's measuring guide, not an acceptance gate.** Every
  item has a non-empty `what` and `how`; `target` and `actual` are optional.
  Its `what` names exactly the thing measured, no wider than what the
  measurement covers: write «геометрия строк trace», not «соответствие дизайну». The
  latter reads as an assessment of the entire change. A missing `actual` never
  blocks closing a change; final acceptance remains the user's decision.
- `retry: 2` and `retry: <=2` are the same value, as are `budget: 3` and
  `budget: $3`.
- A `#` comment must be on its own line — a `#` inside a value belongs to the
  value, so `t#299` survives.

## 2. What the guard refuses

The plan is checked **before** it reaches the user, so what they approve is
already a valid graph. The refusal names the rule, and the same rules run again
on `apply` and on the board (`todos lint`) — one wording everywhere.

Refused: an `on-issue` with no `retry` (a missing limit forbids the transition,
it does not permit an endless one); a cycle in `needs`; a `needs` or `on-issue`
pointing at a step that does not exist; a step with neither a `title` nor a
`task`; a `task` naming no task on the board, or one already bound to an earlier
step; an invalid number or an unknown `kind`; `red` declared without
`red-tests`, or `red-tests` declared without `red` — the gate needs both halves
or neither; a `risk` other than `high`; an `out` item that is not a mapping or
has no `what` or `why`; a `measure` item that is not a mapping or has no `what`
or `how`.

**Prose is refused too.** The language is required of every plan, not only of
the texts that already look like one — a rule the guard declines to check is a
rule kept by asking, and asking is what this whole format replaced. A text
holding several readings (this document quoted above a real plan) still passes
as soon as ONE of them is a valid graph.

### Not starting work? Declare it

Plan mode is also used to settle a question — "here is how I read this, is that
right?" — and such a plan opens no task. It says so on its own line at the
start, and passes untouched:

```
discussion: разбираю, почему повтор вебхука доходит дважды; чиню
  или нет — решаем после, задач этот план не заводит

## Что я вижу
...
```

Nothing is recorded for it: no task is created, none moves — so a plan that
declares a discussion **and** writes steps is refused as well. The two are
different plans, and the declaration wins, which would drop the steps in
silence. The reason is **required** — `discussion: true` is refused, and so is a
label too short to name anything. An exit that costs one word is the exit from every plan; a
sentence about what is being settled is worth writing only when there is
something to settle. Declare it only when it is true: a plan that ends in work
is a graph file, whatever it is called.

Warned but accepted: `auto` with no `verify` (it runs as a gate — the authority
to close a node comes from the check, not the flag); a change with no `budget`
(`todos run --go` refuses to start a group without a ceiling); an `on-issue`
target that is also in `needs` (legal — only the dependency blocks); a
`red-tests` path not also named in `produces`; `red` declared on a `manual`
step (a gate never runs it — nothing closes the node to trigger one).

Which steps are `auto`: the ones a machine can judge, and they carry a `verify`.
A step whose result only a human can accept — a design call, anything to look at
— stays `manual` and becomes a gate where the run stops and waits. Gates are
worth putting where you would want to look anyway, not everywhere.

## 3. Recording it

**An approved plan records itself.** The exit hook takes the plan text, applies
it, and reports the task numbers back — you do not save a file and you do not
run a command. A plan the user turned down records nothing.

The commands are what is left for a plan the hook could not read (prose, or a
plan written outside plan mode), and for checking the graph later:

```
<cli> todos apply <plan>.yaml         # checks it, prints what would change
<cli> todos apply <plan>.yaml --go    # records it
<cli> todos lint [<change>] [--json]  # the same rules over the recorded graph
```

Re-applying the same file **updates** the graph instead of forking it. A step
finds its task by `task: <N>` when it has one, and by its `title` otherwise —
so a reworded title without a binding creates a NEW task rather than renaming
the old one. The search covers the change's members first and the rest of the
project's board after, and a task found outside the change is adopted into it.

**A one-step plan is a file too** — one step, usually bound to the task you are
already working on:

```yaml
steps:
  1:
    task: 318
    why: |
      Провайдер шлёт повтор через 30 секунд, а мы к этому моменту ещё держим
      транзакцию — отсюда дубль. Чиню в приёме, не в обработчике.
    produces: [src/webhook/receive.ts]
    verify: npm run test:webhook
    kind: auto
```

A step already `done` keeps its declarations: they are promises made before the
work, and re-applying a partly finished plan leaves them alone rather than
failing.

What happens to an existing description depends on the task's own status. On
`backlog` or `queue` — nothing downstream has started yet — a `why` that
disagrees with the description **replaces** it, and the old text is not lost:
it is filed as a comment on the task (`Описание до плана «…»:` followed by the
old text), so a step bound by `task: <N>` to a stale plan does not silently run
on reasoning written for a different question, and nothing that was there
before is thrown away either. Once a task is `in_progress` or in `review`, its
description has become the record of what the work was actually understood to
be while it ran, and `apply` leaves it alone, saying so in its notes; `--force`
overwrites in either case, without filing a comment.

## 4. Worked example

The current project example is
[`docs/plans/c70-change-brief-adr.yaml`](plans/c70-change-brief-adr.yaml): it
uses `out` for the change's explicit non-goals and `measure` for its user-facing
measures. The compact graph below shows the same fields in a different domain,
including an optional `ref` and measurable, bounded `what` values.

```yaml
change: "CHANGE: приём вебхуков без потери событий"
vision: |
  **Задача.** Входящие вебхуки теряются, когда падает обработчик: приём и
  обработка идут одним вызовом.

  **Решение.** Приём только пишет событие в таблицу `events` и отвечает;
  обработку ведёт очередь, повтор — по лимиту, а не бесконечно.

  **Риск.** Гонка двух воркеров на одном событии — обработчик идемпотентен по
  ключу события.
out:
  - what: Внешняя очередь сообщений
    why: Таблица в той же базе дешевле в эксплуатации и достаточна на нашем объёме.
    ref: docs/decisions/queue-storage.md
measure:
  - what: Возраст старейшего события в очереди
    how: Нагрузочный сценарий на 10к событий читает метрику после пика.
    target: не больше пяти минут
  - what: Доля принятых событий, которые дошли до обработчика
    how: Сопоставить число принятых и обработанных id в отчёте сценария.
    target: 100%
parallel: 2
budget: 25
steps:
  1:
    title: Таблица событий и приём вебхука сохраняют событие до обработки
    why: |
      Приём обязан отвечать быстро и не зависеть от обработчика: пока запись в
      таблицу — единственное, что он делает, падение обработчика не теряет
      событие. Схему беру из формата вебхука, ключ идемпотентности — оттуда же.
    produces: [migrations/007_events.sql, src/webhook/receive.ts]
    verify: npm run test:webhook
    kind: auto
  2:
    title: Обработчик очереди обеспечивает идемпотентность по ключу события
    why: |
      Повторная доставка от провайдера — норма, поэтому обработчик обязан быть
      идемпотентным по ключу, а не «обычно не дублирует». Риск здесь: гонка двух
      воркеров на одном событии, её и проверяю тестом.
    needs: [1]
    produces: [src/queue/worker.ts]
    verify: npm run test:queue
    retry: 3
    budget: 4
    kind: auto
  3:
    title: "Метрики очереди показывают длину и возраст старейшего события"
    why: |
      Без возраста самого старого события отставание видно только постфактум.
      Метрики не зависят от нагрузочного сценария, поэтому идут параллельно ему.
    needs: [2]
    produces: [src/queue/metrics.ts]
    verify: npm run test:metrics
    kind: auto
  4:
    title: Нагрузочный сценарий на 10к событий измеряет отставание
    why: |
      10к — верхняя оценка суточного пика с запасом вдвое. Если пропускной
      способности не хватит, чинить надо обработчик, а не сценарий — отсюда
      возврат на шаг 2.
    needs: [2]
    produces: [docs/load-report.md]
    verify: npm run test:load
    retry: 2
    on-issue: 2
    kind: auto
  5:
    title: Дашборд и пороги алертов проходят ручную оценку
    why: |
      Порог — суждение о том, что считать бедой, и никакой exit-код его не
      выносит. Поэтому шаг ручной и стоит гейтом перед документированием.
    needs: [3, 4]
    kind: manual
  6:
    title: "Runbook описывает действия при остановке очереди"
    why: |
      Пишется последним намеренно: пока пороги не выбраны, инструкция дежурному
      будет про воображаемую систему.
    needs: [5]
    produces: [docs/runbook-queue.md]
    kind: manual
```

What to read off it:

- **Steps 3 and 4 have no edge between them** — both hang off 2 and run in
  parallel, up to `parallel: 2`. The absence of an arrow is the declaration.
- **Step 4 loops back to 2**, twice at most: if throughput is not there, the
  thing to fix is the worker. Its target is also in `needs` — legal, and only
  the dependency blocks.
- **Step 5 is a gate**: no exit code settles a judgement about thresholds, so it
  carries no `verify` and stays `manual`; the run stops there and waits.
- **Step 6 promises a document and has no check** — `manual` again. A promise
  without a check is fine; an `auto` without one is a gate in disguise.
- **`budget: 25`** on the change is the group's ceiling, `budget: 4` on step 2 is
  that node's own. Reaching either stops the run on a step boundary and rolls
  nothing back.

## 5. When a runner step does not converge

`retry` is a small, deliberate allowance to correct a confirmed review defect;
it is not a request to keep trying until somebody intervenes. The reviewer assigns
every finding one level:

- **critical** — the project does not build, data is lost or corrupted, or the
  function is unavailable;
- **high** — the step's declared obligation is not met or there is a visible
  regression;
- **medium** — the goal is only partly met or a boundary case is wrong;
- **low** — style, a small detail, or wording.

`critical` and `high` require evidence: a `file:line` and a scenario. Without
that evidence the finding is `medium`. Only critical/high findings justify a
new executor attempt. Medium/low findings do not block the node: the runner
records them for the architect, who decides for each one whether to fix it,
put it in the next step's handoff, create a backlog task, or reject it. A
high finding about a declared boundary between steps may likewise be removed
by the architect after checking the plan.

The runner first classifies why it cannot proceed. A failed `verify` is an
ordinary retry: the executor gets the output tail. It becomes mechanical only
when `verify` fails with the same output tail on two consecutive attempts after
a review with no critical/high findings; then it goes to the architect and that
attempt consumes no executor retry. Review findings follow the levels above. It parks immediately with
**«резать шаг или менять подход»** when one attempt contains three or more
critical/high findings, or when attempt 3 or later introduces new
critical/high findings: continuing to repair one defect while creating another
is not convergence. It also parks with **«порог денег»** when the attempt
journal shows more than 60% of the node's budget spent without convergence.
The parking record names the route and reason, rather than merely saying that
the retry limit ended.

Each attempt appends to that journal: number, cost, findings by level, closed
findings to recheck next time, and the SHA of its checkpoint. The checkpoint is
the existing `snapshotTree` commit-tree snapshot, not a branch, tag, or remote
ref; it is unreachable from refs and therefore cannot be pushed. Before a
repeat, the reviewer checks previously closed findings first. If a later
attempt has more critical/high findings than the best one, or regresses a
previously clean place, the runner restores the best checkpoint instead of
building on the worse tree. If Git has already pruned that checkpoint, no
unsafe partial rollback is attempted: park it for the architect with
**«контрольная точка потеряна»**.

Plan before spending the first attempt. A step that edits a very large file
and promises several separable outputs is warned as **«резать»**: split a
mechanical move from the behaviour change, or split by `produces`, so a failed
attempt has a small, reviewable surface.

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
