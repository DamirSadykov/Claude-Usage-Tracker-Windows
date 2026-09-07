// `cli todos adoption [--since <date>|--days N]` — does the process language
// actually get USED (t#315)?
//
// The change built the language, the validator, the runner and the prompts; none
// of that can be judged from the code, because every question it raises is about
// the behaviour of a live session: does the ritual fire at all, are the
// declarations filled in, is the format read, what does the validator refuse,
// what do the injected texts cost. This command answers those with numbers off
// data the harness writes ANYWAY — transcripts, the exit journal, the board and
// the kept plan files. Nothing here asks a person to remember anything, which is
// the only reason to expect it to still be running in a month
// (`patterns/measurement-carried-by-harness-not-human.md`).
//
// The five questions, and where each one's number comes from:
//   1. RITUAL      — did plan mode reach the tracker: ExitPlanMode calls in the
//                    transcripts vs what the exit hook did with them (journal),
//                    and whether the format doc was read while planning.
//   2. DECLARATIONS— the §18 fill rate: share of plan steps that declared
//                    `produces` / `verify`. Below 70% the language does not take,
//                    and artefacts should be mined from transcripts instead.
//   3. VALIDATOR   — every `todos apply` a session ran, and which of them the
//                    rules refused. A rule that never fires is a candidate for
//                    removal; one that fires on an honest graph is noise.
//   4. DOUBLES     — steps recorded twice under a reworded phrase (re-apply
//                    matches by exact subject), the failure the VERBATIM warning
//                    in the exit instruction is there to prevent.
//   5. TEXTS       — what the injections cost, both as the code stands today and
//                    as the sessions in the window actually received them.
//
// Read-only: transcripts, the board and the journal are all opened, never
// written. Exit code is 0 whatever the numbers say — this reports, it never gates.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardPath, loadBoard, isChangeRoot } from "./todos.mjs";
import { roamingBase } from "./settings.mjs";
import { buildEnterContext, buildExitContext, buildDiscussionContext, planFormatDoc } from "./plan-hook.mjs";

const USAGE =
  "usage: cli todos adoption [--since <YYYY-MM-DD> | --days <N>] [--json]\n" +
  "       is the process language being used — the five numbers of t#315:\n" +
  "       ritual reach, declaration fill rate, what the validator refused,\n" +
  "       doubled steps, and what the injected texts cost.\n" +
  "       Default window: 30 days. Reads transcripts, the board and the exit\n" +
  "       journal; writes nothing.";

// ── where the evidence lives ────────────────────────────────────────────────
// Transcripts are per-cwd directories under ~/.claude/projects (the same
// location task-cost.mjs reads); the ritual is not one project's, so every
// directory is in scope.
function claudeProjectsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return home ? path.join(home, ".claude", "projects") : null;
}

export function eventsPath() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "plan-events.jsonl");
}

export function plansDir() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "plans");
}

// ── the transcript scan ─────────────────────────────────────────────────────
//
// A cheap pre-filter, then a JSON.parse of the few lines that can carry an
// answer: a session transcript is megabytes of tool traffic and only a handful
// of its lines are about the plan ritual.
const INTERESTING =
  /ExitPlanMode|plan-format\.md|todos apply|hook_success|has approved your plan|doesn't want to proceed/;

// Which branch of the exit hook spoke, read off the text it injected. The old
// wording ("PLAN accepted · now record it") is kept on purpose: the window can
// reach back past a change of wording, and a branch misread as "other" would
// look like a hook that misbehaved.
export function branchOf(text) {
  const t = String(text || "");
  if (/recorded by the tracker/i.test(t)) return "recorded";
  if (/declared a discussion/i.test(t)) return "discussion";
  if (/record it in the tracker|now record it in the tracker/i.test(t)) return "instruction";
  if (/not approved/i.test(t)) return "not-approved";
  return "other";
}

const attachmentText = (a) => {
  try {
    return JSON.parse(a.stdout).hookSpecificOutput.additionalContext ?? "";
  } catch {
    return String(a.stdout || "");
  }
};

// One transcript → the plan calls it holds and what its session did around them.
// `since` is an ISO instant; timestamps are ISO too, so a string compare is the
// window test.
function scanTranscript(file, project, since, acc) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!INTERESTING.test(raw)) return;

  const session = path.basename(file, ".jsonl");
  const exits = new Map(); // ExitPlanMode tool_use_id → the call record
  const applies = new Map(); // Bash tool_use_id → the `todos apply` it ran

  for (const line of raw.split("\n")) {
    if (!line) continue;
    // The pre-filter cannot be a word list alone: the ANSWER to a call carries
    // none of the words — `apply` refuses with "refusing: step …", and that line
    // says nothing about apply. What ties it back is the id of the call, so a
    // result is let through when it answers something already being followed.
    if (!INTERESTING.test(line)) {
      if (!line.includes('"tool_use_id"')) continue;
      const m = /"tool_use_id":"([^"]+)"/.exec(line);
      if (!m || !(exits.has(m[1]) || applies.has(m[1]))) continue;
    }
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = String(e.timestamp || "");
    if (ts && ts < since) continue;

    // The hook's own output, linked to the call it answered by tool-use id.
    if (e.type === "attachment" && e.attachment?.type === "hook_success") {
      const a = e.attachment;
      const text = attachmentText(a);
      if (a.hookName === "PostToolUse:ExitPlanMode") {
        const call = exits.get(a.toolUseID);
        if (call) call.hook = branchOf(text);
        acc.injections.push({ kind: "exit", chars: text.length, ts });
      } else if (/EnterPlanMode|UserPromptSubmit/.test(String(a.hookName || "")) && /PLAN MODE ·/.test(text)) {
        acc.injections.push({ kind: "enter", chars: text.length, ts });
      } else if (/TASK TRACKER · how to edit/.test(text)) {
        acc.injections.push({ kind: "session-start", chars: text.length, ts });
      }
      continue;
    }

    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") {
        if (b.name === "ExitPlanMode") {
          const rec = {
            ts,
            session,
            project,
            chars: String(b.input?.plan ?? "").length,
            keys: Object.keys(b.input || {}),
            verdict: "unanswered",
            hook: "",
          };
          exits.set(b.id, rec);
          acc.plans.push(rec);
        } else if (b.name === "Read" && /plan-format\.md/i.test(String(b.input?.file_path ?? ""))) {
          acc.formatReads.add(session);
        } else if (/todos apply/.test(String(b.input?.command ?? ""))) {
          // `--go` is what separates a check from a write: the interesting
          // refusals are the ones that stopped a recording, not a dry run.
          const cmd = String(b.input.command);
          const rec = { ts, session, project, go: /--go\b/.test(cmd), ok: null, head: "" };
          applies.set(b.id, rec);
          acc.applies.push(rec);
        }
        continue;
      }
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      // The user's answer to a plan arrives as that call's tool_result — and the
      // very same sentences appear in transcripts as quoted text (a session
      // reading an old transcript, a test fixture echoed by a shell command).
      // Linking by tool-use id is what keeps those out: without it this scan
      // counted 4 approvals that were somebody else's Bash output.
      const call = exits.get(b.tool_use_id);
      if (call) {
        if (/has approved your plan/i.test(text)) call.verdict = "approved";
        else if (/doesn't want to proceed/i.test(text)) call.verdict = "rejected";
      }
      const applied = applies.get(b.tool_use_id);
      if (applied) {
        // A command the user declined never reached the validator, so it is not
        // a refusal — counting it as one would credit the rules with a stop they
        // never made (the first live run did exactly that).
        if (/Permission to use|doesn't want to proceed/i.test(text)) continue;
        applied.ok = b.is_error ? false : !/^\s*(refus|error|✗)/im.test(text);
        // A refusal names its rule on the line AFTER the headline ("refusing to
        // apply x.yaml — 1 error(s):" then the rule), and which rule fired is the
        // whole point of counting refusals — the headline alone says nothing.
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        const i = lines.findIndex((l) => /^refusing|error\(s\)/i.test(l));
        applied.head = (i >= 0 ? [lines[i], lines[i + 1]].filter(Boolean).join(" ") : lines[0] || "").slice(
          0,
          160,
        );
      }
    }
  }
}

export function scanTranscripts(since, root = claudeProjectsDir()) {
  const acc = { plans: [], applies: [], injections: [], formatReads: new Set(), projects: 0 };
  if (!root || !existsSync(root)) return acc;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    acc.projects += 1;
    for (const f of files) {
      const file = path.join(dir, f);
      // A transcript untouched since before the window cannot hold an event in
      // it — skipping it by mtime is what keeps the scan a couple of seconds
      // over thousands of files.
      try {
        if (statSync(file).mtime.toISOString() < since) continue;
      } catch {
        continue;
      }
      scanTranscript(file, d.name, since, acc);
    }
  }
  return acc;
}

// ── the exit journal ────────────────────────────────────────────────────────
export function readJournal(since, file = eventsPath()) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && String(e.ts || "") >= since);
  } catch {
    return [];
  }
}

// ── the board half ──────────────────────────────────────────────────────────
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function boardSlice(data, since) {
  const tasks = (data.todos || []).filter((t) => t && String(t.created_at || "") >= since);
  const filled = (t, f) => (Array.isArray(t[f]) ? t[f].length > 0 : Boolean(String(t[f] || "").trim()));
  // Change roots are excluded from the fill rate: a root is a container, it
  // produces nothing itself, and counting it would drag the rate down for a
  // shape the language asks for.
  const steps = tasks.filter((t) => !isChangeRoot(t));
  const doubles = [];
  const bySubject = new Map();
  for (const t of tasks) {
    const key = norm(t.subject);
    if (!key) continue;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(t);
  }
  for (const [, group] of bySubject) if (group.length > 1) doubles.push(group);
  return {
    created: tasks.length,
    steps: steps.length,
    produces: steps.filter((t) => filled(t, "produces")).length,
    verify: steps.filter((t) => filled(t, "verify")).length,
    auto: steps.filter((t) => t.kind === "auto").length,
    doubles,
  };
}

// ── the texts ───────────────────────────────────────────────────────────────
// What the machinery injects as the code stands right now. Measured, not
// remembered: the numbers in the change's notes went stale twice already.
export function textSizes() {
  const doc = (() => {
    try {
      return readFileSync(planFormatDoc(), "utf8").length;
    } catch {
      return 0;
    }
  })();
  return {
    enter: buildEnterContext().length,
    exit_instruction: buildExitContext("").length,
    exit_discussion: buildDiscussionContext("").length,
    format_doc: doc,
  };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ── the report ──────────────────────────────────────────────────────────────
export const THRESHOLD = 0.7; // §18: below this the declaration does not take

// Every way the exit hook can end, in the order a reader wants them.
const BRANCHES = [
  "recorded",
  "instruction",
  "discussion",
  "not-approved",
  "silent",
  "record-failed",
  "other",
];

export function collect(since, { root, journalFile } = {}) {
  const scan = scanTranscripts(since, root ?? claudeProjectsDir());
  const journal = readJournal(since, journalFile ?? eventsPath());
  const board = boardSlice(loadBoard(boardPath()), since);
  const approved = scan.plans.filter((p) => p.verdict === "approved");
  const answered = approved.filter((p) => p.hook);
  const branch = (name) => journal.filter((e) => e.branch === name).length;
  const recorded = journal.filter((e) => e.branch === "recorded");
  const declaredSteps = recorded.reduce((n, e) => n + (e.steps || 0), 0);
  const kept = (() => {
    try {
      return readdirSync(plansDir()).filter((f) => f.endsWith(".yaml")).length;
    } catch {
      return 0;
    }
  })();
  return {
    since,
    projects: scan.projects,
    ritual: {
      calls: scan.plans.length,
      approved: approved.length,
      rejected: scan.plans.filter((p) => p.verdict === "rejected").length,
      // A call whose answer is not in the transcript — the plan was superseded by
      // a re-plan, or the session ended on it. Named rather than folded into the
      // approvals: a rate computed over "everything not rejected" would flatter.
      unanswered: scan.plans.filter((p) => p.verdict === "unanswered").length,
      answered: answered.length,
      silent: approved.length - answered.length,
      no_plan_text: approved.filter((p) => !p.chars).length,
      // Two readings of the same events, deliberately kept apart. The transcript
      // knows only the branches that SPOKE; the journal knows every invocation,
      // including the three silent ones. They disagree exactly when the hook ran
      // without saying anything — which is the case worth seeing.
      branches: Object.fromEntries(
        BRANCHES.map((b) => [b, answered.filter((p) => p.hook === b).length]),
      ),
      journal_branches: Object.fromEntries(BRANCHES.map((b) => [b, branch(b)])),
      journal_lines: journal.length,
      format_read_sessions: [...scan.formatReads].length,
      plan_sessions: new Set(scan.plans.map((p) => p.session)).size,
      plan_files_kept: kept,
    },
    declarations: {
      // The plans' own fill rate, straight from the journal — the number §18
      // states its threshold about.
      plan_steps: declaredSteps,
      plan_produces: recorded.reduce((n, e) => n + (e.produces || 0), 0),
      plan_verify: recorded.reduce((n, e) => n + (e.verify || 0), 0),
      // And the board's, which mixes plan-borne nodes with hand-typed ones.
      board_steps: board.steps,
      board_produces: board.produces,
      board_verify: board.verify,
      board_auto: board.auto,
      created: board.created,
    },
    validator: {
      runs: scan.applies.length,
      writes: scan.applies.filter((a) => a.go).length,
      refused: scan.applies.filter((a) => a.ok === false).length,
      reasons: scan.applies.filter((a) => a.ok === false).map((a) => a.head),
    },
    doubles: board.doubles.map((g) => ({ subject: g[0].subject, tasks: g.map((t) => t.number) })),
    texts: {
      now: textSizes(),
      observed: Object.fromEntries(
        ["enter", "exit", "session-start"].map((k) => {
          const xs = scan.injections.filter((i) => i.kind === k).map((i) => i.chars);
          return [k, { n: xs.length, median: median(xs), max: xs.length ? Math.max(...xs) : 0 }];
        }),
      ),
    },
  };
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "n/a");

export function formatReport(r) {
  const L = [];
  L.push(`adoption of the process language — since ${r.since.slice(0, 10)}, ${r.projects} project dir(s)`);
  L.push("");
  L.push("1. RITUAL — did plan mode reach the tracker");
  L.push(
    `   ExitPlanMode: ${r.ritual.calls} call(s), ${r.ritual.approved} approved, ${r.ritual.rejected} rejected, ${r.ritual.unanswered} without an answer in the transcript`,
  );
  L.push(
    `   exit hook answered ${r.ritual.answered}/${r.ritual.approved} approved plan(s)` +
      (r.ritual.silent ? ` — SILENT on ${r.ritual.silent}` : ""),
  );
  const b = r.ritual.branches;
  const j = r.ritual.journal_branches;
  L.push(
    `   branches heard: recorded ${b.recorded}, instruction ${b.instruction}, discussion ${b.discussion}, not-approved ${b["not-approved"]}`,
  );
  L.push(
    `   branches journalled: recorded ${j.recorded}, instruction ${j.instruction}, discussion ${j.discussion}, not-approved ${j["not-approved"]}, silent ${j.silent}, record-failed ${j["record-failed"]}`,
  );
  L.push(`   journal lines: ${r.ritual.journal_lines}   plan files kept: ${r.ritual.plan_files_kept}`);
  if (!r.ritual.journal_lines && r.ritual.approved)
    L.push("   ⚠ no journal line for any of them — the exit hook did not run at all");
  L.push(
    `   format doc read in ${r.ritual.format_read_sessions}/${r.ritual.plan_sessions} planning session(s)`,
  );
  L.push("");
  L.push("2. DECLARATIONS — §18: produces on <70% of steps means the language does not take");
  const d = r.declarations;
  L.push(
    `   recorded plans: ${d.plan_steps} step(s), produces ${d.plan_produces} (${pct(d.plan_produces, d.plan_steps)}), verify ${d.plan_verify} (${pct(d.plan_verify, d.plan_steps)})`,
  );
  L.push(
    `   board (all new tasks, plan-borne or not): ${d.board_steps} step(s) of ${d.created} created, produces ${d.board_produces} (${pct(d.board_produces, d.board_steps)}), verify ${d.board_verify} (${pct(d.board_verify, d.board_steps)}), auto ${d.board_auto}`,
  );
  if (d.plan_steps && d.plan_produces / d.plan_steps < THRESHOLD)
    L.push("   ✗ below the §18 threshold — artefacts would have to be mined from transcripts");
  if (!d.plan_steps) L.push("   (no recorded plan in the window — the rate has no material yet)");
  L.push("");
  L.push("3. VALIDATOR — what `todos apply` refused");
  L.push(`   ${r.validator.runs} run(s), ${r.validator.writes} with --go, ${r.validator.refused} refused`);
  for (const reason of r.validator.reasons.slice(0, 8)) L.push(`     ✗ ${reason}`);
  L.push("");
  L.push("4. DOUBLES — the same phrase recorded twice");
  L.push(
    r.doubles.length
      ? r.doubles.map((g) => `   #${g.tasks.join(" / #")}  ${g.subject.slice(0, 70)}`).join("\n")
      : "   none",
  );
  L.push("");
  L.push("5. TEXTS — what the injections cost (chars)");
  const t = r.texts.now;
  L.push(
    `   as coded now: enter ${t.enter}, exit instruction ${t.exit_instruction}, exit discussion ${t.exit_discussion}, format doc ${t.format_doc} (read by reference)`,
  );
  for (const [k, v] of Object.entries(r.texts.observed))
    L.push(`   observed ${k}: ${v.n} injection(s), median ${v.median}, max ${v.max}`);
  return L.join("\n") + "\n";
}

// ── entry ───────────────────────────────────────────────────────────────────
function windowStart(args) {
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : "";
  };
  const since = at("--since");
  if (since) return new Date(since + (since.length === 10 ? "T00:00:00.000Z" : "")).toISOString();
  const days = Number(at("--days")) || 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function run(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const report = collect(windowStart(args));
  process.stdout.write(
    args.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : formatReport(report),
  );
}
