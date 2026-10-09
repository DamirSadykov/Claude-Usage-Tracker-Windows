# Plan format — when a runner step does not converge

Open this supplement when the runner parks a step. The base graph language is
in [`plan-format.md`](plan-format.md); guidance for splitting work is in
[`plan-format-cutting.md`](plan-format-cutting.md).

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
and promises several separable outputs is warned as **«резать»**: follow
[`plan-format-cutting.md`](plan-format-cutting.md) to split a mechanical move
from the behaviour change, or split by `produces`, so a failed attempt has a
small, reviewable surface.
