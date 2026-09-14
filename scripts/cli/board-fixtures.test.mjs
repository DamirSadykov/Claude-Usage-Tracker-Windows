import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBoard, saveBoard, CURRENT, BoardUnreadableError } from "./todos.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "board-fixtures",
);

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "board-fixtures-"));
  file = path.join(dir, "todos.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stage = (relative) => {
  writeFileSync(file, readFileSync(path.join(FIXTURES, relative)));
};

const corruptBackups = () => readdirSync(dir).filter((f) => f.includes(".corrupt-"));

describe("matrix row: v1/*.json (version 1) — CLI v2 writer", () => {
  it("v1/empty.json is readable but a CLI write refuses without changing it or creating a backup", () => {
    stage("v1/empty.json");
    const before = readFileSync(file);
    const data = loadBoard(file);
    expect(data.version).toBe(1);
    expect(data.todos).toEqual([]);

    let caught;
    try {
      saveBoard(file, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardUnreadableError);
    expect(caught.exitCode).toBe(4);
    expect(caught.message).toContain(`board version 1 is older than this writer (CURRENT ${CURRENT})`);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(corruptBackups()).toHaveLength(0);
  });

  it("v1/full.json is readable but a CLI write refuses without changing it or creating a backup", () => {
    stage("v1/full.json");
    const before = readFileSync(file);
    const data = loadBoard(file);
    expect(data.version).toBe(1);
    expect(data.todos).toHaveLength(3);

    let caught;
    try {
      saveBoard(file, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardUnreadableError);
    expect(caught.exitCode).toBe(4);
    expect(caught.message).toContain(`board version 1 is older than this writer (CURRENT ${CURRENT})`);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(corruptBackups()).toHaveLength(0);
  });
});

describe("matrix row: v2/*.json known fields — CLI v2 writer", () => {
  it("v2/empty.json round-trips untouched", () => {
    stage("v2/empty.json");
    const data = loadBoard(file);
    expect(data.version).toBe(2);

    saveBoard(file, data);
    const reread = loadBoard(file);
    expect(reread).toEqual({ version: 2, todos: [] });
  });

  it("v2/full.json known fields round-trip losslessly", () => {
    stage("v2/full.json");
    const original = JSON.parse(readFileSync(file, "utf8"));

    const data = loadBoard(file);
    saveBoard(file, data);
    const reread = JSON.parse(readFileSync(file, "utf8"));

    expect(reread.version).toBe(2);
    expect(reread.todos).toEqual(original.todos);
    expect(reread.changes).toEqual(original.changes);

    const t0 = reread.todos[0];
    expect(t0.id).toBe("b2222222-0000-4000-8000-000000000001");
    expect(t0.number).toBe(42);
    expect(t0.subject).toBe("Свести схему CSV-экспорта с дашбордом");
    expect(t0.description).toBe(
      "Экспорт и дашборд расходятся в именах колонок — свести перед тем, как добавлять новую.",
    );
    expect(t0.status).toBe("in_progress");
    expect(t0.project).toBe("usage-tracker");
    expect(t0.from).toBe("claude-usage-tracker-windows");
    expect(t0.plan).toBe("1. сверить список колонок\n2. написать миграцию для устаревших файлов");
    expect(t0.priority).toBe("high");
    expect(t0.kind).toBe("auto");
    expect(t0.change_id).toBe("c3333333-0000-4000-8000-000000000001");
    expect(t0.scheduled_for).toBe("2026-02-10");
    expect(t0.comments).toHaveLength(1);
    expect(t0.comments[0].author).toBe("user");
    expect(t0.comments[0].body).toBe("давай сначала сверим формат с дашбордом");
    expect(t0.links).toEqual(["b2222222-0000-4000-8000-000000000002"]);
    expect(t0.depends_on).toEqual(["b2222222-0000-4000-8000-000000000003"]);
    expect(t0.produces).toEqual(["docs/specs/tasks/spec.md#board-file"]);
    expect(t0.spec).toEqual(["tasks#board-file"]);
    expect(t0.spec_answers).toHaveLength(1);
    expect(t0.spec_answers[0].verdict).toBe("updated");
    expect(t0.spec_answers[0].address).toBe("tasks#board-file");
    expect(t0.spec_answers[0].blocks).toEqual(["3f9a1c2b"]);
    expect(t0.spec_seen).toHaveLength(1);
    expect(t0.spec_seen[0].hash).toBe("1a2b3c4d");
    expect(t0.status_history).toHaveLength(3);
    expect(t0.status_history[0]).toEqual({ status: "backlog", at: "2026-02-01T09:00:00.000Z" });
    expect(t0.status_history[2]).toEqual({ status: "in_progress", at: "2026-02-03T09:00:00.000Z" });
    expect(t0.verify).toBe("npx vitest run scripts/cli/spec.test.mjs");
    expect(t0.retry_limit).toBe(2);
    expect(t0.on_issue).toBe("b2222222-0000-4000-8000-000000000002");
    expect(t0.budget_usd).toBe(5);
    expect(t0.parallel_limit).toBe(2);
    expect(t0.outcome).toBe("ok");
    expect(t0.outcome_reason).toBe("ok");
    expect(t0.outcome_at).toBe("2026-02-03T11:00:00.000Z");
    expect(t0.handoff).toBe("Спека и фикстуры записаны, следующий шаг — Node-замок.");
    expect(t0.handoff_at).toBe("2026-02-03T11:00:00.000Z");
    expect(t0.handout_at).toBe("2026-02-03T08:00:00.000Z");
    expect(t0.imported_at).toBe("2026-02-01T08:00:00.000Z");
    expect(t0.created_by).toBe("claude");
    expect(t0.created_at).toBe("2026-02-01T09:00:00.000Z");
    expect(t0.updated_at).toBe("2026-02-03T11:00:00.000Z");

    const t3 = reread.todos[3];
    expect(t3.change).toBe(true);
    expect(t3.change_id).toBeUndefined();

    const t4 = reread.todos[4];
    expect(t4.scheduled_for).toBeNull();
    expect(t4.plan).toBe("");

    const [change0, change1] = reread.changes;
    expect(change0.title).toBe("контракт файла доски — замок fail-closed, recovery, фикстуры и версии");
    expect(change0.delta).toBe(
      "Записать контракт файла доски в спеку и положить фикстуры по версиям, затем реализовать замок и recovery на обеих сторонах.",
    );
    expect(change0.budget_usd).toBe(20);
    expect(change0.parallel_limit).toBe(1);
    expect(change0.spec).toEqual(["tasks#board-file"]);

    expect(change1.title).toBe("пример завершённого change'а");
    expect(change1.delta).toBe(
      "Демонстрационная запись со всеми полями Change, включая закрытие и происхождение из старого root'а.",
    );
    expect(change1.migrated_from).toBe(208);
    expect(change1.closed_at).toBe("2026-01-20T09:00:00.000Z");
    expect(change1.spec).toEqual([]);
  });
});

describe("matrix row: v2/unknown-field.json — CLI v2 writer", () => {
  it("ext and reviewer_note survive a CLI write (Node passes unknown fields through)", () => {
    stage("v2/unknown-field.json");
    const data = loadBoard(file);
    expect(data.todos[0].ext).toEqual({ triage: { kind: "stale", note: "не двигалась 40 дней" } });
    expect(data.todos[0].reviewer_note).toBe("поле, которого нет ни в CLI, ни в приложении");

    saveBoard(file, data);
    const reread = JSON.parse(readFileSync(file, "utf8"));
    expect(reread.todos[0].ext).toEqual({ triage: { kind: "stale", note: "не двигалась 40 дней" } });
    expect(reread.todos[0].reviewer_note).toBe("поле, которого нет ни в CLI, ни в приложении");
    expect(reread.todos[0].status).toBe("backlog");
  });
});

describe("matrix row: v2/future-version.json — CLI v2 writer", () => {
  it("reads known fields but refuses write with exit code 4 and leaves the file untouched", () => {
    stage("v2/future-version.json");
    const before = readFileSync(file);

    const data = loadBoard(file);
    expect(data.todos).toHaveLength(1);
    expect(data.todos[0].number).toBe(60);

    let caught;
    try {
      saveBoard(file, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardUnreadableError);
    expect(caught.exitCode).toBe(4);
    expect(caught.message).toContain(`board version 99 is newer than this writer (CURRENT ${CURRENT})`);

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(corruptBackups()).toHaveLength(0);
  });
});

describe("matrix row: corrupt/*.json — CLI v2 writer", () => {
  for (const name of ["truncated.json", "not-object.json", "todos-not-array.json", "empty-file.json"]) {
    it(`corrupt/${name} is unreadable: read yields an empty board with one backup, write refuses with exit code 4`, () => {
      stage(`corrupt/${name}`);
      const before = readFileSync(file);

      const data = loadBoard(file);
      expect(data.todos).toEqual([]);
      expect(corruptBackups()).toHaveLength(1);

      let caught;
      try {
        saveBoard(file, data);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BoardUnreadableError);
      expect(caught.exitCode).toBe(4);

      expect(readFileSync(file).equals(before)).toBe(true);
      expect(corruptBackups()).toHaveLength(1);
    });
  }

  it("corrupt/todo-field-type.json — Node still reads it (asymmetry with Rust) and round-trips the loose field", () => {
    stage("corrupt/todo-field-type.json");
    const data = loadBoard(file);
    expect(data.todos).toHaveLength(1);
    expect(data.todos[0].number).toBe("42");
    expect(corruptBackups()).toHaveLength(0);

    saveBoard(file, data);
    const reread = JSON.parse(readFileSync(file, "utf8"));
    expect(reread.version).toBe(2);
    expect(reread.todos[0].number).toBe("42");
  });
});
