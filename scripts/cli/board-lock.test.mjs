import { describe, it, expect, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBoardLock, acquireBoardLock, releaseBoardLock, boardLockPath } from "./board-lock.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

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

  it("breaks a stale lock rather than waiting on a process that died", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "todos.json");
    writeFileSync(boardLockPath(file), "9999999\n");
    const longAgo = new Date(Date.now() - 5 * 60_000);
    utimesSync(boardLockPath(file), longAgo, longAgo);

    const got = acquireBoardLock(file, { waitMs: 0, staleMs: 60_000 });
    expect(got.ok).toBe(true);
    releaseBoardLock(got.lock);
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
});
