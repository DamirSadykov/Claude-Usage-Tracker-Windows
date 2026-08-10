// Unit tests for the change-vision walk (`cli.mjs todos vision`, t#252; the
// entity was `theme`, renamed to `change` at t#345).
//
// The pure helpers are what's worth testing: the UP-walk that finds the nearest
// change root(s) along each branch of the reverse dep graph, and the block both
// `vision <task>` and the in_progress anchor print.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeRootsFor,
  formatChangeVision,
  specAddressesFor,
  formatSpecSections,
  isChangeRoot,
  formatDeclarations,
  normalizeLimit,
  resolveTask,
  taskSessionsPath,
  currentSessionId,
  envWithoutSession,
  appendTaskSessionEvent,
  readTaskSessionEvents,
  lastTaskSessionEvent,
} from "./todos.mjs";

// Minimal board builder: rows are [id, {change, depends_on, ...}].
const board = (...rows) => ({
  todos: rows.map(([id, extra], i) => ({
    id,
    number: i + 1,
    subject: `task ${id}`,
    status: "queue",
    ...extra,
  })),
});

const byId = (data, id) => data.todos.find((t) => t.id === id);

describe("changeRootsFor", () => {
  it("finds the change root straight above a subtask", () => {
    const data = board(["child"], ["root", { change: true, depends_on: ["child"] }]);
    const roots = changeRootsFor(data, byId(data, "child"));
    expect(roots.map((r) => r.id)).toEqual(["root"]);
  });

  it("walks through non-change intermediates to the nearest root", () => {
    const data = board(
      ["leaf"],
      ["mid", { depends_on: ["leaf"] }],
      ["root", { change: true, depends_on: ["mid"] }],
    );
    expect(changeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "root",
    ]);
  });

  it("stops at the NEAREST root — an outer change wrapping an inner one stays out", () => {
    const data = board(
      ["leaf"],
      ["inner", { change: true, depends_on: ["leaf"] }],
      ["outer", { change: true, depends_on: ["inner"] }],
    );
    expect(changeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "inner",
    ]);
  });

  it("reports a root reachable via two branches once (diamond)", () => {
    const data = board(
      ["leaf"],
      ["a", { depends_on: ["leaf"] }],
      ["b", { depends_on: ["leaf"] }],
      ["root", { change: true, depends_on: ["a", "b"] }],
    );
    expect(changeRootsFor(data, byId(data, "leaf")).map((r) => r.id)).toEqual([
      "root",
    ]);
  });

  it("collects several distinct roots when branches lead to different changes", () => {
    const data = board(
      ["leaf"],
      ["root1", { change: true, depends_on: ["leaf"] }],
      ["root2", { change: true, depends_on: ["leaf"] }],
    );
    const ids = changeRootsFor(data, byId(data, "leaf")).map((r) => r.id);
    expect(ids.sort()).toEqual(["root1", "root2"]);
  });

  it("returns nothing when no change sits above, and never the task itself", () => {
    const data = board(
      ["self", { change: true }],
      ["dep", { depends_on: ["self"] }],
    );
    expect(changeRootsFor(data, byId(data, "self"))).toEqual([]);
    expect(changeRootsFor(data, byId(data, "dep"))).toEqual([]);
  });

  // t#345: the field was `theme` before the rename — a file saved by an older
  // build (or not yet re-saved) must keep working, read as `change`.
  it("reads a legacy `theme: true` root the same as `change: true`", () => {
    const data = board(["child"], ["root", { theme: true, depends_on: ["child"] }]);
    const roots = changeRootsFor(data, byId(data, "child"));
    expect(roots.map((r) => r.id)).toEqual(["root"]);
    expect(isChangeRoot(byId(data, "root"))).toBe(true);
  });
});

describe("formatChangeVision", () => {
  const t = { number: 7, subject: "the subtask" };

  it("prints each root's description as the vision", () => {
    const out = formatChangeVision(t, [
      { number: 9, subject: "CHANGE: X", status: "queue", description: "north star text" },
    ]);
    expect(out).toContain('#7 "the subtask"');
    expect(out).toContain("change t#9 CHANGE: X [queue]");
    expect(out).toContain("north star text");
  });

  it("адресует запись как c#N, а немигрированный корень как t#N", () => {
    const record = formatChangeVision(t, [
      { number: 4, address: "c#4", subject: "CHANGE: запись", status: "queue", description: "дельта" },
    ]);
    expect(record).toContain("── change c#4 CHANGE: запись");
  });

  it("nudges to fill an empty description instead of printing a blank block", () => {
    const out = formatChangeVision(t, [
      { number: 9, subject: "CHANGE: X", status: "queue", description: "  " },
    ]);
    expect(out).toContain("vision is missing");
    expect(out).toContain("t#9");
  });
});

// t#340: the spec channel a task carries into context at the in_progress
// anchor — the addressed section(s) of `docs/specs` its own `spec` field (or,
// failing that, its change root's) names, printed WHOLE and next to the vision,
// never instead of it (docs/specs/README.md §7/§8).
describe("specAddressesFor", () => {
  it("uses the task's own spec field when it has one", () => {
    const t = { spec: ["proj#a", "proj#b"] };
    expect(specAddressesFor(t, [{ spec: ["proj#c"] }])).toEqual({
      source: "task",
      addresses: ["proj#a", "proj#b"],
    });
  });

  it("falls back to the change root's spec field when the task has none", () => {
    const t = {};
    const roots = [{ spec: ["proj#a"] }];
    expect(specAddressesFor(t, roots)).toEqual({ source: "root", addresses: ["proj#a"] });
  });

  it("collects and dedups addresses across several roots", () => {
    const t = {};
    const roots = [{ spec: ["proj#a"] }, { spec: ["proj#a", "proj#b"] }];
    expect(specAddressesFor(t, roots)).toEqual({ source: "root", addresses: ["proj#a", "proj#b"] });
  });

  it("ignores the root's spec entirely once the task carries its own — no double-print", () => {
    const t = { spec: ["proj#a"] };
    const roots = [{ spec: ["proj#a"] }];
    expect(specAddressesFor(t, roots)).toEqual({ source: "task", addresses: ["proj#a"] });
  });

  it("returns nothing when neither the task nor any root carries a spec — the channel stays silent", () => {
    expect(specAddressesFor({}, [])).toEqual({ source: "root", addresses: [] });
    expect(specAddressesFor({}, [{}])).toEqual({ source: "root", addresses: [] });
  });
});

describe("formatSpecSections", () => {
  let dir, appDataDir;
  const t = { number: 7, subject: "the subtask" };

  function writeDomain(id, frontmatter, body) {
    const domDir = path.join(dir, id);
    mkdirSync(domDir, { recursive: true });
    writeFileSync(path.join(domDir, "spec.md"), `---\n${frontmatter}\n---\n${body}`);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-todos-spec-"));
    appDataDir = mkdtempSync(path.join(os.tmpdir(), "cut-todos-spec-appdata-"));
    writeDomain(
      "proj",
      ["id: proj", "version: 1", "updated: 2026-08-03"].join("\n"),
      [
        "## a — Section A",
        "",
        "part: требования",
        "",
        "Text of section a.",
        "",
        "## b — Section B",
        "",
        "part: устройство",
        "refs: proj#a",
        "",
        "Text of section b, refers to a.",
        "",
        "## unreachable — Section unreachable",
        "",
        "part: устройство",
        "location: repo=private path=specs/proj/spec.md",
        "",
        "Lives outside this repo.",
      ].join("\n"),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(appDataDir, { recursive: true, force: true });
  });

  it("returns nothing when there is no address to print", () => {
    expect(formatSpecSections(t, { source: "root", addresses: [] }, { root: dir, appData: appDataDir })).toBe("");
  });

  it("prints the addressed section whole — heading, part, refs and prose — attributed to the task's own field", () => {
    const out = formatSpecSections(
      t,
      { source: "task", addresses: ["proj#a"] },
      { root: dir, appData: appDataDir },
    );
    expect(out).toContain('#7 "the subtask"\'s own `spec` field');
    expect(out).toContain("## a — Section A");
    expect(out).toContain("part: требования");
    expect(out).toContain("Text of section a.");
  });

  it("attributes the section to the change root's field when that's the source", () => {
    const out = formatSpecSections(
      t,
      { source: "root", addresses: ["proj#a"] },
      { root: dir, appData: appDataDir },
    );
    expect(out).toContain("change root(s)");
  });

  it("prints every address in full when there are several", () => {
    const out = formatSpecSections(
      t,
      { source: "task", addresses: ["proj#a", "proj#b"] },
      { root: dir, appData: appDataDir },
    );
    expect(out).toContain("## a — Section A");
    expect(out).toContain("## b — Section B");
    // refs is named as an ADDRESS only, never expanded into b's own text here.
    expect(out).toContain("refs: proj#a");
    expect(out.match(/Text of section a\./g)).toHaveLength(1);
  });

  it("names what's missing for an address that does not exist, instead of staying silent", () => {
    const out = formatSpecSections(
      t,
      { source: "task", addresses: ["proj#does-not-exist"] },
      { root: dir, appData: appDataDir },
    );
    expect(out).toContain("proj#does-not-exist");
    expect(out).toMatch(/нет раздела/);
  });

  it("reports a declared-but-unavailable section by name, not a silent empty block", () => {
    const out = formatSpecSections(
      t,
      { source: "task", addresses: ["proj#unreachable"] },
      { root: dir, appData: appDataDir },
    );
    expect(out).toContain("proj#unreachable");
    expect(out).toMatch(/недоступен/);
    expect(out).toContain('"private"');
  });
});

// The help promises "add/dep/ref args also accept N|#N" — `comment add`,
// `comment list` and `set project` used to look the id up directly and only
// matched a full UUID.
describe("resolveTask", () => {
  const data = board(["aaa-uuid"], ["bbb-uuid"]);

  it("matches a full id", () => {
    expect(resolveTask(data, "bbb-uuid").number).toBe(2);
  });

  it("matches the board number in every notation", () => {
    for (const token of ["2", "#2", "t#2"]) {
      expect(resolveTask(data, token).id).toBe("bbb-uuid");
    }
  });

  it("returns undefined for an unknown number or an empty token", () => {
    expect(resolveTask(data, "99")).toBeUndefined();
    expect(resolveTask(data, "")).toBeUndefined();
  });
});

// The session<->task binding journal (t#295): an append-only jsonl next to
// todos.json, so parallel sessions can record a binding without the
// read-modify-write race a shared JSON file would have.
describe("task-session journal", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const savedSession = process.env.CLAUDE_CODE_SESSION_ID;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-tasksess-"));
    process.env.APPDATA = dir;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    if (savedSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSession;
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one record per event and reads them back in order", () => {
    expect(appendTaskSessionEvent({ session: "s1", task: "t1", event: "start", source: "take" })).toBe(true);
    expect(appendTaskSessionEvent({ session: "s1", task: "t1", event: "end", source: "set-status" })).toBe(true);
    const events = readTaskSessionEvents();
    expect(events.map((e) => e.event)).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({ session: "s1", task: "t1", source: "take" });
    expect(typeof events[0].ts).toBe("string");
  });

  it("carries the project only when the task has one", () => {
    appendTaskSessionEvent({ session: "s1", task: "t1", event: "start", source: "take", project: "proj" });
    appendTaskSessionEvent({ session: "s1", task: "t2", event: "start", source: "take", project: null });
    const [withProj, without] = readTaskSessionEvents();
    expect(withProj.project).toBe("proj");
    expect(without).not.toHaveProperty("project");
  });

  it("writes nothing when the session, task or event is missing", () => {
    expect(appendTaskSessionEvent({ task: "t1", event: "start" })).toBe(false);
    expect(appendTaskSessionEvent({ session: "s1", event: "start" })).toBe(false);
    expect(appendTaskSessionEvent({ session: "s1", task: "t1" })).toBe(false);
    expect(existsSync(taskSessionsPath())).toBe(false);
  });

  it("skips malformed lines instead of throwing", () => {
    appendTaskSessionEvent({ session: "s1", task: "t1", event: "start", source: "take" });
    const file = taskSessionsPath();
    writeFileSync(file, readFileSync(file, "utf8") + "{ not json\n\n");
    appendTaskSessionEvent({ session: "s1", task: "t2", event: "start", source: "take" });
    expect(readTaskSessionEvents().map((e) => e.task)).toEqual(["t1", "t2"]);
  });

  it("reads an empty journal as no events", () => {
    expect(readTaskSessionEvents()).toEqual([]);
    expect(lastTaskSessionEvent("s1")).toBeNull();
  });

  // What the SessionStart hook dedups against (t#296): re-binding the same
  // session to the same task on every hook run would flood the journal.
  it("lastTaskSessionEvent returns the latest record of THAT session only", () => {
    appendTaskSessionEvent({ session: "s1", task: "t1", event: "start", source: "take" });
    appendTaskSessionEvent({ session: "s2", task: "t9", event: "start", source: "auto" });
    appendTaskSessionEvent({ session: "s1", task: "t2", event: "start", source: "take" });
    expect(lastTaskSessionEvent("s1")).toMatchObject({ task: "t2" });
    expect(lastTaskSessionEvent("s2")).toMatchObject({ task: "t9" });
    expect(lastTaskSessionEvent("")).toBeNull();
  });

  it("takes the session id from --session first, then the environment", () => {
    expect(currentSessionId({})).toBe("");
    process.env.CLAUDE_CODE_SESSION_ID = "env-session";
    expect(currentSessionId({})).toBe("env-session");
    expect(currentSessionId({ session: "flag-session" })).toBe("flag-session");
    expect(currentSessionId({ session: true })).toBe("env-session");
  });

  // What the runner hands its children (t#312): the variable gone, everything
  // else — APPDATA above all, which is what points them at this journal — intact.
  it("envWithoutSession erases only the session id, and never in place", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "env-session";
    const child = envWithoutSession();
    expect("CLAUDE_CODE_SESSION_ID" in child).toBe(false);
    expect(child.APPDATA).toBe(process.env.APPDATA);
    expect(process.env.CLAUDE_CODE_SESSION_ID).toBe("env-session");
    expect(currentSessionId({})).toBe("env-session");
    expect(envWithoutSession({ A: "1" })).toEqual({ A: "1" });
  });
});

// `take` outside a Claude Code session has nothing to bind — it must say so
// rather than record a binding with an empty session.
describe("todos take without a session id", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");

  // A continuation session re-runs `set status <id> in_progress` on a task that
  // is ALREADY in_progress: the status write short-circuits, but the binding
  // must still be recorded — that session did work on the task.
  it("records the binding even when the status move is a no-op", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-setstatus-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(appDir)},{recursive:true})`]);
    writeFileSync(
      path.join(appDir, "todos.json"),
      JSON.stringify({
        version: 1,
        todos: [{ id: "task-uuid", number: 1, subject: "s", status: "in_progress", project: "p" }],
      }),
    );
    const env = { ...process.env, APPDATA: dir, CLAUDE_CODE_SESSION_ID: "sess-cont" };
    const out = execFileSync(process.execPath, [cli, "todos", "set", "status", "1", "in_progress"], {
      env,
      encoding: "utf8",
    });
    expect(out).toContain("already in_progress");
    const events = readTaskSessionEvents(path.join(appDir, "task-sessions.jsonl"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "sess-cont", task: "task-uuid", event: "start", source: "set-status" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails with a message naming the variable and the --session escape", () => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    let stderr = "";
    let failed = false;
    try {
      execFileSync(process.execPath, [cli, "todos", "take", "1"], { env, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      failed = true;
      stderr = String(e.stderr || "");
    }
    expect(failed).toBe(true);
    expect(stderr).toContain("CLAUDE_CODE_SESSION_ID");
    expect(stderr).toContain("--session");
  });
});

// --- process DSL declarations (t#302) ---------------------------------------
//
// The fields a node declares BEFORE it runs. Two things are worth guarding by
// test: the §15 invariants the setters enforce (a transition without a declared
// limit, a target off the board, the ?issue edge never becoming a dependency),
// and the file itself — an undeclared field must be ABSENT, not null/empty, and
// declaring must not disturb the rest of the task.

describe("normalizeLimit", () => {
  it("takes a positive number and the plan notations <=M / $N", () => {
    expect(normalizeLimit("3")).toBe(3);
    expect(normalizeLimit("<=2")).toBe(2);
    expect(normalizeLimit("$2.5", { integer: false })).toBe(2.5);
  });

  it("reads none|clear|off|empty as withdrawing the declaration", () => {
    for (const v of ["none", "clear", "off", ""]) expect(normalizeLimit(v)).toBeNull();
  });

  it("rejects zero, negatives, fractions where whole is required, and junk", () => {
    for (const v of ["0", "-1", "1.5", "two", "1e3", true, null]) {
      expect(normalizeLimit(v)).toBeUndefined();
    }
    expect(normalizeLimit("0", { integer: false })).toBeUndefined();
  });
});

describe("formatDeclarations", () => {
  it("prints the declarations of a node on one compact line", () => {
    const out = formatDeclarations(
      {
        number: 3,
        subject: "teach the CLI",
        status: "queue",
        kind: "auto",
        produces: ["scripts/cli/todos.mjs", "scripts/cli/todos.test.mjs"],
        verify: "npm test",
        retry_limit: 2,
        budget_usd: 2,
        on_issue: "impl-id",
      },
      new Map([["impl-id", { number: 2 }]]),
    );
    expect(out).toContain("#3 [queue] teach the CLI");
    expect(out).toContain("auto");
    expect(out).toContain("produces: scripts/cli/todos.mjs, scripts/cli/todos.test.mjs");
    expect(out).toContain("verify: npm test");
    expect(out).toContain("retry: <=2");
    expect(out).toContain("budget: $2");
    expect(out).toContain("?issue -> #2");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  // t#310: the "nothing else declared" filler is gone — a node with no
  // declarations prints its kind and nothing more (and is only listed at all
  // when it is on the frontier).
  it("prints only the kind when a node declared nothing else", () => {
    const out = formatDeclarations({ number: 4, subject: "bare", status: "queue" }, new Map());
    expect(out.trim()).toBe("#4 [queue] bare — manual");
    expect(out).not.toContain("⚠");
  });

  it("marks a frontier node with ▸ and leaves the others unmarked", () => {
    const t = { number: 4, subject: "bare", status: "queue" };
    expect(formatDeclarations(t, new Map(), { ready: true })).toContain("▸ #4");
    expect(formatDeclarations(t, new Map())).not.toContain("▸");
  });

  it("warns that an auto node without verify runs as a gate", () => {
    const out = formatDeclarations(
      { number: 5, subject: "unchecked", status: "queue", kind: "auto" },
      new Map(),
    );
    expect(out).toContain("auto without verify");
    expect(out).toContain("GATE");
    expect(out).toContain("todos set verify 5");
  });

  it("shows the parallel limit and the raw id of a vanished ?issue target", () => {
    const out = formatDeclarations(
      { number: 6, subject: "change", status: "queue", change: true, parallel_limit: 2, on_issue: "gone" },
      new Map(),
    );
    expect(out).toContain("parallel: 2");
    expect(out).toContain("?issue -> gone");
  });
});

describe("declaration commands", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;

  // Two tasks on one board plus one on another, so the cross-board guard has a
  // target. Project-less (global) rows show up in every board's `pipeline`.
  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-dsl-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos }, null, 2));
  };

  const todo = (number, extra = {}) => ({
    id: `id-${number}`,
    number,
    subject: `task ${number}`,
    description: "",
    status: "queue",
    plan: "",
    created_by: "claude",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...extra,
  });

  const run = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  // Returns the stderr of a command expected to FAIL (null when it succeeded).
  const refuse = (...args) => {
    try {
      execFileSync(process.execPath, [cli, "todos", ...args], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
      return null;
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const read = (number) =>
    JSON.parse(readFileSync(file, "utf8")).todos.find((t) => t.number === number);

  beforeEach(() => seed([todo(1), todo(2), todo(3, { project: "other-board" })]));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("produces add declares outputs and produces list reads them back", () => {
    run("produces", "add", "1", "scripts/cli/todos.mjs");
    run("produces", "add", "#1", "scripts/cli/todos.test.mjs");
    expect(read(1).produces).toEqual([
      "scripts/cli/todos.mjs",
      "scripts/cli/todos.test.mjs",
    ]);
    const listed = run("produces", "list", "t#1");
    expect(listed).toContain("scripts/cli/todos.mjs");
    expect(JSON.parse(run("produces", "list", "1", "--json")).produces).toHaveLength(2);
  });

  it("produces add ignores a duplicate and rm removes the field with the last entry", () => {
    run("produces", "add", "1", "a.mjs");
    expect(run("produces", "add", "1", "a.mjs")).toContain("already produces");
    expect(read(1).produces).toEqual(["a.mjs"]);
    expect(run("produces", "rm", "1", "b.mjs")).toContain("did not declare");
    run("produces", "rm", "1", "a.mjs");
    expect(read(1)).not.toHaveProperty("produces");
  });

  it("set verify declares the check and an empty string clears the field", () => {
    run("set", "verify", "1", "npx vitest run");
    expect(read(1).verify).toBe("npx vitest run");
    expect(run("set", "verify", "1", "")).toContain("verify cleared");
    expect(read(1)).not.toHaveProperty("verify");
  });

  it("set retry stores a positive limit, takes <=M, and none withdraws it", () => {
    run("set", "retry", "1", "3");
    expect(read(1).retry_limit).toBe(3);
    run("set", "retry", "1", "<=2");
    expect(read(1).retry_limit).toBe(2);
    run("set", "retry", "1", "none");
    expect(read(1)).not.toHaveProperty("retry_limit");
  });

  it("set retry refuses anything that is not a positive whole number", () => {
    for (const bad of ["0", "-2", "1.5", "many"]) {
      expect(refuse("set", "retry", "1", bad)).toContain("invalid retry limit");
    }
    expect(read(1)).not.toHaveProperty("retry_limit");
  });

  it("set budget stores dollars, takes $N, and none withdraws it", () => {
    run("set", "budget", "1", "$2.5");
    expect(read(1).budget_usd).toBe(2.5);
    run("set", "budget", "1", "none");
    expect(read(1)).not.toHaveProperty("budget_usd");
  });

  it("set budget refuses a non-positive or non-numeric ceiling", () => {
    for (const bad of ["0", "-1", "cheap"]) {
      expect(refuse("set", "budget", "1", bad)).toContain("invalid budget");
    }
    expect(read(1)).not.toHaveProperty("budget_usd");
  });

  it("set parallel refuses a limit on a task and points at the change record", () => {
    seed([todo(1, { change: true }), todo(2)]);
    const out = refuse("set", "parallel", "1", "2");
    expect(out).toContain("belongs to the CHANGE");
    expect(out).toContain("cli change set parallel <c#N> 2");
    expect(read(1)).not.toHaveProperty("parallel_limit");
  });

  it("set parallel none clears a limit inherited from an unmigrated root", () => {
    seed([todo(1, { change: true, parallel_limit: 2 }), todo(2)]);
    run("set", "parallel", "1", "none");
    expect(read(1)).not.toHaveProperty("parallel_limit");
  });

  it("set parallel refuses anything that is not a positive whole number", () => {
    for (const bad of ["0", "-1", "2.5", "lots"]) {
      expect(refuse("set", "parallel", "1", bad)).toContain("invalid parallel limit");
    }
    expect(read(1)).not.toHaveProperty("parallel_limit");
  });

  it("set on-issue declares the transition once a retry limit exists", () => {
    run("set", "retry", "1", "2");
    const out = run("set", "on-issue", "1", "#2");
    expect(out).toContain("?issue -> #2");
    expect(out).toContain("not a dependency");
    expect(read(1).on_issue).toBe("id-2");
    expect(run("set", "on-issue", "1", "none")).toContain("cleared");
    expect(read(1)).not.toHaveProperty("on_issue");
  });

  // §15: «отсутствие объявленного лимита запрещает переход, а не разрешает бесконечный»
  it("set on-issue refuses a node with no declared retry limit", () => {
    const err = refuse("set", "on-issue", "1", "2");
    expect(err).toContain("no declared retry limit");
    expect(err).toContain("does not permit an endless one");
    expect(err).toContain("todos set retry 1");
    expect(read(1)).not.toHaveProperty("on_issue");
  });

  it("set on-issue refuses a target on another board", () => {
    run("set", "retry", "1", "2");
    const err = refuse("set", "on-issue", "1", "3");
    expect(err).toContain("another board");
    expect(read(1)).not.toHaveProperty("on_issue");
  });

  it("set on-issue refuses a transition to the task itself", () => {
    run("set", "retry", "1", "2");
    const err = refuse("set", "on-issue", "1", "1");
    expect(err).toContain("itself");
    expect(read(1)).not.toHaveProperty("on_issue");
  });

  // §15: the loop lives on the run layer — a back edge in depends_on would break
  // the acyclicity the dep graph is checked for.
  it("set on-issue never writes an edge into depends_on", () => {
    run("dep", "add", "2", "1");
    run("set", "retry", "2", "2");
    run("set", "on-issue", "2", "1");
    expect(read(2).on_issue).toBe("id-1");
    expect(read(2).depends_on).toEqual(["id-1"]);
    expect(read(1)).not.toHaveProperty("depends_on");
    expect(read(1)).not.toHaveProperty("on_issue");
  });

  it("withdrawing the retry limit flags the ?issue transition it leaves unrunnable", () => {
    run("set", "retry", "1", "2");
    run("set", "on-issue", "1", "2");
    const out = run("set", "retry", "1", "none");
    expect(out).toContain("warn:");
    expect(out).toContain("?issue -> #2");
  });

  it("writes no empty declaration fields — undeclared means absent", () => {
    seed([todo(1, { parallel_limit: 2 }), todo(2)]);
    run("produces", "add", "1", "out.mjs");
    run("set", "verify", "1", "npm test");
    run("set", "retry", "1", "2");
    run("set", "budget", "1", "2");
    run("set", "on-issue", "1", "2");
    run("produces", "rm", "1", "out.mjs");
    run("set", "verify", "1", "");
    run("set", "retry", "1", "none");
    run("set", "budget", "1", "none");
    run("set", "parallel", "1", "none");
    run("set", "on-issue", "1", "none");
    const raw = readFileSync(file, "utf8");
    for (const field of ["produces", "verify", "retry_limit", "on_issue", "budget_usd", "parallel_limit"]) {
      expect(raw).not.toContain(field);
    }
  });

  it("declaring leaves the task's other fields untouched", () => {
    seed([
      todo(1, {
        description: "what & why",
        plan: "steps",
        handoff: "the baton",
        priority: "high",
        kind: "auto",
        depends_on: ["id-2"],
        comments: [{ id: "c1", author: "user", body: "note", created_at: "2026-07-01T00:00:00.000Z" }],
        status_history: [{ status: "queue", at: "2026-07-01T00:00:00.000Z" }],
      }),
      todo(2),
    ]);
    const before = read(1);
    run("produces", "add", "1", "out.mjs");
    run("set", "verify", "1", "npm test");
    run("set", "retry", "1", "2");
    run("set", "budget", "1", "2");
    run("set", "on-issue", "1", "2");
    const after = read(1);
    for (const [key, value] of Object.entries(before)) {
      if (key === "updated_at") continue;
      expect(after[key]).toEqual(value);
    }
    expect(after.updated_at).not.toBe(before.updated_at);
  });
});

// §8: the declarations listing in `pipeline` IS the discipline channel — the
// field is invisible otherwise, which is how `kind` ended up set on 3 of 20 nodes.
describe("todos pipeline declarations", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;

  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-pipe-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "todos.json"), JSON.stringify({ version: 1, todos }, null, 2));
  };

  const pipeline = (...args) =>
    execFileSync(process.execPath, [cli, "todos", "pipeline", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the commands and the fields, not the rules a command enforces", () => {
    seed([]);
    const out = pipeline();
    expect(out).toContain("todos produces add <task> <path>");
    expect(out).toContain("todos set <field> <task> <value>");
    for (const f of ["verify", "retry", "budget", "parallel", "on-issue", "kind"]) {
      expect(out).toContain(f);
    }
    expect(out).toContain("(no open tasks)");
  });

  // t#310, the whole point: a rule a command refuses on is not explained here
  // any more — the refusal explains it, at the moment it matters.
  it("no longer re-states what the CLI itself refuses", () => {
    seed([]);
    const out = pipeline();
    expect(out).not.toContain("never written into");
    expect(out).not.toMatch(/FORBIDS the/);
    expect(out).not.toMatch(/--force overrides/);
  });

  // ~100 lines is not read; a page is. The instruction plus an empty board has
  // to stay inside one screenful of scrollback.
  it("stays short — instructions + an empty board under 50 lines", () => {
    seed([]);
    expect(pipeline().split("\n").length).toBeLessThan(50);
  });

  it("prints frontier and declared nodes, and counts the rest in one line", () => {
    seed([
      {
        id: "a",
        number: 1,
        subject: "declared node",
        status: "queue",
        kind: "auto",
        produces: ["out.mjs"],
        verify: "npm test",
        retry_limit: 2,
        budget_usd: 2,
        on_issue: "b",
      },
      { id: "b", number: 2, subject: "plain ready node", status: "queue" },
      { id: "c", number: 3, subject: "blocked bare node", status: "queue", depends_on: ["b"] },
      { id: "d", number: 4, subject: "another bare one", status: "queue", depends_on: ["b"] },
      { id: "e", number: 5, subject: "closed node", status: "done" },
    ]);
    const out = pipeline();
    expect(out).toContain("▸ #1 [queue] declared node — auto · produces: out.mjs · verify: npm test · retry: <=2 · budget: $2 · ?issue -> #2");
    expect(out).toContain("▸ #2 [queue] plain ready node — manual");
    expect(out).toContain("2 more open node(s): blocked and undeclared.");
    expect(out).not.toContain("blocked bare node");
    expect(out).not.toContain("#5 [done]");
  });

  // The filler that cost 13 of ~100 lines: one "nothing else declared" per node
  // that had declared nothing.
  it("prints no filler line for a node with nothing on it", () => {
    seed([
      { id: "a", number: 1, subject: "ready one", status: "queue" },
      { id: "b", number: 2, subject: "blocked one", status: "queue", depends_on: ["a"] },
    ]);
    expect(pipeline()).not.toContain("nothing else declared");
  });

  // A blocked node is hidden as noise UNLESS it declared something — the listing
  // is the discipline channel for declarations (§8), so those are never dropped.
  it("keeps a blocked node that declared something", () => {
    seed([
      { id: "a", number: 1, subject: "gate", status: "queue" },
      { id: "b", number: 2, subject: "declared but blocked", status: "queue", depends_on: ["a"], verify: "npm test" },
    ]);
    const out = pipeline();
    expect(out).toContain("#2 [queue] declared but blocked — manual · verify: npm test");
    expect(out).not.toContain("▸ #2");
  });

  it("warns about every auto node that has no verify", () => {
    seed([
      { id: "a", number: 1, subject: "unchecked", status: "queue", kind: "auto" },
      { id: "b", number: 2, subject: "checked", status: "queue", kind: "auto", verify: "npm test" },
    ]);
    const out = pipeline();
    expect(out).toContain("auto without verify");
    expect(out).toContain("1 auto node(s) without a check run as gates");
  });

  it("scopes the listing like list/ready — --project picks another board", () => {
    seed([
      { id: "a", number: 1, subject: "mine", status: "queue", project: "other-board" },
      { id: "b", number: 2, subject: "global one", status: "queue" },
    ]);
    expect(pipeline()).not.toContain("#1 [queue] mine");
    expect(pipeline()).toContain("#2 [queue] global one");
    expect(pipeline("--project", "other-board")).toContain("#1 [queue] mine");
  });
});

// --- one setter (t#310) ------------------------------------------------------
//
// `todos set <field> <task> <value>` replaced a dozen `set-<field>` verbs. Two
// things are pinned here: every field of the table still writes what it used to,
// and an unknown field or value is REFUSED with the list — the CLI, not the
// instruction, is where the legal values are now written down.

describe("todos set", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;

  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-set-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos }, null, 2));
  };

  const todo = (number, extra = {}) => ({
    id: `id-${number}`,
    number,
    subject: `task ${number}`,
    description: "",
    status: "queue",
    plan: "",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...extra,
  });

  const run = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  const refuse = (...args) => {
    try {
      execFileSync(process.execPath, [cli, "todos", ...args], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
      return null;
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const read = (number) =>
    JSON.parse(readFileSync(file, "utf8")).todos.find((t) => t.number === number);

  beforeEach(() => seed([todo(1), todo(2), todo(3, { project: "other-board" })]));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const scalars = [
    ["status", "review", (t) => expect(t.status).toBe("review")],
    ["priority", "high", (t) => expect(t.priority).toBe("high")],
    ["kind", "auto", (t) => expect(t.kind).toBe("auto")],
    ["project", "elsewhere", (t) => expect(t.project).toBe("elsewhere")],
    ["verify", "npm test", (t) => expect(t.verify).toBe("npm test")],
    ["retry", "3", (t) => expect(t.retry_limit).toBe(3)],
    ["budget", "$2.5", (t) => expect(t.budget_usd).toBe(2.5)],
  ];

  for (const [field, value, check] of scalars) {
    it(`writes the ${field} field`, () => {
      run("set", field, "1", value);
      check(read(1));
    });
  }

  it("set subject changes the title without touching description or other fields", () => {
    run("set", "description", "1", "--text", "keep me");
    run("set", "priority", "1", "high");
    run("set", "subject", "1", "a shorter title");
    const t = read(1);
    expect(t.subject).toBe("a shorter title");
    expect(t.description).toBe("keep me");
    expect(t.priority).toBe("high");
  });

  it("set subject accepts a title exactly at the 150-char cap", () => {
    const title = "x".repeat(150);
    run("set", "subject", "1", title);
    expect(read(1).subject).toBe(title);
    expect(read(1).subject.length).toBe(150);
  });

  it("set subject refuses a title one char over the cap", () => {
    const title = "x".repeat(151);
    const err = refuse("set", "subject", "1", title);
    expect(err).toContain("151");
    expect(err).toContain("150");
    expect(err).toContain("todos set description");
    expect(read(1).subject).toBe("task 1");
  });

  it("set subject refuses an empty title", () => {
    const err = refuse("set", "subject", "1", "");
    expect(err).toContain("empty");
    expect(read(1).subject).toBe("task 1");
  });

  it("set subject trims surrounding whitespace before checking the cap", () => {
    run("set", "subject", "1", "  padded title  ");
    expect(read(1).subject).toBe("padded title");
  });

  it("writes the on-issue field once a retry limit is declared", () => {
    run("set", "retry", "1", "2");
    run("set", "on-issue", "1", "#2");
    expect(read(1).on_issue).toBe("id-2");
  });

  it("writes the long-text fields from --text", () => {
    run("set", "plan", "1", "--text", "1. do it\n2. check it");
    run("set", "description", "1", "--text", "what & why");
    expect(read(1).plan).toBe("1. do it\n2. check it");
    expect(read(1).description).toBe("what & why");
  });

  it("takes an id, a bare number or #N as the task", () => {
    for (const ref of ["id-1", "1", "#1", "t#1"]) run("set", "priority", ref, "low");
    expect(read(1).priority).toBe("low");
    expect(refuse("set", "priority", "999", "low")).toContain("no todo with id 999");
  });

  it("refuses an unknown field and prints the ones that exist", () => {
    const err = refuse("set", "kindd", "1", "auto");
    expect(err).toContain('unknown field "kindd"');
    for (const f of ["status", "kind", "verify", "on-issue", "description"]) {
      expect(err).toContain(f);
    }
    expect(read(1)).not.toHaveProperty("kind");
  });

  it("prints the whole field table when no field is named", () => {
    const err = refuse("set");
    expect(err).toContain("usage: cli todos set <field> <task> <value>");
    expect(err).toContain("fields:");
    expect(err).toContain("on-issue");
  });

  it("refuses a missing value with that field's usage", () => {
    expect(refuse("set", "verify", "1")).toContain("usage: cli todos set verify <task>");
    expect(refuse("set", "plan", "1")).toContain("usage: cli todos set plan <task>");
  });

  const badValues = [
    ["status", "shipped", "invalid status"],
    ["priority", "urgent", "invalid priority"],
    ["kind", "semi", "invalid kind"],
    ["change", "maybe", "invalid change"],
    ["retry", "0", "invalid retry limit"],
    ["budget", "-1", "invalid budget"],
    ["parallel", "2.5", "invalid parallel limit"],
  ];

  for (const [field, value, message] of badValues) {
    it(`refuses an invalid ${field} value and names the valid ones`, () => {
      const err = refuse("set", field, "1", value);
      expect(err).toContain(message);
      expect(err.length).toBeGreaterThan(message.length);
    });
  }

  it("clears every optional field with none, leaving no empty key behind", () => {
    seed([todo(1, { parallel_limit: 2 }), todo(2)]);
    run("set", "priority", "1", "high");
    run("set", "kind", "1", "auto");
    run("set", "verify", "1", "npm test");
    run("set", "retry", "1", "2");
    run("set", "budget", "1", "2");
    run("set", "priority", "1", "none");
    run("set", "kind", "1", "manual");
    run("set", "change", "1", "none");
    run("set", "verify", "1", "");
    run("set", "retry", "1", "none");
    run("set", "budget", "1", "none");
    run("set", "parallel", "1", "none");
    const raw = readFileSync(file, "utf8");
    for (const key of [
      "priority",
      "kind",
      "change_id",
      "verify",
      "retry_limit",
      "budget_usd",
      "parallel_limit",
    ]) {
      expect(raw).not.toContain(key);
    }
  });
});

describe("todos add: subject cap", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-add-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos: [] }, null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  const refuse = (...args) => {
    try {
      execFileSync(process.execPath, [cli, "todos", ...args], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
      return null;
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const todos = () => JSON.parse(readFileSync(file, "utf8")).todos;

  it("accepts a subject exactly at the 150-char cap", () => {
    const subject = "x".repeat(150);
    run("add", subject, "--global");
    expect(todos()).toHaveLength(1);
    expect(todos()[0].subject).toBe(subject);
  });

  it("refuses a subject one char over the cap and creates nothing", () => {
    const subject = "x".repeat(151);
    const err = refuse("add", subject, "--global");
    expect(err).toContain("151");
    expect(err).toContain("150");
    expect(err).toContain("todos set description");
    expect(todos()).toHaveLength(0);
  });
});

// The rules that used to be paragraphs of `pipeline`/`--help` and are now the
// behaviour of the command itself: each one is a refusal or a warning printed at
// the moment it applies. This is the list the text was allowed to drop.
describe("rules the CLI enforces instead of explaining", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let file;

  const seed = (todos) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-rules-"));
    const appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos }, null, 2));
  };

  const todo = (number, extra = {}) => ({
    id: `id-${number}`,
    number,
    subject: `task ${number}`,
    description: "",
    status: "queue",
    plan: "",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...extra,
  });

  const run = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
    });

  const refuse = (...args) => {
    try {
      execFileSync(process.execPath, [cli, "todos", ...args], {
        env: { ...process.env, APPDATA: dir },
        encoding: "utf8",
        stdio: "pipe",
      });
      return null;
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const read = (number) =>
    JSON.parse(readFileSync(file, "utf8")).todos.find((t) => t.number === number);

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // t#323: deletion is irreversible, so it follows `apply`/`run` — a dry run
  // that shows the edges about to disappear, and nothing written without --go.
  describe("todos rm", () => {
    const all = () => JSON.parse(readFileSync(file, "utf8")).todos.map((t) => t.number);

    it("shows what would go and writes nothing without --go", () => {
      seed([todo(1), todo(2, { depends_on: ["id-1"] })]);
      const out = run("rm", "1");
      expect(out).toContain("DRY RUN");
      expect(out).toContain("blocks:");
      expect(all()).toEqual([1, 2]);
    });

    it("deletes the task and every edge that pointed at it", () => {
      seed([
        todo(1),
        todo(2, { depends_on: ["id-1"], links: ["id-1"] }),
        todo(3, { on_issue: "id-1", retry_limit: 2 }),
      ]);
      const out = run("rm", "1", "--go");
      expect(out).toContain("ok: deleted #1");
      expect(all()).toEqual([2, 3]);
      // A dangling edge is exactly what `lint` reports, so it is cleared here
      // rather than left behind for the linter to find.
      expect(read(2).depends_on).toBeUndefined();
      expect(read(2).links).toBeUndefined();
      expect(read(3).on_issue).toBeUndefined();
      expect(read(3).retry_limit).toBe(2);
    });

    it("refuses a task it cannot find instead of deleting something else", () => {
      seed([todo(1)]);
      expect(refuse("rm", "99", "--go")).toContain("usage");
      expect(all()).toEqual([1]);
    });
  });

  // §15, «auto без verify — не auto».
  it("warns at the moment a node is marked auto without a check", () => {
    seed([todo(1)]);
    const out = run("set", "kind", "1", "auto");
    expect(out).toContain("runs as a GATE");
    expect(out).toContain('todos set verify 1 "<cmd>"');
    expect(read(1).kind).toBe("auto");
  });

  it("stays quiet when the auto node already declares its check", () => {
    seed([todo(1, { verify: "npm test" })]);
    expect(run("set", "kind", "1", "auto")).not.toContain("GATE");
  });

  it("says an auto node was demoted to a gate when its check is withdrawn", () => {
    seed([todo(1, { kind: "auto", verify: "npm test" }), todo(2, { verify: "npm test" })]);
    expect(run("set", "verify", "1", "")).toContain("GATE");
    expect(run("set", "verify", "2", "")).not.toContain("GATE");
  });

  // t#360: a change is a RECORD, so the flag form has nothing to mark any more.
  it("refuses the old boolean form of set change and names the record form", () => {
    seed([todo(1), todo(2)]);
    const err = refuse("set", "change", "1", "on");
    expect(err).toContain("is the OLD root-task form");
    expect(err).toContain("cli change new");
  });

  // §1/§6: a declaration is made BEFORE the work.
  it("refuses a declaration on a closed node and names the way back", () => {
    seed([todo(1, { status: "done" })]);
    for (const [field, value] of [
      ["verify", "npm test"],
      ["retry", "2"],
      ["budget", "1"],
      ["kind", "auto"],
    ]) {
      const err = refuse("set", field, "1", value);
      expect(err).toContain("BEFORE the work");
      expect(err).toContain("todos set status 1 queue");
    }
    expect(refuse("produces", "add", "1", "out.mjs")).toContain("BEFORE the work");
    expect(read(1)).not.toHaveProperty("verify");
  });

  it("still allows the non-declaration fields on a closed node", () => {
    seed([todo(1, { status: "done" })]);
    run("set", "priority", "1", "high");
    expect(read(1).priority).toBe("high");
  });

  // The done-gate (#88): only `done` releases downstream, so it cannot be reached
  // over an unfinished prerequisite without an explicit override.
  it("refuses done while a direct prerequisite is open, and takes --force", () => {
    seed([todo(1, { depends_on: ["id-2"] }), todo(2)]);
    const err = refuse("set", "status", "1", "done");
    expect(err).toContain("depends on unfinished task(s)");
    expect(err).toContain("--force");
    run("set", "status", "1", "done", "--force");
    expect(read(1).status).toBe("done");
  });

  it("warns when a task is started off the frontier", () => {
    seed([todo(1, { depends_on: ["id-2"] }), todo(2)]);
    expect(run("set", "status", "1", "in_progress")).toContain("not on the frontier");
    seed([todo(1), todo(2)]);
    expect(run("set", "status", "1", "in_progress")).not.toContain("not on the frontier");
  });

  // t#253 field roles: one role each, never the same text in two.
  it("refuses text that is already in another field of the same task", () => {
    seed([todo(1)]);
    run("set", "description", "1", "--text", "the vision");
    const err = refuse("set", "plan", "1", "--text", "the vision");
    expect(err).toContain("already the description");
    expect(err).toContain("never the same text in two fields");
    expect(read(1).plan).toBe("");
  });

  it("warns when an ?issue transition points at a closed node", () => {
    seed([todo(1), todo(2, { status: "done" })]);
    run("set", "retry", "1", "2");
    expect(run("set", "on-issue", "1", "2")).toContain("is done");
  });
});

// The instruction may name only commands the CLI actually has: text and code
// drift apart the moment nothing compares them.
describe("the text and the CLI agree", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  const say = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      encoding: "utf8",
      windowsHide: true,
    });

  const fields = (() => {
    let out = "";
    try {
      execFileSync(process.execPath, [cli, "todos", "set"], {
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (e) {
      out = String(e.stderr || "");
    }
    return out
      .split("fields:")[1]
      .split("\n")
      .map((l) => l.trim().split(/\s/)[0])
      .filter(Boolean);
  })();

  it("names in `pipeline` no command or field the CLI does not have", () => {
    const help = say("--help");
    const out = say("pipeline");
    const named = [...out.matchAll(/\btodos ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(8);
    for (const cmd of new Set(named)) {
      if (cmd.startsWith("set ")) expect(fields).toContain(cmd.slice(4));
      else expect(help).toContain(`  ${cmd.split(" ")[0]} `);
    }
  });

  it("lists in --help exactly the fields `set` accepts", () => {
    const help = say("--help");
    expect(fields).toHaveLength(14);
    for (const f of fields) expect(help).toContain(f);
  });

  it("names no `set-<field>` verb in the help or the pipeline text", () => {
    expect(say("--help")).not.toMatch(/\bset-[a-z]/);
    expect(say("pipeline")).not.toMatch(/\bset-[a-z]/);
  });
});

// The old verbs were removed, not aliased (t#310), so a call left on one is a
// call that fails at runtime. Two files are exempt: they hold pre-t#310
// transcript fixtures on purpose, proving the parsers still read that history.
describe("no call site left on an old setter name", () => {
  const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const EXEMPT = new Set(["stop-hook.test.mjs", "task-cost.test.mjs"]);
  const SKIP_DIR = new Set(["node_modules", "target", ".git", "dist", "archive"]);

  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIR.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(mjs|md)$/.test(name) && !EXEMPT.has(name)) out.push(full);
    }
    return out;
  };

  it("has no `todos set-<field>` left in scripts, docs or the README", () => {
    const files = [
      ...walk(path.join(repoRoot, "scripts")),
      ...walk(path.join(repoRoot, "docs")),
      path.join(repoRoot, "README.md"),
    ];
    // Built from pieces so this file's own source cannot match its own patterns.
    const shell = new RegExp("todos " + "set" + "-[a-z]");
    const argv = new RegExp('"todos",\\s*"' + "set" + '-');
    const offenders = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (shell.test(text) || argv.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
