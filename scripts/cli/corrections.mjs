// `cli.mjs corrections` — the PUBLIC DATA CONTRACT for user-correction signals
// mined from Claude Code transcripts (task t#101, part A of the L3→L4 outcome
// breakdown t#86). Lazily loaded by ../cli.mjs; one exported `run(args)` like
// every other area (todos/phases/triage).
//
// SCOPE (collection + statistics, not classification)
//   This tool owns COLLECTION + STATISTICS and exposes them as a versioned JSON
//   contract. It does NOT judge whether a candidate is a real correction — that
//   classification (a "correction vs refinement/new-task/approval" pass) is a
//   further step left to whatever consumes this contract, and is out of scope
//   here. So everything here is deliberately cheap, offline, and LLM-free; the
//   numbers it prints are CANDIDATES (an upper bound) a downstream pass can refine.
//
// WHY THE METRIC / WHY IT ANCHORS OUTCOME FROM OUTSIDE THE LOOP
//   A user correction arrives from OUTSIDE the assistant loop and can't be
//   inflated from within it, so "how often must the user correct the assistant"
//   is an external anchor of outcome quality. Two ratios per session:
//     corrections_per_session = N(candidate) / N(assistant_turns)
//     rework_after_done_rate  = N(candidate right after a "done" claim) / N(done-claims)
//   The second operationalizes the completion-signal invariant: claiming "done"
//   then being corrected is the failure we most want to see trend down.
//
// USER-FAULT vs LLM-FAULT (what the signals mean)
//   Not every candidate is the assistant's fault. The contract exposes the SIGNAL
//   TYPE per candidate so a downstream pass (and a human) can attribute fault:
//     · post-reject / post-interrupt (structural) → almost always LLM-fault: the
//       user stopped the assistant mid-action.
//     · rework_after_done                         → LLM-fault: false "done" signal.
//     · lexical (negation / corrective imperative) → ambiguous: could be the user
//       changing direction (refinement / new_task), not an assistant miss.
//   Each candidate carries EVIDENCE (the preceding assistant snippet + any
//   rejected tool names) so the external classifier can decide correction vs
//   refinement/approval/new_task/question without re-reading raw JSONL.
//
// HONESTY ABOUT THE DENOMINATOR & THE TREND
//   `assistant_turns` dedupes by the model message id when present (one assistant
//   turn spans several JSONL lines — text then tool_use). The ratio is only
//   comparable at a FIXED task mix (harder tasks → more corrections ≠ worse
//   assistant); treat it as a relative trend across similar sessions.
//
// VALIDATION (holdout discipline, AgentTrust arxiv 2606.08539)
//   `label-template <session>` emits EVERY real user turn (with the layer-1
//   prediction + evidence) for hand-labeling; `eval --labels <file>` scores the
//   layer-1 precision/recall for the `correction` class against those gold
//   labels, so the layer-1 net can be tuned before any classifier consumes it.
//
// Commands (run as `cli.mjs corrections <cmd>`):
//   scan [<session>] [--project <name>|--all] [--json] [--candidates]
//   label-template <session> [--out <file>]
//   eval --labels <file> [--json]
//
// Read-only over the transcripts (~/.claude/projects/**/*.jsonl); never writes to
// the board or the transcripts. Non-zero exit on any error.
//
// CONTRACT: the `--json` shapes below carry `contract_version`. Consumers pin it
// and refuse an unexpected major. Bump on any breaking field change; additive
// fields keep the same version. See docs/corrections-contract.md.
//
// BUILD YOUR OWN INTEGRATION on top of this contract (classifier, export, report)
// — the data is meant to be consumed. Integration guide:
//   https://github.com/DamirSadykov/Claude-Usage-Tracker-Windows/wiki/Corrections-Integration

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

// Versioned wire contract for every `--json` output. Bump on a BREAKING change
// (removed/renamed/retyped field); additive fields do not bump it.
const CONTRACT_VERSION = 1;

// How much surrounding text to hand the external classifier as evidence.
const EVIDENCE_CHARS = 240;

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ── transcript location ──────────────────────────────────────────────────────
// Claude Code stores one JSONL per session under ~/.claude/projects/<encoded-cwd>/,
// where the cwd is encoded by replacing every `:` `\` `/` with `-`
// (e.g. `D:\projects\MVPs\app` → `D--projects-MVPs-app`). Mirrors the encoding
// used by src-tauri/src/memory.rs.
function claudeProjectsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (!home) return null;
  return path.join(home, ".claude", "projects");
}

function encodeCwd(cwd) {
  // Claude Code replaces `:` `\` `/` AND `.` with `-` when naming the project dir
  // (a dotted path like `D:\projects\.clients\shop` → `D--projects--clients-shop`),
  // so `.` must be encoded too or the default/`--project` scope misses the dir.
  return String(cwd).replace(/[:\\/.]/g, "-");
}

// Resolve which transcript files to analyze. Precedence:
//   explicit <session>  → that one file (id, id.jsonl, or a full path)
//   --all               → every *.jsonl under every project dir
//   --project <name>    → the project dir whose encoded name ENDS WITH <name>
//   (default)           → the current cwd's project dir
// Returns [{ session, file, projectDir }] sorted by session id for stable output.
function resolveTranscripts({ session, project, all }) {
  const root = claudeProjectsDir();
  if (!root || !existsSync(root)) fail(`no transcripts dir: ${root}`);

  if (session) {
    // A full path, or a bare id (with/without .jsonl) inside the current project.
    if (session.includes(path.sep) || session.includes("/")) {
      if (!existsSync(session)) fail(`no such transcript: ${session}`);
      return [
        {
          session: path.basename(session, ".jsonl"),
          file: session,
          projectDir: path.basename(path.dirname(session)),
        },
      ];
    }
    const id = session.replace(/\.jsonl$/, "");
    for (const dir of listProjectDirs(root)) {
      const f = path.join(dir, id + ".jsonl");
      if (existsSync(f))
        return [{ session: id, file: f, projectDir: path.basename(dir) }];
    }
    fail(`session not found in any project: ${id}`);
  }

  let dirs;
  if (all) {
    dirs = listProjectDirs(root);
  } else if (project) {
    dirs = listProjectDirs(root).filter((d) =>
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
      // Skip `agent-*.jsonl` — subagent transcripts, not a user↔assistant
      // conversation, so they have no real user turns to correct anything.
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

function listProjectDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name));
}

// ── entry classification ─────────────────────────────────────────────────────
// The interrupt marker is a SYNTHETIC user turn Claude Code injects when the user
// stops a tool use; it is a signal, not a real turn, and must be excluded from
// both the user-turn set and the denominator.
const INTERRUPT_MARKERS = [
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
];

// Prefixes that mark an injected (non-typed) user entry: harness reminders,
// slash-command wrappers, hook output. A turn that is ONLY these is not a real
// human turn.
const INJECTED_PREFIXES = ["<system-reminder", "<command-", "<local-command", "Caveat:"];

// Pull the human-typed text out of a user entry, or null if it isn't a real turn
// (tool_result carrier, interrupt marker, pure injection, or empty).
function realUserText(entry) {
  if (!entry || entry.type !== "user") return null;
  const content = entry.message && entry.message.content;

  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // Any tool_result block → this is a synthetic carrier (incl. rejects), not a turn.
    if (content.some((b) => b && b.type === "tool_result")) return null;
    text = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }

  text = stripInjected(text).trim();
  if (!text) return null;
  if (INTERRUPT_MARKERS.includes(text)) return null;
  return text;
}

// Remove trailing/leading injected blocks (a real message can arrive with a
// system-reminder appended). If what remains starts with an injection prefix and
// nothing human precedes it, treat the whole thing as injected.
function stripInjected(text) {
  let t = String(text);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const trimmed = t.trim();
  if (INJECTED_PREFIXES.some((p) => trimmed.startsWith(p))) return "";
  return t;
}

// Tool-use REJECT (`tool_result` with is_error + the canonical "was rejected /
// doesn't want to proceed" copy). Returns the rejected tool_use_ids so the caller
// can resolve them to tool names for evidence.
function rejectedToolIds(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b) =>
        b &&
        b.type === "tool_result" &&
        b.is_error === true &&
        typeof b.content === "string" &&
        /was rejected|want to proceed/i.test(b.content),
    )
    .map((b) => b.tool_use_id)
    .filter(Boolean);
}

function isInterruptMarker(entry) {
  if (!entry || entry.type !== "user") return false;
  const content = entry.message && entry.message.content;
  const text = Array.isArray(content)
    ? content.map((b) => (b && b.type === "text" ? b.text : "")).join("")
    : typeof content === "string"
      ? content
      : "";
  return INTERRUPT_MARKERS.includes(text.trim());
}

function isAssistantTurn(entry) {
  return (
    entry &&
    entry.type === "assistant" &&
    entry.message &&
    entry.message.role === "assistant"
  );
}

function assistantText(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// tool_use blocks in an assistant entry → [{id, name}] for id→name resolution.
function assistantToolUses(entry) {
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "tool_use" && b.id && b.name);
}

// ── layer-1 lexical detector ─────────────────────────────────────────────────
// High-recall, deliberately noisy. The external classifier prunes the false
// positives; tune these with `eval` against hand labels, don't trust them raw.
// NOTE on word boundaries: JS `\b` is ASCII-only (`\w` = [A-Za-z0-9_]), so a `\b`
// touching a Cyrillic letter never fires — it would silently kill every Russian
// keyword and leave only the ASCII ones matching. We use the `u` flag + explicit
// Unicode-aware boundaries `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` instead.
const WB_L = "(?<![\\p{L}\\p{N}_])"; // left boundary (no letter/number/_ before)
const WB_R = "(?![\\p{L}\\p{N}_])"; //  right boundary (no letter/number/_ after)
const NEGATION_OPENERS = new RegExp(
  `^\\s*(нет${WB_R}|не так|не то${WB_R}|неправильно|неверно|зачем|почему|я же (просил|говорил)|опять|снова|стоп${WB_R}|это не то|да нет|no${WB_R}|nope${WB_R}|wrong${WB_R})`,
  "iu",
);
const CORRECTIVE_IMPERATIVES = new RegExp(
  `${WB_L}(переделай|переделать|исправь|исправить|поправь|почини|верни|вернуть|убери|убрать|откати|откатить|замени|заменить|не надо было|не нужно было|сломал|сломано|ошиб(ся|ка|аешься)|revert|undo|fix (this|that|it))${WB_R}`,
  "iu",
);

// A "done"/completion claim in an assistant turn — the anchor for rework_after_done.
const DONE_CLAIM = new RegExp(
  `(готово${WB_R}|готов${WB_R}|сделал|сделано|исправил|починил|смерж|запушил|закоммит|всё чисто|все чисто|работает теперь|done${WB_R}|fixed${WB_R}|✓|✅)`,
  "iu",
);

// Predict whether a real user turn is a correction candidate.
// `precededBy` is 'reject' | 'interrupt' | null (the structural signal).
function predictCorrection(text, precededBy) {
  const reasons = [];
  if (precededBy === "reject") reasons.push("post-reject");
  if (precededBy === "interrupt") reasons.push("post-interrupt");
  if (NEGATION_OPENERS.test(text)) reasons.push("negation-opener");
  if (CORRECTIVE_IMPERATIVES.test(text)) reasons.push("corrective-imperative");
  return { predicted: reasons.length > 0, reasons };
}

// Coarse fault attribution from the signal set, for the contract. `structural`
// (post-reject/interrupt) ≈ LLM-fault; lexical-only ≈ ambiguous. Never a verdict —
// just which bucket the external classifier should weigh.
function faultHint(reasons) {
  const structural = reasons.some(
    (r) => r === "post-reject" || r === "post-interrupt",
  );
  if (structural) return "likely-llm";
  if (reasons.length) return "ambiguous";
  return "none";
}

// ── per-session analysis ─────────────────────────────────────────────────────
function readEntries(file) {
  const out = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push({ entry: JSON.parse(line), lineIndex: i });
    } catch {
      // A half-written last line (session in progress) — skip it, keep the rest.
    }
  }
  return out;
}

function snip(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, EVIDENCE_CHARS);
}

// The real project name, from the `cwd` field the transcript entries carry — the
// LAST path component, exactly as the app derives it (src-tauri/src/cc.rs::
// project_name). The encoded `projectDir` is lossy (every separator became `-`),
// so a consumer can't recover the project from it; this gives an exact key to
// filter by. Null when no entry carries a cwd.
function projectFromRows(rows) {
  for (const { entry } of rows) {
    const cwd = entry && entry.cwd;
    if (typeof cwd === "string" && cwd.trim()) {
      const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      if (name) return name;
    }
  }
  return null;
}

function analyzeSession(session, file, projectDir) {
  const rows = readEntries(file);
  const project = projectFromRows(rows);

  const assistantMsgIds = new Set();
  let assistantAnon = 0; // assistant turns with no message.id (counted individually)
  const userTurns = []; // normalized real user turns (see row shape below)
  const candidates = [];
  let doneClaims = 0;
  let reworkAfterDone = 0;

  // Streaming state consumed by the next real user turn.
  let pendingSignal = null; // 'reject' | 'interrupt' | null
  let pendingDone = false;
  let pendingRejectedTools = []; // names resolved from the reject's tool_use_ids
  let lastAssistantText = ""; // evidence: what the assistant last said/did
  const toolNameById = new Map();

  for (const { entry, lineIndex } of rows) {
    const rejIds = rejectedToolIds(entry);
    if (rejIds.length) {
      pendingSignal = "reject";
      for (const id of rejIds) {
        const name = toolNameById.get(id);
        if (name) pendingRejectedTools.push(name);
      }
      continue;
    }
    if (isInterruptMarker(entry)) {
      if (!pendingSignal) pendingSignal = "interrupt";
      continue;
    }

    if (isAssistantTurn(entry)) {
      const id = entry.message.id;
      // A FRESH assistant turn (new message id, or an anonymous one) means the
      // assistant acted again. Both the structural signal (reject/interrupt) and a
      // "done" claim bind only to the user turn IMMEDIATELY after them, so an
      // intervening assistant turn invalidates both — otherwise a reject gets
      // mis-attributed to a much later message, and rework_after_done fires when
      // the correction isn't actually right after the done-claim. A multi-line
      // turn shares one id, so later lines of the SAME turn don't reset again.
      const isNewTurn = id ? !assistantMsgIds.has(id) : true;
      if (id) assistantMsgIds.add(id);
      else assistantAnon++;
      if (isNewTurn) {
        pendingSignal = null;
        pendingRejectedTools = [];
        pendingDone = false;
      }
      for (const tu of assistantToolUses(entry)) toolNameById.set(tu.id, tu.name);
      const txt = assistantText(entry);
      if (txt.trim()) lastAssistantText = txt;
      if (DONE_CLAIM.test(txt)) {
        doneClaims++;
        pendingDone = true;
      }
      continue;
    }

    const text = realUserText(entry);
    if (text == null) continue; // meta / carrier / injection — not a real turn

    const { predicted, reasons } = predictCorrection(text, pendingSignal);
    const row = {
      key: `${session}#${lineIndex}`,
      lineIndex,
      text,
      precededBy: pendingSignal,
      afterDone: pendingDone,
      predicted,
      reasons,
      faultHint: faultHint(reasons),
      // Evidence for the external classifier — no raw-JSONL re-read needed.
      evidence: {
        prevAssistant: snip(lastAssistantText),
        rejectedTools: [...new Set(pendingRejectedTools)],
      },
    };
    userTurns.push(row);
    if (predicted) {
      candidates.push(row);
      if (pendingDone) reworkAfterDone++;
    }
    // Consumed by this real turn.
    pendingSignal = null;
    pendingDone = false;
    pendingRejectedTools = [];
  }

  const assistantTurns = assistantMsgIds.size + assistantAnon;
  const stats = {
    assistant_turns: assistantTurns,
    user_turns: userTurns.length,
    candidate_corrections: candidates.length,
    done_claims: doneClaims,
    rework_after_done: reworkAfterDone,
    // Ratios are null (not 0) when the denominator is 0, so an empty session
    // doesn't masquerade as a perfect score.
    corrections_per_session:
      assistantTurns > 0 ? candidates.length / assistantTurns : null,
    rework_after_done_rate: doneClaims > 0 ? reworkAfterDone / doneClaims : null,
  };

  return { session, file, projectDir, project, stats, userTurns, candidates };
}

// Serialize a normalized user turn for the wire contract (snake_case).
function turnToWire(u) {
  return {
    key: u.key,
    text: u.text,
    predicted: u.predicted,
    reasons: u.reasons,
    preceded_by: u.precededBy,
    after_done: u.afterDone,
    fault_hint: u.faultHint,
    evidence: {
      prev_assistant: u.evidence.prevAssistant,
      rejected_tools: u.evidence.rejectedTools,
    },
  };
}

// ── commands ─────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const flags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") flags.all = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--candidates") flags.candidates = true;
    else if (a === "--project") flags.project = args[++i];
    else if (a === "--labels") flags.labels = args[++i];
    else if (a === "--out") flags.out = args[++i];
    else if (a.startsWith("--")) fail(`unknown flag: ${a}`);
    else flags.positional.push(a);
  }
  return flags;
}

function fmtRatio(r) {
  return r == null ? "n/a" : r.toFixed(3);
}

function cmdScan(args) {
  const f = parseFlags(args);
  const targets = resolveTranscripts({
    session: f.positional[0],
    project: f.project,
    all: f.all,
  });
  const results = targets.map((t) =>
    analyzeSession(t.session, t.file, t.projectDir),
  );

  if (f.json) {
    // CONTRACT shape (per session). See docs/corrections-contract.md.
    const payload = {
      contract_version: CONTRACT_VERSION,
      kind: "corrections.scan",
      sessions: results.map((r) => ({
        session: r.session,
        project_dir: r.projectDir,
        project: r.project,
        stats: r.stats,
        candidates: r.candidates.map(turnToWire),
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  // Aggregate across the selected sessions (candidate-level, upper bound).
  let A = 0, U = 0, C = 0, D = 0, R = 0, Llm = 0, Amb = 0;
  for (const r of results) {
    A += r.stats.assistant_turns;
    U += r.stats.user_turns;
    C += r.stats.candidate_corrections;
    D += r.stats.done_claims;
    R += r.stats.rework_after_done;
    for (const c of r.candidates) {
      if (c.faultHint === "likely-llm") Llm++;
      else Amb++;
    }
  }

  if (results.length > 1) {
    process.stdout.write(`corrections — LAYER 1 candidates (upper bound) — ${results.length} session(s)\n\n`);
    for (const r of results) {
      const m = r.stats;
      process.stdout.write(
        `  ${r.session}  cand=${m.candidate_corrections}/${m.assistant_turns} ` +
          `(cps=${fmtRatio(m.corrections_per_session)})  ` +
          `rework=${m.rework_after_done}/${m.done_claims} (${fmtRatio(m.rework_after_done_rate)})\n`,
      );
    }
    process.stdout.write(
      `\n  TOTAL  candidates=${C}  (likely-LLM=${Llm}  ambiguous=${Amb})\n` +
        `         assistant_turns=${A}  user_turns=${U}\n` +
        `         corrections_per_session=${fmtRatio(A > 0 ? C / A : null)}\n` +
        `         rework_after_done_rate=${fmtRatio(D > 0 ? R / D : null)} (${R}/${D})\n`,
    );
  } else if (results.length === 1) {
    const r = results[0];
    const m = r.stats;
    process.stdout.write(
      `corrections — LAYER 1 candidates (upper bound) — session ${r.session}\n\n` +
        `  assistant_turns          ${m.assistant_turns}\n` +
        `  user_turns               ${m.user_turns}\n` +
        `  candidate_corrections    ${m.candidate_corrections} (likely-LLM=${Llm} ambiguous=${Amb})\n` +
        `  corrections_per_session  ${fmtRatio(m.corrections_per_session)}\n` +
        `  done_claims              ${m.done_claims}\n` +
        `  rework_after_done        ${m.rework_after_done}\n` +
        `  rework_after_done_rate   ${fmtRatio(m.rework_after_done_rate)}\n`,
    );
    if (f.candidates && r.candidates.length) {
      process.stdout.write(`\n  candidates:\n`);
      for (const c of r.candidates) {
        process.stdout.write(
          `   · ${c.key}  [${c.reasons.join(",")}] (${c.faultHint})${c.afterDone ? " after-done" : ""}\n` +
            `       ${c.text.replace(/\s+/g, " ").slice(0, 100)}\n`,
        );
      }
    }
  } else {
    process.stdout.write("(no sessions matched)\n");
  }

  process.stdout.write(
    "\n  note: LAYER 1 counts CANDIDATES (high recall). A downstream classification\n" +
      "  pass prunes refinement/approval/new_task/question; the true correction\n" +
      "  count is <= these numbers. likely-LLM ≈ structural signal.\n",
  );
}

// Emit every real user turn of a session as a gold-labeling worksheet: the
// detector's own prediction + evidence + an empty `gold` for a human to fill with
// correction|refinement|approval|new_task|question. `eval` reads this back.
function cmdLabelTemplate(args) {
  const f = parseFlags(args);
  if (!f.positional[0]) fail("label-template needs a <session>");
  const [t] = resolveTranscripts({ session: f.positional[0] });
  const r = analyzeSession(t.session, t.file, t.projectDir);
  const worksheet = {
    contract_version: CONTRACT_VERSION,
    kind: "corrections.labels",
    session: r.session,
    project_dir: r.projectDir,
    stats: r.stats,
    // How to label: set each `gold`. Only `correction` is a true positive; the
    // others are the anti-signals the detector should learn to reject.
    labels: r.userTurns.map((u) => ({
      ...turnToWire(u),
      gold: "", // ← fill: correction | refinement | approval | new_task | question
    })),
  };
  const json = JSON.stringify(worksheet, null, 2) + "\n";
  if (f.out) {
    writeFileSync(f.out, json);
    process.stdout.write(
      `ok: wrote ${worksheet.labels.length} turn(s) -> ${f.out}\n` +
        `     fill each "gold", then: cli.mjs corrections eval --labels ${f.out}\n`,
    );
  } else {
    process.stdout.write(json);
  }
}

// Score layer-1 precision/recall for the `correction` class against a filled
// worksheet (holdout discipline). Positive = correction. Turns with an empty
// gold are skipped (unlabeled), and reported so partial labeling is visible.
function cmdEval(args) {
  const f = parseFlags(args);
  if (!f.labels) fail("eval needs --labels <file>");
  let doc;
  try {
    doc = JSON.parse(readFileSync(f.labels, "utf8"));
  } catch (e) {
    fail(`cannot read labels: ${(e && e.message) || e}`);
  }
  const labels = Array.isArray(doc) ? doc : Array.isArray(doc.labels) ? doc.labels : null;
  if (!labels) fail("labels file must be an array or { labels: [...] }");

  let tp = 0, fp = 0, fn = 0, tn = 0, skipped = 0;
  for (const l of labels) {
    const gold = String(l.gold || "").trim().toLowerCase();
    if (!gold) { skipped++; continue; }
    const goldPos = gold === "correction";
    const predPos = !!l.predicted;
    if (predPos && goldPos) tp++;
    else if (predPos && !goldPos) fp++;
    else if (!predPos && goldPos) fn++;
    else tn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  if (f.json) {
    process.stdout.write(
      JSON.stringify(
        {
          contract_version: CONTRACT_VERSION,
          kind: "corrections.eval",
          tp, fp, fn, tn, skipped, precision, recall, f1,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  process.stdout.write(
    `corrections eval — layer-1 vs gold (positive = correction)\n\n` +
      `  TP ${tp}   FP ${fp}   FN ${fn}   TN ${tn}` +
      (skipped ? `   (skipped ${skipped} unlabeled)` : "") +
      `\n` +
      `  precision  ${fmtRatio(precision)}\n` +
      `  recall     ${fmtRatio(recall)}\n` +
      `  f1         ${fmtRatio(f1)}\n`,
  );
}

// ── publish: the metric SINK ─────────────────────────────────────────────────
// Same app data dir the tracker, todos CLI, hook, and triage use; the metrics
// file lives next to todos.json so the app (and any external consumer) finds it
// without extra config. Mirrors triage.mjs::digestPath.
function metricsPath() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(
    appData,
    "com.claude-usage-tracker.app",
    "corrections-metrics.json",
  );
}

// Atomic write (temp + rename), matching triage.mjs / todos.mjs, so a partial
// write can never leave the app reading a half file.
function saveAtomic(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

// `publish` computes the metric over a scope and writes it to the sink file the
// app watches. This is what turns `scan` (stdout-only) into an actual OUTPUT.
// Scope: default = current project, --all = every project, --project <name>.
function cmdPublish(args) {
  const f = parseFlags(args);
  const targets = resolveTranscripts({ project: f.project, all: f.all });

  // Analyze + stamp each session's mtime so the app can show "recent" first.
  const analyzed = targets
    .map((t) => {
      const r = analyzeSession(t.session, t.file, t.projectDir);
      let mtime = null;
      try {
        mtime = statSync(t.file).mtime.toISOString();
      } catch {
        // File vanished mid-run — keep the analysis, drop the timestamp.
      }
      const llm = r.candidates.filter((c) => c.faultHint === "likely-llm").length;
      return {
        session: r.session,
        project_dir: r.projectDir,
        project: r.project,
        modified_at: mtime,
        stats: r.stats,
        likely_llm: llm,
        ambiguous: r.candidates.length - llm,
      };
    })
    // Only sessions the user actually spoke in — empty transcripts are noise.
    .filter((s) => s.stats.user_turns > 0)
    .sort((a, b) => String(b.modified_at || "").localeCompare(String(a.modified_at || "")));

  // Totals over the whole scope (not just the listed sessions).
  const T = analyzed.reduce(
    (acc, s) => {
      acc.assistant_turns += s.stats.assistant_turns;
      acc.user_turns += s.stats.user_turns;
      acc.candidate_corrections += s.stats.candidate_corrections;
      acc.done_claims += s.stats.done_claims;
      acc.rework_after_done += s.stats.rework_after_done;
      acc.likely_llm += s.likely_llm;
      acc.ambiguous += s.ambiguous;
      return acc;
    },
    {
      assistant_turns: 0,
      user_turns: 0,
      candidate_corrections: 0,
      done_claims: 0,
      rework_after_done: 0,
      likely_llm: 0,
      ambiguous: 0,
    },
  );
  const totals = {
    sessions: analyzed.length,
    ...T,
    corrections_per_session:
      T.assistant_turns > 0 ? T.candidate_corrections / T.assistant_turns : null,
    rework_after_done_rate:
      T.done_claims > 0 ? T.rework_after_done / T.done_claims : null,
  };

  const project = f.all
    ? null
    : f.project || path.basename(process.cwd().replace(/[\\/]+$/, ""));

  const doc = {
    version: 1, // on-disk file schema (mirrored by src-tauri/src/corrections.rs)
    contract_version: CONTRACT_VERSION,
    kind: "corrections.metrics",
    generated_at: new Date().toISOString(),
    scope: f.all ? "all" : "project",
    project,
    totals,
    sessions: analyzed,
  };

  const file = metricsPath();
  saveAtomic(file, doc);
  process.stdout.write(
    `ok: published metrics (${totals.sessions} session(s), ` +
      `${totals.candidate_corrections} candidate(s)) -> ${file}\n`,
  );
}

function usage(code) {
  process.stdout.write(
    "cli corrections - public contract for user-correction signals (t#101)\n\n" +
      "  scan [<session>] [--project <name>|--all] [--json] [--candidates]\n" +
      "        per-session candidate corrections + stats (layer-1 upper bound)\n" +
      "  label-template <session> [--out <file>]\n" +
      "        emit every real user turn (+evidence) for hand-labeling (holdout)\n" +
      "  eval --labels <file> [--json]\n" +
      "        score layer-1 precision/recall against a filled worksheet\n" +
      "  publish [--project <name>|--all]\n" +
      "        compute the metric over a scope and write corrections-metrics.json\n" +
      "        (the sink the tracker watches; next to todos.json)\n\n" +
      "  --json emits the versioned wire contract (see docs/corrections-contract.md).\n" +
      "  Build your own integration: docs/corrections-integration.md\n" +
      "  https://github.com/DamirSadykov/Claude-Usage-Tracker-Windows/wiki/Corrections-Integration\n",
  );
  process.exit(code);
}

export function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "scan":
      cmdScan(rest);
      break;
    case "label-template":
      cmdLabelTemplate(rest);
      break;
    case "eval":
      cmdEval(rest);
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
