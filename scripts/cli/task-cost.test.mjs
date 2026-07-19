// Unit tests for the attribution parser (`cli.mjs task-cost`, t#87).
//
// parseSessionEvidence(raw) reads a session's JSONL transcript and returns
// { moves, touched, mentions }: the tasks the session MOVED into a worked
// status (with bracketing timestamps), the tasks it worked without a move
// (comment add / handoff), and corroboration-only mentions (user text, triage
// CLI verbs). The join (Rust) attributes tokens only when the evidence names
// exactly one task — so what matters here is that the parser neither invents
// evidence (echoes, non-CLI commands, triage re-shelving, hook/system
// injections, board dumps in tool_results) nor drops it (multiple moves in one
// command, '#'-prefixed refs).

import { describe, it, expect } from "vitest";
import { parseSessionEvidence, parseSessionMoves } from "./task-cost.mjs";

// One transcript line: a Bash tool_use running `cmd` at `ts`.
const bashLine = (cmd, ts = "2026-07-16T10:00:00Z") =>
  JSON.stringify({
    timestamp: ts,
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }],
    },
  });

// One transcript line: what the human typed (content is a plain string).
const userLine = (text, extra = {}) =>
  JSON.stringify({ type: "user", message: { content: text }, ...extra });

const CLI = 'node "D:\\\\app\\\\scripts\\\\cli.mjs"';

describe("parseSessionMoves", () => {
  it("records a worked move with its ref, status and timestamp", () => {
    const raw = bashLine(`${CLI} todos set-status 42 in_progress`);
    expect(parseSessionMoves(raw)).toEqual([
      {
        ref: "42",
        statuses: ["in_progress"],
        first_ts: "2026-07-16T10:00:00Z",
        last_ts: "2026-07-16T10:00:00Z",
      },
    ]);
  });

  it("merges repeated moves of one task and brackets the timestamps", () => {
    const raw = [
      bashLine(`${CLI} todos set-status 42 in_progress`, "2026-07-16T10:00:00Z"),
      bashLine(`${CLI} todos set-status #42 done`, "2026-07-16T12:00:00Z"),
    ].join("\n");
    const moves = parseSessionMoves(raw);
    expect(moves).toHaveLength(1);
    expect(moves[0].statuses).toEqual(["in_progress", "done"]);
    expect(moves[0].first_ts).toBe("2026-07-16T10:00:00Z");
    expect(moves[0].last_ts).toBe("2026-07-16T12:00:00Z");
  });

  it("keeps distinct tasks separate, including uuid refs and && chains", () => {
    const raw = bashLine(
      `${CLI} todos set-status 7 done && ${CLI} todos set-status aa0d4a5e-d69a review`,
    );
    const refs = parseSessionMoves(raw).map((m) => m.ref);
    expect(refs.sort()).toEqual(["7", "aa0d4a5e-d69a"]);
  });

  it("ignores triage moves (backlog/queue) — re-shelving is not work", () => {
    const raw = [
      bashLine(`${CLI} todos set-status 5 backlog`),
      bashLine(`${CLI} todos set-status 6 queue`),
    ].join("\n");
    expect(parseSessionMoves(raw)).toEqual([]);
  });

  it("requires a real CLI invocation — an echo of the string is not a move", () => {
    const raw = bashLine(`echo "todos set-status 42 done"`);
    expect(parseSessionMoves(raw)).toEqual([]);
  });

  it("ignores non-Bash tool_use, malformed lines and prose mentions", () => {
    const raw = [
      "not json at all set-status",
      JSON.stringify({
        timestamp: "2026-07-16T10:00:00Z",
        message: { content: [{ type: "text", text: "run set-status 42 done" }] },
      }),
      JSON.stringify({
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { command: `${CLI} todos set-status 42 done` } },
          ],
        },
      }),
    ].join("\n");
    expect(parseSessionMoves(raw)).toEqual([]);
  });

  it("survives a line without a timestamp", () => {
    const raw = JSON.stringify({
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: `${CLI} todos set-status 42 done` } },
        ],
      },
    });
    expect(parseSessionMoves(raw)).toEqual([
      { ref: "42", statuses: ["done"], first_ts: null, last_ts: null },
    ]);
  });
});

describe("parseSessionEvidence — touched", () => {
  it("collects comment add and handoff targets, id and number alike", () => {
    const raw = [
      bashLine(`${CLI} todos comment add 87 --text "нашёл причину"`),
      bashLine(`${CLI} todos handoff set aa0d4a5e-d69a --text "baton"`),
      bashLine(`${CLI} todos handoff #91`),
    ].join("\n");
    const ev = parseSessionEvidence(raw);
    expect(ev.touched).toEqual(["87", "91", "aa0d4a5e-d69a"]);
    expect(ev.moves).toEqual([]);
  });

  it("does not let `handoff set` swallow the word `set` as a ref", () => {
    const raw = bashLine(`${CLI} todos handoff set 87 --text "x"`);
    expect(parseSessionEvidence(raw).touched).toEqual(["87"]);
  });

  it("requires a real CLI invocation for touches too", () => {
    const raw = bashLine(`echo "comment add 42"`);
    expect(parseSessionEvidence(raw).touched).toEqual([]);
  });
});

describe("parseSessionEvidence — mentions", () => {
  it("collects t#N and #N from user text, but never bare numbers", () => {
    const raw = userLine("продолжай t#87, потом глянь #92 и вариант 3");
    expect(parseSessionEvidence(raw).mentions).toEqual(["87", "92"]);
  });

  it("collects refs from triage CLI verbs, including both dep args", () => {
    const raw = [
      bashLine(`${CLI} todos set-priority 5 high`),
      bashLine(`${CLI} todos dep add 7 #9`),
    ].join("\n");
    expect(parseSessionEvidence(raw).mentions).toEqual(["5", "7", "9"]);
  });

  it("ignores hook and system injections: system-reminder, isMeta, sidechain", () => {
    const raw = [
      userLine("привет <system-reminder>задачи: #86 [in_progress] t#87</system-reminder> как дела"),
      userLine("Stop hook feedback: task #63 needs a handoff", { isMeta: true }),
      userLine("работай над t#99", { isSidechain: true }),
    ].join("\n");
    expect(parseSessionEvidence(raw).mentions).toEqual([]);
  });

  it("ignores tool_result echoes of the board and assistant free text", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "#86 [in_progress] t#87 доска" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "на доске t#86, t#87 и t#88" }] },
      }),
    ].join("\n");
    expect(parseSessionEvidence(raw).mentions).toEqual([]);
  });

  it("drops evidence from a command whose tool_result is an error", () => {
    // A rejected permission or a failing CLI run (`set-status 99999`, bogus
    // status) must not credit a move that never happened.
    const use = (id, cmd) =>
      JSON.stringify({
        timestamp: "2026-07-16T10:00:00Z",
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] },
      });
    const result = (id, is_error) =>
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: "x" }] },
      });
    const raw = [
      use("t1", `${CLI} todos set-status 99999 done`),
      result("t1", true),
      use("t2", `${CLI} todos comment add 7 --text "y"`),
      result("t2", true),
      use("t3", `${CLI} todos set-status 42 done`),
      result("t3", false),
    ].join("\n");
    const ev = parseSessionEvidence(raw);
    expect(ev.moves.map((m) => m.ref)).toEqual(["42"]);
    expect(ev.touched).toEqual([]);
  });

  it("keeps evidence when the command's result never reached the transcript", () => {
    // Truncated tail: no tool_result at all → benefit of the doubt.
    const raw = JSON.stringify({
      timestamp: "2026-07-16T10:00:00Z",
      message: {
        content: [
          { type: "tool_use", id: "t9", name: "Bash", input: { command: `${CLI} todos set-status 42 done` } },
        ],
      },
    });
    expect(parseSessionEvidence(raw).moves.map((m) => m.ref)).toEqual(["42"]);
  });

  it("does not read a --scheduled date or triage set-status as a mention", () => {
    const raw = [
      bashLine(`${CLI} todos add "x" --scheduled 2026-07-19`),
      bashLine(`${CLI} todos set-status 5 backlog`),
    ].join("\n");
    const ev = parseSessionEvidence(raw);
    expect(ev.mentions).toEqual([]);
    expect(ev.moves).toEqual([]);
  });
});
