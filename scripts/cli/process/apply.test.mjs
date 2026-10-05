import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYamlSubset, readDocument, validate, applyDocument } from "./apply.mjs";
import { loadBoard, withDeferredSave, saveBoard, setField } from "../board/todos.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

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
        "      - scripts/cli/process/apply.mjs",
        "      - docs/spec.md",
      ].join("\n"),
    );
    // A value may itself contain a colon — only the FIRST one splits the pair.
    expect(doc.change).toBe("CHANGE: язык процесса");
    expect(doc.vision).toBe("Первая строка.\nВторая строка.");
    expect(doc.parallel).toBe("2");
    expect(doc.steps["1"].needs).toEqual(["2", "3"]);
    expect(doc.steps["1"].produces).toEqual(["scripts/cli/process/apply.mjs", "docs/spec.md"]);
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

  it("keeps change out and measure instead of silently dropping them", () => {
    const doc = readDocument([
      "out:", "  - what: Окно", "    why: нет запроса",
      "measure:", "  - what: Доля", "    how: считаем через месяц",
      "unknown-top: preserved nowhere",
      "steps:", "  1: Работа",
    ].join("\n"));
    expect(doc.out).toEqual([{ what: "Окно", why: "нет запроса" }]);
    expect(doc.measure).toEqual([{ what: "Доля", how: "считаем через месяц" }]);
    expect(validate(doc).warnings).toContain('document: unknown key "unknown-top" — ignored');
  });

  it("requires the durable reason and measurement method", () => {
    const { errors } = validate(readDocument([
      "out:", "  - what: Окно",
      "measure:", "  - what: Доля",
      "steps:", "  1: Работа",
    ].join("\n")));
    expect(errors).toEqual(expect.arrayContaining(["out[1]: why is required", "measure[1]: how is required"]));
  });
});

describe("change brief fields in apply", () => {
  it("uses c#70's plan input and merges planned items by what", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cut-change-brief-")), "todos.json");
    try {
      const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "plans", "c70-change-brief-adr.yaml");
      const initial = { version: 1, todos: [], changes: [] };
      const doc = readDocument(readFileSync(fixture, "utf8"));
      expect(validate(doc).errors).toEqual([]);
      expect(applyDocument(doc, { go: true, project: "fixture", board: { data: initial, file } }).ok).toBe(true);
      const change = initial.changes[0];
      expect(change.out).toHaveLength(5);
      expect(change.measure).toHaveLength(2);
      change.out.push({ what: "Командный пункт", why: "добавлен по ходу работы" });
      change.measure.push({ what: "Ручной замер", how: "командой" });
      const repeated = {
        ...doc,
        out: [{ what: change.out[0].what, why: "обновлённый повод" }],
        measure: [{ what: change.measure[0].what, how: "обновлённый способ" }],
      };
      expect(applyDocument(repeated, { go: true, project: "fixture", board: { data: initial, file } }).ok).toBe(true);
      expect(change.out.find((item) => item.what === "Командный пункт")).toBeTruthy();
      expect(change.measure.find((item) => item.what === "Ручной замер")).toBeTruthy();
      expect(change.out[0].why).toBe("обновлённый повод");
      expect(change.measure[0].how).toBe("обновлённый способ");
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
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

  it("warns before work when four outputs include a large existing file", () => {
    const { errors, warnings } = validate(
      readDocument(
        [
          "steps:",
          "  1:",
          "    title: Большой шаг",
          "    produces: [src/large.mjs, src/a.mjs, src/b.mjs, src/c.mjs]",
        ].join("\n"),
      ),
      { lineCount: (file) => (file === "src/large.mjs" ? 1501 : null) },
    );
    expect(errors).toEqual([]);
    expect(warnings).toContain('step "1": шаг крупный — разрезать по produces');
  });

  it("warns that parallel/budget land nowhere without a change root", () => {
    const { warnings } = check(["parallel: 2", "steps:", "  1: A"].join("\n"));
    expect(warnings.join(" ")).toMatch(/change/);
  });

  it("refuses red declared without red-tests", () => {
    const { errors } = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    red: npm run test:red"].join("\n"),
    );
    expect(errors.join(" ")).toMatch(/red declared without red-tests/);
  });

  it("refuses red-tests declared without red", () => {
    const { errors } = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    red-tests: [test/a.spec.js]"].join("\n"),
    );
    expect(errors.join(" ")).toMatch(/red-tests declared without red/);
  });

  it("requires flow for an auto step that produces configured code, but accepts an explained n/a", () => {
    const missing = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    produces: [src/Notifier.cs]"].join("\n"),
    );
    expect(missing.errors.join(" ")).toMatch(/produces configured flow-language code but has no flow/);
    const blankNa = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    produces: [src/Notifier.cs]", "    flow: n/a"].join("\n"),
    );
    expect(blankNa.errors.join(" ")).toMatch(/flow: n\/a needs a reason/);
    const explained = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    produces: [src/Notifier.cs]", "    flow: n/a generated file only"].join("\n"),
    );
    expect(explained.errors).toEqual([]);
    const scalar = check(
      ["steps:", "  1:", "    title: A", "    kind: auto", "    produces: [src/Notifier.cs]", "    flow: placeholder"].join("\n"),
    );
    expect(scalar.errors.join(" ")).toMatch(/flow must be a method delta, a list of them, or flow: n\/a <reason>/);
  });

  it("requires flow for Rust and TS/JS only when those languages are configured", () => {
    const doc = readDocument(["steps:", "  1:", "    title: A", "    kind: auto", "    produces: [src/notify.rs, src/view.tsx, scripts/check.cjs]"].join("\n"));
    expect(validate(doc, { languages: ["rs", "ts", "js"] }).errors.join(" ")).toMatch(/configured flow-language code but has no flow/);
    expect(validate(doc, { languages: ["cs"] }).errors).toEqual([]);
  });

  it("only WARNS when a red-tests path is not also in produces", () => {
    const { errors, warnings } = check(
      [
        "steps:",
        "  1:",
        "    title: A",
        "    kind: auto",
        "    red: npm run test:red",
        "    red-tests: [test/a.spec.js]",
        "    produces: [src/a.js]",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toMatch(/red-tests path "test\/a\.spec\.js" is not declared in produces/);
  });

  it("takes the same red declaration once red-tests is in produces too", () => {
    const { errors, warnings } = check(
      [
        "steps:",
        "  1:",
        "    title: A",
        "    kind: auto",
        "    red: npm run test:red",
        "    red-tests: [test/a.spec.js]",
        "    produces: [src/a.js, test/a.spec.js]",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).not.toMatch(/not declared in produces/);
  });

  it("only WARNS when red is declared on a manual node — a gate never runs it", () => {
    const { errors, warnings } = check(
      [
        "steps:",
        "  1:",
        "    title: A",
        "    kind: manual",
        "    red: npm run test:red",
        "    red-tests: [test/a.spec.js]",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toMatch(/red declared on a manual node — a gate never runs it/);
  });

  it("refuses a risk other than high", () => {
    const { errors } = check(["steps:", "  1:", "    title: A", "    risk: medium"].join("\n"));
    expect(errors.join(" ")).toMatch(/invalid risk "medium" — the only accepted value is "high"/);
  });

  it("takes risk: high without complaint", () => {
    const { errors, warnings } = check(["steps:", "  1:", "    title: A", "    risk: high"].join("\n"));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("apply records the graph", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () => loadBoard(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
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
    "    produces: [scripts/cli/process/apply.mjs, tests/apply.red.spec.js]",
    "    verify: npm test",
    "    retry: 3",
    "    kind: auto",
    "    red: npm run test:red",
    "    red-tests: [tests/apply.red.spec.js]",
    "    risk: high",
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
    expect(board().todos).toEqual([]);
  });

  it("--go refuses code 4 on an unreadable board and writes nothing", () => {
    const boardFile = path.join(dir, "com.claude-usage-tracker.app", "todos.json");
    writeFileSync(boardFile, "{ not json");
    const before = readFileSync(boardFile);
    let status = 0;
    let stderr = "";
    try {
      say(path.join(dir, "graph.yaml"), "--go");
    } catch (e) {
      status = e.status;
      stderr = String(e.stderr || "");
    }
    expect(status).toBe(4);
    expect(stderr).toContain("board unreadable (");
    expect(readFileSync(boardFile).equals(before)).toBe(true);
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

    expect(one.produces).toEqual(["scripts/cli/process/apply.mjs", "tests/apply.red.spec.js"]);
    expect(one.verify).toBe("npm test");
    expect(one.retry_limit).toBe(3);
    expect(one.kind).toBe("auto");
    expect(one.red).toBe("npm run test:red");
    expect(one.red_tests).toEqual(["tests/apply.red.spec.js"]);
    expect(one.risk).toBe("high");

    expect(two.depends_on).toContain(one.id);
    expect(three.depends_on).toContain(two.id);
    expect(two.on_issue).toBe(one.id);
  });

  it("keeps a flow object on the task when it applies the plan", () => {
    writeFileSync(
      path.join(dir, "flow.yaml"),
      [
        "change: CHANGE: flow",
        "steps:",
        "  1:",
        "    title: Меняю метод",
        "    kind: auto",
        "    produces: [src/Notifier.cs]",
        "    flow:",
        "      file: src/Notifier.cs",
        "      method: SendSms",
        "      change: [insert: ValidatePhone]",
        "      preserve: all",
      ].join("\n"),
    );
    say(path.join(dir, "flow.yaml"), "--go");
    expect(board().todos[0].flow).toEqual({
      file: "src/Notifier.cs",
      method: "SendSms",
      change: ["insert: ValidatePhone"],
      preserve: "all",
    });
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
    expect(board().todos).toEqual([]);
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
    expect([saved.ext.process.verify, saved.ext.process.retry_limit]).toEqual(["npm test", 2]);
  });
});

// t#324: a plan that continues existing work names the task instead of hoping
// its phrase is reproduced verbatim. Guessing by phrase is what forked the live
// board once already.
describe("a step may name the task it IS", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () => loadBoard(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
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

  it("returns only a retry-exhausted review node to queue when its limit is raised", () => {
    todos("add", "Исчерпан");
    const n = board().todos[0].number;
    const data = board();
    Object.assign(data.todos[0], {
      status: "review",
      retry_limit: 2,
      comments: [{ author: "review", body: "ISSUE attempt 2/2\nverify\nfailed" }],
    });
    writeFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), JSON.stringify(data));
    const out = say(yaml("raise.yaml", "steps:", "  1:", `    task: ${n}`, "    retry: 3"), "--go");
    expect(out).toMatch(/returned to queue/);
    expect(board().todos[0].status).toBe("queue");
    expect(board().todos[0].retry_limit).toBe(3);
  });

  it("does not reopen a review node whose issue was not written by the runner review", () => {
    todos("add", "Ручное ревью");
    const n = board().todos[0].number;
    const data = board();
    Object.assign(data.todos[0], {
      status: "review",
      retry_limit: 2,
      comments: [{ author: "manual", body: "ISSUE attempt 2/2\nverify\nfailed" }],
    });
    writeFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), JSON.stringify(data));
    const out = say(yaml("manual.yaml", "steps:", "  1:", `    task: ${n}`, "    retry: 3"), "--go");
    expect(out).not.toMatch(/returned to queue/);
    expect(board().todos[0].status).toBe("review");
  });

  it("refuses a binding that points at nothing instead of forking the graph", () => {
    todos("add", "Уже есть");
    expect(() => say(yaml("ghost.yaml", "steps:", "  1:", "    task: 9999", "    title: A"), "--go")).toThrow(
      /is not a task on this board/,
    );
    expect(board().todos).toHaveLength(1);
  });

  // A still-open (backlog/queue) task no longer keeps a stale description —
  // apply replaces it with the file's `why`, and the old text moves to a
  // comment instead of being kept silently (t#739).
  it("replaces a backlog task's description with the file's `why`, keeping the old one as a comment", () => {
    todos("add", "Уже есть", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    const out = say(
      yaml("why.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага", "    retry: 2"),
      "--go",
    );
    expect(out).toMatch(/description replaced for step "1"/);
    const row = board().todos[0];
    expect(row.description).toBe("Новое обоснование шага");
    expect(row.retry_limit).toBe(2);
    expect(row.comments).toHaveLength(1);
    expect(row.comments[0].author).toBe("claude");
    expect(row.comments[0].body).toContain("Постановка трёхнедельной давности");
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

describe("apply and a stale description (t#739)", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () => loadBoard(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
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
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-stale-desc-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
  });
  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the description on an in_progress task and only notes it, unchanged from before", () => {
    todos("add", "В работе", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    todos("set", "status", String(n), "in_progress");
    const out = say(
      yaml("wip.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага"),
      "--go",
    );
    expect(out).toMatch(/`why` for step "1" was NOT recorded/);
    const row = board().todos[0];
    expect(row.description).toBe("Постановка трёхнедельной давности");
    expect(row.comments || []).toHaveLength(0);
  });

  it("does nothing when the file's why already matches the description", () => {
    todos("add", "Совпадает", "--description", "Одно и то же обоснование");
    const n = board().todos[0].number;
    const out = say(
      yaml("same.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Одно и то же обоснование"),
      "--go",
    );
    expect(out).not.toMatch(/replace description/);
    expect(out).not.toMatch(/NOT recorded/);
    const row = board().todos[0];
    expect(row.description).toBe("Одно и то же обоснование");
    expect(row.comments || []).toHaveLength(0);
  });

  it("re-applying the same plan twice replaces the description once and adds one comment only", () => {
    todos("add", "Повтор", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    const file = yaml("rep.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага");
    const first = say(file, "--go");
    const second = say(file, "--go");
    expect(first).toMatch(/description replaced for step "1"/);
    expect(second).not.toMatch(/description replaced for step "1"/);
    const row = board().todos[0];
    expect(row.description).toBe("Новое обоснование шага");
    expect(row.comments).toHaveLength(1);
  });

  it("shows the planned replacement in a dry run without writing anything", () => {
    todos("add", "Черновик", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    const out = say(
      yaml("dry.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага"),
    );
    expect(out).toMatch(/replace description \(old kept as comment\)/);
    const row = board().todos[0];
    expect(row.description).toBe("Постановка трёхнедельной давности");
    expect(row.comments || []).toHaveLength(0);
  });

  it("--force overwrites the description without recording a comment", () => {
    todos("add", "Форс", "--description", "Постановка трёхнедельной давности");
    const n = board().todos[0].number;
    const out = say(
      yaml("force.yaml", "steps:", "  1:", `    task: ${n}`, "    why: |", "      Новое обоснование шага"),
      "--go",
      "--force",
    );
    expect(out).not.toMatch(/replace description/);
    const row = board().todos[0];
    expect(row.description).toBe("Новое обоснование шага");
    expect(row.comments || []).toHaveLength(0);
  });
});

describe("apply requires a change for new work", () => {
  let dir;
  const savedAppData = process.env.APPDATA;
  const board = () => loadBoard(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
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
