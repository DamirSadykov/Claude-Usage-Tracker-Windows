# Differential oracle

`diff-oracle.mjs` runs the Rust port and the Python pilot on the same inputs, then
compares, for each method, its status and the set of problem strings. Rust-only
`extra`, coverage, and diagnostic fields are intentionally not compared.

Run it from the repository root:

```powershell
$env:FLOWCHECK_PILOT = 'C:\path\to\pilot'
node tools/flowcheck/diff-oracle.mjs
```

The pilot directory holds `flowcheck.py`, `spec-phone.yaml`, and a
`gv\Scripts\python.exe` virtual environment; override the interpreter with
`--python` or `FLOWCHECK_PYTHON`. The script builds `tools/flowcheck` once,
then creates disposable git repositories for every `Notifier.*.cs` teaching head
in `tools/flowcheck/tests/fixture`. The teaching corpus has 18 source fixtures:
16 executable heads plus `Notifier.base.cs` and `Contracts.cs`, which are shared
inputs rather than heads.

Live cases are opt-in because their commits belong to private repositories, not
to this one. Describe them in a JSON file outside the repository:

```json
[{ "label": "live/example", "spec": "spec-example.yaml", "base": "abc123^", "head": "abc123" }]
```

`spec` resolves against the pilot directory. Point the script at the file and at
a checkout that contains the commits:

```powershell
$env:FLOWCHECK_LIVE_REPO = 'C:\path\to\checkout'
$env:FLOWCHECK_LIVE_CASES = 'C:\path\to\live-cases.json'
node tools/flowcheck/diff-oracle.mjs
```

Or use `--live-repo`, `--live-cases`, `--pilot`, `--python`, or `--rust`. Without
both live settings the script still checks the teaching corpus and prints the
number of skipped live cases. A commit missing from the checkout is printed as
`SKIP`, rather than being mistaken for a passing comparison.

An exit code of 1 means the status or reason set differs. The report is evidence
for a human decision: a mismatch can be a Rust regression or a correction to the
Python reference; it is not automatically proof that the Rust behavior is wrong.
