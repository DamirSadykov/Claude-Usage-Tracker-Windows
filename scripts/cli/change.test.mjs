import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseChangeRef,
  changesOf,
  nextChangeNumber,
  changeAddress,
  createChange,
  findChange,
  findChangeByTitle,
  legacyRootsOf,
  legacyChange,
  changeOfTask,
  membersOf,
  changeProgress,
  changeStatus,
  sortedChanges,
} from "./change.mjs";

const task = (number, fields = {}) => ({
  id: `id-${number}`,
  number,
  subject: `задача ${number}`,
  status: "backlog",
  project: "board",
  ...fields,
});

const boardWithRecord = () => {
  const data = { version: 1, todos: [], changes: [] };
  const change = createChange(data, {
    title: "CHANGE: перевод на записи",
    delta: "что меняем и почему сейчас",
    project: "board",
    spec: ["tasks#changes"],
    budget_usd: 60,
    parallel_limit: 2,
  });
  data.todos.push(
    task(1, { change_id: change.id, status: "done" }),
    task(2, { change_id: change.id }),
    task(3),
  );
  return { data, change };
};

const legacyBoard = () => {
  const data = {
    version: 1,
    todos: [
      task(10, { change: true, description: "дельта старого корня", spec: ["tasks#changes"], depends_on: ["id-11", "id-12"] }),
      task(11, { status: "done" }),
      task(12, { depends_on: ["id-13"] }),
      task(13, { status: "done" }),
      task(14),
    ],
  };
  return data;
};

describe("parseChangeRef", () => {
  it("takes c#N, cN and a bare number", () => {
    expect(parseChangeRef("c#12")).toEqual({ number: 12 });
    expect(parseChangeRef("C#12")).toEqual({ number: 12 });
    expect(parseChangeRef("c12")).toEqual({ number: 12 });
    expect(parseChangeRef("12")).toEqual({ number: 12 });
  });

  it("treats anything else as an id", () => {
    expect(parseChangeRef("2f0a-uuid")).toEqual({ id: "2f0a-uuid" });
    expect(parseChangeRef("  ")).toBe(null);
  });

  it("does not read a task reference as a change", () => {
    expect(parseChangeRef("t#12")).toEqual({ id: "t#12" });
  });
});

describe("createChange", () => {
  it("numbers from its own counter, not the task numbers", () => {
    const data = { version: 1, todos: [task(340), task(341)], changes: [] };
    const first = createChange(data, { title: "первый" });
    const second = createChange(data, { title: "второй" });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(nextChangeNumber(data)).toBe(3);
  });

  it("keeps the ceilings only when declared", () => {
    const data = { version: 1, todos: [] };
    const bare = createChange(data, { title: "без потолков" });
    const capped = createChange(data, { title: "с потолками", budget_usd: 12, parallel_limit: 3 });
    expect(bare.budget_usd).toBeUndefined();
    expect(bare.parallel_limit).toBeUndefined();
    expect(capped.budget_usd).toBe(12);
    expect(capped.parallel_limit).toBe(3);
  });

  it("refuses an empty title", () => {
    expect(() => createChange({ todos: [] }, { title: "  " })).toThrow();
  });

  it("creates the section when the board has none", () => {
    const data = { version: 1, todos: [] };
    createChange(data, { title: "первый" });
    expect(changesOf(data)).toHaveLength(1);
  });
});

describe("sortedChanges", () => {
  it("ставит свежие вверх по времени, а без него по номеру", () => {
    const data = { version: 1, todos: [], changes: [] };
    const first = createChange(data, { title: "первый" });
    const second = createChange(data, { title: "второй" });
    const third = createChange(data, { title: "третий" });
    first.created_at = "2026-06-01T10:00:00Z";
    second.created_at = "2026-08-01T10:00:00Z";
    third.created_at = "2026-07-01T10:00:00Z";
    expect(sortedChanges(data).map((c) => c.title)).toEqual(["второй", "третий", "первый"]);
    for (const c of data.changes) delete c.created_at;
    expect(sortedChanges(data).map((c) => c.number)).toEqual([3, 2, 1]);
  });

  it("не трогает исходный порядок записи", () => {
    const data = { version: 1, todos: [], changes: [] };
    createChange(data, { title: "первый" });
    createChange(data, { title: "второй" });
    sortedChanges(data);
    expect(data.changes.map((c) => c.number)).toEqual([1, 2]);
  });
});

describe("findChange", () => {
  it("resolves by number, by address and by id", () => {
    const { data, change } = boardWithRecord();
    expect(findChange(data, "c#1")?.id).toBe(change.id);
    expect(findChange(data, "1")?.id).toBe(change.id);
    expect(findChange(data, change.id)?.id).toBe(change.id);
    expect(findChange(data, "c#9")).toBe(null);
  });

  it("finds by title within one board", () => {
    const { data, change } = boardWithRecord();
    expect(findChangeByTitle(data, "change: перевод на записи", "board")?.id).toBe(change.id);
    expect(findChangeByTitle(data, "CHANGE: перевод на записи", "other")).toBe(null);
  });
});

describe("changeAddress", () => {
  it("addresses a record as c#N and an unmigrated root as t#N", () => {
    const { change } = boardWithRecord();
    expect(changeAddress(change)).toBe("c#1");
    const data = legacyBoard();
    expect(changeAddress(legacyChange(data.todos[0]))).toBe("t#10");
  });
});

describe("membership", () => {
  it("reads the field, not the edges", () => {
    const { data, change } = boardWithRecord();
    expect(membersOf(data, change).map((t) => t.number)).toEqual([1, 2]);
    expect(changeOfTask(data, data.todos[1])?.id).toBe(change.id);
  });

  it("leaves a task with no change out", () => {
    const { data } = boardWithRecord();
    expect(changeOfTask(data, data.todos[2])).toBe(null);
  });

  it("still resolves an unmigrated board through its edges", () => {
    const data = legacyBoard();
    const deep = data.todos[3];
    const change = changeOfTask(data, deep);
    expect(change?.legacy).toBe(true);
    expect(change?.number).toBe(10);
    expect(change?.delta).toBe("дельта старого корня");
    expect(membersOf(data, change).map((t) => t.number).sort()).toEqual([11, 12, 13]);
  });

  it("keeps a task outside every legacy root out", () => {
    const data = legacyBoard();
    expect(changeOfTask(data, data.todos[4])).toBe(null);
  });

  it("prefers the field over the edges when a board holds both", () => {
    const data = legacyBoard();
    data.changes = [];
    const record = createChange(data, { title: "новая запись", project: "board" });
    data.todos[3].change_id = record.id;
    expect(changeOfTask(data, data.todos[3])?.id).toBe(record.id);
  });
});

describe("derived status", () => {
  it("stays open while a task is open", () => {
    const { data, change } = boardWithRecord();
    expect(changeProgress(data, change)).toEqual({ total: 2, done: 1 });
    expect(changeStatus(data, change)).toBe("open");
  });

  it("closes when every task is done", () => {
    const { data, change } = boardWithRecord();
    for (const t of data.todos) if (t.change_id === change.id) t.status = "done";
    expect(changeStatus(data, change)).toBe("closed");
  });

  it("counts review as open — a gate is not a closed task", () => {
    const { data, change } = boardWithRecord();
    data.todos[1].status = "review";
    expect(changeStatus(data, change)).toBe("open");
  });

  it("holds a change with no tasks open", () => {
    const data = { version: 1, todos: [] };
    const change = createChange(data, { title: "только что заведён" });
    expect(changeStatus(data, change)).toBe("open");
  });

  it("derives the same way for an unmigrated root", () => {
    const data = legacyBoard();
    const change = changeOfTask(data, data.todos[1]);
    expect(changeProgress(data, change)).toEqual({ total: 3, done: 2 });
    expect(changeStatus(data, change)).toBe("open");
  });
});

describe("legacyRootsOf", () => {
  it("stops at the nearest root above a task", () => {
    const data = legacyBoard();
    expect(legacyRootsOf(data, data.todos[3]).map((r) => r.number)).toEqual([10]);
  });

  it("returns the root itself for a root", () => {
    const data = legacyBoard();
    expect(legacyRootsOf(data, data.todos[0]).map((r) => r.number)).toEqual([10]);
  });
});

describe("cli change", () => {
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
  let dir;
  let appDir;
  let board;

  const run = (args, opts = {}) =>
    execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, APPDATA: dir },
      encoding: "utf8",
      cwd: opts.cwd ?? process.cwd(),
      stdio: "pipe",
    });

  const refuse = (args) => {
    try {
      run(args);
      return "";
    } catch (e) {
      return String(e.stderr || "");
    }
  };

  const read = () => JSON.parse(readFileSync(board, "utf8"));

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-change-"));
    appDir = path.join(dir, "com.claude-usage-tracker.app");
    mkdirSync(appDir, { recursive: true });
    board = path.join(appDir, "todos.json");
    writeFileSync(
      board,
      JSON.stringify({
        version: 1,
        todos: [
          { id: "t-1", number: 1, subject: "первая", status: "backlog", project: "board" },
          { id: "t-2", number: 2, subject: "вторая", status: "done", project: "board" },
        ],
      }),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("заводит запись со своим номером и потолками группы", () => {
    const out = run(["change", "new", "Перевод на записи", "--project", "board", "--budget", "12", "--parallel", "2"]);
    expect(out).toContain("ok: c#1");
    const rec = read().changes[0];
    expect(rec.number).toBe(1);
    expect(rec.budget_usd).toBe(12);
    expect(rec.parallel_limit).toBe(2);
  });

  it("отказывает второй записи с тем же заголовком на одной доске", () => {
    run(["change", "new", "Перевод на записи", "--project", "board"]);
    expect(refuse(["change", "new", "Перевод на записи", "--project", "board"])).toContain("already carries that title");
  });

  it("привязывает задачу к записи и снимает привязку", () => {
    run(["change", "new", "Перевод на записи", "--project", "board"]);
    expect(run(["todos", "set", "change", "1", "c#1"])).toContain("change -> c#1");
    expect(read().todos[0].change_id).toBe(read().changes[0].id);
    expect(run(["todos", "set", "change", "1", "none"])).toContain("change -> none");
    expect(read().todos[0].change_id).toBeUndefined();
  });

  it("отказывает привязке к несуществующему change'у, называя новую форму", () => {
    const err = refuse(["todos", "set", "change", "1", "c#9"]);
    expect(err).toContain("valid: <c#N> | none");
    expect(err).toContain("cli change list");
  });

  it("отказывает старой булевой форме, называя новую", () => {
    const err = refuse(["todos", "set", "change", "1", "on"]);
    expect(err).toContain("is the OLD root-task form");
    expect(err).toContain("cli change new");
  });

  it("показывает состав и производный статус", () => {
    run(["change", "new", "Перевод на записи", "--project", "board"]);
    run(["todos", "set", "change", "1", "c#1"]);
    run(["todos", "set", "change", "2", "c#1"]);
    const out = run(["change", "show", "c#1"]);
    expect(out).toContain("c#1 [open]");
    expect(out).toContain("1/2 готово");
    expect(out).toContain("#1 [backlog] первая");
  });

  it("отказывается закрывать change с открытой задачей и закрывает готовый", () => {
    run(["change", "new", "Перевод на записи", "--project", "board"]);
    run(["todos", "set", "change", "1", "c#1"]);
    run(["todos", "set", "change", "2", "c#1"]);
    expect(refuse(["change", "close", "c#1"])).toContain("still has 1 open task");
    run(["todos", "set", "status", "1", "done"]);
    expect(run(["change", "close", "c#1"])).toContain("closed — 2 task(s) done");
    expect(read().changes[0].closed_at).toBeTruthy();
  });

  it("отказывается закрывать change без задач", () => {
    run(["change", "new", "Пустой", "--project", "board"]);
    expect(refuse(["change", "close", "c#1"])).toContain("has no tasks");
  });

  it("перечисляет немигрированные корни под адресом t#N", () => {
    const data = read();
    data.todos.push({
      id: "t-3",
      number: 3,
      subject: "старый корень",
      status: "queue",
      project: "board",
      change: true,
      depends_on: ["t-1"],
    });
    writeFileSync(board, JSON.stringify(data));
    const out = run(["change", "list", "--all"]);
    expect(out).toContain("t#3");
    expect(out).toContain("не мигрирован");
    expect(refuse(["change", "close", "t#3"])).toContain("still a root task");
  });
});

describe("потребители читают запись, а не корень", () => {
  const withRecord = () => {
    const data = { version: 1, todos: [], changes: [] };
    const change = createChange(data, {
      title: "CHANGE: потребители",
      delta: "что меняем в этом заходе",
      project: "board",
      parallel_limit: 3,
    });
    data.todos.push(
      task(1, { change_id: change.id, status: "done" }),
      task(2, { change_id: change.id }),
    );
    return { data, change };
  };

  it("vision наследуется от записи и адресуется c#N", async () => {
    const { changeRootsFor, formatChangeVision } = await import("./todos.mjs");
    const { data, change } = withRecord();
    const roots = changeRootsFor(data, data.todos[1]);
    expect(roots.map((r) => r.address)).toEqual(["c#1"]);
    expect(roots[0].subject).toBe(change.title);
    const out = formatChangeVision(data.todos[1], roots);
    expect(out).toContain("── change c#1");
    expect(out).toContain("что меняем в этом заходе");
  });

  it("раннер собирает группу по ссылке c#N и берёт потолок с записи", async () => {
    const { collectChange } = await import("./run.mjs");
    const { data } = withRecord();
    const { root, members } = collectChange(data, "c#1");
    expect(root.parallel_limit).toBe(3);
    expect(members.map((t) => t.number)).toEqual([1, 2]);
  });

  it("линт видит запись без потолка, пока в ней есть открытая задача", async () => {
    const { boardGraph } = await import("./lint.mjs");
    const { checkGraph } = await import("./graph-rules.mjs");
    const { data } = withRecord();
    const findings = checkGraph(boardGraph(data, data.todos));
    expect(findings.map((f) => f.message).join(" ")).toContain("no budget declared");
    for (const t of data.todos) t.status = "done";
    const closed = checkGraph(boardGraph(data, data.todos));
    expect(closed.map((f) => f.message).join(" ")).not.toContain("no budget declared");
  });
});
