import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { invokeDutySync } from "../agents/agents.mjs";
import { appDataDir } from "../kernel/appdata.mjs";
import {
  boardPath,
  changeAddress,
  findChange,
  loadBoard,
  loadBoardForWrite,
  saveBoard,
} from "../kernel/board-io.mjs";
import { withBoardLock } from "../kernel/board-lock.mjs";
import { collectRetroFacts, collectSessionRetroFacts } from "./retro-facts.mjs";

export const PROPOSAL_TYPES = ["процесс", "инвариант проекта"];
export const PROPOSAL_ADDRESSEES = ["architect", "critic", "worker", "review", "human"];
export const EPISODE_OUTCOMES = ["fixed", "deferred", "open", "by_design", "insufficient"];
export const RECOGNIZERS = ["worker", "review", "check", "user"];
export const INTERVENTIONS = ["fulfil_requirement", "deliver_existing_rule", "add_check", "new_rule"];
export const RETRO_OUTPUT_CONTRACT = `Верни только один JSON-объект без markdown-ограды:
{
  "report": "Markdown-отчёт",
  "episodes": [{"id":"e1","expected":"…","observed":"…","signal_refs":["s001"],"outcome":"fixed|deferred|open|by_design|insufficient","detection_gap":{"observable":"s007|null","recognized":{"signal":"s007|null","by":"worker|review|check|user|null"},"reached_user":"s033|null","why_late":"…|null"}}],
  "signal_dispositions": {"s001":"e1","s002":"noise","s003":"no_data"},
  "proposals": [{"type":"процесс|инвариант проекта","addressee":"architect|critic|worker|review|human","what":"…","episode_refs":["e1"],"intervention":"fulfil_requirement|deliver_existing_rule|add_check|new_rule","evidence":"…","measure":{"cases":"…","baseline":"…","observe":"…","source":"…","fails_if":"…"}}]
}
Все поля обязательны, кроме явно допускающих null. Допустимо не больше шести предложений.`;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requiredString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function nullableSignal(value, knownSignals) {
  if (value === null) return null;
  const signal = requiredString(value);
  return signal && (!knownSignals || knownSignals.has(signal)) ? signal : undefined;
}

export function parseRetroOutput(output, facts = {}) {
  const raw = String(output ?? "").trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    const envelope = object(value);
    const report = requiredString(envelope?.report);
    if (!report || !Array.isArray(envelope.episodes) || !object(envelope.signal_dispositions) ||
        !Array.isArray(envelope.proposals) || envelope.proposals.length > 6) continue;
    const factSignalIds = Array.isArray(facts?.signals)
      ? facts.signals.map((signal) => requiredString(signal?.id)).filter(Boolean)
      : null;
    const knownSignals = factSignalIds ? new Set(factSignalIds) : null;
    const episodeIds = new Set();
    const episodes = [];
    let valid = true;
    for (const rawEpisode of envelope.episodes) {
      const episode = object(rawEpisode);
      const id = requiredString(episode?.id);
      const expected = requiredString(episode?.expected);
      const observed = requiredString(episode?.observed);
      const outcome = requiredString(episode?.outcome);
      const gap = object(episode?.detection_gap);
      const recognized = object(gap?.recognized);
      const observable = nullableSignal(gap?.observable, knownSignals);
      const recognizedSignal = nullableSignal(recognized?.signal, knownSignals);
      const recognizedBy = recognized?.by === null ? null : requiredString(recognized?.by);
      const reachedUser = nullableSignal(gap?.reached_user, knownSignals);
      const whyLate = gap?.why_late === null ? null : requiredString(gap?.why_late);
      const signalRefs = Array.isArray(episode?.signal_refs)
        ? episode.signal_refs.map(requiredString)
        : [];
      if (!id || episodeIds.has(id) || !expected || !observed || !EPISODE_OUTCOMES.includes(outcome) ||
          signalRefs.length === 0 || signalRefs.some((ref) => !ref || (knownSignals && !knownSignals.has(ref))) ||
          !gap || !Object.hasOwn(gap, "observable") || !Object.hasOwn(gap, "recognized") ||
          !Object.hasOwn(gap, "reached_user") || !Object.hasOwn(gap, "why_late") || !recognized ||
          !Object.hasOwn(recognized, "signal") || !Object.hasOwn(recognized, "by") ||
          observable === undefined || recognizedSignal === undefined || reachedUser === undefined ||
          (gap.why_late !== null && !whyLate) ||
          (recognizedSignal === null ? recognizedBy !== null : !RECOGNIZERS.includes(recognizedBy))) {
        valid = false;
        break;
      }
      episodeIds.add(id);
      episodes.push({
        id, expected, observed, signal_refs: signalRefs, outcome,
        detection_gap: {
          observable,
          recognized: { signal: recognizedSignal, by: recognizedBy },
          reached_user: reachedUser,
          why_late: whyLate,
        },
      });
    }
    if (!valid) continue;

    const signalDispositions = {};
    const rawDispositions = envelope.signal_dispositions;
    const dispositionKeys = Object.keys(rawDispositions);
    if (knownSignals && (dispositionKeys.length !== knownSignals.size ||
        factSignalIds.some((id) => !Object.hasOwn(rawDispositions, id)) ||
        dispositionKeys.some((id) => !knownSignals.has(id)))) continue;
    for (const [signal, rawDisposition] of Object.entries(rawDispositions)) {
      const disposition = requiredString(rawDisposition);
      if (!disposition || (!["noise", "no_data"].includes(disposition) && !episodeIds.has(disposition))) {
        valid = false;
        break;
      }
      signalDispositions[signal] = disposition;
    }
    if (!valid) continue;

    const proposals = [];
    for (const rawProposal of envelope.proposals) {
      const proposal = object(rawProposal);
      const type = requiredString(proposal?.type);
      const addressee = requiredString(proposal?.addressee);
      const what = requiredString(proposal?.what);
      const episodeRefs = Array.isArray(proposal?.episode_refs)
        ? proposal.episode_refs.map(requiredString)
        : [];
      const intervention = requiredString(proposal?.intervention);
      const evidence = requiredString(proposal?.evidence);
      const rawMeasure = object(proposal?.measure);
      const measure = rawMeasure && {
        cases: requiredString(rawMeasure.cases),
        baseline: requiredString(rawMeasure.baseline),
        observe: requiredString(rawMeasure.observe),
        source: requiredString(rawMeasure.source),
        fails_if: requiredString(rawMeasure.fails_if),
      };
      if (!PROPOSAL_TYPES.includes(type) || !PROPOSAL_ADDRESSEES.includes(addressee) || !what || episodeRefs.length === 0 ||
          episodeRefs.some((id) => !id || !episodeIds.has(id)) || !INTERVENTIONS.includes(intervention) ||
          !evidence || !measure || Object.values(measure).some((field) => !field)) {
        valid = false;
        break;
      }
      proposals.push({ type, addressee, what, episode_refs: episodeRefs, intervention, evidence, measure });
    }
    if (valid) return { report, episodes, signal_dispositions: signalDispositions, proposals };
  }
  return null;
}

export function retroReportPath(changeNumber, appData) {
  return path.join(appDataDir(appData), "retro", `c${changeNumber}-report.md`);
}

export function retroSessionReportPath(session, appData) {
  return path.join(appDataDir(appData), "retro", `session-${session}-report.md`);
}

function writeTextAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  renameSync(tmp, file);
}

export function buildRetroPrompt({ factsFile, facts, change, session }) {
  const target = change ? `${changeAddress(change)}: ${change.title}` : `Сессия ${session}`;
  return `## Текущий объект\n\n${target}\n` +
    `Файл детерминированных фактов: ${factsFile}\n` +
    `Сводка фактов (для выбора аномалий):\n${JSON.stringify(facts.summary, null, 2)}\n` +
    `Отрицательные компоненты, выделенные кодом:\n${JSON.stringify(facts.negative_components, null, 2)}\n` +
    `Прочитай полный файл фактов и ничего не изменяй.\n\n## Контракт вывода\n\n${RETRO_OUTPUT_CONTRACT}`;
}

export function retroReadDirs(factsFile) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return [
    path.dirname(factsFile),
    ...(home ? [path.join(home, ".claude", "projects")] : []),
  ];
}

function resolveChange(board, ref) {
  const change = findChange(board, ref);
  if (!change || change.legacy) throw new Error(`refusing: no change ${ref}`);
  return change;
}

export function runRetro(ref, {
  appData,
  repo = process.cwd(),
  file = boardPath(),
  invoke = invokeDutySync,
  collectFacts = collectRetroFacts,
  idFactory = randomUUID,
  readBoard = loadBoard,
  readBoardForWrite = loadBoardForWrite,
  save = saveBoard,
  lock = withBoardLock,
  writeReport = writeTextAtomic,
} = {}) {
  const board = readBoard(file);
  const change = resolveChange(board, ref);
  const collected = collectFacts({ board, change, appData, repo });
  const prompt = buildRetroPrompt({ factsFile: collected.file, facts: collected.facts, change });
  const invoked = invoke("retro", prompt, {
    cwd: repo,
    appData,
    timeoutMs: 20 * 60_000,
    addDirs: retroReadDirs(collected.file),
  });
  const raw = String(invoked?.text || invoked?.error || "retro agent returned no output");
  const parsed = invoked?.ok ? parseRetroOutput(raw, collected.facts) : null;
  const reportFile = retroReportPath(change.number, appData);
  writeReport(reportFile, parsed?.report || raw);

  if (!invoked?.ok) {
    const error = new Error(`retro agent failed; diagnostic report saved to ${reportFile}: ${invoked?.error || "no output"}`);
    error.reportFile = reportFile;
    throw error;
  }
  if (!parsed) return { parsed: false, reportFile, proposals: [], profile: invoked.profile };

  const episodeById = new Map(parsed.episodes.map((episode) => [episode.id, episode]));
  const signalById = new Map((collected.facts.signals || []).map((signal) => [signal.id, signal]));
  const proposals = parsed.proposals.map((proposal) => ({
    id: `retro-${idFactory()}`,
    ...proposal,
    episodes: proposal.episode_refs.map((id) => {
      const { expected, observed, outcome, detection_gap } = episodeById.get(id);
      const recognizedSignal = detection_gap.recognized.signal;
      const detectedAt = recognizedSignal ? signalById.get(recognizedSignal)?.at ?? null : null;
      return { id, expected, observed, outcome, detection_gap, detected_at: detectedAt };
    }),
    status: "proposed",
  }));
  lock(file, () => {
    const current = readBoardForWrite(file);
    const target = resolveChange(current, ref);
    target.ext ??= {};
    target.ext.retro ??= {};
    const existing = Array.isArray(target.ext.retro.proposals) ? target.ext.retro.proposals : [];
    target.ext.retro.proposals = [...existing, ...proposals];
    target.updated_at = new Date().toISOString();
    save(file, current);
  });
  return { parsed: true, reportFile, proposals, profile: invoked.profile };
}

export function runRetroSession(session, {
  appData,
  repo = process.cwd(),
  invoke = invokeDutySync,
  collectFacts = collectSessionRetroFacts,
  writeReport = writeTextAtomic,
} = {}) {
  const id = String(session || "").trim();
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("session must be a transcript GUID");
  const collected = collectFacts({ session: id, appData });
  const prompt = buildRetroPrompt({ factsFile: collected.file, facts: collected.facts, session: id });
  const invoked = invoke("retro", prompt, {
    cwd: repo,
    appData,
    timeoutMs: 20 * 60_000,
    addDirs: retroReadDirs(collected.file),
  });
  const raw = String(invoked?.text || invoked?.error || "retro agent returned no output");
  const parsed = invoked?.ok ? parseRetroOutput(raw, collected.facts) : null;
  const reportFile = retroSessionReportPath(id, appData);
  writeReport(reportFile, parsed?.report || raw);
  if (!invoked?.ok) {
    const error = new Error(`retro agent failed; diagnostic report saved to ${reportFile}: ${invoked?.error || "no output"}`);
    error.reportFile = reportFile;
    throw error;
  }
  return { parsed: !!parsed, reportFile, proposals: [], profile: invoked.profile, factsFile: collected.file };
}

export async function run(args) {
  const sessionFlag = args.indexOf("--session");
  if (sessionFlag >= 0) {
    const session = args[sessionFlag + 1];
    if (!session || session.startsWith("--")) throw new Error("usage: cli change retro --session <guid>");
    const result = runRetroSession(session);
    if (!result.parsed) process.stdout.write(`warning: retro report saved, but agent output could not be parsed; no proposals are written for a session retro\n${result.reportFile}\n`);
    else process.stdout.write(`ok: session ${session} retro — report only, no proposals written\n${result.reportFile}\n`);
    return;
  }
  const ref = args.find((arg) => !arg.startsWith("--"));
  if (!ref) throw new Error("usage: cli change retro <c#N> | --session <guid>");
  const result = runRetro(ref);
  if (!result.parsed) {
    process.stdout.write(`warning: retro report saved, but agent output could not be parsed; proposals were not written\n${result.reportFile}\n`);
    return;
  }
  process.stdout.write(`ok: ${ref} retro — ${result.proposals.length} proposal(s)\n${result.reportFile}\n`);
}
