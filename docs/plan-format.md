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
parallel: <N>             # steps of the group the runner may drive at once
budget: <usd>             # the group's ceiling
steps:
  <n>:
    title: <the step phrase — first person, becomes the task subject VERBATIM>
    task: <N>             # this step IS task #N, already on the board
    why: |                # what this step rests on, and where its risk is
      <...>
    needs: [<n>, <n>]     # REAL blockers only: the step cannot start before them
    produces: [<path|interface|record>]
    verify: <cmd>         # exit 0 = ok, non-zero = issue
    retry: <M>            # attempts before the node parks in review
    on-issue: <n>         # where control goes on `issue` — run layer, not an edge
    kind: auto|manual     # manual = only a human closes it; auto needs a verify
    budget: <usd>
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
step; an invalid number or an unknown `kind`.

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
target that is also in `needs` (legal — only the dependency blocks).

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

A task that already carries a description keeps it too — the file's `why` is
**not** written over it, and `apply` says so in its notes. That is the usual
case for a step bound by `task: <N>` to older work: if the plan's reasoning is
the one that should stand, re-apply with `--force`, otherwise the step runs on a
description written for a different question.

## 4. Worked example

```yaml
change: "CHANGE: приём вебхуков без потери событий"
vision: |
  Должен появиться разбор входящих вебхуков, который не теряет события при
  падении обработчика: приём отделён от обработки очередью, а повтор идёт по
  лимиту, а не бесконечно. Решили не брать внешнюю очередь — таблица в той же
  базе дешевле в эксплуатации и достаточна на нашем объёме.
parallel: 2
budget: 25
steps:
  1:
    title: Завожу таблицу событий и приём вебхука, который только пишет в неё
    why: |
      Приём обязан отвечать быстро и не зависеть от обработчика: пока запись в
      таблицу — единственное, что он делает, падение обработчика не теряет
      событие. Схему беру из формата вебхука, ключ идемпотентности — оттуда же.
    produces: [migrations/007_events.sql, src/webhook/receive.ts]
    verify: npm run test:webhook
    kind: auto
  2:
    title: Пишу обработчик очереди с идемпотентностью по ключу события
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
    title: "Прикручиваю метрики: длина очереди, возраст самого старого события"
    why: |
      Без возраста самого старого события отставание видно только постфактум.
      Метрики не зависят от нагрузочного сценария, поэтому идут параллельно ему.
    needs: [2]
    produces: [src/queue/metrics.ts]
    verify: npm run test:metrics
    kind: auto
  4:
    title: Прогоняю нагрузочный сценарий на 10к событий и смотрю отставание
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
    title: Смотрю глазами дашборд и решаю, годятся ли пороги алертов
    why: |
      Порог — суждение о том, что считать бедой, и никакой exit-код его не
      выносит. Поэтому шаг ручной и стоит гейтом перед документированием.
    needs: [3, 4]
    kind: manual
  6:
    title: "Пишу runbook: что делать, когда очередь встала"
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
