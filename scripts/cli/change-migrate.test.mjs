import { describe, it, expect } from "vitest";
import { legacyRoots, membersOfRoot, planMigration, migrate, describe as describeMigration } from "./change-migrate.mjs";
import { changesOf, changeOfTask, membersOf, changeStatus } from "./change.mjs";

const task = (number, fields = {}) => ({
  id: `id-${number}`,
  number,
  subject: `задача ${number}`,
  status: "backlog",
  project: "board",
  created_at: `2026-0${Math.min(9, Math.max(1, Math.floor(number / 100)))}-01T00:00:00Z`,
  ...fields,
});

const board = () => ({
  version: 1,
  todos: [
    task(100, {
      change: true,
      subject: "ТЕМА: первая",
      description: "дельта первой",
      spec: ["tasks#changes"],
      budget_usd: 10,
      parallel_limit: 2,
      depends_on: ["id-101", "id-102"],
      status: "done",
    }),
    task(101, { status: "done" }),
    task(102, { depends_on: ["id-103"] }),
    task(103, { status: "done" }),
    task(200, {
      change: true,
      subject: "ТЕМА: вторая",
      description: "дельта второй",
      depends_on: ["id-201"],
    }),
    task(201),
    task(300, { project: "other" }),
  ],
});

describe("legacyRoots", () => {
  it("собирает корни в порядке номеров, чтобы c#N читались хронологией", () => {
    expect(legacyRoots(board()).map((r) => r.number)).toEqual([100, 200]);
  });

  it("берёт и legacy-поле theme", () => {
    const data = { todos: [task(1, { theme: true, depends_on: ["id-2"] }), task(2)] };
    expect(legacyRoots(data).map((r) => r.number)).toEqual([1]);
  });
});

describe("membersOfRoot", () => {
  it("идёт вглубь по рёбрам и не заходит за чужой корень", () => {
    const data = board();
    const [first] = legacyRoots(data);
    expect(membersOfRoot(data, first).map((t) => t.number).sort()).toEqual([101, 102, 103]);
  });

  it("не отдаёт вложенный корень членом", () => {
    const data = board();
    data.todos[4].depends_on = ["id-201", "id-100"];
    const nested = legacyRoots(data).find((r) => r.number === 200);
    expect(membersOfRoot(data, nested).map((t) => t.number)).toEqual([201]);
  });
});

describe("migrate", () => {
  it("заводит запись на каждый корень и снимает корень с доски", () => {
    const data = board();
    const result = migrate(data);
    expect(result.roots).toBe(2);
    expect(changesOf(data).map((c) => c.number)).toEqual([1, 2]);
    expect(data.todos.map((t) => t.number).sort((a, b) => a - b)).toEqual([101, 102, 103, 201, 300]);
  });

  it("переносит дельту, разделы спеки и потолки группы", () => {
    const data = board();
    migrate(data);
    const [first] = changesOf(data);
    expect(first.title).toBe("ТЕМА: первая");
    expect(first.delta).toBe("дельта первой");
    expect(first.spec).toEqual(["tasks#changes"]);
    expect(first.budget_usd).toBe(10);
    expect(first.parallel_limit).toBe(2);
    expect(first.migrated_from).toBe(100);
  });

  it("сохраняет время корня — иначе сортировка свежих наверх соврёт", () => {
    const data = board();
    data.todos[0].created_at = "2026-03-01T00:00:00Z";
    migrate(data);
    expect(changesOf(data)[0].created_at).toBe("2026-03-01T00:00:00Z");
  });

  it("проставляет принадлежность всем членам, включая глубоких", () => {
    const data = board();
    migrate(data);
    const first = changesOf(data)[0];
    expect(membersOf(data, first).map((t) => t.number).sort()).toEqual([101, 102, 103]);
    const deep = data.todos.find((t) => t.number === 103);
    expect(changeOfTask(data, deep)?.number).toBe(1);
  });

  it("оставляет задачу вне change'ей вне их и после миграции", () => {
    const data = board();
    migrate(data);
    const loose = data.todos.find((t) => t.number === 300);
    expect(loose.change_id).toBeUndefined();
    expect(changeOfTask(data, loose)).toBe(null);
  });

  it("держит производный статус верным сразу после миграции", () => {
    const data = board();
    migrate(data);
    const [first, second] = changesOf(data);
    expect(changeStatus(data, first)).toBe("open");
    expect(changeStatus(data, second)).toBe("open");
    for (const t of data.todos) t.status = "done";
    expect(changeStatus(data, first)).toBe("closed");
  });

  it("снимает висячие рёбра и ссылки на удалённый корень", () => {
    const data = board();
    data.todos[6].depends_on = ["id-100"];
    data.todos[6].links = ["id-200", "id-101"];
    migrate(data);
    const loose = data.todos.find((t) => t.number === 300);
    expect(loose.depends_on).toEqual([]);
    expect(loose.links).toEqual(["id-101"]);
  });

  it("разводит вложенные корни в две записи и говорит про снятое ребро", () => {
    const data = board();
    data.todos[4].depends_on = ["id-201", "id-100"];
    const result = migrate(data);
    expect(changesOf(data)).toHaveLength(2);
    expect(result.notes.join(" ")).toContain("no longer nests");
    const members = membersOf(data, changesOf(data)[1]);
    expect(members.map((t) => t.number)).toEqual([201]);
  });

  it("не отдаёт задачу двум change'ам, когда составы пересекаются", () => {
    const data = board();
    data.todos[4].depends_on = ["id-201", "id-102"];
    migrate(data);
    const [first, second] = changesOf(data);
    const shared = data.todos.find((t) => t.number === 102);
    expect(shared.change_id).toBe(first.id);
    expect(membersOf(data, second).map((t) => t.number)).toEqual([201]);
  });

  it("идемпотентна: второй прогон ничего не удваивает", () => {
    const data = board();
    migrate(data);
    const before = JSON.stringify(data);
    const again = migrate(data);
    expect(again.roots).toBe(0);
    expect(changesOf(data)).toHaveLength(2);
    expect(JSON.stringify(data)).toBe(before);
  });

  it("сухой прогон только описывает и адресует записи по порядку", () => {
    const data = board();
    const lines = describeMigration(data);
    expect(lines[0]).toContain("+ c#1 ← #100");
    expect(lines[1]).toContain("+ c#2 ← #200");
    expect(changesOf(data)).toHaveLength(0);
    expect(data.todos).toHaveLength(7);
  });
});

describe("planMigration", () => {
  it("отдаёт корень, его состав и вложенные корни отдельно", () => {
    const data = board();
    data.todos[4].depends_on = ["id-201", "id-100"];
    const plan = planMigration(data);
    expect(plan).toHaveLength(2);
    expect(plan[1].nestedRoots.map((r) => r.number)).toEqual([100]);
  });
});
