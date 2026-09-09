import fs from "node:fs";
import path from "node:path";

const envWaitMs = Number(process.env.BOARD_LOCK_WAIT_MS);
export const BOARD_LOCK_WAIT_MS = envWaitMs > 0 ? envWaitMs : 15_000;
export const BOARD_LOCK_STALE_AGE_MS = 10 * 60_000;
export const BOARD_LOCK_UNREADABLE_STALE_MS = 30_000;
const POLL_MS = 25;

export class BoardLockedError extends Error {
  constructor(message, { lockPath, pid = null, writer = null, at = null } = {}) {
    super(message);
    this.name = "BoardLockedError";
    this.exitCode = 3;
    this.lockPath = lockPath;
    this.pid = pid;
    this.writer = writer;
    this.at = at;
  }
}

function normalizedPath(file) {
  let real;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    try {
      const dir = fs.realpathSync.native(path.dirname(file));
      real = path.join(dir, path.basename(file));
    } catch {
      real = path.resolve(file);
    }
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function boardLockPath(file) {
  return `${normalizedPath(file)}.lock`;
}

const held = new Map();
const active = new Set();
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const lock of active) releaseBoardLock(lock);
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryCreate(lock, writer) {
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (e) {
    return e.code || "EFAIL";
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, writer, at: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lock);
    } catch {}
    return e.code || "EFAIL";
  }
  return "";
}

function readLockInfo(lock) {
  let raw;
  try {
    raw = fs.readFileSync(lock, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { missing: true };
    return { missing: false, parsed: null, mtimeMs: Date.now() };
  }
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch {
    mtimeMs = Date.now();
  }
  let parsed = null;
  try {
    const obj = JSON.parse(raw);
    if (obj && Number.isInteger(obj.pid) && obj.pid > 0 && typeof obj.at === "string") parsed = obj;
  } catch {}
  return { missing: false, parsed, mtimeMs };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === "ESRCH");
  }
}

function isStale(info) {
  if (!info.parsed) return Date.now() - info.mtimeMs > BOARD_LOCK_UNREADABLE_STALE_MS;
  if (!isPidAlive(info.parsed.pid)) return true;
  const atMs = Date.parse(info.parsed.at);
  if (Number.isNaN(atMs)) return Date.now() - info.mtimeMs > BOARD_LOCK_UNREADABLE_STALE_MS;
  const age = Math.max(0, Date.now() - atMs);
  return age > BOARD_LOCK_STALE_AGE_MS;
}

function stealStaleLock(lock) {
  const claimed = `${lock}.stale-${process.pid}`;
  try {
    fs.renameSync(lock, claimed);
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(claimed);
  } catch {}
  return true;
}

export function acquireBoardLock(file, { waitMs = BOARD_LOCK_WAIT_MS, writer = "cli" } = {}) {
  const lock = boardLockPath(file);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {}
  const deadline = Date.now() + waitMs;
  for (;;) {
    const err = tryCreate(lock, writer);
    if (!err) {
      active.add(lock);
      hookExit();
      return { ok: true, lock };
    }
    if (err !== "EEXIST") return { ok: false, lock, reason: err };

    const info = readLockInfo(lock);
    if (info.missing) {
      if (Date.now() >= deadline) return { ok: false, lock, reason: "TIMEOUT", info };
      continue;
    }
    if (isStale(info)) {
      stealStaleLock(lock);
      if (Date.now() >= deadline) return { ok: false, lock, reason: "TIMEOUT", info };
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, lock, reason: "TIMEOUT", info };
    sleepSync(POLL_MS);
  }
}

export function releaseBoardLock(lock) {
  active.delete(lock);
  const info = readLockInfo(lock);
  if (info.missing) return;
  if (!info.parsed || info.parsed.pid !== process.pid) return;
  try {
    fs.unlinkSync(lock);
  } catch {}
}

function lockedMessage(lock, info) {
  const p = info && info.parsed;
  if (p) return `board locked by pid ${p.pid} (${p.writer}, since ${p.at}): ${lock}`;
  return `board locked (contents unreadable): ${lock}`;
}

export function renameWithRetry(tmp, file, { retries = 5, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!(e && (e.code === "EPERM" || e.code === "EACCES")) || attempt >= retries) throw e;
      sleepSync(delayMs);
    }
  }
}

export function sweepOrphanTmp(file) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${base}\\.\\d+\\.tmp$`);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!re.test(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
}

export function withBoardLock(file, fn, opts = {}) {
  const key = boardLockPath(file);
  const depth = held.get(key) || 0;
  if (depth > 0) {
    held.set(key, depth + 1);
    try {
      return fn();
    } finally {
      held.set(key, held.get(key) - 1);
    }
  }

  const got = acquireBoardLock(file, opts);
  if (!got.ok) {
    if (got.reason === "TIMEOUT") {
      throw new BoardLockedError(lockedMessage(got.lock, got.info), {
        lockPath: got.lock,
        pid: got.info?.parsed?.pid ?? null,
        writer: got.info?.parsed?.writer ?? null,
        at: got.info?.parsed?.at ?? null,
      });
    }
    throw new Error(`could not take the board lock (${got.reason}): ${got.lock}`);
  }
  sweepOrphanTmp(file);
  held.set(key, 1);
  try {
    return fn();
  } finally {
    held.set(key, (held.get(key) || 1) - 1);
    releaseBoardLock(got.lock);
  }
}
