// `cli.mjs triage` — publish/read the nightly-triage DIGEST without hand-editing
// the file. Lazily loaded by ../cli.mjs. The nightly triage agent (a scheduled
// Claude session, see task #35) reads the board read-only via `todos list --json`,
// reasons about it, and writes its findings here with `triage publish`. The
// tracker watches the resulting `triage-digest.json` and raises a desktop
// notification + an in-app summary (later phases).
//
// Why a separate file + CLI (not todos.json): the digest is DERIVED, regenerated
// each run, and strictly advisory — it must never touch the user's board (the
// triage agent is read-only over todos by design). Keeping it in its own file
// means a bad/partial digest can't corrupt the shared todo list, and the writer
// path is one validated, atomic temp+rename — mirroring todos.mjs / todos.rs.
//
// Commands (run as `cli.mjs triage <cmd>`):
//   publish [--file <path>] [--json <inline>]   write the digest (else read stdin)
//   show [--json]                               print the current digest
//   clear                                       remove the digest file
//
// The on-disk shape (snake_case, matching the rest of the app's wire format),
// mirrored by src-tauri/src/triage.rs::TriageDigest:
//   {
//     "version": 1,
//     "generated_at": "<ISO-8601>",      // stamped by publish if absent
//     "project": "<basename>" | null,    // which board this triage covered
//     "headline": "<short line>",        // <=140 chars, for the notification
//     "summary": "<prose>",              // human digest, for the in-app card
//     "items": [                         // findings + suggestions
//       { "kind": "stale|overdue|no_priority|suggestion",
//         "number": <int>|null, "id": "<uuid>"|null,
//         "subject": "<str>", "note": "<str>" }
//     ]
//   }
//
// Exit code is non-zero on any error (bad JSON, bad shape, usage), so the caller
// (and the triage prompt) can tell success from failure.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

// Finding kinds the digest understands. Keep in lockstep with triage.rs::KINDS
// and the in-app digest view. `stale`/`overdue`/`no_priority` are facts the agent
// surfaces; `suggestion` is an advisory move it proposes (never applied here).
const KINDS = ["stale", "overdue", "no_priority", "suggestion"];

// Same app data dir the tracker, todos CLI, and hook use; the digest lives next
// to todos.json so the tracker finds it without extra config.
function digestPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(
    appData,
    "com.claude-usage-tracker.app",
    "triage-digest.json",
  );
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Atomic write: serialize to a sibling temp file, then rename over the target
// (rename replaces the destination on Windows). 2-space pretty-print matches the
// tracker's serde output so the file stays hand-readable.
function save(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

// Forgiving read: a missing/corrupt file yields null (no digest yet), mirroring
// the read-side contract in triage.rs::load. `show` turns that into a friendly
// note; the tracker treats it as "nothing to surface".
function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// Minimal `--flag value` parser (same shape as todos.mjs): positional args plus
// flag pairs; a flag with no following value becomes `true`.
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = true;
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const PUBLISH_USAGE =
  "usage: cli triage publish [--file <path>] [--json <inline>]\n" +
  "       (with neither flag, the digest JSON is read from stdin)";

// Read the raw digest JSON the caller is publishing: --file <path>, --json
// <inline>, or stdin (fd 0). Exactly one source; --file wins over --json.
function readInput(flags) {
  if (typeof flags.file === "string") {
    try {
      return readFileSync(flags.file, "utf8");
    } catch (e) {
      fail(`cannot read --file ${flags.file}: ${(e && e.message) || e}`);
    }
  }
  if (typeof flags.json === "string") return flags.json;
  try {
    return readFileSync(0, "utf8");
  } catch {
    fail(PUBLISH_USAGE);
  }
}

// Validate + normalize the incoming digest, then write it atomically. Unlike the
// forgiving read side, publish is STRICT: a malformed digest is rejected (exit 1)
// rather than written, so the tracker never has to defend against junk and the
// triage prompt gets a clear failure it can retry. Stamps version=1 and, if the
// caller didn't supply one, generated_at=now.
function cmdPublish(args) {
  const { flags } = parseArgs(args);
  const raw = readInput(flags);

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    fail(`digest is not valid JSON: ${(e && e.message) || e}`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("digest must be a JSON object");
  }

  // Optional scalar fields — present → must be the right type.
  for (const key of ["headline", "summary"]) {
    if (input[key] != null && typeof input[key] !== "string") {
      fail(`"${key}" must be a string`);
    }
  }
  if (
    input.project != null &&
    typeof input.project !== "string"
  ) {
    fail('"project" must be a string or null');
  }
  if (
    input.generated_at != null &&
    typeof input.generated_at !== "string"
  ) {
    fail('"generated_at" must be an ISO-8601 string');
  }

  // Items: an array of findings. Each needs a known kind and a non-empty subject;
  // number/id/note are optional but type-checked when present.
  const rawItems = input.items == null ? [] : input.items;
  if (!Array.isArray(rawItems)) fail('"items" must be an array');
  const items = rawItems.map((it, i) => {
    if (!it || typeof it !== "object" || Array.isArray(it))
      fail(`items[${i}] must be an object`);
    if (!KINDS.includes(it.kind))
      fail(`items[${i}].kind must be one of: ${KINDS.join(" | ")}`);
    if (typeof it.subject !== "string" || !it.subject.trim())
      fail(`items[${i}].subject must be a non-empty string`);
    if (it.number != null && !Number.isInteger(it.number))
      fail(`items[${i}].number must be an integer`);
    if (it.id != null && typeof it.id !== "string")
      fail(`items[${i}].id must be a string`);
    if (it.note != null && typeof it.note !== "string")
      fail(`items[${i}].note must be a string`);
    return {
      kind: it.kind,
      number: it.number == null ? null : it.number,
      id: it.id == null ? null : it.id,
      subject: it.subject,
      note: typeof it.note === "string" ? it.note : "",
    };
  });

  const digest = {
    version: 1,
    generated_at:
      typeof input.generated_at === "string"
        ? input.generated_at
        : new Date().toISOString(),
    project: typeof input.project === "string" ? input.project : null,
    headline: typeof input.headline === "string" ? input.headline : "",
    summary: typeof input.summary === "string" ? input.summary : "",
    items,
  };

  const file = digestPath();
  save(file, digest);
  process.stdout.write(
    `ok: published digest (${items.length} item(s)) -> ${file}\n`,
  );
}

function cmdShow(args) {
  const file = digestPath();
  const digest = load(file);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    return;
  }
  if (!digest) {
    process.stdout.write("(no triage digest yet)\n");
    return;
  }
  process.stdout.write(`generated_at: ${digest.generated_at || "?"}\n`);
  if (digest.project) process.stdout.write(`project: ${digest.project}\n`);
  if (digest.headline) process.stdout.write(`headline: ${digest.headline}\n`);
  if (digest.summary) process.stdout.write(`\n${digest.summary}\n`);
  const items = Array.isArray(digest.items) ? digest.items : [];
  if (items.length) {
    process.stdout.write("\nitems:\n");
    for (const it of items) {
      const num = it.number != null ? `#${it.number} ` : "";
      // Subject on its own line, the note (the advice) indented below with an
      // arrow — keeps "which task" and "what to do" visually separate, mirroring
      // the in-app digest popover.
      process.stdout.write(`  [${it.kind}] ${num}${it.subject || ""}\n`);
      if (it.note) process.stdout.write(`        → ${it.note}\n`);
    }
  }
}

function cmdClear() {
  const file = digestPath();
  try {
    unlinkSync(file);
    process.stdout.write(`ok: removed ${file}\n`);
  } catch {
    // Already absent → nothing to do; clearing is idempotent.
    process.stdout.write("ok: no digest to remove\n");
  }
}

function usage(code) {
  process.stdout.write(
    "cli triage - Claude Usage Tracker nightly-triage digest\n\n" +
      "  publish [--file <path>] [--json <inline>]   write the digest (else stdin)\n" +
      "  show [--json]                               print the current digest\n" +
      "  clear                                       remove the digest file\n",
  );
  process.exit(code);
}

// Entry for the unified dispatcher: `cli.mjs triage <cmd> …` → run([...]).
export function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "publish":
      cmdPublish(rest);
      break;
    case "show":
      cmdShow(rest);
      break;
    case "clear":
      cmdClear();
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage(0);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      usage(1);
  }
}
