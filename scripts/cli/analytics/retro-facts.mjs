import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appDataDir, appDataFile, writeJsonAtomic } from "../kernel/appdata.mjs";
import { boardPath, changeAddress, findChange, loadBoard } from "../kernel/board-io.mjs";

const SHORT_INTERVAL_SECONDS = 30;
const READ_TOOLS = new Set(["Read", "read_file", "view_image"]);
const SUCCESSFUL_RUN_RESULTS = new Set(["ok", "done"]);

const taskNumber = (value) => Number(String(value ?? "").replace(/^t#/, ""));

function cutSignalText(value, limit = 600) {
  const text = value == null ? "" : String(value);
  if (text.length <= limit) return text;
  const suffix = `… [+${text.length - limit}]`;
  if (suffix.length >= limit) return text.slice(0, limit);
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}

function readJsonl(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

const isoTime = (value) => {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : null;
};

function humanText(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
      : "";
  if (!text.trim()) return null;
  if (/^\s*<(system-reminder|command-|local-command|task-notification)/.test(text)) return null;
  if (/^\s*\/(compact|clear|context|cost|model|resume|exit|config|help|status|usage|fast|memory|permissions)\b/i.test(text)) return null;
  return text;
}

const contextOf = (usage = {}) =>
  (usage.input_tokens || 0) +
  (usage.cache_read_input_tokens || 0) +
  (usage.cache_creation_input_tokens || 0);

function sampleCurve(curve, limit = 40) {
  if (curve.length <= limit) return curve;
  const indexes = new Set([0, curve.length - 1]);
  for (let i = 1; i < limit - 1; i++) indexes.add(Math.round((i * (curve.length - 1)) / (limit - 1)));
  return [...indexes].sort((a, b) => a - b).map((i) => curve[i]);
}

export function parseRetroTranscript(raw) {
  const events = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }

  const human = [];
  const assistantTimes = [];
  const messageIds = new Set();
  const toolCounts = {};
  const reads = new Map();
  const curve = [];
  const interruptions = [];
  const delegations = [];
  const turns = new Map();
  let first = null;
  let last = null;
  let output = 0;
  let compactions = 0;

  for (const event of events) {
    const ts = typeof event.timestamp === "string" ? event.timestamp : null;
    if (ts && (!first || ts < first)) first = ts;
    if (ts && (!last || ts > last)) last = ts;
    if (event.isCompactSummary || (event.type === "system" && /compact/i.test(event.subtype || ""))) compactions++;

    if (event.type === "user" && !event.isMeta && !event.isCompactSummary && !event.isSidechain) {
      const content = event.message?.content;
      const text = humanText(content);
      if (text && /\[Request interrupted/i.test(text)) interruptions.push(ts);
      else if (text && !(Array.isArray(content) && content.some((b) => b?.type === "tool_result")))
        human.push({ ts, text: text.slice(0, 600) });
    }

    if (event.type !== "assistant") continue;
    if (ts) assistantTimes.push(ts);
    const usage = event.message?.usage;
    const id = event.message?.id || `${ts || ""}:${curve.length}`;
    let turn = turns.get(id);
    if (!turn) {
      turn = { id, turn: turns.size + 1, ts, model: event.message?.model || event.model || null, usage: null, has_tool_use: false };
      turns.set(id, turn);
    }
    if (!turn.model) turn.model = event.message?.model || event.model || null;
    if (usage && !messageIds.has(id)) {
      messageIds.add(id);
      turn.usage = usage;
      const context = contextOf(usage);
      output += usage.output_tokens || 0;
      curve.push({ turn: messageIds.size, ts, context_k: Math.round(context / 1000) });
    }
    for (const block of event.message?.content || []) {
      if (block?.type !== "tool_use") continue;
      turn.has_tool_use = true;
      const name = String(block.name || "unknown");
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      const input = block.input || {};
      if (READ_TOOLS.has(name)) {
        const file = input.file_path || input.path;
        if (typeof file === "string" && file) reads.set(file, (reads.get(file) || 0) + 1);
      }
      if (name === "Agent" || name === "Task")
        delegations.push({ ts, kind: "agent", model: input.model || null, description: input.description || null });
      if (name === "Bash" && /\bcodex(?:\.exe)?\b/i.test(input.command || ""))
        delegations.push({ ts, kind: "codex", description: String(input.command).slice(0, 160) });
    }
  }

  const humanMessages = human.map((message, index) => {
    const next = human[index + 1]?.ts;
    const actions = assistantTimes.filter((ts) => ts >= message.ts && (!next || ts < next));
    const end = actions.at(-1) || message.ts;
    const startMs = isoTime(message.ts);
    const endMs = isoTime(end);
    const nextMs = isoTime(next);
    return {
      ...message,
      active_seconds: startMs !== null && endMs !== null ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null,
      human_wait_seconds: nextMs !== null && endMs !== null ? Math.max(0, Math.round((nextMs - endMs) / 1000)) : null,
    };
  });
  const repeated = [...reads].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const peak = curve.reduce((n, item) => Math.max(n, item.context_k), 0);
  const measuredTurns = [...turns.values()].filter((turn) => turn.usage)
    .map((turn, index) => ({ ...turn, turn: index + 1 }));
  const cacheCreate = measuredTurns.reduce((n, turn) => n + (turn.usage.cache_creation_input_tokens || 0), 0);
  const cacheRead = measuredTurns.reduce((n, turn) => n + (turn.usage.cache_read_input_tokens || 0), 0);
  const cachedInput = cacheCreate + cacheRead;
  const modelSequence = measuredTurns.map((turn) => turn.model).filter(Boolean);
  const modelTransitions = [];
  for (let i = 1; i < modelSequence.length; i++) {
    if (modelSequence[i] !== modelSequence[i - 1]) modelTransitions.push({ turn: i + 1, from: modelSequence[i - 1], to: modelSequence[i] });
  }
  const coldStarts = measuredTurns.filter((turn) => turn.turn > 1
    && (turn.usage.cache_read_input_tokens || 0) === 0
    && (turn.usage.cache_creation_input_tokens || 0) > 10_000);
  const verboseTurns = measuredTurns.filter((turn) => (turn.usage.output_tokens || 0) > 5_000 && !turn.has_tool_use);
  return {
    first,
    last,
    assistant_turns: messageIds.size,
    peak_context_k: peak,
    context_cumulative_m: Math.round(curve.reduce((n, item) => n + item.context_k, 0) / 1000),
    output_k: Math.round(output / 1000),
    cache_create: cacheCreate,
    cache_read: cacheRead,
    cache_create_share_pct: cachedInput ? Math.round((cacheCreate / cachedInput) * 1000) / 10 : null,
    models: [...new Set(modelSequence)],
    model_change_count: modelTransitions.length,
    model_changes: modelTransitions,
    cold_starts: coldStarts.map((turn) => ({
      turn: turn.turn, ts: turn.ts,
      cache_read: turn.usage.cache_read_input_tokens || 0,
      cache_create: turn.usage.cache_creation_input_tokens || 0,
    })),
    verbose_turns_without_tools: verboseTurns.map((turn) => ({
      turn: turn.turn, ts: turn.ts, output_tokens: turn.usage.output_tokens || 0,
    })),
    compactions,
    interruptions: interruptions.filter(Boolean),
    delegations,
    human_messages: humanMessages,
    tools: Object.fromEntries(Object.entries(toolCounts).sort(([a], [b]) => a.localeCompare(b))),
    distinct_read_paths: reads.size,
    repeated_paths: repeated.map(([file, count]) => ({ path: file, count })),
    context_curve: sampleCurve(curve),
  };
}

export function bindingIntervals(events, taskNumbers) {
  const rows = (events || [])
    .filter((e) => e && taskNumbers.has(e.task) && e.session && e.ts && (e.event === "start" || e.event === "end"))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.session).localeCompare(String(b.session)));
  const open = new Map();
  const intervals = [];
  const close = (entry, end) => {
    const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(entry.ts)) / 1000));
    intervals.push({
      task: `t#${taskNumbers.get(entry.task)}`,
      session: entry.session,
      start: entry.ts,
      end,
      seconds,
      empty: seconds < SHORT_INTERVAL_SECONDS,
      source: entry.source || null,
      agent: entry.agent || null,
    });
  };
  for (const row of rows) {
    const prior = open.get(row.session);
    if (prior && (row.event === "start" || row.task === prior.task)) {
      close(prior, row.ts);
      open.delete(row.session);
    }
    if (row.event === "start") open.set(row.session, row);
  }
  for (const entry of open.values()) intervals.push({
    task: `t#${taskNumbers.get(entry.task)}`,
    session: entry.session,
    start: entry.ts,
    end: null,
    seconds: null,
    empty: false,
    source: entry.source || null,
    agent: entry.agent || null,
  });
  return intervals.sort((a, b) => a.start.localeCompare(b.start) || a.session.localeCompare(b.session));
}

function projectRoots(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
  } catch { return []; }
}

function defaultTranscriptRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return home ? path.join(home, ".claude", "projects") : null;
}

export function findTranscript(session, root = defaultTranscriptRoot()) {
  if (!session || !root) return null;
  for (const dir of projectRoots(root)) {
    const file = path.join(dir, `${session}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function subagentFacts(mainFile) {
  const session = path.basename(mainFile, ".jsonl");
  const dir = path.join(path.dirname(mainFile), session, "subagents");
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort(); } catch { return []; }
  return names.map((name) => {
    const id = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(dir, name.replace(/\.jsonl$/, ".meta.json")), "utf8")); } catch {}
    const parsed = parseRetroTranscript(readFileSync(path.join(dir, name), "utf8"));
    return {
      agent_id: meta.agent_id || meta.agentId || id,
      model: meta.model || null,
      description: meta.description || null,
      started: parsed.first,
      ended: parsed.last,
      assistant_turns: parsed.assistant_turns,
      peak_context_k: parsed.peak_context_k,
      context_cumulative_m: parsed.context_cumulative_m,
      compactions: parsed.compactions,
      interruptions: parsed.interruptions.length,
      repeated_reads: parsed.repeated_paths.reduce((n, item) => n + item.count - 1, 0),
    };
  });
}

function commitsFor(changeNumber, repo) {
  try {
    const raw = execFileSync("git", ["-C", repo, "log", "--all", "--fixed-strings", "--grep", `c#${changeNumber}`, "--date=iso-strict", "--format=%H%x09%ad%x09%s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, date, ...subject] = line.split("\t");
      return { sha, date, subject: subject.join("\t") };
    });
  } catch { return []; }
}

function runsFor(records, change, taskNumbers) {
  const number = Number(change.number);
  const memberNumbers = new Set(taskNumbers.values());
  return (records || []).filter((record) => {
    const n = Number(record?.change?.number ?? String(record?.change || "").replace(/^c#/, ""));
    return n === number || (record?.steps || []).some((step) => memberNumbers.has(taskNumber(step?.task)));
  }).map((record) => ({
    ts: record.ts || null,
    complete: !!record.complete,
    one_pass: !!record.one_pass,
    stop: record.stop || null,
    steps: (record.steps || []).map((step) => ({
      task: step.task == null ? null : `t#${taskNumber(step.task)}`,
      attempt: step.attempt ?? null,
      result: step.result ?? null,
      reason: step.reason ?? null,
      verify: step.verify ?? null,
      session: step.session ?? null,
      provider: step.provider ?? null,
      model: step.model ?? null,
      cost_usd: Number.isFinite(step.cost_usd) ? step.cost_usd : null,
      worker_cost_usd: Number.isFinite(step.worker_cost_usd) ? step.worker_cost_usd : null,
      review: step.review ?? null,
    })),
  }));
}

function completionChains(tasks, runs) {
  return tasks.map((task) => {
    const number = Number(task.number);
    const runnerAttempts = [];
    const stops = [];
    for (const [runIndex, run] of runs.entries()) {
      for (const step of run.steps || []) {
        if (taskNumber(step.task) !== number) continue;
        runnerAttempts.push({
          run: runIndex + 1,
          run_ts: run.ts,
          attempt: step.attempt,
          result: step.result,
          verify: step.verify,
          review_approved: step.review?.approved ?? null,
          cost_usd: step.cost_usd,
        });
      }
      if (taskNumber(run.stop?.task) === number) stops.push({ run: runIndex + 1, ts: run.ts, ...run.stop });
    }

    const history = Array.isArray(task.status_history) ? task.status_history : [];
    const done = [...history].reverse().find((entry) => entry?.status === "done");
    const process = task.ext?.process || {};
    const successfulAttempt = runnerAttempts.some((attempt) => SUCCESSFUL_RUN_RESULTS.has(attempt.result));
    const outcomeMs = isoTime(process.outcome_at);
    const doneMs = isoTime(done?.at);
    const runnerOutcomeMatches = process.outcome === "ok"
      && outcomeMs !== null
      && doneMs !== null
      && Math.abs(outcomeMs - doneMs) <= 10_000;
    const kind = task.kind ?? "manual";
    let closedBy = `not_closed:${task.status}`;
    if (done) {
      if (kind === "manual") closedBy = "human_gate";
      else if (successfulAttempt && runnerOutcomeMatches) closedBy = "runner";
      else if (runnerAttempts.length) closedBy = "outside_runner_after_runner_attempts";
      else closedBy = "session";
    }

    return {
      task: `t#${number}`,
      kind,
      outcome: process.outcome ?? null,
      outcome_reason: process.outcome_reason ?? null,
      subject: task.subject,
      closed_by: closedBy,
      done_at: done?.at ?? null,
      runner_attempts: runnerAttempts,
      stops,
      status_history: history.map((entry) => `${entry.at} ${entry.status}`),
    };
  });
}

function signalRegistry(tasks, runs, sessions, changeNumber) {
  const signals = [];
  const add = (kind, task, at, text, ref) => signals.push({
    id: `s${String(signals.length + 1).padStart(3, "0")}`,
    kind,
    task,
    at: at ?? null,
    ref,
    text: cutSignalText(text),
  });

  for (const task of tasks) {
    const ref = `t#${task.number}`;
    for (const [commentIndex, comment] of (task.comments || []).entries()) {
      add(
        `comment:${comment.author ?? "?"}`,
        ref,
        comment.at ?? comment.created_at ?? null,
        comment.body,
        `todos.json ${ref} comments[${commentIndex}]`,
      );
    }
    if (task.handoff) add("handoff", ref, task.handoff_at, task.handoff, `todos.json ${ref} handoff`);
    if (task.description && /не |ошиб|сбой|fail|error/i.test(task.description)) {
      add("description", ref, task.created_at, task.description, `todos.json ${ref} description`);
    }
    for (const [runIndex, run] of runs.entries()) {
      for (const step of run.steps || []) {
        if (taskNumber(step.task) !== Number(task.number) || SUCCESSFUL_RUN_RESULTS.has(step.result)) continue;
        add(
          `run:${step.result}`,
          ref,
          run.ts,
          step.reason,
          `runs.jsonl c#${changeNumber} run ${runIndex + 1} attempt ${step.attempt}`,
        );
      }
    }
  }
  for (const session of Object.keys(sessions).sort()) {
    const facts = sessions[session];
    for (const message of facts.human_messages || []) {
      add("human_message", null, message.ts, message.text, `session ${session} ${message.id}`);
    }
    for (const at of facts.interruptions || []) add("interruption", null, at, "", `session ${session}`);
  }
  return signals;
}

function factsCoverage(tasks, runs, sessions, chains) {
  const closedBy = {};
  for (const chain of chains) closedBy[chain.closed_by] = (closedBy[chain.closed_by] || 0) + 1;
  return {
    tasks: tasks.length,
    runner_steps: runs.reduce((count, run) => count + (run.steps || []).length, 0),
    interactive_sessions_read: Object.keys(sessions).length,
    runner_sessions_read: 0,
    closed_by: closedBy,
    cannot_claim: [
      "контекст и действия исполнителей раннера: rollout codex не прочитан",
      "автор ручных переходов статуса: история статусов не хранит актора",
    ],
  };
}

function costsByRole(runs) {
  const roles = { worker: { cost_usd: 0, measured: 0 }, reviewer: { cost_usd: 0, measured: 0 } };
  for (const run of runs) for (const step of run.steps) {
    const reviewCost = step.review?.cost_usd ?? step.review?.costUsd;
    const workerCost = Number.isFinite(step.worker_cost_usd)
      ? step.worker_cost_usd
      : Number.isFinite(step.cost_usd)
        ? Math.max(0, step.cost_usd - (Number.isFinite(reviewCost) ? reviewCost : 0))
        : null;
    if (Number.isFinite(workerCost)) { roles.worker.cost_usd += workerCost; roles.worker.measured++; }
    if (Number.isFinite(reviewCost)) { roles.reviewer.cost_usd += reviewCost; roles.reviewer.measured++; }
  }
  for (const role of Object.values(roles)) role.cost_usd = Math.round(role.cost_usd * 1e6) / 1e6;
  return roles;
}

function negativeComponents(facts) {
  const out = [];
  for (const run of facts.runs) {
    if (run.stop) out.push({ kind: "park", stop: run.stop.kind || null, task: run.stop.task || null });
    for (const step of run.steps) {
      if ((step.attempt || 0) > 1) out.push({ kind: "retry", task: step.task, attempt: step.attempt });
      if (step.verify === "issue" || step.result === "issue") out.push({ kind: "failed_step", task: step.task });
    }
  }
  for (const task of facts.tasks) for (const attempt of task.attempts || []) {
    for (const finding of attempt.findings || []) {
      if (finding?.level === "critical" || finding?.level === "high")
        out.push({ kind: "blocking_finding", task: task.task, level: finding.level, text: finding.text || null });
    }
  }
  return out;
}

export function summarizeRetroFacts(facts) {
  const sessions = Object.values(facts.sessions || {});
  const components = facts.negative_components || negativeComponents(facts);
  return {
    tasks: facts.tasks.length,
    sessions: sessions.length,
    human_messages: sessions.reduce((n, s) => n + s.human_messages.length, 0),
    bindings: facts.bindings.length,
    empty_bindings: facts.bindings.filter((b) => b.empty).length,
    subagents: sessions.reduce((n, s) => n + s.subagents.length, 0),
    interruptions: sessions.reduce((n, s) => n + s.interruptions.length, 0),
    compactions: sessions.reduce((n, s) => n + s.compactions, 0),
    attempts: facts.runs.reduce((n, r) => n + r.steps.length, 0),
    parks: facts.runs.filter((r) => r.stop).length,
    commits: facts.commits.length,
    cost_by_role: facts.cost_by_role,
    negative_components: components.length,
  };
}

export function buildRetroFacts({ board, change, taskSessionEvents = [], runRecords = [], transcripts = new Map(), commits = [] }) {
  const tasks = (board.todos || []).filter((task) => task?.change_id === change.id).sort((a, b) => (a.number || 0) - (b.number || 0));
  const taskNumbers = new Map(tasks.map((task) => [task.id, task.number]));
  const bindings = bindingIntervals(taskSessionEvents, taskNumbers);
  const sessionIds = [...new Set(bindings.map((b) => b.session))].sort();
  const sessions = {};
  let messageNumber = 0;
  for (const session of sessionIds) {
    const source = transcripts.get(session);
    if (!source) continue;
    let sourceIsFile = false;
    try { sourceIsFile = typeof source === "string" && existsSync(source); } catch {}
    const raw = sourceIsFile ? readFileSync(source, "utf8") : String(source || "");
    const parsed = parseRetroTranscript(raw);
    for (const message of parsed.human_messages) message.id = `m${String(++messageNumber).padStart(2, "0")}`;
    parsed.subagents = sourceIsFile ? subagentFacts(source) : [];
    sessions[session] = parsed;
  }
  const runs = runsFor(runRecords, change, taskNumbers);
  const chains = completionChains(tasks, runs);
  const signals = signalRegistry(tasks, runs, sessions, change.number);
  const allSessions = Object.values(sessions);
  const facts = {
    version: 2,
    change: { number: change.number, title: change.title, project: change.project ?? null, created_at: change.created_at ?? null, closed_at: change.closed_at ?? null },
    tasks: tasks.map((task) => ({
      task: `t#${task.number}`,
      subject: task.subject,
      status: task.status,
      kind: task.kind || null,
      risk: task.risk || task.ext?.process?.risk || null,
      verify: task.verify || task.ext?.process?.verify || null,
      status_history: task.status_history || [],
      attempts: task.attempts || [],
      comments: (task.comments || []).length,
      handoff: String(task.handoff || "").slice(0, 400),
    })),
    bindings,
    window: {
      from: allSessions.map((s) => s.first).filter(Boolean).sort()[0] || null,
      to: allSessions.map((s) => s.last).filter(Boolean).sort().at(-1) || null,
    },
    sessions,
    runs,
    completion_chains: chains,
    signals,
    coverage: factsCoverage(tasks, runs, sessions, chains),
    commits,
    cost_by_role: costsByRole(runs),
  };
  facts.negative_components = negativeComponents(facts);
  facts.summary = summarizeRetroFacts(facts);
  return facts;
}

export function retroFactsPath(changeNumber, appData) {
  return path.join(appDataDir(appData), "retro", `c${changeNumber}-facts.json`);
}

function safeSessionId(session) {
  const value = String(session || "").trim();
  if (!value || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("session must be a transcript GUID");
  return value;
}

export function sessionRetroFactsPath(session, appData) {
  return path.join(appDataDir(appData), "retro", `session-${safeSessionId(session)}-facts.json`);
}

export function collectSessionRetroFacts({ session, appData, transcriptRoot, write = true } = {}) {
  const id = safeSessionId(session);
  const transcript = findTranscript(id, transcriptRoot);
  if (!transcript) throw new Error(`refusing: no transcript for session ${id}`);
  const parsed = parseRetroTranscript(readFileSync(transcript, "utf8"));
  const facts = {
    version: 1,
    scope: "session",
    session: id,
    transcript,
    ...parsed,
    subagents: [],
    negative_components: [],
    summary: {
      sessions: 1,
      assistant_turns: parsed.assistant_turns,
      peak_context_k: parsed.peak_context_k,
      cache_create_share_pct: parsed.cache_create_share_pct,
      model_change_count: parsed.model_change_count,
      cold_starts: parsed.cold_starts.length,
      verbose_turns_without_tools: parsed.verbose_turns_without_tools.length,
      repeated_reads: parsed.repeated_paths.reduce((n, item) => n + item.count - 1, 0),
      compactions: parsed.compactions,
      interruptions: parsed.interruptions.length,
    },
  };
  const file = sessionRetroFactsPath(id, appData);
  if (write) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, facts);
  }
  return { facts, file, summary: facts.summary };
}

export function collectRetroFacts({ board = loadBoard(boardPath()), change, appData, transcriptRoot, repo = process.cwd(), write = true } = {}) {
  if (!change) throw new Error("a change is required");
  const events = readJsonl(appDataFile("task-sessions.jsonl", appData));
  const runs = readJsonl(appDataFile("runs.jsonl", appData));
  const taskIds = new Set((board.todos || []).filter((t) => t?.change_id === change.id).map((t) => t.id));
  const sessions = [...new Set(events.filter((e) => taskIds.has(e.task)).map((e) => e.session))].sort();
  const transcripts = new Map();
  for (const session of sessions) {
    const file = findTranscript(session, transcriptRoot);
    if (file) transcripts.set(session, file);
  }
  const facts = buildRetroFacts({
    board,
    change,
    taskSessionEvents: events,
    runRecords: runs,
    transcripts,
    commits: commitsFor(change.number, repo),
  });
  const file = retroFactsPath(change.number, appData);
  if (write) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, facts);
  }
  return { facts, file, summary: facts.summary };
}

function resolveChange(board, ref) {
  const change = findChange(board, ref);
  if (!change || change.legacy) throw new Error(`refusing: no change ${ref}`);
  return change;
}

export async function run(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const json = args.includes("--json");
  if (!positional[0]) throw new Error("usage: cli change retro-facts <c#N> [--json]");
  const board = loadBoard(boardPath());
  const change = resolveChange(board, positional[0]);
  const result = collectRetroFacts({ board, change });
  if (json) process.stdout.write(JSON.stringify(result.facts, null, 2) + "\n");
  else process.stdout.write(`ok: ${changeAddress(change)} retro facts — ${result.summary.negative_components} negative component(s)\n${result.file}\n`);
}
