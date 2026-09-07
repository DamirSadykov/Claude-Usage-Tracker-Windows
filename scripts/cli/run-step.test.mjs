// Unit tests for the step executor of the process-DSL runner (t#305).
//
// The model is never called: `claude` is replaced by a node script that reports
// back what it was given, so what is under test is the HARNESS — the seam
// (which context crosses it and which does not), the session identity and its
// binding, the deadline, and the predicate the declared check produces.
//
// Three properties are worth stating as tests because breaking them is silent:
//   * the prompt carries the baton of the DIRECT prerequisites and nothing of
//     the run's history — a leak there costs money without failing anything;
//   * the binding is written for the SESSION THAT WORKED, before it starts, or
//     the step measures as $0 (the t#294 failure, DSL §10);
//   * a deadline actually kills the process tree, not just the promise.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTaskSessionEvents } from "./todos.mjs";
import {
  buildStepPrompt,
  executeStep,
  runVerify,
  clampOutput,
  parseClaudeResult,
  extractHandoff,
  MAX_CAPTURE_CHARS,
} from "./run-step.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────────

let tmp;
let appDir;
let prevAppData;
let prevSession;

const boardFile = () => path.join(appDir, "todos.json");
const journal = () => path.join(appDir, "task-sessions.jsonl");

// A chain step-1 -> step-2 -> step-3: step-3 is the node under test, step-2 its
// DIRECT prerequisite, step-1 the history that must NOT cross the seam.
const chain = () => ({
  version: 1,
  todos: [
    {
      id: "id-1",
      number: 1,
      subject: "first step",
      status: "done",
      handoff: "BATON-ONE: this is the history of an earlier step",
    },
    {
      id: "id-2",
      number: 2,
      subject: "second step",
      status: "done",
      depends_on: ["id-1"],
      handoff: "BATON-TWO: wrote src/parser.rs, GOTCHA: the lexer eats newlines",
    },
    {
      id: "id-3",
      number: 3,
      subject: "third step",
      status: "in_progress",
      kind: "auto",
      depends_on: ["id-2"],
      description: "DESC-THREE: teach the parser about comments",
      plan: "PLAN-THREE: extend the token table, then the tests",
      produces: ["src/parser.rs", "src/parser.test.rs"],
      verify: "npm test",
      retry_limit: 2,
      budget_usd: 3,
    },
    {
      id: "id-9",
      number: 9,
      subject: "unrelated step",
      status: "queue",
      handoff: "BATON-NINE: nothing to do with the node under test",
    },
  ],
});

const taskOf = (data, id) => data.todos.find((t) => t.id === id);

// A stand-in for `claude`: same argv contract, no model. Modes come from argv so
// one script covers every case.
const FAKE_CLAUDE = `
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ""; };
const sid = at("--session-id");
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
if (process.env.FAKE_ECHO) writeFileSync(process.env.FAKE_ECHO, JSON.stringify({ argv, stdin, parentSession: process.env.CLAUDE_CODE_SESSION_ID ?? null }));
if (mode === "hang") { setTimeout(() => { try { writeFileSync(process.env.FAKE_ALIVE, "survived"); } catch {} }, 2000); }
else if (mode === "crash") { process.stderr.write("boom: model unavailable\\n"); process.exit(1); }
else if (mode === "garbage") { process.stdout.write("not json at all\\n"); }
else if (mode === "is_error") { process.stdout.write(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", result: "hit the turn cap", session_id: sid }) + "\\n"); }
else if (mode === "other-session") { process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "11111111-2222-3333-4444-555555555555" }) + "\\n"); }
else { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "step finished\\n## HANDOFF\\nwrote it", session_id: sid, total_cost_usd: 0.042, num_turns: 7 }) + "\\n"); }
`;

// A stand-in for a declared check: exit code and output are argv-driven.
const FAKE_VERIFY = `
import { writeFileSync } from "node:fs";
const [mode, arg] = process.argv.slice(2);
if (mode === "pass") { process.stdout.write("all good\\n"); process.exit(0); }
if (mode === "fail") { process.stdout.write("2 failing\\n"); process.stderr.write("assertion failed\\n"); process.exit(3); }
if (mode === "flood") { process.stdout.write("HEAD-MARKER\\n" + "x".repeat(Number(arg || 100000)) + "\\nTAIL-MARKER\\n"); process.exit(0); }
if (mode === "sleep") { setTimeout(() => { writeFileSync(arg, "survived"); }, 2000); }
`;

let fakeClaude;
let fakeVerify;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "run-step-"));
  appDir = path.join(tmp, "com.claude-usage-tracker.app");
  mkdirSync(appDir, { recursive: true });
  prevAppData = process.env.APPDATA;
  process.env.APPDATA = tmp;
  prevSession = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  fakeClaude = path.join(tmp, "fake-claude.mjs");
  fakeVerify = path.join(tmp, "fake-verify.mjs");
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  writeFileSync(fakeVerify, FAKE_VERIFY);
});

afterEach(() => {
  if (prevAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prevAppData;
  if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_ECHO;
  delete process.env.FAKE_ALIVE;
  rmSync(tmp, { recursive: true, force: true });
});

// ── the seam ─────────────────────────────────────────────────────────────────

describe("buildStepPrompt", () => {
  it("carries the baton of the DIRECT prerequisites", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).toContain("BATON-TWO");
    expect(prompt).toContain("the lexer eats newlines");
    expect(prompt).toContain("t#2 second step");
  });

  it("does not carry the history of earlier steps across the seam", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).not.toContain("BATON-ONE");
    expect(prompt).not.toContain("first step");
    expect(prompt).not.toContain("BATON-NINE");
    expect(prompt).not.toContain("unrelated step");
  });

  it("states the node's own work and its declarations", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).toContain("third step");
    expect(prompt).toContain("DESC-THREE");
    expect(prompt).toContain("PLAN-THREE");
    expect(prompt).toContain("src/parser.rs");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("2 attempt(s)");
    expect(prompt).toContain("$3");
  });

  it("says the baton is missing rather than inventing one", () => {
    const orphan = {
      id: "id-7",
      number: 7,
      subject: "orphan",
      status: "queue",
      depends_on: ["id-2"],
    };
    // Board never written to disk => the CLI cannot resolve it.
    const prompt = buildStepPrompt({ task: orphan, board: { todos: [orphan] } });
    expect(prompt).toContain("could not be read");
    expect(prompt).not.toContain("BATON-TWO");
  });

  // The change root's description is the ONLY place the frame of the work lives —
  // what the change keeps, what it refuses, why the step exists at all. The
  // interactive path prints it on `-> in_progress`; a headless step that never
  // saw it works one node without the plan around it.
  it("carries the vision of the change above the node", () => {
    const data = chain();
    data.todos.push({
      id: "id-t",
      number: 10,
      subject: "CHANGE: разбор без словаря",
      status: "queue",
      change: true,
      depends_on: ["id-3"],
      description: "VISION-TEN: словарь НЕ удаляем — он остаётся оракулом",
    });
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).toContain("VISION-TEN");
    expect(prompt).toContain("CHANGE: разбор без словаря");
  });

  it("says the vision is missing rather than pretending the node has a frame", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).toContain("no change root above this node");
  });

  it("names the nodes waiting on this one and what they promised", () => {
    const data = chain();
    data.todos.push({
      id: "id-4",
      number: 4,
      subject: "fourth step",
      status: "backlog",
      depends_on: ["id-3"],
      produces: ["src/select.rs"],
    });
    data.todos.push({
      id: "id-t",
      number: 10,
      subject: "CHANGE: разбор",
      status: "queue",
      change: true,
      depends_on: ["id-3", "id-4"],
    });
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    const waits = prompt.split("── WHAT WAITS ON YOU")[1].split("\n── ")[0];
    expect(waits).toContain("t#4 fourth step");
    expect(waits).toContain("src/select.rs");
    // The change root depends on every member and is no one's next step.
    expect(waits).not.toContain("CHANGE: разбор");
  });

  it("warns about the steps of its own wave, which edit files at the same time", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({
      task: taskOf(data, "id-3"),
      board: data,
      alongside: [{ id: "id-9", number: 9, subject: "unrelated step" }],
    });
    expect(prompt).toContain("ALONGSIDE");
    expect(prompt).toContain("t#9 unrelated step");
  });

  it("tells the step it has no shell and does not close its own node", () => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    const prompt = buildStepPrompt({ task: taskOf(data, "id-3"), board: data });
    expect(prompt).toContain("no shell");
    expect(prompt).toContain("Do not touch the task board");
  });
});

// ── the check ────────────────────────────────────────────────────────────────

describe("runVerify", () => {
  it("returns 0 for a passing check", async () => {
    const r = await runVerify({ cmd: [process.execPath, fakeVerify, "pass"], cwd: tmp });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("all good");
  });

  it("returns the non-zero code and both streams for a failing check", async () => {
    const r = await runVerify({ cmd: [process.execPath, fakeVerify, "fail"], cwd: tmp });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("2 failing");
    expect(r.stderr).toContain("assertion failed");
  });

  it("runs a declared command string through the shell", async () => {
    const cmd = `"${process.execPath}" "${fakeVerify}" fail`;
    const r = await runVerify({ cmd, cwd: tmp });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("2 failing");
  });

  it("refuses an empty command instead of reporting a pass", async () => {
    const r = await runVerify({ cmd: "  ", cwd: tmp });
    expect(r.code).not.toBe(0);
    expect(r.error).toContain("no command declared");
  });

  it("clamps a flood of output and keeps both ends", async () => {
    const r = await runVerify({
      cmd: [process.execPath, fakeVerify, "flood", "300000"],
      cwd: tmp,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeLessThan(MAX_CAPTURE_CHARS + 200);
    expect(r.stdout).toContain("HEAD-MARKER");
    expect(r.stdout).toContain("TAIL-MARKER");
    expect(r.stdout).toContain("chars elided");
  });

  it("kills the process on the deadline and says so", async () => {
    const alive = path.join(tmp, "verify-alive.txt");
    const started = Date.now();
    const r = await runVerify({
      cmd: [process.execPath, fakeVerify, "sleep", alive],
      cwd: tmp,
      timeoutMs: 500,
    });
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("timed out");
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
    // The proof that the tree died: the work it was going to do never happened.
    await new Promise((res) => setTimeout(res, 2200));
    expect(existsSync(alive)).toBe(false);
  }, 15000);
});

// ── the step ─────────────────────────────────────────────────────────────────

describe("executeStep", () => {
  const run = (extra = {}) => {
    const data = chain();
    writeFileSync(boardFile(), JSON.stringify(data));
    return executeStep({
      task: taskOf(data, "id-3"),
      board: data,
      cwd: tmp,
      claudeBin: [process.execPath, fakeClaude],
      ...extra,
    });
  };

  it("returns the session id of the session that did the work", async () => {
    const echo = path.join(tmp, "echo.json");
    process.env.FAKE_ECHO = echo;
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.error).toBe("");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(r.costUsd).toBe(0.042);
    expect(r.result).toContain("## HANDOFF");
    const seen = JSON.parse(String(readFileSync(echo, "utf8")));
    expect(seen.argv).toContain("--session-id");
    expect(seen.argv[seen.argv.indexOf("--session-id") + 1]).toBe(r.sessionId);
    expect(seen.stdin).toContain("third step");
    expect(seen.stdin).toContain("BATON-TWO");
  });

  it("hands back the baton the step wrote, cut out of its answer", async () => {
    const r = await run();
    expect(r.handoff).toBe("wrote it");
  });

  it("gives the step file tools and no Bash pattern", async () => {
    const echo = path.join(tmp, "echo.json");
    process.env.FAKE_ECHO = echo;
    await run();
    const seen = JSON.parse(String(readFileSync(echo, "utf8")));
    expect(seen.argv).toContain("--allowedTools");
    expect(seen.argv).toContain("Edit");
    expect(seen.argv.some((a) => String(a).startsWith("Bash"))).toBe(false);
  });

  it("binds the worked session to the task, opening the block before the work", async () => {
    const r = await run();
    const events = readTaskSessionEvents(journal());
    expect(events.map((e) => e.event)).toEqual(["start", "end"]);
    expect(events.every((e) => e.session === r.sessionId)).toBe(true);
    expect(events.every((e) => e.task === "id-3")).toBe(true);
    // The runner's own wire value, listed in task_sessions.rs::EXPLICIT_SOURCES
    // since t#312: the block stays explicit AND says who bound it.
    expect(events.every((e) => e.source === "run-step")).toBe(true);
    expect(events[0].ts <= events[1].ts).toBe(true);
  });

  // t#312: run the executor the way the runner is really used — from inside a
  // Claude Code session. The parent's id must reach neither the journal (a block
  // opened on a session that works nothing) nor the step's environment (its own
  // SessionStart hook reads that variable).
  it("never lets the launching session's id into the step or the journal", async () => {
    const echo = path.join(tmp, "echo.json");
    process.env.FAKE_ECHO = echo;
    process.env.CLAUDE_CODE_SESSION_ID = "parent-session";
    const r = await run();
    const seen = JSON.parse(String(readFileSync(echo, "utf8")));
    expect(seen.parentSession).toBe(null);
    const events = readTaskSessionEvents(journal());
    expect(events.map((e) => e.event)).toEqual(["start", "end"]);
    expect(events.every((e) => e.session === r.sessionId)).toBe(true);
    expect(events.some((e) => e.session === "parent-session")).toBe(false);
  });

  it("trusts the session id the binary reports when it disagrees", async () => {
    process.env.FAKE_MODE = "other-session";
    const r = await run();
    expect(r.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    const events = readTaskSessionEvents(journal());
    expect(events.filter((e) => e.session === r.sessionId).length).toBe(2);
  });

  it("reports ok:false with a message when the step crashes", async () => {
    process.env.FAKE_MODE = "crash";
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exited 1");
    expect(r.error).toContain("model unavailable");
    // The block still closes: what was spent was spent (DSL §15).
    expect(readTaskSessionEvents(journal()).map((e) => e.event)).toEqual(["start", "end"]);
  });

  it("reports ok:false when the step cannot be confirmed to have run", async () => {
    process.env.FAKE_MODE = "garbage";
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no parseable JSON");
  });

  it("reports ok:false when the step itself reports an error", async () => {
    process.env.FAKE_MODE = "is_error";
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("hit the turn cap");
  });

  it("reports ok:false when the binary is missing rather than throwing", async () => {
    const r = await run({ claudeBin: path.join(tmp, "no-such-claude.exe") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot start/i);
  });

  it("kills a hung step on the deadline and never leaves it running", async () => {
    process.env.FAKE_MODE = "hang";
    const alive = path.join(tmp, "step-alive.txt");
    process.env.FAKE_ALIVE = alive;
    const started = Date.now();
    const r = await run({ timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(4000);
    await new Promise((res) => setTimeout(res, 2200));
    expect(existsSync(alive)).toBe(false);
  }, 15000);
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe("clampOutput / parseClaudeResult", () => {
  it("keeps head and tail and marks what it dropped", () => {
    const s = "A".repeat(100) + "B".repeat(1000) + "C".repeat(100);
    const out = clampOutput(s, 200);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("C")).toBe(true);
    expect(out).toContain("chars elided");
    expect(out.length).toBeLessThan(300);
  });

  it("leaves short output alone", () => {
    expect(clampOutput("short", 200)).toBe("short");
  });

  it("takes the last JSON object when the binary printed extra lines", () => {
    const raw = 'warning: something\n{"session_id":"a"}\n{"session_id":"b"}\n';
    expect(parseClaudeResult(raw).session_id).toBe("b");
    expect(parseClaudeResult("nope")).toBe(null);
    expect(parseClaudeResult("")).toBe(null);
  });

  it("cuts the baton at the HANDOFF heading and keeps everything under it", () => {
    const answer = "narration nobody asked for\n\n## HANDOFF\nwrote src/a.mjs\nGOTCHA: два вьюпорта";
    expect(extractHandoff(answer)).toBe("wrote src/a.mjs\nGOTCHA: два вьюпорта");
    expect(extractHandoff("### handoff:\nтело")).toBe("тело");
  });

  it("returns nothing when the step wrote no HANDOFF, instead of guessing one", () => {
    expect(extractHandoff("I did the work and it went fine.")).toBe("");
    expect(extractHandoff("")).toBe("");
    expect(extractHandoff(null)).toBe("");
    // A mention inside prose is not the section — a heading stands alone.
    expect(extractHandoff("see the ## HANDOFF section of the spec for the shape")).toBe("");
  });
});
