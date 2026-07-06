# Corrections — integration guide

The tracker mines your Claude Code transcripts for **user corrections** — the
moments you had to stop, reject, or push back on the assistant — and turns them
into an outcome metric (`corrections-per-session`, `rework-after-done`). The
in-app card shows the built-in aggregate, but the same data is exposed through a
small CLI + a versioned JSON contract, so **you can build your own integration on
top of it**: a smarter classifier, a dashboard, an export, a nightly report — the
tracker just hands you clean, structured signals.

This page explains the CLI, the data it produces, and how to consume it. For the
exact JSON field-by-field schema, see
[corrections-contract.md](./corrections-contract.md).

> **Layer 1 only.** The detector here is a cheap, offline, high-recall heuristic:
> it flags *candidate* corrections. Deciding whether a candidate is a real
> correction (vs a refinement, a new task, an approval, a question) is a further
> **classification step this tool intentionally leaves to you** — that's the main
> thing an integration adds.

---

## The CLI

```
node scripts/cli.mjs corrections <command>
```

(installed builds ship the same tree; the CLI is bundled next to the app.)

| Command | What it does | Output |
|---|---|---|
| `scan [<session>] [--project <name>\|--all] [--json] [--candidates]` | Analyze transcripts and print per-session stats + candidate corrections | Human table, or the `corrections.scan` JSON contract with `--json` |
| `label-template <session> [--out <file>]` | Emit **every** real user turn of a session (with the detector's prediction + evidence) as a worksheet to hand-label | `corrections.labels` JSON |
| `eval --labels <file> [--json]` | Score the detector's precision/recall for the `correction` class against a filled worksheet | `corrections.eval` JSON |
| `publish [--project <name>\|--all]` | Compute the metric over a scope and write `corrections-metrics.json` (the file the app card reads) | writes the sink file |

Scope resolution (shared by `scan` / `publish`):
- **no flag** → the current working directory's project,
- `--project <name>` → the project whose transcript dir ends with `<name>`,
- `--all` → every project,
- an explicit `<session>` (id or path) → just that transcript.

Everything is **read-only** over `~/.claude/projects/**/*.jsonl`. The CLI never
writes to your todo board or your transcripts; the only file it writes is
`corrections-metrics.json` (via `publish`), atomically.

---

## How the detection works

For each transcript the CLI walks the JSONL entries in order and identifies:

1. **Real user turns** — a `type:"user"` entry with typed text, *excluding*
   tool-result carriers, the `[Request interrupted …]` marker, and injected
   blocks (`<system-reminder>`, slash-command wrappers, hook output).
2. **Assistant turns** — deduped by the model message id (one turn can span
   several JSONL lines: text, then tool calls).
3. **Signals** that a user turn is a correction candidate:
   - **Structural** (high precision): the turn immediately follows a **tool-use
     reject** (`tool_result` with `is_error`) or an **interrupt** marker — you
     stopped the assistant mid-action.
   - **Lexical** (high recall, noisy): the text opens with a negation
     (нет / не так / wrong …) or contains a corrective imperative
     (переделай / откати / fix this …).
4. **Done-claims** — assistant turns that assert completion (готово / done / ✓ …),
   used to compute `rework-after-done`.

Each candidate gets a **`fault_hint`**:
- `likely-llm` — had a structural signal → almost always the assistant's miss.
- `ambiguous` — only a lexical signal → could be *you* changing direction.

And an **`evidence`** block (the preceding assistant snippet + any rejected tool
names) so a downstream classifier can judge it without re-reading raw JSONL.

The two metrics:

```
corrections_per_session = candidate_corrections / assistant_turns
rework_after_done_rate  = corrections_right_after_a_done_claim / done_claims
```

Both are **candidate upper bounds** and are only comparable at a fixed task mix
(harder tasks → more corrections, not a worse assistant).

---

## Building your own integration

The whole point of the contract is that you don't have to touch this repo. A
typical integration reads the JSON, classifies the candidates, and does something
with the result.

### 1. Get the data

```bash
# per-session stats + candidates, as JSON, for the current project
node scripts/cli.mjs corrections scan --json > scan.json

# or the published aggregate the app also reads
node scripts/cli.mjs corrections publish --all
cat "$APPDATA/com.claude-usage-tracker.app/corrections-metrics.json"
```

### 2. Classify the candidates (the layer you add)

Each candidate carries everything a classifier needs:

```jsonc
{
  "key": "…session…#123",
  "text": "no, revert that — I wanted the old header",
  "reasons": ["post-reject"],
  "fault_hint": "likely-llm",
  "evidence": {
    "prev_assistant": "…what the assistant last did…",
    "rejected_tools": ["Edit"]
  }
}
```

Decide `correction | refinement | approval | new_task | question` however you
like — a rules pass, or an LLM call with the `text` + `evidence` as the prompt.
Count only `correction` for the true metric.

### 3. Validate before you trust it

Use the built-in holdout harness so your threshold isn't guesswork:

```bash
node scripts/cli.mjs corrections label-template <session> --out labels.json
#   … fill each "gold" by hand …
node scripts/cli.mjs corrections eval --labels labels.json
#   → precision / recall / f1 for the correction class
```

### Contract stability

Every `--json` payload carries `contract_version` (currently `1`). Pin it in your
consumer and fail on an unexpected major; additive fields won't bump it. Field
definitions live in [corrections-contract.md](./corrections-contract.md).

---

## Refresh & automation

`corrections-metrics.json` is only as fresh as the last `publish`. To keep the
card current, run `corrections publish` on a schedule (e.g. from the nightly
task-triage job) or after sessions of interest. The app reads the file on window
focus.
