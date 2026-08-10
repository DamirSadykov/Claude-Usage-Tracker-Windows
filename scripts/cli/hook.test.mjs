// Unit tests for the SessionStart hook's session<->task binding (t#296).
//
// The binding is the hook's only write: when exactly one task of the project is
// in_progress it appends a `start` record to the task-sessions journal, so the
// session's token cost can be split into blocks (task × session × interval).
// Ambiguity (two in_progress) and repeat hook runs must NOT produce records.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindSessionToTask } from "./hook.mjs";
import { readTaskSessionEvents, taskSessionsPath, appendTaskSessionEvent } from "./todos.mjs";

const task = (id, extra = {}) => ({
  id,
  number: Number(String(id).replace(/\D/g, "")) || 1,
  subject: `task ${id}`,
  status: "queue",
  project: "proj",
  ...extra,
});

describe("bindSessionToTask", () => {
  let dir;
  const savedAppData = process.env.APPDATA;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-hookbind-"));
    process.env.APPDATA = dir;
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  const events = () => readTaskSessionEvents(taskSessionsPath());

  it("binds the session when exactly one task is in_progress", () => {
    const tasks = [task("t1", { status: "in_progress" }), task("t2")];
    const note = bindSessionToTask("sess-a", tasks);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      session: "sess-a",
      task: "t1",
      event: "start",
      source: "auto",
      project: "proj",
    });
    expect(note).toContain("t#1");
    expect(note).toContain("<cli> todos take");
  });

  it("does not append a second record when the hook fires again", () => {
    const tasks = [task("t1", { status: "in_progress" })];
    bindSessionToTask("sess-a", tasks);
    const note = bindSessionToTask("sess-a", tasks);
    expect(events()).toHaveLength(1);
    // The note still prints — the binding is as true on the second run.
    expect(note).toContain("t#1");
  });

  // SessionStart fires again on resume/compact. By then the session may have run
  // `take` on a task that is NOT the single in_progress one (a review task being
  // finished, say) — re-guessing there would silently steal the cost back.
  it("never overrides an explicit binding made earlier in the session", () => {
    appendTaskSessionEvent({ session: "sess-a", task: "t9", event: "start", source: "take", project: "proj" });
    const note = bindSessionToTask("sess-a", [
      task("t1", { status: "in_progress" }),
      task("t9", { number: 9, status: "review" }),
    ]);
    expect(events()).toHaveLength(1);
    expect(note).toContain("t#9");
    expect(note).toContain("explicitly");
  });

  it("still binds after an explicit record for the SAME task (no duplicate)", () => {
    appendTaskSessionEvent({ session: "sess-a", task: "t1", event: "start", source: "set-status", project: "proj" });
    bindSessionToTask("sess-a", [task("t1", { status: "in_progress" })]);
    expect(events()).toHaveLength(1);
  });

  it("re-binds when the session's last record points at another task", () => {
    bindSessionToTask("sess-a", [task("t1", { status: "in_progress" })]);
    bindSessionToTask("sess-a", [task("t2", { status: "in_progress" })]);
    bindSessionToTask("sess-a", [task("t1", { status: "in_progress" })]);
    expect(events().map((e) => e.task)).toEqual(["t1", "t2", "t1"]);
  });

  it("dedups per session — another session records its own binding", () => {
    const tasks = [task("t1", { status: "in_progress" })];
    bindSessionToTask("sess-a", tasks);
    bindSessionToTask("sess-b", tasks);
    expect(events().map((e) => e.session)).toEqual(["sess-a", "sess-b"]);
  });

  it("writes nothing and asks for a take when two tasks are in_progress", () => {
    const note = bindSessionToTask("sess-a", [
      task("t1", { status: "in_progress" }),
      task("t2", { status: "in_progress" }),
    ]);
    expect(events()).toHaveLength(0);
    expect(note).toContain("<cli> todos take");
    expect(note).toContain("t#1");
    expect(note).toContain("t#2");
  });

  it("stays completely silent with no in_progress task", () => {
    expect(bindSessionToTask("sess-a", [task("t1"), task("t2")])).toBe("");
    expect(bindSessionToTask("sess-a", [])).toBe("");
    expect(bindSessionToTask("sess-a", undefined)).toBe("");
    expect(events()).toHaveLength(0);
  });

  it("does nothing without a session id — there is nothing to bind", () => {
    expect(bindSessionToTask("", [task("t1", { status: "in_progress" })])).toBe("");
    expect(events()).toHaveLength(0);
  });

  it("omits the project for a global (project-less) task", () => {
    bindSessionToTask("sess-a", [
      task("t1", { status: "in_progress", project: null }),
    ]);
    expect(events()[0]).not.toHaveProperty("project");
  });
});

// End-to-end through the dispatcher: the session id comes off the SessionStart
// stdin payload, and the context off-switch must not stop the binding.
describe("cli.mjs hook (stdin payload)", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let appDir;

  const setup = (settings) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-hooke2e-"));
    appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "todos.json"),
      JSON.stringify({
        version: 1,
        todos: [
          {
            id: "task-uuid",
            number: 4,
            subject: "the running task",
            status: "in_progress",
            priority: "high",
            project: "proj",
          },
        ],
      }),
    );
    if (settings) {
      writeFileSync(path.join(appDir, "settings.json"), JSON.stringify(settings));
    }
  };

  const runHook = () => {
    const env = { ...process.env, APPDATA: dir };
    delete env.CLAUDE_CODE_SESSION_ID;
    return execFileSync(process.execPath, [cli, "hook"], {
      env,
      encoding: "utf8",
      input: JSON.stringify({ cwd: "D:\\work\\proj", session_id: "sess-e2e" }),
    });
  };

  const written = () =>
    readTaskSessionEvents(path.join(appDir, "task-sessions.jsonl"));

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records the binding once and names it in the injected context", () => {
    setup(null);
    const out = runHook();
    expect(out).toContain("Session ↔ task");
    expect(out).toContain("t#4");
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      session: "sess-e2e",
      task: "task-uuid",
      event: "start",
      source: "auto",
    });
    runHook();
    expect(written()).toHaveLength(1);
  });

  it("still records the binding when context injection is switched off", () => {
    setup({ hookContextEnabled: false });
    expect(runHook()).toBe("");
    expect(written()).toHaveLength(1);
  });

  // t#340: the shown in_progress task's `spec` field is a separate channel from
  // the change vision — printed whole, addressed by `<домен>#<слаг>`.
  it("surfaces the addressed spec section for a shown in_progress task's own `spec` field", () => {
    const specDir = mkdtempSync(path.join(os.tmpdir(), "cut-hooke2e-specs-"));
    mkdirSync(path.join(specDir, "proj"), { recursive: true });
    writeFileSync(
      path.join(specDir, "proj", "spec.md"),
      [
        "---",
        "id: proj",
        "version: 1",
        "---",
        "## a — Section A",
        "",
        "part: требования",
        "",
        "Text of section a.",
        "",
      ].join("\n"),
    );
    try {
      setup({ specRoot: specDir });
      const data = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
      data.todos[0].spec = ["proj#a"];
      writeFileSync(path.join(appDir, "todos.json"), JSON.stringify(data));
      writeFileSync(path.join(appDir, "settings.json"), JSON.stringify({ specRoot: specDir }));
      const out = runHook();
      expect(out).toContain("## a — Section A");
      expect(out).toContain("Text of section a.");
      expect(out).toContain("own `spec` field");
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });
});
