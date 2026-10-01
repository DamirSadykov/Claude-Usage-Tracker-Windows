// `cli trace` reads the restart-point dataset written by Rust.  Keep the wire
// names below literal: Node is a reader of that dataset, not its schema owner.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appDataFile, writeJsonAtomic } from "../kernel/appdata.mjs";
import { loadBoard } from "../kernel/board-io.mjs";

const pointsPath = () => appDataFile("restart-points.jsonl");
const sessionsPath = () => appDataFile("task-sessions.jsonl");

function readJsonl(file) {
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch { return []; }
}

// A record is valid only with Rust's actual key fields. Do not add compatibility
// aliases here: a changed Rust wire format must be noticed, not guessed at.
export function readRestartPoints(file = pointsPath()) {
  return readJsonl(file).filter((r) =>
    r && typeof r.session === "string" && typeof r.task === "string" &&
    r.observed && Array.isArray(r.observed.ctx) && Array.isArray(r.scenarios),
  );
}

export function readTaskSessions(file = sessionsPath()) {
  return readJsonl(file).filter((r) => r && typeof r.session === "string" && typeof r.task === "string");
}

export function latestBySessionTask(records) {
  const out = new Map();
  for (const record of records) out.set(`${record.session}\u0000${record.task}`, record);
  return out;
}

function firstEditContext(point) {
  const { observed } = point;
  if (Number.isFinite(observed.ctxAtFirstEdit)) return observed.ctxAtFirstEdit;
  // Rust numbers calls from one, so firstEditCall: 2 means ctx[1].
  if (Number.isInteger(observed.firstEditCall) && observed.firstEditCall >= 1)
    return observed.ctx[observed.firstEditCall - 1];
  return undefined;
}

function roleFor(point, events) {
  if (typeof point.role === "string" && point.role) return point.role;
  // The session journal calls this `agent`; only use the matching task row.
  return [...events].reverse().find((e) => e.session === point.session && e.task === point.task && typeof e.agent === "string")?.agent || "unknown";
}

function quantile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * fraction;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function fmtPct(n) { return `${Number(n).toFixed(1)}%`; }
function taskLabel(record) { return record.task_number ? `t#${record.task_number}` : record.task; }

function scenarioSummary(point) {
  const scenarios = [...point.scenarios].filter((s) => Number.isFinite(s.rho) && Number.isFinite(s.savePct)).sort((a, b) => a.rho - b.rho);
  if (!scenarios.length) return "не посчитано";
  const low = scenarios[0], mid = scenarios[Math.floor(scenarios.length / 2)], high = scenarios[scenarios.length - 1];
  const h = point.params?.h, R = point.params?.R;
  return `экономия входа, сценарий: ${fmtPct(low.savePct)}–${fmtPct(high.savePct)} (медиана ${fmtPct(mid.savePct)}; ρ=${low.rho}/${mid.rho}/${high.rho}, h=${h}, R=${R})`;
}

function resolveTasks(token) {
  if (!token || token === "--all") return null;
  const board = loadBoard();
  if (/^c#\d+$/i.test(token)) {
    const n = Number(token.slice(2));
    const change = (board.changes || []).find((c) => c && c.number === n);
    if (!change) return new Set();
    return new Set((board.todos || []).filter((t) => t?.change_id === change.id).map((t) => t.id));
  }
  const bare = token.replace(/^t?#/i, "");
  const todo = (board.todos || []).find((t) => t && (t.id === token || t.number === Number(bare)));
  return todo ? new Set([todo.id]) : new Set([bare]); // permits a journal-only task id
}

export function buildRestartReport({ points, events, taskIds = null, session = null }) {
  const latest = latestBySessionTask(points);
  const candidates = new Map();
  for (const point of latest.values()) {
    if ((!taskIds || taskIds.has(point.task)) && (!session || point.session === session)) candidates.set(`${point.session}\u0000${point.task}`, { session: point.session, task: point.task, point });
  }
  for (const event of events) {
    if ((!taskIds || taskIds.has(event.task)) && (!session || event.session === session)) {
      const key = `${event.session}\u0000${event.task}`;
      if (!candidates.has(key)) candidates.set(key, { session: event.session, task: event.task, point: latest.get(key) || null });
    }
  }
  return [...candidates.values()].sort((a, b) => `${a.session}\0${a.task}`.localeCompare(`${b.session}\0${b.task}`)).map((row) => ({
    session: row.session, task: row.point ? taskLabel(row.point) : row.task, role: row.point ? roleFor(row.point, events) : "unknown",
    calls: row.point?.observed.calls ?? null, first_edit_call: row.point?.observed.firstEditCall ?? null,
    scenarios: row.point?.scenarios ?? null, params: row.point?.params ?? null, computed: !!row.point,
  }));
}

export function calibrate(points, events) {
  const latest = latestBySessionTask(points);
  const starts = events.filter((e) => e.event === "start" && e.agent === "worker");
  const byTask = new Map();
  for (const start of starts) {
    const rows = byTask.get(start.task) || []; rows.push(start); byTask.set(start.task, rows);
  }
  const accepted = [], dropped = {};
  const drop = (reason) => { dropped[reason] = (dropped[reason] || 0) + 1; };
  for (const [task, rows] of byTask) {
    rows.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
    for (let i = 1; i < rows.length; i++) {
      const previous = latest.get(`${rows[i - 1].session}\u0000${task}`);
      const next = latest.get(`${rows[i].session}\u0000${task}`);
      if (!previous || !next) { drop("missing_restart_point"); continue; }
      const before0 = previous.observed.ctx[0], beforeLast = previous.observed.ctx.at(-1);
      const next0 = next.observed.ctx[0], nextEdit = firstEditContext(next);
      const denominator = beforeLast - before0;
      if (![before0, beforeLast, next0, nextEdit].every(Number.isFinite)) { drop("missing_context"); continue; }
      if (denominator <= 0) { drop("nonpositive_prior_growth"); continue; }
      const rho = (nextEdit - next0) / denominator;
      if (!Number.isFinite(rho) || rho < 0 || rho > 1) { drop("rho_out_of_range"); continue; }
      accepted.push(rho);
    }
  }
  accepted.sort((a, b) => a - b);
  return { rhos: accepted.length ? [quantile(accepted, .25), quantile(accepted, .5), quantile(accepted, .75)] : [], pairs: accepted.length, total: accepted.length + Object.values(dropped).reduce((a, b) => a + b, 0), dropped };
}

function cmdRestart(args) {
  let json = false, session = null, token = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--session") session = args[++i];
    else if (!token) token = args[i];
    else throw new Error(`unexpected argument: ${args[i]}`);
  }
  if (!token && !session) throw new Error("usage: cli trace restart <task|c#N|--session id|--all> [--json]");
  const rows = buildRestartReport({ points: readRestartPoints(), events: readTaskSessions(), taskIds: resolveTasks(token), session });
  if (json) return process.stdout.write(JSON.stringify({ sessions: rows }, null, 2) + "\n");
  for (const row of rows) {
    if (!row.computed) process.stdout.write(`${row.session} ${row.task}: не посчитано\n`);
    else process.stdout.write(`${row.session} ${row.task}: роль=${row.role}; вызовы=${row.calls}; первая правка=${row.first_edit_call}; k=${row.scenarios.map((s) => s.k ?? "—").join("/")}; ${scenarioSummary({ scenarios: row.scenarios, params: row.params })}\n`);
  }
  if (!rows.length) process.stdout.write("не посчитано\n");
}

function cmdCalibrate(args) {
  const json = args.includes("--json");
  const result = calibrate(readRestartPoints(), readTaskSessions());
  if (result.pairs) {
    const file = appDataFile("restart-calibration.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { rhos: result.rhos, pairs: result.pairs, computed_at: new Date().toISOString(), total: result.total, dropped: result.dropped });
  }
  if (json) return process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`пар всего: ${result.total}; принято: ${result.pairs}; отброшено: ${Object.entries(result.dropped).map(([k, v]) => `${k}=${v}`).join(", ") || "0"}\n`);
}

export function run(args) {
  const [command, ...rest] = args;
  if (command === "restart") return cmdRestart(rest);
  if (command === "calibrate") return cmdCalibrate(rest);
  throw new Error("usage: cli trace restart <task|c#N|--session id|--all> [--json] | calibrate [--json]");
}
