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
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withBoardLock,
  boardLockPath,
  renameWithRetry,
} from "./board-lock.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

describe("board race — Node CLI writers vs a Rust-shaped app writer (t#578)", () => {
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
        {
          encoding: "utf8",
          env: { ...process.env, APPDATA: dir, BOARD_LOCK_WAIT_MS: "30000" },
          windowsHide: true,
        },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      ),
    );

  it(
    "8 CLI writers push 3 transitions each while an app-writer wave lands mid-race, and nothing is lost",
    { timeout: 60000 },
    async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "board-race-"));
      mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });

      const CLI_COUNT = 8;
      const cliNumbers = [];
      for (let i = 0; i < CLI_COUNT; i++) {
        const out = todos("add", `cli узел ${i}`, "--global");
        cliNumbers.push(Number(out.match(/#(\d+)/)[1]));
      }
      const appNumbers = [];
      for (let i = 0; i < 4; i++) {
        const out = todos("add", `app узел ${i}`, "--global");
        appNumbers.push(Number(out.match(/#(\d+)/)[1]));
      }

      const SEQUENCE = ["in_progress", "review", "done"];

      const cliWaves = cliNumbers.map(async (n) => {
        for (const status of SEQUENCE) {
          const r = await todosAsync("set", "status", String(n), status);
          expect(r.code, `set ${n} -> ${status}: ${r.stderr}`).toBe(0);
        }
      });

      const appWave = (async () => {
        await new Promise((r) => setTimeout(r, 60));
        withBoardLock(
          boardFile(),
          () => {
            const file = JSON.parse(readFileSync(boardFile(), "utf8"));
            const now = new Date().toISOString();
            for (const n of appNumbers) {
              const t = file.todos.find((x) => x.number === n);
              t.status = "in_progress";
              t.status_history = [...(t.status_history || []), { status: "in_progress", at: now }];
              t.updated_at = now;
            }
            const tmp = `${boardFile()}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(file, null, 2));
            renameWithRetry(tmp, boardFile());
          },
          { writer: "app" },
        );
      })();

      await Promise.all([...cliWaves, appWave]);

      const after = board().todos;
      for (const n of cliNumbers) {
        const t = after.find((x) => x.number === n);
        expect(t.status, `task #${n}`).toBe("done");
        const history = (t.status_history || []).map((h) => h.status);
        for (const status of SEQUENCE) expect(history, `task #${n} history`).toContain(status);
      }
      for (const n of appNumbers) {
        const t = after.find((x) => x.number === n);
        expect(t.status, `task #${n}`).toBe("in_progress");
        expect((t.status_history || []).map((h) => h.status), `task #${n} history`).toContain(
          "in_progress",
        );
      }

      const dirContents = readdirSync(path.dirname(boardFile()));
      for (const name of dirContents) {
        if (name === "todos.json") continue;
        expect(name.endsWith(".lock"), name).toBe(false);
        expect(name.includes(".stale-"), name).toBe(false);
        expect(name.endsWith(".tmp"), name).toBe(false);
      }
      expect(() => JSON.parse(readFileSync(boardFile(), "utf8"))).not.toThrow();
    },
  );
});

describe("board race — a Rust-shaped lock file blocks then releases the CLI (t#578)", () => {
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
  const setStatusAsync = (n, status, extraEnv = {}) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, "todos", "set", "status", String(n), status],
        { encoding: "utf8", env: { ...process.env, APPDATA: dir, ...extraEnv }, windowsHide: true },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      ),
    );

  it(
    "waits out, then refuses with exit code 3 naming writer app, then proceeds once the lock is gone",
    { timeout: 60000 },
    async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "board-race-applock-"));
      mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
      const n = Number(todos("add", "заблокирован приложением", "--global").match(/#(\d+)/)[1]);

      const lockPath = boardLockPath(boardFile());
      const at = new Date().toISOString().replace("Z", "+00:00");
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, writer: "app", at }));

      const result = await setStatusAsync(n, "in_progress", { BOARD_LOCK_WAIT_MS: "300" });

      expect(result.code).toBe(3);
      expect(result.stderr).toMatch(new RegExp(`board locked by pid ${process.pid} \\(app, since `));
      expect(result.stderr).toContain(lockPath);
      expect(board().todos.find((t) => t.number === n).status).toBe("backlog");
      expect(existsSync(lockPath)).toBe(true);

      rmSync(lockPath);

      const retried = await setStatusAsync(n, "in_progress", { BOARD_LOCK_WAIT_MS: "5000" });
      expect(retried.code, retried.stderr).toBe(0);
      expect(board().todos.find((t) => t.number === n).status).toBe("in_progress");
      expect(existsSync(lockPath)).toBe(false);
    },
  );
});
