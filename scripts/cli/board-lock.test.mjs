import { describe, it, expect, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withBoardLock,
  acquireBoardLock,
  releaseBoardLock,
  boardLockPath,
  sweepOrphanTmp,
  BoardLockedError,
  BOARD_LOCK_STALE_AGE_MS,
  BOARD_LOCK_UNREADABLE_STALE_MS,
} from "./board-lock.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

const DEAD_PID = 9_999_999;

describe("board lock — the primitive", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("refuses a second holder while the first one has it", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const first = acquireBoardLock(file, { waitMs: 0 });
    expect(first.ok).toBe(true);
    expect(existsSync(boardLockPath(file))).toBe(true);

    const second = acquireBoardLock(file, { waitMs: 0 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("TIMEOUT");

    releaseBoardLock(first.lock);
    expect(existsSync(boardLockPath(file))).toBe(false);
    const third = acquireBoardLock(file, { waitMs: 0 });
    expect(third.ok).toBe(true);
    releaseBoardLock(third.lock);
  });

  it("is re-entrant inside one process", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const seen = withBoardLock(file, () =>
      withBoardLock(file, () => existsSync(boardLockPath(file))),
    );
    expect(seen).toBe(true);
    expect(existsSync(boardLockPath(file))).toBe(false);
  });

  it("releases only the lock its own pid created", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const lock = boardLockPath(file);
    writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, writer: "cli", at: new Date().toISOString() }));
    releaseBoardLock(lock);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
  });

  it("breaks a lock whose holder pid is dead, via rename, leaving no .stale- file behind", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const lock = boardLockPath(file);
    writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, writer: "cli", at: new Date().toISOString() }));

    const got = acquireBoardLock(file, { waitMs: 200 });
    expect(got.ok).toBe(true);
    const leftovers = readdirSync(dir).filter((n) => n.includes(".stale-"));
    expect(leftovers).toEqual([]);
    releaseBoardLock(got.lock);
  });

  it("waits on an unreadable lock younger than the unreadable-stale ceiling", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    writeFileSync(boardLockPath(file), "not json at all");

    const got = acquireBoardLock(file, { waitMs: 0 });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("TIMEOUT");
  });

  it("breaks an unreadable lock older than the unreadable-stale ceiling", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const lock = boardLockPath(file);
    writeFileSync(lock, "not json at all");
    const old = new Date(Date.now() - BOARD_LOCK_UNREADABLE_STALE_MS - 5_000);
    utimesSync(lock, old, old);

    const got = acquireBoardLock(file, { waitMs: 200 });
    expect(got.ok).toBe(true);
    releaseBoardLock(got.lock);
  });

  it("does not break a live holder's lock even a minute old", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const lock = boardLockPath(file);
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, writer: "cli", at: minuteAgo }));

    const got = acquireBoardLock(file, { waitMs: 0 });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("TIMEOUT");
    rmSync(lock);
  });

  it("breaks a live holder's lock once its `at` passes the 10-minute ceiling", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const lock = boardLockPath(file);
    const longAgo = new Date(Date.now() - BOARD_LOCK_STALE_AGE_MS - 5_000).toISOString();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, writer: "cli", at: longAgo }));

    const got = acquireBoardLock(file, { waitMs: 200 });
    expect(got.ok).toBe(true);
    releaseBoardLock(got.lock);
  });

  it("shares one lock across two different-case spellings of the same path", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    writeFileSync(file, "{}");
    const variant = path.join(dir, "TODOS.JSON");

    const first = acquireBoardLock(file, { waitMs: 0 });
    expect(first.ok).toBe(true);
    const second = acquireBoardLock(variant, { waitMs: 0 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("TIMEOUT");
    expect(boardLockPath(variant)).toBe(boardLockPath(file));

    releaseBoardLock(first.lock);
  });

  it("the exit hook does not delete a lock whose ownership changed under it", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const modUrl = JSON.stringify(new URL("./board-lock.mjs", import.meta.url).href);
    const scriptPath = path.join(dir, "child.mjs");
    writeFileSync(
      scriptPath,
      [
        `import { acquireBoardLock, boardLockPath } from ${modUrl};`,
        `import { writeFileSync } from "node:fs";`,
        `const file = ${JSON.stringify(file)};`,
        `const got = acquireBoardLock(file, { waitMs: 0 });`,
        `if (!got.ok) process.exit(2);`,
        `writeFileSync(boardLockPath(file), JSON.stringify({ pid: 424242, writer: "cli", at: new Date().toISOString() }));`,
      ].join("\n"),
    );
    execFileSync(process.execPath, [scriptPath], { encoding: "utf8", windowsHide: true });

    const lockPath = boardLockPath(file);
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(content.pid).toBe(424242);
  });
});

describe("board lock — fail-closed on a busy board (t#573)", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("withBoardLock throws BoardLockedError with exitCode 3 instead of writing past the lock", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    writeFileSync(file, JSON.stringify({ version: 1, todos: [] }));
    const before = readFileSync(file, "utf8");

    const holder = acquireBoardLock(file, { waitMs: 0 });
    expect(holder.ok).toBe(true);

    let called = false;
    expect(() =>
      withBoardLock(
        file,
        () => {
          called = true;
          writeFileSync(file, JSON.stringify({ version: 1, todos: [{ id: "x" }] }));
        },
        { waitMs: 0 },
      ),
    ).toThrow(BoardLockedError);
    expect(called).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);

    releaseBoardLock(holder.lock);
  });

  it("names the pid, writer and lock path in the error, and sets exitCode 3", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    const holder = acquireBoardLock(file, { waitMs: 0 });
    expect(holder.ok).toBe(true);

    try {
      withBoardLock(file, () => {}, { waitMs: 0 });
      throw new Error("expected withBoardLock to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BoardLockedError);
      expect(err.exitCode).toBe(3);
      expect(err.message).toMatch(new RegExp(`board locked by pid ${process.pid} \\(cli, since `));
      expect(err.message).toContain(holder.lock);
    } finally {
      releaseBoardLock(holder.lock);
    }
  });
});

describe("sweepOrphanTmp", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("removes an orphaned todos.json.<pid>.tmp but leaves todos.json alone", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    writeFileSync(file, "{}");
    writeFileSync(`${file}.123.tmp`, "leftover");
    writeFileSync(`${file}.notanumber.tmp`, "not a pid-shaped name");

    sweepOrphanTmp(file);

    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.123.tmp`)).toBe(false);
    expect(existsSync(`${file}.notanumber.tmp`)).toBe(true);
  });
});

// The live case the lock exists for (t#528): a parallel wave moves two nodes at
// once, each through its own `cli todos set status` process. Without the lock
// both read the same board and the later writer replays a state that never saw
// the other move — one transition is silently lost.
describe("board lock — which commands take it", () => {
  it("keeps the runner and the other parents that spawn `todos set` outside the lock", async () => {
    const { MUTATING } = await import("./todos.mjs");
    for (const parent of ["run", "apply", "outcome", "lint", "list", "pipeline"])
      expect(MUTATING.has(parent), `${parent} would deadlock on its own children`).toBe(false);
    for (const leaf of ["set", "take", "handoff", "comment", "dep"])
      expect(MUTATING.has(leaf)).toBe(true);
  });
});

describe("board lock — concurrent CLI writers", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const boardFile = () => path.join(dir, "com.claude-usage-tracker.app", "todos.json");
  const board = () => JSON.parse(readFileSync(boardFile(), "utf8"));
  const todos = (...args) =>
    execFileSync(process.execPath, [cli, "todos", ...args], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
  const todosAsync = (...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, "todos", ...args],
        { encoding: "utf8", env: { ...process.env, APPDATA: dir }, windowsHide: true },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      ),
    );

  it("keeps every status of a wave written at the same moment", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });

    const numbers = [];
    for (const subject of ["узел A", "узел B", "узел C", "узел D"]) {
      const out = todos("add", subject, "--global");
      numbers.push(Number(out.match(/#(\d+)/)[1]));
    }

    const results = await Promise.all(
      numbers.map((n) => todosAsync("set", "status", String(n), "in_progress")),
    );
    for (const r of results) expect(r.code).toBe(0);

    const after = board().todos;
    for (const n of numbers) {
      const t = after.find((x) => x.number === n);
      expect(t.status).toBe("in_progress");
      expect((t.status_history || []).map((h) => h.status)).toContain("in_progress");
    }
  });

  // The regression the lock is FOR: a mutating command must wait for whoever
  // holds the board, not read it, sit on its copy and overwrite the other
  // writer's change afterwards. Held from the test process, so the window is
  // deterministic instead of a race the machine may win by luck.
  it("makes a mutating command wait while the board is held", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    const n = Number(todos("add", "ждёт лока", "--global").match(/#(\d+)/)[1]);

    const holder = acquireBoardLock(boardFile(), { waitMs: 0 });
    expect(holder.ok).toBe(true);

    let finished = false;
    const moving = todosAsync("set", "status", String(n), "in_progress").then((r) => {
      finished = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 1200));
    expect(finished).toBe(false);
    expect(board().todos.find((x) => x.number === n).status).toBe("backlog");

    releaseBoardLock(holder.lock);
    const moved = await moving;
    expect(moved.code).toBe(0);
    expect(board().todos.find((x) => x.number === n).status).toBe("in_progress");
  });

  it("keeps a handoff written next to a concurrent status move", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });

    const a = Number(todos("add", "пишет батон", "--global").match(/#(\d+)/)[1]);
    const b = Number(todos("add", "двигает статус", "--global").match(/#(\d+)/)[1]);

    const [wrote, moved] = await Promise.all([
      todosAsync("handoff", "set", String(a), "--text", "батон из параллельной волны"),
      todosAsync("set", "status", String(b), "in_progress"),
    ]);
    expect(wrote.code).toBe(0);
    expect(moved.code).toBe(0);

    const after = board().todos;
    expect(after.find((x) => x.number === a).handoff).toMatch(/параллельной волны/);
    expect(after.find((x) => x.number === b).status).toBe("in_progress");
  });

  // t#573: fail-closed, end to end — a child CLI process must give up and exit
  // 3 rather than write past a held lock. BOARD_LOCK_WAIT_MS (read by
  // board-lock.mjs) shortens the wait so the test does not sit through the
  // real 15 s production ceiling.
  it("a child CLI process exits 3 with the spec's message when the board is busy", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    const n = Number(todos("add", "занятый лок", "--global").match(/#(\d+)/)[1]);

    const holder = acquireBoardLock(boardFile(), { waitMs: 0 });
    expect(holder.ok).toBe(true);

    const result = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, "todos", "set", "status", String(n), "in_progress"],
        {
          encoding: "utf8",
          env: { ...process.env, APPDATA: dir, BOARD_LOCK_WAIT_MS: "200" },
          windowsHide: true,
        },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      ),
    );

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(new RegExp(`board locked by pid ${process.pid} \\(cli, since `));
    expect(result.stderr).toContain(boardLockPath(boardFile()));
    expect(board().todos.find((x) => x.number === n).status).toBe("backlog");

    releaseBoardLock(holder.lock);
  });

  it("two children racing to steal one stale lock leave exactly one holder and no .stale- file", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-cli-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    writeFileSync(boardFile(), JSON.stringify({ version: 1, todos: [] }));
    writeFileSync(
      boardLockPath(boardFile()),
      JSON.stringify({ pid: DEAD_PID, writer: "cli", at: new Date().toISOString() }),
    );

    const [a, b] = await Promise.all([
      todosAsync("add", "гонка A", "--global"),
      todosAsync("add", "гонка B", "--global"),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    const leftovers = readdirSync(path.dirname(boardFile())).filter((n) => n.includes(".stale-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(boardLockPath(boardFile()))).toBe(false);
    const subjects = board().todos.map((t) => t.subject);
    expect(subjects).toContain("гонка A");
    expect(subjects).toContain("гонка B");
  });
});
