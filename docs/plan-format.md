# Plan graph format

Write recordable YAML: one step is one task and one work session. Omitted
runner-owned fields are inferred; explicit values win.

## 1. Field legend

Document fields:

`change` — creates or selects the change root; declare when the plan opens new tasks.
`vision` — WHAT & WHY in 2–5 labelled blocks; declare when creating or revising a change.
`out` — durable non-goals (`what`, `why`, optional `ref`); declare decided exclusions.
`measure` — measures (`what`, `how`, optional `target`, `actual`, `ok`, `note`); declare observable outcomes.
`parallel` — maximum simultaneous steps; declare only a justified group limit.
`budget` — group spend ceiling; declare only a justified group limit.
`steps` — graph nodes; declare whenever the plan records work.

Step fields:

`title` — new task subject, verbatim; declare for a new task.
`task` — binds an existing task (`N`, `#N`, `t#N`, or uuid); use instead of `title` when continuing it.
`needs` — blocking edges; declare only blockers, not preferred order.
`produces` — files, interfaces, or records reconciled after work; declare durable outputs.
`verify` — exit-code authority; declare when a command can judge success.
`retry` — attempt limit; omit for runner default `2`, or declare only when `why` explains the exception.
`on-issue` — corrective target; declare only a decided target (omitted `retry` still becomes `2`).
`kind` — closing authority; omit for `auto` with `verify`, otherwise `manual`; an explicit value wins.
`size` — required for a new `auto` step: S = point edit, M = multi-file feature, L = connected rework with tests and a document.
`budget` — exceptional node spend ceiling; declare only with the reason in `why`, otherwise history translates `size` into dollars.
`red` — command that must fail on the base state; include the regression-test path in the command.
`red-tests` — regression-test paths protected during the red gate; omit to extract them from `red`, or declare explicitly.
`flow` — method delta for configured source (`file`, `method`, `params`, `change`, `preserve`), or `n/a <reason>`; `nth` in `change` selects the 1-based anchor occurrence.
`risk` — exceptional routing; declare only `high` or `sensitive`.

`why` is the task's durable reasoning: what the step rests on and where its risk
is. The guard's refusal explains invalid `out` and `measure` items.

## 2. Graph skeleton

```yaml
change: "CHANGE: webhook delivery is observable"
vision: Delivery failures leave durable evidence for operators.
steps:
  1:
    title: Delivery state is recorded
    why: Receipt must leave evidence for both downstream branches.
    size: S
    produces: [src/delivery-state.ts]
    verify: npm run test:delivery-state
  2:
    title: Operators accept dashboard thresholds
    why: Threshold usefulness needs human judgement.
    needs: [1]
  3:
    task: 318
    why: The existing runbook task joins recorded state and accepted thresholds.
    needs: [1, 2]
    produces: [docs/delivery-runbook.md]
    verify: npm run docs:check
```

Bug-fix gate (the test path in `red` makes `red-tests` inferable):

```yaml
change: "CHANGE: duplicate webhook regression"
steps:
  fix:
    title: Duplicate delivery has a regression test
    why: The command isolates the new regression file on the old implementation.
    size: S
    produces: [test/webhook-duplicate.test.mjs]
    verify: npx vitest run test/webhook-duplicate.test.mjs
    red: npx vitest run test/webhook-duplicate.test.mjs
```

## 3. Recording and refusals

The ExitPlanMode hook records an approved plan. Fallback only when the hook says
it could not read the plan:

```
<cli> todos apply <plan>.yaml
<cli> todos apply <plan>.yaml --go
<cli> todos lint [<change>] [--json]
```

`apply` prints every inferred value as `выведено` and writes that value to the
board. Re-applying explicit old graphs leaves their declarations explicit.
An automatic step explicitly declared without `verify` remains a gate.

For a plan that settles a question and records no work, start with:

```
discussion: <what is being settled, and why it opens no task>
```

Open [`plan-format-issues.md`](plan-format-issues.md) only when a step parks.
Open [`plan-format-cutting.md`](plan-format-cutting.md) only when a plan or step
must be split.
