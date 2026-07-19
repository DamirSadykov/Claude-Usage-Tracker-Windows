// `cli.mjs task-cost` — the ATTRIBUTION half of "tokens per task" (t#87).
//
// The tracker already knows what every SESSION cost (cc_usage in SQLite, keyed
// by session_id) and the board knows every task. What's missing is the bridge:
// WHICH task was a session working on? This module derives that bridge from the
// transcripts and publishes it as a sink file; the app joins it with the token
// aggregates (src-tauri/src/task_cost.rs) — the same split as the corrections
// metric (t#101): Node owns transcript parsing, Rust owns the SQLite join.
//
// Attribution signals, strongest first (the join in task_cost.rs consumes them
// in this order — deliberately conservative: tokens land on a task only when
// the evidence names exactly ONE, ambiguity is REPORTED, never smeared):
//   moves    — `set-status <ref> in_progress|review|done` the session itself
//              ran (same transcript-derived evidence as the Stop-hook guard,
//              #219). Moving a task into a worked status = worked on it.
//   touched  — `comment add <ref>` / `handoff [set] <ref>`: a session that
//              records findings or reads/writes a handoff worked the task too —
//              this is what a post-/clear continuation typically leaves behind
//              when it never re-runs set-status.
//   mentions — corroboration only, NEVER attributes by itself: task refs the
//              session named in USER text (`t#87` / `#87`; bare numbers are
//              too noisy) or in other tracker-CLI commands (set-priority,
//              dep/ref edges). The interval fallback in the join requires a
//              mention, so an unrelated same-project session that merely
//              overlaps a task's in_progress window no longer inherits its
//              cost. Hook/system injections (`<system-reminder>` blocks,
//              isMeta hook feedback, tool_result echoes of the board) are
//              excluded — otherwise every session "mentions" every task —
//              and so is assistant free text (an assistant summarising the
//              board would corroborate tasks the session never worked).
//
// Commands:
//   scan    [--project <name>|--all] [--json]   per-session moves, stdout only
//   publish [--project <name>|--all]            write task-attribution.json
//
// The sink lives next to todos.json; schema mirrored by src-tauri/src/task_cost.rs.

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── transcript location (mirrors corrections.mjs) ────────────────────────────
function claudeProjectsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (!home) return null;
  return path.join(home, ".claude", "projects");
}

// Claude Code replaces `:` `\` `/` `.` with `-` when naming the project dir.
function encodeCwd(cwd) {
  return String(cwd).replace(/[:\\/.]/g, "-");
}

function listProjectDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name));
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Scope resolution: default = current project, --project <name>, --all.
// Skips `agent-*.jsonl` (subagent transcripts run no set-status of their own
// worth attributing separately — their tokens roll up under the parent session).
function resolveTranscripts({ project, all }) {
  const root = claudeProjectsDir();
  if (!root || !existsSync(root)) fail(`no transcripts dir: ${root}`);
  let dirs;
  if (all) {
    dirs = listProjectDirs(root);
  } else if (project) {
    dirs = listProjectDirs(root).filter(
      (d) =>
        path.basename(d).endsWith(encodeCwd(project)) ||
        path.basename(d).endsWith(project),
    );
    if (!dirs.length) fail(`no project dir matching: ${project}`);
  } else {
    const here = path.join(root, encodeCwd(process.cwd()));
    if (!existsSync(here)) fail(`no transcripts for this project: ${here}`);
    dirs = [here];
  }
  const out = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
      out.push({
        session: f.replace(/\.jsonl$/, ""),
        file: path.join(dir, f),
        projectDir: path.basename(dir),
      });
    }
  }
  out.sort((a, b) => a.session.localeCompare(b.session));
  return out;
}

// ── the parser ────────────────────────────────────────────────────────────────
// A `set-status <ref> <status>` inside a command that really invokes the tracker
// CLI. Keep the pattern in lockstep with stop-hook.mjs::SET_STATUS_RE (not
// imported: pulling stop-hook would drag its settings/phases imports along).
const SET_STATUS_RE =
  /\bset-status\s+#?([\w-]+)\s+(backlog|queue|in_progress|review|done)\b/g;

// Statuses that mean the session WORKED the task. backlog/queue moves are
// triage — re-shelving someone else's work carries no cost worth attributing.
const WORKED = new Set(["in_progress", "review", "done"]);

// A ref as the CLI accepts it: a task number or an id (uuid-shaped, so it can't
// swallow subcommand words like `set` — those aren't hex). Tighter than
// SET_STATUS_RE's [\w-]+ because these patterns have no status keyword anchor.
const REF = "#?(\\d+|[0-9a-f][0-9a-f-]{5,})";

// touched: commands that mean the session WORKED the task without moving it —
// recorded a finding or read/wrote its handoff.
const TOUCH_RES = [
  new RegExp(`\\bcomment\\s+add\\s+${REF}\\b`, "g"),
  new RegExp(`\\bhandoff\\s+(?:set\\s+)?${REF}\\b`, "g"),
];

// mentions from CLI commands: the session at least NAMED the task. Triage-only
// verbs (priority, graph edges, comment list) — deliberately not `set-status
// backlog|queue` refs: re-shelving stays invisible, as for moves. Two capture
// slots because dep/ref commands name two tasks.
const CLI_MENTION_RES = [
  new RegExp(`\\bset-priority\\s+${REF}\\b`, "g"),
  new RegExp(`\\b(?:dep|ref)\\s+(?:add|rm|list)\\s+${REF}\\b(?:\\s+${REF}\\b)?`, "g"),
  new RegExp(`\\bcomment\\s+list\\s+${REF}\\b`, "g"),
];

// mentions from USER text: `t#87` (the board's own convention) and `#87`. Bare
// numbers are NOT matched — "вариант 2", line numbers and years would
// corroborate almost anything. `#N` does collide with GitHub PR numbers; the
// join tolerates that because a mention alone never attributes.
const TEXT_MENTION_RE = /(?:\bt)?#(\d{1,4})\b/g;

// Cheap line prefilter: user entries (text mentions + failed tool_results) or
// any line that could contain a tracker verb. Everything else is skipped
// without a JSON.parse.
const LINE_PREFILTER =
  /"type":"user"|"is_error":true|set-status|set-priority|comment\s+add|comment\s+list|handoff|\b(?:dep|ref)\s+(?:add|rm|list)/;

const collect = (res, text, into) => {
  for (const re of res) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      for (const g of m.slice(1)) if (g) into.add(g);
    }
  }
};

// Pure parser over the raw JSONL transcript text — exported for the unit tests.
// Returns { moves, touched, mentions }:
//   moves    [{ ref, statuses: [..], first_ts, last_ts }] — worked set-status
//            runs; `ref` is the id or number the command named ('#' stripped;
//            resolution against the board happens in the Rust join, which owns
//            todos.json), timestamps bracket the moves (null when absent);
//   touched  [ref] — comment add / handoff [set] targets;
//   mentions [ref] — corroboration refs from user text and triage CLI verbs.
export function parseSessionEvidence(raw) {
  // CLI evidence is buffered per tool_use id and committed only if the command
  // did not FAIL: a rejected permission, a CLI error (`set-status 99999`, a
  // bogus status) or any non-zero exit comes back as a tool_result with
  // is_error — counting those would credit moves that never happened (a real
  // case: negative tests run while developing the tracker itself). A command
  // whose result never made it into the transcript (truncated tail) keeps the
  // benefit of the doubt.
  const pending = new Map(); // tool_use id → { moves, touched, mentions }
  const errored = new Set(); // tool_use ids whose result was an error
  const byRef = new Map();
  const touched = new Set();
  const mentions = new Set();
  for (const line of String(raw || "").split("\n")) {
    if (!LINE_PREFILTER.test(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // header / truncated tail line
    }
    const content = rec && rec.message && rec.message.content;
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    // USER entries. Text → mentions: isMeta = hook feedback, isSidechain =
    // subagent prompt — neither is the human; tool_result items carry board
    // echoes and are never scanned for refs, but their is_error flag is what
    // voids the matching command's buffered evidence; <system-reminder> blocks
    // inside real prompts are hook injections, stripped before matching.
    if (rec && rec.type === "user") {
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.type === "tool_result" && item.is_error && item.tool_use_id) {
            errored.add(item.tool_use_id);
          }
        }
      }
      if (!rec.isMeta && !rec.isSidechain) {
        const texts =
          typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content.filter((i) => i && i.type === "text").map((i) => i.text || "")
              : [];
        for (const t of texts) {
          const clean = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
          collect([TEXT_MENTION_RE], clean, mentions);
        }
      }
      continue; // user entries carry no tool_use
    }

    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || item.type !== "tool_use" || item.name !== "Bash") continue;
      const cmd = item.input && item.input.command;
      // Require a real CLI invocation, so an echo of "set-status …" can't count.
      if (typeof cmd !== "string" || !/cli\.mjs|cc-todos/.test(cmd)) continue;
      const buf = { moves: new Map(), touched: new Set(), mentions: new Set() };
      SET_STATUS_RE.lastIndex = 0;
      let m;
      while ((m = SET_STATUS_RE.exec(cmd))) {
        const [, ref, status] = m;
        if (!WORKED.has(status)) continue;
        let mv = buf.moves.get(ref);
        if (!mv) buf.moves.set(ref, (mv = { ref, statuses: [], ts }));
        if (!mv.statuses.includes(status)) mv.statuses.push(status);
      }
      collect(TOUCH_RES, cmd, buf.touched);
      collect(CLI_MENTION_RES, cmd, buf.mentions);
      if (!buf.moves.size && !buf.touched.size && !buf.mentions.size) continue;
      // No id → nothing to match a result against (shouldn't happen in real
      // transcripts) — commit unconditionally via the shared pending pass.
      pending.set(typeof item.id === "string" ? item.id : `no-id-${pending.size}`, buf);
    }
  }

  for (const [id, buf] of pending) {
    if (errored.has(id)) continue;
    for (const { ref, statuses, ts } of buf.moves.values()) {
      let mv = byRef.get(ref);
      if (!mv) byRef.set(ref, (mv = { ref, statuses: [], first_ts: ts, last_ts: ts }));
      for (const s of statuses) if (!mv.statuses.includes(s)) mv.statuses.push(s);
      if (ts) {
        if (!mv.first_ts || ts < mv.first_ts) mv.first_ts = ts;
        if (!mv.last_ts || ts > mv.last_ts) mv.last_ts = ts;
      }
    }
    for (const r of buf.touched) touched.add(r);
    for (const r of buf.mentions) mentions.add(r);
  }
  return {
    moves: [...byRef.values()],
    touched: [...touched].sort(),
    mentions: [...mentions].sort(),
  };
}

// Back-compat shim for the original single-signal API (unit tests use both).
export function parseSessionMoves(raw) {
  return parseSessionEvidence(raw).moves;
}

// The real project name, from the `cwd` a transcript entry carries (the encoded
// dir name is lossy). Same derivation as cc.rs::project_name / corrections.mjs.
function projectFromRaw(raw) {
  for (const line of String(raw || "").split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string" && cwd.trim()) {
        const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        if (name) return name;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function analyze(targets) {
  const sessions = [];
  for (const t of targets) {
    let raw;
    try {
      raw = readFileSync(t.file, "utf8");
    } catch {
      continue; // vanished mid-run
    }
    const ev = parseSessionEvidence(raw);
    // Mention-only sessions ARE published: the join's interval fallback fires
    // only for sessions whose mentions corroborate the candidate task.
    if (!ev.moves.length && !ev.touched.length && !ev.mentions.length) continue;
    let mtime = null;
    try {
      mtime = statSync(t.file).mtime.toISOString();
    } catch {
      // keep the evidence, drop the stamp
    }
    sessions.push({
      session: t.session,
      project_dir: t.projectDir,
      project: projectFromRaw(raw),
      modified_at: mtime,
      moves: ev.moves,
      touched: ev.touched,
      mentions: ev.mentions,
    });
  }
  sessions.sort((a, b) =>
    String(b.modified_at || "").localeCompare(String(a.modified_at || "")),
  );
  return sessions;
}

// ── flags / sink ─────────────────────────────────────────────────────────────
function parseFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") f.all = true;
    else if (a === "--json") f.json = true;
    else if (a === "--project") f.project = args[++i];
  }
  return f;
}

function sinkPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "com.claude-usage-tracker.app", "task-attribution.json");
}

// Atomic write (temp + rename), matching corrections.mjs / todos.mjs.
function saveAtomic(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function buildDoc(f, sessions) {
  return {
    version: 2, // on-disk schema (mirrored by src-tauri/src/task_cost.rs); v2 added touched/mentions
    kind: "task.attribution",
    generated_at: new Date().toISOString(),
    scope: f.all ? "all" : "project",
    sessions,
  };
}

function cmdScan(args) {
  const f = parseFlags(args);
  const sessions = analyze(resolveTranscripts(f));
  if (f.json) {
    process.stdout.write(JSON.stringify(buildDoc(f, sessions), null, 2) + "\n");
    return;
  }
  for (const s of sessions) {
    process.stdout.write(`${s.session}  (${s.project || s.project_dir})\n`);
    for (const m of s.moves) {
      process.stdout.write(`    ${m.ref} -> ${m.statuses.join(",")}\n`);
    }
    if (s.touched.length) process.stdout.write(`    touched: ${s.touched.join(", ")}\n`);
    if (s.mentions.length) process.stdout.write(`    mentions: ${s.mentions.join(", ")}\n`);
  }
  process.stdout.write(`${sessions.length} session(s) with evidence\n`);
}

function cmdPublish(args) {
  const f = parseFlags(args);
  const sessions = analyze(resolveTranscripts(f));
  const file = sinkPath();
  saveAtomic(file, buildDoc(f, sessions));
  process.stdout.write(
    `ok: published attribution (${sessions.length} session(s) with evidence) -> ${file}\n`,
  );
}

function usage(code) {
  process.stdout.write(
    "cli task-cost - session->task attribution for tokens-per-task (t#87)\n\n" +
      "  scan    [--project <name>|--all] [--json]   per-session task moves (stdout)\n" +
      "  publish [--project <name>|--all]            write task-attribution.json\n" +
      "          (the sink the tracker joins with per-session token usage)\n",
  );
  process.exit(code);
}

export function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "scan":
      cmdScan(rest);
      break;
    case "publish":
      cmdPublish(rest);
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
