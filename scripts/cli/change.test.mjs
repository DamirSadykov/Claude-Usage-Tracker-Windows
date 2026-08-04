import { describe, it, expect } from "vitest";
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
