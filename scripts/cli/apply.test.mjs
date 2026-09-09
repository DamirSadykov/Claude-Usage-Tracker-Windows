import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYamlSubset, readDocument, validate } from "./apply.mjs";
import { withDeferredSave, saveBoard, setField } from "./todos.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

describe("the YAML subset apply reads", () => {
  it("reads nested mappings, block scalars and both list forms", () => {
    const doc = parseYamlSubset(
      [
        "change: CHANGE: язык процесса",
        "vision: |",
        "  Первая строка.",
        "  Вторая строка.",
        "parallel: 2",
        "steps:",
        "  1:",
        "    title: Собираю каркас",
        "    needs: [2, 3]",
        "    produces:",
        "      - scripts/cli/apply.mjs",
        "      - docs/spec.md",
      ].join("\n"),
    );
    // A value may itself contain a colon — only the FIRST one splits the pair.
    expect(doc.change).toBe("CHANGE: язык процесса");
    expect(doc.vision).toBe("Первая строка.\nВторая строка.");
    expect(doc.parallel).toBe("2");
    expect(doc.steps["1"].needs).toEqual(["2", "3"]);
    expect(doc.steps["1"].produces).toEqual(["scripts/cli/apply.mjs", "docs/spec.md"]);
  });

  it("keeps a t#N inside a value and drops only whole-line comments", () => {
    const doc = parseYamlSubset(["# заголовок файла", "vision: продолжение t#299", "steps:", "  1: шаг"].join("\n"));
    expect(doc.vision).toBe("продолжение t#299");
    expect(doc.steps["1"]).toBe("шаг");
  });

  it("takes steps as a list of objects as readily as a mapping", () => {
    const doc = readDocument(
      ["steps:", "  - id: A", "    title: Первый", "  - id: B", "    title: Второй", "    needs: [A]"].join("\n"),
    );
    expect(doc.steps.map((s) => s.id)).toEqual(["A", "B"]);
    expect(doc.steps[1].needs).toEqual(["A"]);
  });

  it("reads a bare string step as its title", () => {
    const doc = readDocument(["steps:", "  1: Собираю каркас"].join("\n"));
    expect(doc.steps[0]).toMatchObject({ id: "1", title: "Собираю каркас", needs: [] });
  });
});

// The rules of §15 live HERE, in code, which is the whole point of the command:
// the exit prompt no longer has to recite them for the graph to be valid.
describe("apply refuses an invalid graph", () => {
  const check = (yaml) => validate(readDocument(yaml));

  it("refuses a ?issue transition with no declared retry limit", () => {
    const { errors } = check(["steps:", "  1:", "    title: A", "  2:", "    title: B", "    on-issue: 1"].join("\n"));
    expect(errors.join(" ")).toMatch(/on-issue without a retry limit/);
  });

  it("takes the same transition once a limit is declared", () => {
    const { errors } = check(
      ["steps:", "  1:", "    title: A", "  2:", "    title: B", "    retry: 2", "    on-issue: 1"].join("\n"),
    );
    expect(errors).toEqual([]);
  });

  it("refuses a cycle in needs and names the ring", () => {
    const { errors } = check(
      ["steps:", "  1:", "    title: A", "    needs: [2]", "  2:", "    title: B", "    needs: [1]"].join("\n"),
    );
    expect(errors.join(" ")).toMatch(/needs form a cycle/);
  });

  it("refuses a need or a transition pointing at nothing", () => {
    const { errors } = check(["steps:", "  1:", "    title: A", "    needs: [9]"].join("\n"));
    expect(errors.join(" ")).toMatch(/neither a step of this file nor a task on the board/);
  });

  it("refuses a step with no title and a file with no steps", () => {
    expect(check(["steps:", "  1:", "    verify: npm test"].join("\n")).errors.join(" ")).toMatch(/no title/);
    expect(check("change: CHANGE: пусто").errors.join(" ")).toMatch(/no steps/);
  });

  it("only WARNS on auto without a verify — a gate is a legal graph", () => {
    const { errors, warnings } = check(["steps:", "  1:", "    title: A", "    kind: auto"].join("\n"));
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toMatch(/runs as a GATE/);
  });

  it("warns that parallel/budget land nowhere without a change root", () => {
    const { warnings } = check(["parallel: 2", "steps:", "  1: A"].join("\n"));
    expect(warnings.join(" ")).toMatch(/change/);
  });
});

describe("apply records the graph", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () =>
    JSON.parse(readFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), "utf8"));
  const todos = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
  const say = (...args) => todos("apply", ...args);

  const GRAPH = [
    "change: CHANGE: пробный процесс",
    "vision: Проверяю запись графа из файла.",
    "parallel: 2",
    "budget: 5",
    "steps:",
    "  1:",
    "    title: Собираю каркас",
    "    produces: [scripts/cli/apply.mjs]",
    "    verify: npm test",
    "    retry: 3",
    "    kind: auto",
    "  2:",
    "    title: Пишу тесты",
    "    needs: [1]",
    "    retry: 2",
    "    on-issue: 1",
    "  3:",
    "    title: Смотрю глазами",
    "    needs: [2]",
    "",
  ].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-apply-"));
    // The app data directory is the tracker's to create, exactly as in real use.
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    writeFileSync(path.join(dir, "graph.yaml"), GRAPH);
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing without --go", () => {
    const out = say(path.join(dir, "graph.yaml"));
    expect(out).toMatch(/DRY RUN, nothing written/);
    expect(() => board()).toThrow();
  });

  it("records tasks, dep edges and every declaration in one pass", () => {
    say(path.join(dir, "graph.yaml"), "--go");
    const { todos, changes } = board();
    const bySubject = Object.fromEntries(todos.map((t) => [t.subject, t]));
    const one = bySubject["Собираю каркас"];
    const two = bySubject["Пишу тесты"];
    const three = bySubject["Смотрю глазами"];
    const change = changes.find((c) => c.title === "CHANGE: пробный процесс");

    // The change is a RECORD now: no task carries it, and membership is a field.
    expect(bySubject["CHANGE: пробный процесс"]).toBeUndefined();
    expect(change.number).toBe(1);
    expect(change.delta).toMatch(/Проверяю запись графа/);
    expect(change.parallel_limit).toBe(2);
    expect(change.budget_usd).toBe(5);
    expect([one, two, three].map((t) => t.change_id)).toEqual([change.id, change.id, change.id]);

    expect(one.produces).toEqual(["scripts/cli/apply.mjs"]);
    expect(one.verify).toBe("npm test");
    expect(one.retry_limit).toBe(3);
    expect(one.kind).toBe("auto");

    expect(two.depends_on).toContain(one.id);
    expect(three.depends_on).toContain(two.id);
    expect(two.on_issue).toBe(one.id);
  });

  // §15: the loop lives on the run layer. A back edge in depends_on would break
  // acyclicity, so the transition must not leak into the dep graph.
  it("keeps a ?issue target out of depends_on", () => {
    writeFileSync(
      path.join(dir, "loop.yaml"),
      ["change: CHANGE: петля прогона", "steps:", "  1:", "    title: A", "  2:", "    title: B", "    needs: [1]", "  3:", "    title: C", "    needs: [2]", "    retry: 2", "    on-issue: 1"].join("\n"),
    );
    say(path.join(dir, "loop.yaml"), "--go");
    const { todos } = board();
    const a = todos.find((t) => t.subject === "A");
    const c = todos.find((t) => t.subject === "C");
    expect(c.on_issue).toBe(a.id);
    expect(c.depends_on || []).not.toContain(a.id);
  });

  it("re-applying the same file updates instead of forking the graph", () => {
    say(path.join(dir, "graph.yaml"), "--go");
    const before = board().todos.length;
    const out = say(path.join(dir, "graph.yaml"), "--go");
    expect(board().todos.length).toBe(before);
    expect(out).toMatch(/0 new step\(s\), 3 matched/);
  });

  it("leaves an existing vision alone unless --force says otherwise", () => {
    say(path.join(dir, "graph.yaml"), "--go");
    writeFileSync(path.join(dir, "graph.yaml"), GRAPH.replace("Проверяю запись графа из файла.", "Другое видение."));
    const kept = say(path.join(dir, "graph.yaml"), "--go");
    expect(kept).toMatch(/already carries a delta/);
    expect(board().changes[0].delta).toMatch(/Проверяю запись графа/);
    say(path.join(dir, "graph.yaml"), "--go", "--force");
    expect(board().changes[0].delta).toBe("Другое видение.");
  });

  // t#323: an interrupted run leaves tasks that were created but never linked to
  // the change. Searching only among the change's children would not see them, and
  // the next run would create a SECOND task with the same phrase — which is how
  // the live board got its duplicates.
  it("matches a task that is not (yet) a child of the change, and adopts it", () => {
    todos("add", "Пишу тесты");
    const out = say(path.join(dir, "graph.yaml"), "--go");
    expect(out).toMatch(/2 new step\(s\), 1 matched/);
    const { todos: rows } = board();
    expect(rows.filter((t) => t.subject === "Пишу тесты")).toHaveLength(1);
    const change = board().changes[0];
    const adopted = rows.find((t) => t.subject === "Пишу тесты");
    expect(adopted.change_id).toBe(change.id);
  });

  // Two steps sharing a phrase must not collapse onto one row: the second one
  // gets its own task rather than overwriting the first one's declarations.
  it("does not seat two steps on the same task", () => {
    writeFileSync(
      path.join(dir, "twins.yaml"),
      ["change: CHANGE: близнецы", "steps:", "  1:", "    title: Одинаковое", "  2:", "    title: Одинаковое"].join("\n"),
    );
    say(path.join(dir, "twins.yaml"), "--go");
    expect(board().todos.filter((t) => t.subject === "Одинаковое")).toHaveLength(2);
  });

  // Re-applying a file whose early steps are already finished is the normal case
  // once a run is under way. A declaration on a closed node is refused by the
  // board (a promise is made BEFORE the work) — the pass must survive that
  // instead of dying with the rest of the graph unwritten.
  it("skips declarations on a closed step instead of failing the pass", () => {
    say(path.join(dir, "graph.yaml"), "--go");
    const one = board().todos.find((t) => t.subject === "Собираю каркас");
    todos("set", "status", String(one.number), "done", "--force");
    const out = say(path.join(dir, "graph.yaml"), "--go");
    expect(out).toMatch(/its declarations were left as they are/);
    expect(out).toMatch(/0 new step\(s\)/);
    expect(board().todos.find((t) => t.subject === "Собираю каркас").verify).toBe("npm test");
  });

  it("refuses the whole file when a rule is broken — nothing half-written", () => {
    writeFileSync(path.join(dir, "bad.yaml"), ["steps:", "  1:", "    title: A", "  2:", "    title: B", "    on-issue: 1"].join("\n"));
    expect(() => say(path.join(dir, "bad.yaml"), "--go")).toThrow(/retry limit/);
    expect(() => board()).toThrow();
  });
});

// t#323: `apply` writes a task, its edges and its declarations one after the
// other, and every one of those used to hit the disk. A failure midway (the app
// holding the file — EPERM — is the one that actually happened) left the board
// half-built, and the re-run forked it into duplicates.
describe("a graph is written all at once or not at all", () => {
  let dir;
  let file;
  const row = () => ({
    id: "a",
    number: 1,
    subject: "A",
    status: "backlog",
    status_history: [{ status: "backlog", at: "2026-07-29T00:00:00.000Z" }],
    depends_on: [],
    produces: [],
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-defer-"));
    file = path.join(dir, "todos.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes nothing when the pass throws midway", () => {
    const data = { todos: [row()] };
    saveBoard(file, data);
    const before = readFileSync(file, "utf8");
    expect(() =>
      withDeferredSave(file, data, () => {
        setField({ data, file, todo: data.todos[0], field: "verify", value: "npm test" });
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("writes once, at the end, when the pass completes", () => {
    const data = { todos: [row()] };
    saveBoard(file, data);
    withDeferredSave(file, data, () => {
      setField({ data, file, todo: data.todos[0], field: "verify", value: "npm test" });
      setField({ data, file, todo: data.todos[0], field: "retry", value: "2" });
      // Still the state as of the last real write: nothing has reached the disk.
      expect(JSON.parse(readFileSync(file, "utf8")).todos[0].verify).toBeUndefined();
    });
    const saved = JSON.parse(readFileSync(file, "utf8")).todos[0];
    expect([saved.verify, saved.retry_limit]).toEqual(["npm test", 2]);
  });
});

// t#324: a plan that continues existing work names the task instead of hoping
// its phrase is reproduced verbatim. Guessing by phrase is what forked the live
// board once already.
describe("a step may name the task it IS", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () =>
    JSON.parse(readFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), "utf8"));
  const todos = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
  const say = (...args) => todos("apply", ...args);
  const yaml = (name, ...lines) => {
    const p = path.join(dir, name);
    writeFileSync(p, lines.join("\n"));
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-bind-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
  });
  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records onto the named task, whatever the file calls the step", () => {
    todos("add", "Чиню отвал вебхука");
    const n = board().todos[0].number;
    const out = say(
      yaml("one.yaml", "steps:", "  1:", `    task: ${n}`, "    title: Совсем другая фраза", "    verify: npm test", "    produces: [src/webhook.ts]"),
      "--go",
    );
    const rows = board().todos;
    expect(rows).toHaveLength(1);
    expect(out).toMatch(/keeps its own title/);
    expect(rows[0].subject).toBe("Чиню отвал вебхука");
    expect([rows[0].verify, rows[0].produces]).toEqual(["npm test", ["src/webhook.ts"]]);
  });

  it("takes #N and t#N as readily as the bare number, and needs no title", () => {
    todos("add", "Уже есть");
    const n = board().todos[0].number;
    say(yaml("hash.yaml", "steps:", "  1:", `    task: t#${n}`, "    retry: 2"), "--go");
    expect(board().todos).toHaveLength(1);
    expect(board().todos[0].retry_limit).toBe(2);
  });

  it("refuses a binding that points at nothing instead of forking the graph", () => {
    todos("add", "Уже есть");
    expect(() => say(yaml("ghost.yaml", "steps:", "  1:", "    task: 9999", "    title: A"), "--go")).toThrow(
      /is not a task on this board/,
    );
    expect(board().todos).toHaveLength(1);
  });

  // The skip itself is old and deliberate (a description is not overwritten);
  // saying nothing about it is what let a plan's reasoning vanish into a task
  // whose description framed the work weeks earlier.
  it("says out loud that the file's `why` was not recorded over an existing description", () => {
    todos("add", "Уже есть", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    const out = say(
      yaml("why.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага", "    retry: 2"),
      "--go",
    );
    expect(out).toMatch(/`why` for step "1" was NOT recorded/);
    expect(board().todos[0].description).toBe("Постановка трёхнедельной давности");
    expect(board().todos[0].retry_limit).toBe(2);
  });

  it("records the why when the task carries no description of its own", () => {
    todos("add", "Пустая");
    const n = board().todos[0].number;
    const out = say(yaml("why2.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Обоснование"), "--go");
    expect(out).not.toMatch(/was NOT recorded/);
    expect(board().todos[0].description).toBe("Обоснование");
  });

  it("refuses two steps bound to the same task, in any spelling", () => {
    todos("add", "Уже есть");
    const n = board().todos[0].number;
    expect(() =>
      say(yaml("twins.yaml", "steps:", "  1:", `    task: ${n}`, "  2:", `    task: #${n}`), "--go"),
    ).toThrow(/already bound to an earlier step/);
  });
});

describe("apply requires a change for new work", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () =>
    JSON.parse(readFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), "utf8"));
  const todos = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
  const write = (name, ...lines) => {
    const p = path.join(dir, name);
    writeFileSync(p, lines.join("\n"));
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-apply-change-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a plan that opens a new task and names no change", () => {
    expect(() => todos("apply", write("bare.yaml", "steps:", "  1:", "    title: Один шаг"), "--go")).toThrow(
      /no change: a step that opens a NEW task/,
    );
  });

  it("takes a one-step plan bound to an existing task — it opens nothing", () => {
    todos("add", "Уже на доске");
    const n = board().todos[0].number;
    const out = todos("apply", write("bound.yaml", "steps:", "  1:", `    task: ${n}`, "    verify: npm test"), "--go");
    expect(out).toMatch(/0 new step/);
    expect(board().todos[0].verify).toBe("npm test");
  });

  it("inherits the change from a task the step is bound to", () => {
    execFileSync(process.execPath, [cli, "change", "new", "CHANGE: уже заведён"], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
    todos("add", "Уже на доске");
    const n = board().todos[0].number;
    todos("set", "change", String(n), "c#1");
    const out = todos(
      "apply",
      write("mixed.yaml", "steps:", "  1:", `    task: ${n}`, "  2:", "    title: Новый шаг", "    needs: [1]"),
      "--go",
    );
    expect(out).toMatch(/1 new step/);
    const fresh = board().todos.find((t) => t.subject === "Новый шаг");
    expect(fresh.change_id).toBe(board().changes[0].id);
  });
});
