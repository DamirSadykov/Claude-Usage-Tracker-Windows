import { openSync, closeSync, writeSync, statSync, unlinkSync } from "node:fs";

export const BOARD_LOCK_WAIT_MS = 15_000;
export const BOARD_LOCK_STALE_MS = 60_000;
const POLL_MS = 25;

export function boardLockPath(file) {
  return `${file}.lock`;
}

const held = new Map();
const active = new Set();
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const lock of active) {
      try {
        unlinkSync(lock);
      } catch {}
    }
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryCreate(lock) {
  let fd;
  try {
    fd = openSync(lock, "wx");
  } catch (e) {
    return e.code || "EFAIL";
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {}
  closeSync(fd);
  return "";
}

function ageOf(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return Infinity;
  }
}

export function acquireBoardLock(file, { waitMs = BOARD_LOCK_WAIT_MS, staleMs = BOARD_LOCK_STALE_MS } = {}) {
  const lock = boardLockPath(file);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const err = tryCreate(lock);
    if (!err) {
      active.add(lock);
      hookExit();
      return { ok: true, lock };
    }
    if (err !== "EEXIST") return { ok: false, lock, reason: err };
    if (ageOf(lock) > staleMs) {
      try {
        unlinkSync(lock);
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, lock, reason: "TIMEOUT" };
    sleepSync(POLL_MS);
  }
}

export function releaseBoardLock(lock) {
  active.delete(lock);
  try {
    unlinkSync(lock);
  } catch {}
}

export function withBoardLock(file, fn, opts = {}) {
  const depth = held.get(file) || 0;
  if (depth > 0) {
    held.set(file, depth + 1);
    try {
      return fn();
    } finally {
      held.set(file, held.get(file) - 1);
    }
  }

  const got = acquireBoardLock(file, opts);
  if (!got.ok && got.reason === "TIMEOUT")
    process.stderr.write(
      `board lock busy for ${opts.waitMs ?? BOARD_LOCK_WAIT_MS}ms (${got.lock}) — writing without it\n`,
    );
  held.set(file, 1);
  try {
    return fn();
  } finally {
    held.set(file, (held.get(file) || 1) - 1);
    if (got.ok) releaseBoardLock(got.lock);
  }
}
