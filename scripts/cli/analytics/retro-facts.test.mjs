import { describe, expect, it } from "vitest";
import { bindingIntervals, buildRetroFacts, parseRetroTranscript } from "./retro-facts.mjs";

const transcript = [
  { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "Сделай файл" } },
  { type: "assistant", timestamp: "2026-01-01T00:00:02Z", message: { id: "a1", usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 100 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.mjs" } }] } },
  { type: "assistant", timestamp: "2026-01-01T00:00:04Z", message: { id: "a2", usage: { input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 200 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.mjs" } }, { type: "tool_use", name: "Agent", input: { model: "small", description: "проверить" } }] } },
  { type: "user", timestamp: "2026-01-01T00:00:10Z", message: { content: "Исправь имя" } },
  { type: "system", subtype: "compact", timestamp: "2026-01-01T00:00:11Z" },
  { type: "user", timestamp: "2026-01-01T00:00:12Z", message: { content: "[Request interrupted by user]" } },
].map(JSON.stringify).join("\n");

describe("retro facts", () => {
  it("extracts deterministic activity, context and repeated reads from a transcript fixture", () => {
    const one = parseRetroTranscript(transcript);
    const two = parseRetroTranscript(transcript);
    expect(two).toEqual(one);
    expect(one).toMatchObject({
      assistant_turns: 2,
      peak_context_k: 5,
      compactions: 1,
      distinct_read_paths: 1,
    });
    expect(one.repeated_paths).toEqual([{ path: "src/a.mjs", count: 2 }]);
    expect(one.human_messages).toEqual([
      expect.objectContaining({ text: "Сделай файл", active_seconds: 4, human_wait_seconds: 6 }),
      expect.objectContaining({ text: "Исправь имя", active_seconds: 0, human_wait_seconds: null }),
    ]);
    expect(one.delegations).toHaveLength(1);
    expect(one.interruptions).toEqual(["2026-01-01T00:00:12Z"]);
  });

  it("does not count built-in slash commands as user messages", () => {
    const parsed = parseRetroTranscript([
      { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "/compact обсудим изменения" } },
      { type: "user", timestamp: "2026-01-01T00:00:01Z", message: { content: "/chat-retro c#1" } },
    ].map(JSON.stringify).join("\n"));
    expect(parsed.human_messages.map((m) => m.text)).toEqual(["/chat-retro c#1"]);
  });

  it("marks binding intervals shorter than 30 seconds as empty", () => {
    const tasks = new Map([["task-1", 7]]);
    expect(bindingIntervals([
      { event: "start", task: "task-1", session: "session-1", ts: "2026-01-01T00:00:00Z" },
      { event: "end", task: "task-1", session: "session-1", ts: "2026-01-01T00:00:29Z" },
    ], tasks)).toEqual([
      expect.objectContaining({ task: "t#7", seconds: 29, empty: true }),
    ]);
  });

  it("computes cache churn, model transitions, mid-session cold starts and verbose tool-free turns", () => {
    const anomalyTranscript = [
      { type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { id: "m1", model: "model-a", usage: { cache_creation_input_tokens: 20_000, output_tokens: 10 }, content: [] } },
      { type: "assistant", timestamp: "2026-01-01T00:00:02Z", message: { id: "m2", model: "model-a", usage: { cache_creation_input_tokens: 11_001, cache_read_input_tokens: 0, output_tokens: 5_001 }, content: [{ type: "text", text: "long" }] } },
      { type: "assistant", timestamp: "2026-01-01T00:00:03Z", message: { id: "m3", model: "model-b", usage: { cache_read_input_tokens: 100, output_tokens: 20 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }] } },
    ].map(JSON.stringify).join("\n");
    const parsed = parseRetroTranscript(anomalyTranscript);
    expect(parsed.cache_create_share_pct).toBe(99.7);
    expect(parsed.model_change_count).toBe(1);
    expect(parsed.model_changes).toEqual([{ turn: 3, from: "model-a", to: "model-b" }]);
    expect(parsed.cold_starts).toEqual([expect.objectContaining({ turn: 2, cache_create: 11_001, cache_read: 0 })]);
    expect(parsed.verbose_turns_without_tools).toEqual([expect.objectContaining({ turn: 2, output_tokens: 5_001 })]);
  });

  it("builds the same complete facts twice and keeps costs separated by role", () => {
    const change = { id: "change-1", number: 3, title: "ретро", project: "demo" };
    const board = { todos: [{ id: "task-1", number: 7, subject: "шаг", status: "done", change_id: change.id }] };
    const input = {
      board,
      change,
      taskSessionEvents: [
        { event: "start", task: "task-1", session: "session-1", ts: "2026-01-01T00:00:00Z" },
        { event: "end", task: "task-1", session: "session-1", ts: "2026-01-01T00:00:20Z" },
      ],
      runRecords: [{ change: { number: 3 }, stop: { kind: "retry", task: 7 }, steps: [{ task: 7, attempt: 2, result: "ok", cost_usd: 1.25, review: { cost_usd: 0.2 } }] }],
      transcripts: new Map([["session-1", transcript]]),
      commits: [{ sha: "abc", date: "2026-01-01T00:00:30Z", subject: "finish c#3" }],
    };
    const facts = buildRetroFacts(input);
    expect(buildRetroFacts(input)).toEqual(facts);
    expect(facts.cost_by_role).toEqual({
      worker: { cost_usd: 1.05, measured: 1 },
      reviewer: { cost_usd: 0.2, measured: 1 },
    });
    expect(facts.summary).toMatchObject({ tasks: 1, sessions: 1, empty_bindings: 1, attempts: 1, parks: 1, commits: 1 });
    expect(facts.summary.negative_components).toBe(facts.negative_components.length);
  });

  it("builds completion chains, stable signals and honest coverage from fixture-only data", () => {
    const change = { id: "change-episodes", number: 85, title: "эпизоды", project: "demo" };
    const board = {
      todos: [
        {
          id: "runner-task", number: 10, change_id: change.id, subject: "закрывает раннер",
          kind: "auto", status: "done", created_at: "2026-01-01T00:00:00Z",
          status_history: [
            { status: "in_progress", at: "2026-01-01T00:00:10Z" },
            { status: "done", at: "2026-01-01T00:01:00Z" },
          ],
          ext: { process: { outcome: "ok", outcome_at: "2026-01-01T00:01:05Z", outcome_reason: "verified" } },
          comments: [{ author: "reviewer", body: "проверено", created_at: "2026-01-01T00:00:50Z" }],
          handoff: "готовый интерфейс", handoff_at: "2026-01-01T00:01:04Z",
        },
        {
          id: "outside-task", number: 11, change_id: change.id, subject: "закрыто после остановки",
          kind: "auto", status: "done", created_at: "2026-01-01T00:02:00Z",
          description: "Исправить сбой схемы",
          status_history: [
            { status: "in_progress", at: "2026-01-01T00:02:10Z" },
            { status: "done", at: "2026-01-01T00:04:00Z" },
          ],
          ext: { process: { outcome: "issue", outcome_at: "2026-01-01T00:03:00Z", outcome_reason: "review failed" } },
        },
        {
          id: "open-task", number: 12, change_id: change.id, subject: "ещё открыто",
          status: "in_progress", status_history: [{ status: "in_progress", at: "2026-01-01T00:05:00Z" }],
        },
      ],
    };
    const input = {
      board,
      change,
      taskSessionEvents: [
        { event: "start", task: "runner-task", session: "session-1", ts: "2026-01-01T00:00:00Z" },
        { event: "end", task: "runner-task", session: "session-1", ts: "2026-01-01T00:00:20Z" },
      ],
      runRecords: [
        {
          change: { number: 85 }, ts: "2026-01-01T00:00:40Z",
          steps: [{ task: 10, attempt: 1, result: "ok", verify: "ok", cost_usd: 0.5 }],
        },
        {
          change: { number: 85 }, ts: "2026-01-01T00:03:00Z",
          stop: { kind: "review_issue", task: 11, reason: "schema mismatch" },
          steps: [{ task: 11, attempt: 1, result: "issue", verify: "issue", reason: "schema mismatch" }],
        },
      ],
      transcripts: new Map([["session-1", transcript]]),
    };

    const facts = buildRetroFacts(input);
    expect(JSON.stringify(buildRetroFacts(input))).toBe(JSON.stringify(facts));
    expect(facts.completion_chains.map(({ task, kind, closed_by }) => ({ task, kind, closed_by }))).toEqual([
      { task: "t#10", kind: "auto", closed_by: "runner" },
      { task: "t#11", kind: "auto", closed_by: "outside_runner_after_runner_attempts" },
      { task: "t#12", kind: "manual", closed_by: "not_closed:in_progress" },
    ]);
    expect(facts.completion_chains[1]).toMatchObject({
      done_at: "2026-01-01T00:04:00Z",
      stops: [expect.objectContaining({ run: 2, kind: "review_issue", reason: "schema mismatch" })],
      runner_attempts: [expect.objectContaining({ run: 2, result: "issue" })],
    });
    expect(facts.signals.map(({ id, kind, task, text }) => ({ id, kind, task, text }))).toEqual([
      { id: "s001", kind: "comment:reviewer", task: "t#10", text: "проверено" },
      { id: "s002", kind: "handoff", task: "t#10", text: "готовый интерфейс" },
      { id: "s003", kind: "description", task: "t#11", text: "Исправить сбой схемы" },
      { id: "s004", kind: "run:issue", task: "t#11", text: "schema mismatch" },
      { id: "s005", kind: "human_message", task: null, text: "Сделай файл" },
      { id: "s006", kind: "human_message", task: null, text: "Исправь имя" },
      { id: "s007", kind: "interruption", task: null, text: "" },
    ]);
    expect(facts.coverage).toEqual({
      tasks: 3,
      runner_steps: 2,
      interactive_sessions_read: 1,
      runner_sessions_read: 0,
      closed_by: { runner: 1, outside_runner_after_runner_attempts: 1, "not_closed:in_progress": 1 },
      cannot_claim: [
        "контекст и действия исполнителей раннера: rollout codex не прочитан",
        "автор ручных переходов статуса: история статусов не хранит актора",
      ],
    });
  });

  it("includes the ten-second runner boundary and caps signal text at 600 characters", () => {
    const change = { id: "change-boundaries", number: 86, title: "границы", project: "demo" };
    const longComment = "x".repeat(601);
    const input = {
      change,
      board: {
        todos: [{
          id: "boundary-task",
          number: 13,
          change_id: change.id,
          subject: "граничный случай",
          kind: "auto",
          status: "done",
          status_history: [{ status: "done", at: "2026-01-01T00:01:00Z" }],
          ext: { process: { outcome: "ok", outcome_at: "2026-01-01T00:01:10Z" } },
          comments: [{ author: "reviewer", body: longComment }],
        }],
      },
      runRecords: [{
        change: { number: 86 },
        steps: [{ task: 13, attempt: 1, result: "ok" }],
      }],
    };

    const facts = buildRetroFacts(input);
    expect(facts.completion_chains[0].closed_by).toBe("runner");
    expect(facts.signals[0].text).toHaveLength(600);
    expect(facts.signals[0].text.endsWith("… [+1]")).toBe(true);
  });
});
