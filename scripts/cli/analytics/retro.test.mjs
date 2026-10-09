import { describe, expect, it } from "vitest";

import { buildDutyPrompt, DUTIES, STARTER_DUTIES } from "../agents/agents.mjs";
import { buildRetroPrompt, parseRetroOutput, runRetro, runRetroSession } from "./retro.mjs";

const change = { id: "change-3", number: 3, title: "Проверить процесс" };
const facts = {
  summary: { tasks: 2, negative_components: 1 },
  negative_components: [{ kind: "retry", task: "t#2" }],
  signals: [{ id: "s001", at: "2026-10-09T12:34:56.000Z" }, { id: "s002", at: null }],
};

const proposal = {
  type: "процесс",
  addressee: "human",
  what: "добавить ранний gate",
  episode_refs: ["e1"],
  intervention: "add_check",
  evidence: "t#2, попытка 2",
  measure: {
    cases: "повторы после gate",
    baseline: "1/1",
    observe: "повторы",
    source: "facts.signals",
    fails_if: "есть повтор",
  },
};

function envelope(overrides = {}) {
  return JSON.stringify({
    report: "# Ретро\n\n## Что произошло\nФакт.",
    episodes: [{
      id: "e1",
      expected: "gate остановит работу",
      observed: "работа продолжилась",
      signal_refs: ["s001"],
      outcome: "deferred",
      detection_gap: {
        observable: "s001",
        recognized: { signal: "s001", by: "review" },
        reached_user: null,
        why_late: "не было блокирующей проверки",
      },
    }],
    signal_dispositions: { s001: "e1", s002: "noise" },
    proposals: [proposal],
    ...overrides,
  });
}

describe("retro agent output", () => {
  it("declares the Sol retro duty with medium reasoning", () => {
    expect(DUTIES).toContain("retro");
    expect(STARTER_DUTIES.retro).toMatchObject({
      mode: "agent",
      provider: "openai",
      model: "gpt-5.6-sol",
      role: "retro",
      reasoning_effort: "medium",
    });
  });

  it("parses episodes, signal outcomes and measure passports from a JSON fence", () => {
    expect(parseRetroOutput(`\`\`\`json\n${envelope()}\n\`\`\``, facts)).toEqual({
      report: "# Ретро\n\n## Что произошло\nФакт.",
      episodes: [expect.objectContaining({ id: "e1", outcome: "deferred" })],
      signal_dispositions: { s001: "e1", s002: "noise" },
      proposals: [proposal],
    });
  });

  it("rejects partial proposals, a missing signal outcome and a dangling episode reference", () => {
    expect(parseRetroOutput(envelope({ proposals: [{ type: "совет", what: "что-то" }] }), facts)).toBe(null);
    expect(parseRetroOutput(envelope({ signal_dispositions: { s001: "e1" } }), facts)).toBe(null);
    expect(parseRetroOutput(envelope({ proposals: [{ ...proposal, episode_refs: ["e404"] }] }), facts)).toBe(null);
    expect(parseRetroOutput(envelope({ proposals: [{ ...proposal, addressee: "владелец деплоя" }] }), facts)).toBe(null);
    expect(parseRetroOutput("обычный markdown отчёт", facts)).toBe(null);
  });

  it("assembles the v5 method with facts and the code-owned output contract", () => {
    const prompt = buildRetroPrompt({ factsFile: "C:/data/retro/c3-facts.json", facts, change });
    expect(prompt).toContain("C:/data/retro/c3-facts.json");
    expect(prompt).toContain('"negative_components": 1');
    expect(prompt).toContain('"signal_dispositions"');
    const full = buildDutyPrompt(STARTER_DUTIES.retro, prompt);
    expect(full).toContain("Каждому сигналу дай исход");
    expect(full).toContain("observable");
    expect(full).toContain("reached_user");
  });

  it("lets custom duty instructions replace the whole method without losing the output contract", () => {
    const prompt = buildRetroPrompt({ factsFile: "facts.json", facts, change });
    const full = buildDutyPrompt({ instructions: "МОЙ МЕТОД" }, prompt);
    expect(full).toContain("МОЙ МЕТОД");
    expect(full).toContain('"episodes"');
    expect(full).not.toContain("Фаза 1 — эффективность");
  });
});

describe("runRetro", () => {
  function rig(answer) {
    const board = { changes: [{ ...change, ext: { retro: { proposals: [{ id: "old", status: "accepted" }] } } }] };
    const reports = [];
    const saves = [];
    let locks = 0;
    const options = {
      appData: "C:/roaming",
      repo: "C:/repo",
      file: "C:/roaming/todos.json",
      readBoard: () => board,
      readBoardForWrite: () => board,
      collectFacts: () => ({ facts, file: "C:/roaming/retro/c3-facts.json" }),
      invoke: (duty, prompt, invokeOptions) => ({ ok: true, text: answer, profile: { duty }, prompt, invokeOptions }),
      idFactory: () => "proposal-1",
      lock: (_file, fn) => { locks += 1; return fn(); },
      save: (_file, data) => saves.push(structuredClone(data)),
      writeReport: (file, text) => reports.push({ file, text }),
    };
    return { board, reports, saves, options, locks: () => locks };
  }

  it("stores brief episodes and measure passports with proposed records", () => {
    const test = rig(envelope());
    const result = runRetro("c#3", test.options);
    expect(result).toMatchObject({ parsed: true, proposals: [{
      id: "retro-proposal-1",
      type: "процесс",
      status: "proposed",
    }] });
    expect(test.reports).toEqual([{ file: expect.stringMatching(/retro[\\/]c3-report\.md$/), text: expect.stringContaining("# Ретро") }]);
    expect(test.locks()).toBe(1);
    expect(test.saves).toHaveLength(1);
    expect(test.board.changes[0].ext.retro.proposals).toEqual([
      { id: "old", status: "accepted" },
      expect.objectContaining({
        id: "retro-proposal-1",
        evidence: "t#2, попытка 2",
        measure: expect.objectContaining({ baseline: "1/1", fails_if: "есть повтор" }),
        episodes: [{
          id: "e1",
          expected: "gate остановит работу",
          observed: "работа продолжилась",
          outcome: "deferred",
          detection_gap: {
            observable: "s001",
            recognized: { signal: "s001", by: "review" },
            reached_user: null,
            why_late: "не было блокирующей проверки",
          },
          detected_at: "2026-10-09T12:34:56.000Z",
        }],
        status: "proposed",
      }),
    ]);
  });

  it("keeps invalid agent output as the report and does not touch proposals", () => {
    const test = rig(envelope({ signal_dispositions: { s001: "e1" } }));
    const result = runRetro("c#3", test.options);
    expect(result).toMatchObject({ parsed: false, proposals: [] });
    expect(test.reports[0].text).toContain("signal_dispositions");
    expect(test.locks()).toBe(0);
    expect(test.saves).toEqual([]);
    expect(test.board.changes[0].ext.retro.proposals).toEqual([{ id: "old", status: "accepted" }]);
  });

  it("writes a one-session report but never returns proposals for the board", () => {
    const reports = [];
    const result = runRetroSession("session-guid", {
      appData: "C:/roaming",
      repo: "C:/repo",
      collectFacts: () => ({ facts: { ...facts, scope: "session" }, file: "C:/roaming/retro/session-session-guid-facts.json" }),
      invoke: () => ({ ok: true, text: envelope(), profile: { duty: "retro" } }),
      writeReport: (file, text) => reports.push({ file, text }),
    });
    expect(result).toMatchObject({ parsed: true, proposals: [], factsFile: expect.stringContaining("session-guid-facts.json") });
    expect(reports).toEqual([{ file: expect.stringMatching(/retro[\\/]session-session-guid-report\.md$/), text: expect.stringContaining("# Ретро") }]);
  });
});
