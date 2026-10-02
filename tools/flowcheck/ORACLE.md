# Differential oracle

`diff-oracle.mjs` runs the Rust port and the Python pilot on the same inputs, then
compares, for each method, its status and the set of problem strings. Rust-only
`extra`, coverage, and diagnostic fields are intentionally not compared.

Run it from the repository root:

```powershell
node tools/flowcheck/diff-oracle.mjs
```

By default the script uses the pilot at `D:\projects\_temp\flow-pilot` and its
`gv\Scripts\python.exe` virtual environment. It builds `tools/flowcheck` once,
then creates disposable git repositories for every `Notifier.*.cs` teaching head
in `tools/flowcheck/tests/fixture`. The teaching corpus has 18 source fixtures:
16 executable heads plus `Notifier.base.cs` and `Contracts.cs`, which are shared
inputs rather than heads.

The live cases are opt-in because their commits belong to a private product
repository, not to this one. Point the script at a checkout that contains
`0c9d89648b` and `d3dffd872a`:

```powershell
$env:FLOWCHECK_LIVE_REPO = 'D:\path	o\checkout'
node tools/flowcheck/diff-oracle.mjs
```

Or use `--live-repo`, `--pilot`, `--python`, or `--rust` to override individual
paths. Without `FLOWCHECK_LIVE_REPO`, the script still checks the teaching corpus
and prints the number of skipped live cases. A commit missing from the checkout is
printed as `SKIP`, rather than being mistaken for a passing comparison.

An exit code of 1 means the status or reason set differs. The report is evidence
for a human decision: a mismatch can be a Rust regression or a correction to the
Python reference; it is not automatically proof that the Rust behavior is wrong.
