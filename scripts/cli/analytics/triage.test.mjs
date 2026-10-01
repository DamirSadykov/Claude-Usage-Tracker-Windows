import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./triage.mjs";
import { CURRENT } from "../kernel/board-io.mjs";

const TODAY = "2026-10-01";
const ts = (ymd) => `${ymd}T12:00:00.000Z`;

let tmp;
let prevAppData;
let out;
let err;

const task = (number, over) => ({
  id: `id-${number}`,
  number,
  subject: `task ${number}`,
  status: "queue",
  priority: "medium",
  project: "proj",
  scheduled_for: null,
  created_at: ts("2026-09-01"),
  updated_at: ts("2026-09-30"),
  ...over,
});

const appDir = () => path.join(tmp, "com.claude-usage-tracker.app");
const exportDir = () => path.join(tmp, "export");

function writeBoard(todos, changes = []) {
  mkdirSync(appDir(), { recursive: true });
  writeFileSync(path.join(appDir(), "todos.json"), JSON.stringify({ version: CURRENT, todos, changes }));
}

function writeGroups(groups) {
  mkdirSync(appDir(), { recursive: true });
  writeFileSync(path.join(appDir(), "project-groups.json"), JSON.stringify({ version: 1, groups }));
}

function digestFile() {
  return path.join(appDir(), "triage-digest.json");
}

function call(args) {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += s), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += s), true));
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    run(args);
  } finally {
    vi.restoreAllMocks();
  }
}

const readJson = (name) => JSON.parse(readFileSync(path.join(exportDir(), name), "utf8"));

function exportBoard() {
  call(["export", "--today", TODAY, "--out-dir", exportDir()]);
  const { units } = readJson("units.json");
  return { units, parts: units.map((u) => readJson(u.file)) };
}

function flat() {
  const { parts } = exportBoard();
  return { facts: parts.flatMap((p) => p.facts), tasks: parts.flatMap((p) => p.tasks) };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "triage-test-"));
  prevAppData = process.env.APPDATA;
  process.env.APPDATA = tmp;
});

afterEach(() => {
  process.env.APPDATA = prevAppData;
  rmSync(tmp, { recursive: true, force: true });
});

describe("triage export: facts and trimming", () => {
  it("computes overdue, stale and no_priority from --today", () => {
    writeBoard([
      task(1, { scheduled_for: "2026-09-28", status: "in_progress" }),
      task(2, { updated_at: ts("2026-09-10") }),
      task(3, { priority: undefined, status: "review" }),
      task(4, { scheduled_for: "2026-10-01" }),
      task(5, { updated_at: ts("2026-09-17") }),
      task(6, { scheduled_for: "2026-09-20", status: "backlog" }),
    ]);
    const { facts } = flat();
    const key = (f) => `${f.kind}:${f.number}`;
    expect(facts.map(key)).toEqual(["overdue:1", "overdue:6", "stale:2", "no_priority:3"]);
    expect(Object.keys(facts[0]).sort()).toEqual(["kind", "note", "number"]);
    expect(facts[0].note).toContain("3");
    expect(facts[2].note).toContain("20");
    expect(facts[3].note).toContain("review");
  });

  it("does not apply stale or no_priority to backlog, and nothing to done", () => {
    writeBoard([
      task(1, { status: "backlog", priority: undefined, updated_at: ts("2026-08-01") }),
      task(2, { status: "done", priority: undefined, scheduled_for: "2026-09-01", updated_at: ts("2026-09-29") }),
    ]);
    expect(flat().facts).toEqual([]);
  });

  it("trims fields, resolves the change title and cuts the excerpt at 160", () => {
    writeBoard(
      [task(1, { change_id: "c1", description: "x".repeat(500), secret: "dropped", plan: "dropped" })],
      [{ id: "c1", title: "Change title" }],
    );
    const [t] = flat().tasks;
    expect(Object.keys(t).sort()).toEqual(
      ["change", "excerpt", "number", "priority", "project", "status", "subject", "updated"].sort(),
    );
    expect(t.change).toBe("Change title");
    expect(t.excerpt).toHaveLength(160);
  });

  it("includes dependency numbers as needs and omits an empty needs", () => {
    writeBoard([task(1), task(2, { depends_on: ["id-1"] }), task(3, { depends_on: [] })]);
    const tasks = flat().tasks;
    expect(tasks.find((t) => t.number === 2).needs).toEqual([1]);
    expect(tasks.find((t) => t.number === 1)).not.toHaveProperty("needs");
    expect(tasks.find((t) => t.number === 3)).not.toHaveProperty("needs");
  });

  it("drops old done and undated backlog, keeps recent done and dated backlog", () => {
    writeBoard([
      task(1, { status: "done", updated_at: ts("2026-09-25") }),
      task(2, { status: "done", updated_at: ts("2026-09-01") }),
      task(3, { status: "backlog" }),
      task(4, { status: "backlog", scheduled_for: "2026-10-10" }),
      task(5, { status: "in_progress" }),
    ]);
    expect(flat().tasks.map((t) => t.number).sort()).toEqual([1, 4, 5]);
  });

  it("requires a valid --today and an --out-dir", () => {
    writeBoard([]);
    expect(() => call(["export", "--out-dir", exportDir()])).toThrow("exit 1");
    expect(() => call(["export", "--today", "2026-02-31", "--out-dir", exportDir()])).toThrow("exit 1");
    expect(() => call(["export", "--today", TODAY])).toThrow("exit 1");
  });
});

describe("triage export: parts", () => {
  it("cuts by manual group, then loose projects, then tasks without a project", () => {
    writeGroups([{ name: "Ядро", projects: ["a", "b"] }]);
    writeBoard([
      task(1, { project: "a" }),
      task(2, { project: "b" }),
      task(3, { project: "solo" }),
      task(4, { project: undefined }),
      task(5, { project: "a" }),
    ]);
    const { units, parts } = exportBoard();
    expect(units.map((u) => u.name)).toEqual(["Ядро", "solo", "без проекта"]);
    expect(units[0].projects).toEqual(["a", "b"]);
    expect(parts[0].tasks.map((t) => t.number)).toEqual([1, 2, 5]);
    expect(parts[0].unit).toEqual({ name: "Ядро", projects: ["a", "b"] });
    expect(units[1].projects).toEqual(["solo"]);
    expect(units[2].projects).toEqual([]);
  });

  it("puts a project from several groups into the first one", () => {
    writeGroups([
      { name: "Первая", projects: ["x"] },
      { name: "Вторая", projects: ["x", "y"] },
    ]);
    writeBoard([task(1, { project: "x" }), task(2, { project: "y" })]);
    const { units } = exportBoard();
    expect(units.map((u) => u.name)).toEqual(["Первая", "Вторая"]);
    expect(units.map((u) => u.tasks)).toEqual([1, 1]);
  });

  it("without a groups file every project is its own part", () => {
    writeBoard([task(1, { project: "a" }), task(2, { project: "b" })]);
    expect(exportBoard().units.map((u) => u.name)).toEqual(["a", "b"]);
  });

  it("marks agent: false for a part with fewer than 2 tasks", () => {
    writeBoard([task(1, { project: "a" }), task(2, { project: "a" }), task(3, { project: "b" })]);
    const { units } = exportBoard();
    expect(units.map((u) => [u.name, u.agent])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("prints the accounting line with parts", () => {
    writeBoard([
      task(1, { status: "done", updated_at: ts("2026-09-01") }),
      task(2, { status: "backlog" }),
      task(3, { status: "backlog" }),
      task(4, { project: "a" }),
      task(5, { project: "b" }),
      task(6, { project: "b" }),
    ]);
    call(["export", "--today", TODAY, "--out-dir", exportDir()]);
    expect(out).toContain("всего 6");
    expect(out).toContain("в выжимке 3");
    expect(out).toContain("отброшено 3");
    expect(out).toContain("done старше 14 дн.: 1");
    expect(out).toContain("backlog без срока: 2");
    expect(out).toContain("частей 2, с агентом 1");
  });
});

describe("triage publish --dir", () => {
  const writePart = (name, digest) =>
    writeFileSync(path.join(exportDir(), name), JSON.stringify(digest));

  it("builds the digest from two parts, facts first, headline counted", () => {
    writeBoard([
      task(1, { project: "a", scheduled_for: "2026-09-28" }),
      task(2, { project: "a" }),
      task(3, { project: "b", priority: undefined }),
      task(4, { project: "b" }),
    ]);
    const { units } = exportBoard();
    writePart(units[0].digest, {
      summary: "про a",
      items: [
        { kind: "link", number: 2, id: "id-elsewhere", subject: "устаревший заголовок", related: 1, note: "учесть" },
        { kind: "overdue", number: 99, id: "x", subject: "agent made up", note: "n" },
      ],
    });
    writePart(units[1].digest, {
      headline: "ignored",
      summary: "про b",
      items: [{ kind: "suggestion", number: 4, id: null, subject: "task 4", note: "сделать" }],
    });
    call(["publish", "--dir", exportDir()]);

    const d = JSON.parse(readFileSync(digestFile(), "utf8"));
    expect(d.items.map((i) => `${i.kind}:${i.number}`)).toEqual([
      "overdue:1",
      "no_priority:3",
      "link:2",
      "suggestion:4",
    ]);
    expect(d.items[0]).toMatchObject({ id: "id-1", subject: "task 1" });
    expect(d.items[2]).toMatchObject({ id: "id-2", subject: "task 2", related: 1 });
    expect(d.headline).toBe("1 просрочено · 1 без приоритета · 1 связей");
    expect(d.summary).toBe("a: про a\n\nb: про b");
  });

  it("headline is deterministic and says all-clear without facts", () => {
    writeBoard([task(1), task(2)]);
    exportBoard();
    call(["publish", "--dir", exportDir()]);
    expect(JSON.parse(readFileSync(digestFile(), "utf8")).headline).toBe("Всё в порядке");
  });

  it("notes a part whose agent left no digest in the summary", () => {
    writeBoard([task(1, { project: "a" }), task(2, { project: "a" }), task(3, { project: "b" })]);
    const { units } = exportBoard();
    writePart(units[0].digest, { summary: "ok", items: [] });
    call(["publish", "--dir", exportDir()]);
    const d = JSON.parse(readFileSync(digestFile(), "utf8"));
    expect(d.summary).toBe("a: ok");

    writeBoard([task(1, { project: "a" }), task(2, { project: "a" })]);
    exportBoard();
    call(["publish", "--dir", exportDir()]);
    expect(JSON.parse(readFileSync(digestFile(), "utf8")).summary).toContain("a: дайджест части не получен");
  });

  it("rejects a malformed part digest", () => {
    writeBoard([task(1), task(2)]);
    const { units } = exportBoard();
    writePart(units[0].digest, { items: [{ kind: "link", number: 1, subject: "s" }] });
    expect(() => call(["publish", "--dir", exportDir()])).toThrow("exit 1");
    expect(err).toContain("related");
  });

  it("drops links connected by direct dependency edges and reports the count", () => {
    writeBoard([task(1), task(2, { depends_on: ["id-1"] })]);
    const { units } = exportBoard();
    writePart(units[0].digest, { items: [{ kind: "link", number: 2, subject: "task 2", related: 1 }] });
    call(["publish", "--dir", exportDir()]);
    expect(JSON.parse(readFileSync(digestFile(), "utf8")).items).toEqual([]);
    expect(out).toContain("отброшено связей по графу: 1");
  });

  it("drops links connected by a transitive dependency path in either direction", () => {
    writeBoard([task(1), task(2, { depends_on: ["id-1"] }), task(3, { depends_on: ["id-2"] })]);
    const { units } = exportBoard();
    writePart(units[0].digest, {
      items: [
        { kind: "link", number: 3, subject: "task 3", related: 1 },
        { kind: "link", number: 1, subject: "task 1", related: 3 },
      ],
    });
    call(["publish", "--dir", exportDir()]);
    expect(JSON.parse(readFileSync(digestFile(), "utf8")).items).toEqual([]);
    expect(out).toContain("отброшено связей по графу: 2");
  });

  it("keeps a useful link inside one change when no dependency path exists", () => {
    writeBoard([task(1, { change_id: "c1" }), task(2, { change_id: "c1" })], [{ id: "c1", title: "same change" }]);
    const { units } = exportBoard();
    writePart(units[0].digest, { items: [{ kind: "link", number: 2, subject: "task 2", related: 1, note: "учесть результат" }] });
    call(["publish", "--dir", exportDir()]);
    expect(JSON.parse(readFileSync(digestFile(), "utf8")).items).toMatchObject([{ kind: "link", number: 2, related: 1 }]);
    expect(out).toContain("отброшено связей по графу: 0");
  });
});

describe("triage publish (plain)", () => {
  it("accepts a link item with related", () => {
    const item = { kind: "link", number: 7, id: "id-7", subject: "task 7", note: "учесть", related: 3 };
    call(["publish", "--json", JSON.stringify({ headline: "h", items: [item] })]);
    const [saved] = JSON.parse(readFileSync(digestFile(), "utf8")).items;
    expect(saved).toMatchObject({ kind: "link", number: 7, related: 3 });
  });

  it("rejects a link item without related", () => {
    const item = { kind: "link", number: 7, subject: "task 7", note: "n" };
    expect(() => call(["publish", "--json", JSON.stringify({ items: [item] })])).toThrow("exit 1");
    expect(err).toContain("related");
  });
});
