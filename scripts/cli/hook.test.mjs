// Unit tests for the SessionStart hook's session<->task binding (t#296).
//
// The binding is the hook's only write: when exactly one task of the project is
// in_progress it appends a `start` record to the task-sessions journal, so the
// session's token cost can be split into blocks (task × session × interval).
// Ambiguity (two in_progress) and repeat hook runs must NOT produce records.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindSessionToTask, buildWorkflowContext, buildWorkflowSummary, contractBlock } from "./hook.mjs";
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

describe("buildWorkflowContext", () => {
  const base = {
    criticModel: "openai/gpt-5.6-terra",
    architect: true,
    architectModel: "openai/gpt-5.6-terra",
    worker: "anthropic/sonnet",
    review: true,
    reviewModel: "anthropic/opus",
  };

  it.each([
    ["session", "YOU do this pass"],
    ["agent", "Runs as openai/gpt-5.6-terra"],
    ["off", "critic — off"],
  ])("describes critic mode %s truthfully", (critic, expected) => {
    expect(buildWorkflowContext({ ...base, critic, planGuard: true })).toContain(expected);
  });

  it.each([
    [true, true, "Gate: openai/gpt-5.6-terra refuses"],
    [true, false, "Architect gate off"],
    [false, true, "No gate: `plan-guard` is not wired"],
  ])("describes architect wiring=%s and enabled=%s truthfully", (planGuard, architect, expected) => {
    expect(buildWorkflowContext({ ...base, critic: "session", planGuard, architect })).toContain(expected);
  });

  it("keeps the auto runner explicitly separate from this session", () => {
    const context = buildWorkflowContext({ ...base, critic: "session", planGuard: true });
    expect(context).toContain("Auto runner — `cli run`, its own process, NOT this session");
    expect(context).toContain("runner → worker (anthropic/sonnet) → review (anthropic/opus)");
    expect(context).not.toContain("flowchart LR");
  });

  it("renders a Codex workflow without promising Claude plan hooks", () => {
    const context = buildWorkflowContext({ ...base, critic: "session", planGuard: false }, "codex");
    expect(context).toContain("WORKFLOW · this Codex session");
    expect(context).toContain("No tracker ExitPlanMode gate is wired for Codex");
    expect(context).not.toContain("revise and call ExitPlanMode again");
  });
});

describe("buildWorkflowSummary", () => {
  const base = {
    criticModel: "openai/gpt-5.6-terra",
    architect: true,
    architectModel: "openai/gpt-5.6-terra",
    worker: "anthropic/sonnet",
    review: true,
    reviewModel: "anthropic/opus",
  };

  it("fits on one line and names the same models as the full block", () => {
    const state = { ...base, critic: "agent", planGuard: true };
    const full = buildWorkflowContext(state);
    const summary = buildWorkflowSummary(state);
    expect(summary.split("\n")).toHaveLength(1);
    expect(summary.startsWith("workflow —")).toBe(true);
    expect(full).toContain(state.criticModel);
    expect(summary).toContain(state.criticModel);
    expect(full).toContain(state.architectModel);
    expect(summary).toContain(state.architectModel);
    expect(full).toContain(state.worker);
    expect(summary).toContain(state.worker);
    expect(full).toContain(state.reviewModel);
    expect(summary).toContain(state.reviewModel);
  });

  it("never disagrees with the full map on off/no-gate states", () => {
    const state = { ...base, critic: "off", planGuard: false, architect: false };
    expect(buildWorkflowSummary(state)).toContain("critic: off");
    expect(buildWorkflowSummary(state)).toContain("plan gate: none");
  });

  it("marks the Codex plan gate as absent, matching the full Codex map", () => {
    const state = { ...base, critic: "session", planGuard: true };
    const summary = buildWorkflowSummary(state, "codex");
    expect(summary).toContain("plan gate: none (Codex)");
  });
});

describe("contractBlock", () => {
  it.each(["startup", "clear", "banana", undefined])(
    "prints the full survival kit for source=%s",
    (source) => {
      const out = contractBlock(source, 12);
      expect(out).toContain("TASK TRACKER · how to edit the USER's todos (CLI)");
      expect(out).toContain("<cli> todos set <field> <id> <value>");
      expect(out).toContain("<cli> todos add ");
      expect(out).toContain("<cli> todos comment add");
      expect(out).toContain("<cli> todos dep add");
      expect(out).toContain("<cli> todos handoff set");
      expect(out).toContain("<cli> todos list");
      expect(out).toContain("t#12");
    },
  );

  it.each(["resume", "compact"])(
    "collapses to a two-line pointer for source=%s",
    (source) => {
      const out = contractBlock(source);
      expect(out.split("\n")).toHaveLength(2);
      expect(out).not.toContain("<cli> todos set <field>");
      expect(out).not.toContain("Rules:");
      expect(out).not.toContain("These are the USER's todos");
      expect(out).toContain("<cli> = node ");
      expect(out).toContain("<cli> todos --help");
    },
  );

  it("never mentions a task's uuid", () => {
    expect(contractBlock("startup")).not.toContain("uuid");
    expect(contractBlock("resume")).not.toContain("uuid");
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

  const runHook = (host, source) => {
    const env = { ...process.env, APPDATA: dir };
    delete env.CLAUDE_CODE_SESSION_ID;
    const args = [cli, "hook"];
    if (host) args.push("--host", host);
    return execFileSync(process.execPath, args, {
      env,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: "D:\\work\\proj",
        session_id: "sess-e2e",
        ...(source ? { source } : {}),
      }),
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

  it("prints the full contract on startup and a two-line pointer on resume, without dropping the binding line", () => {
    setup(null);
    const startupOut = runHook(undefined, "startup");
    expect(startupOut).toContain("how to edit the USER's todos (CLI)");
    expect(startupOut).toContain("<cli> todos set <field> <id> <value>");

    const resumeOut = runHook(undefined, "resume");
    expect(resumeOut).not.toContain("how to edit the USER's todos (CLI)");
    expect(resumeOut).not.toContain("<cli> todos set <field> <id> <value>");
    expect(resumeOut).toContain("<cli> = node ");
    expect(resumeOut).toContain("<cli> todos --help");
    expect(resumeOut).toContain("Session ↔ task");
    expect(resumeOut).toContain("t#4");

    const compactOut = runHook(undefined, "compact");
    expect(compactOut).not.toContain("<cli> todos set <field> <id> <value>");
    expect(compactOut).toContain("<cli> todos --help");

    expect(written()).toHaveLength(1);
  });

  it("falls back to the full contract for an absent or unrecognized source", () => {
    setup(null);
    expect(runHook()).toContain("how to edit the USER's todos (CLI)");
    expect(runHook(undefined, "some-future-source")).toContain(
      "how to edit the USER's todos (CLI)",
    );
  });

  it("never prints a task's raw uuid, on any source", () => {
    setup(null);
    expect(runHook(undefined, "startup")).not.toContain("⟨id:");
    expect(runHook(undefined, "resume")).not.toContain("⟨id:");
  });

  it("injects the optional role workflow before the first user prompt", () => {
    setup({ workflowContextEnabled: true });
    const out = runHook();
    expect(out).toContain("──────── WORKFLOW · this session");
    expect(out).toContain("0 triage");
    expect(out).toContain("Auto runner — `cli run`, its own process, NOT this session");
  });

  it("injects host-correct workflow text for Codex", () => {
    setup({ workflowContextEnabled: true });
    const out = runHook("codex");
    expect(out).toContain("WORKFLOW · this Codex session");
    expect(out).toContain("No tracker ExitPlanMode gate is wired for Codex");
    expect(out).not.toContain("plan mode → ExitPlanMode");
  });

  it("collapses the workflow block to a one-line summary on resume, naming the same models", () => {
    setup({ workflowContextEnabled: true });
    const startupOut = runHook(undefined, "startup");
    expect(startupOut).toContain("──────── WORKFLOW · this session");

    const resumeOut = runHook(undefined, "resume");
    expect(resumeOut).not.toContain("──────── WORKFLOW · this session");
    expect(resumeOut).toContain("workflow — critic:");
    expect(resumeOut.split("\n").filter((l) => l.startsWith("workflow —"))).toHaveLength(1);
    expect(startupOut).toContain("anthropic/sonnet");
    expect(resumeOut).toContain("anthropic/sonnet");
    expect(startupOut).toContain("anthropic/opus");
    expect(resumeOut).toContain("anthropic/opus");
  });

  it("prints the cross-project note on startup but drops it on resume", () => {
    setup(null);
    const startupOut = runHook(undefined, "startup");
    expect(startupOut).toContain("Cross-project:");

    const resumeOut = runHook(undefined, "resume");
    expect(resumeOut).not.toContain("Cross-project:");
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
      setup({ specRoot: specDir, specsEnabled: true });
      const data = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
      data.todos[0].spec = ["proj#a"];
      writeFileSync(path.join(appDir, "todos.json"), JSON.stringify(data));
      writeFileSync(
        path.join(appDir, "settings.json"),
        JSON.stringify({ specRoot: specDir, specsEnabled: true }),
      );
      const out = runHook();
      expect(out).toContain("## a — Section A");
      expect(out).toContain("Text of section a.");
      expect(out).toContain("own `spec` field");

      const resumeOut = runHook(undefined, "resume");
      expect(resumeOut).toContain("## a — Section A");
      expect(resumeOut).toContain("Text of section a.");
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  // t#361: the spec channel is off by DEFAULT — no settings.json at all still
  // means no spec section, while the task list and the change vision must
  // survive untouched (they are a different feature, not gated by this switch).
  it("shows no spec section, but keeps the task list and change vision, while specsEnabled is off (default)", () => {
    const specDir = mkdtempSync(path.join(os.tmpdir(), "cut-hooke2e-specs-off-"));
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
      data.changes = [
        {
          id: "ch-off",
          number: 9,
          title: "CHANGE: без спек",
          delta: "vision text survives with specs off",
        },
      ];
      data.todos[0].change_id = "ch-off";
      writeFileSync(path.join(appDir, "todos.json"), JSON.stringify(data));
      writeFileSync(path.join(appDir, "settings.json"), JSON.stringify({ specRoot: specDir }));
      const out = runHook();
      expect(out).not.toContain("## a — Section A");
      expect(out).not.toContain("own `spec` field");
      expect(out).toContain("vision text survives with specs off");
      expect(out).toContain("t#4");
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  // t#360: the vision lives on the change RECORD now. The hook used to hand
  // changeRootsFor a board stripped down to its tasks, so a migrated change had
  // no vision to inherit and the injection vanished without a word.
  it("surfaces the vision of a change RECORD, not just of a root task", () => {
    setup();
    const data = JSON.parse(readFileSync(path.join(appDir, "todos.json"), "utf8"));
    data.changes = [
      {
        id: "ch-1",
        number: 7,
        title: "CHANGE: записи вместо корней",
        delta: "что меняем в этом заходе и почему сейчас",
      },
    ];
    data.todos[0].change_id = "ch-1";
    writeFileSync(path.join(appDir, "todos.json"), JSON.stringify(data));
    const out = runHook();
    expect(out).toContain("c#7");
    expect(out).toContain("что меняем в этом заходе");

    const resumeOut = runHook(undefined, "resume");
    expect(resumeOut).toContain("c#7");
    expect(resumeOut).toContain("что меняем в этом заходе");
  });

  it("does not fail on an unreadable board — prints one recovery line and still injects context", () => {
    setup(null);
    writeFileSync(path.join(appDir, "todos.json"), "{ not json");
    const env = { ...process.env, APPDATA: dir };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [cli, "hook"], {
      env,
      encoding: "utf8",
      input: JSON.stringify({ cwd: "D:\\work\\proj", session_id: "sess-e2e" }),
      windowsHide: true,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/board recovery:.*unreadable/);
    expect(r.stdout).toContain("The Claude Usage Tracker is available");
    expect(written()).toHaveLength(0);
  });
});
