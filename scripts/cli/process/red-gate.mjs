import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function gitHead(cwd) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!sha) return { ok: false, error: "git rev-parse HEAD returned nothing" };
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export const UNTRACKED_SNAPSHOT_LIMIT = 2000;

export function snapshotTree(cwd) {
  let indexRel;
  try {
    indexRel = execFileSync("git", ["rev-parse", "--git-path", "index"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const realIndex = path.isAbsolute(indexRel) ? indexRel : path.join(cwd, indexRel);
  const tmpIndex = path.join(os.tmpdir(), `cut-snapshot-index-${process.pid}-${randomUUID()}`);
  try {
    fs.copyFileSync(realIndex, tmpIndex);
  } catch (err) {
    if (!err || err.code !== "ENOENT") return { ok: false, error: String((err && err.message) || err) };
  }
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  let untracked = 0;
  try {
    untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    }).split("\0").filter(Boolean).length;
  } catch {}
  const trackedOnly = untracked > UNTRACKED_SNAPSHOT_LIMIT;
  if (trackedOnly && !snapshotTree.warned) {
    snapshotTree.warned = true;
    process.stderr.write(
      `run: ${untracked} untracked files in ${cwd} — the step snapshot keeps tracked files only; add build output to .gitignore\n`,
    );
  }
  try {
    execFileSync("git", ["add", trackedOnly ? "-u" : "-A"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const tree = execFileSync("git", ["write-tree"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const sha = execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", "snapshot"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    try {
      fs.rmSync(tmpIndex, { force: true });
    } catch {}
  }
}

export function gitBase(cwd) {
  const head = gitHead(cwd);
  if (!head.ok) return head;
  const snap = snapshotTree(cwd);
  if (!snap.ok) return snap;
  try {
    const headTree = execFileSync("git", ["rev-parse", `${head.sha}^{tree}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const snapTree = execFileSync("git", ["rev-parse", `${snap.sha}^{tree}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (headTree === snapTree) return { ok: true, sha: head.sha };
  } catch {}
  return snap;
}

export function diffNameStatus(cwd, from, to) {
  try {
    const out = execFileSync("git", ["diff", "--no-renames", "--name-status", from, to], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { status: line.slice(0, tab).trim()[0], path: normalizePath(line.slice(tab + 1)) };
      });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export function computeNeighbourDamage({ cwd, head, stepBase, end, produces, edited = null }) {
  const changes = diffNameStatus(cwd, stepBase, end);
  if (!Array.isArray(changes)) return { ok: false, error: changes.error };
  const prior = diffNameStatus(cwd, head, stepBase);
  if (!Array.isArray(prior)) return { ok: false, error: prior.error };
  const producesSet = new Set(
    (Array.isArray(produces) ? produces : []).map(normalizePath).filter(Boolean),
  );
  const editedSet = Array.isArray(edited)
    ? new Set(edited.map(normalizePath).filter(Boolean))
    : null;
  const own = editedSet
    ? changes.filter((change) => editedSet.has(change.path) || producesSet.has(change.path))
    : changes;
  const outside = editedSet
    ? changes.filter((change) => !editedSet.has(change.path) && !producesSet.has(change.path))
    : [];
  const priorPaths = new Set(prior.map((c) => c.path));
  const damaged = [];
  for (const change of own) {
    if (!priorPaths.has(change.path) || producesSet.has(change.path)) continue;
    if (change.status === "D") {
      damaged.push({ path: change.path, state: "deleted" });
      continue;
    }
    if (!existsAtBase(cwd, end, change.path)) {
      damaged.push({ path: change.path, state: "deleted" });
      continue;
    }
    if (!existsAtBase(cwd, head, change.path)) continue;
    const endBuf = readAtBase(cwd, end, change.path);
    const headBuf = readAtBase(cwd, head, change.path);
    if (endBuf.equals(headBuf)) damaged.push({ path: change.path, state: "reverted" });
  }
  return { ok: true, own, outside, prior, damaged };
}

const insideCwd = (cwd, rel) => {
  const back = path.relative(path.resolve(cwd), path.resolve(cwd, rel));
  return !!back && !back.startsWith("..") && !path.isAbsolute(back);
};

const sameDir = (a, b) => {
  const na = path.resolve(String(a ?? ""));
  const nb = path.resolve(String(b ?? ""));
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

const normalizePath = (p) => String(p ?? "").trim().replace(/\\/g, "/");

function existsAtBase(cwd, base, relPath) {
  try {
    execFileSync("git", ["cat-file", "-e", `${base}:./${normalizePath(relPath)}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function readAtBase(cwd, base, relPath) {
  return execFileSync("git", ["cat-file", "--filters", `${base}:./${normalizePath(relPath)}`], { cwd });
}

function readWorking(cwd, relPath) {
  try {
    return fs.readFileSync(path.join(cwd, relPath));
  } catch {
    return null;
  }
}

function existsWorking(cwd, relPath) {
  try {
    return fs.statSync(path.join(cwd, relPath)).isFile();
  } catch {
    return false;
  }
}

export function computeRevertSet(task, cwd, base) {
  const redTests = new Set(
    (Array.isArray(task.red_tests) ? task.red_tests : []).map(normalizePath).filter(Boolean),
  );
  const produces = (Array.isArray(task.produces) ? task.produces : []).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const raw of produces) {
    const rel = normalizePath(raw);
    if (!rel || redTests.has(rel) || seen.has(rel) || !insideCwd(cwd, rel)) continue;
    const inBase = existsAtBase(cwd, base, rel);
    const inWork = existsWorking(cwd, rel);
    if (!inBase && !inWork) continue;
    seen.add(rel);
    if (inBase && !inWork) {
      out.push({ path: rel, state: "deleted" });
      continue;
    }
    if (!inBase && inWork) {
      out.push({ path: rel, state: "added" });
      continue;
    }
    const baseBuf = readAtBase(cwd, base, rel);
    const workBuf = readWorking(cwd, rel);
    if (!baseBuf.equals(workBuf)) out.push({ path: rel, state: "modified" });
  }
  return out;
}

export function redTestsChanged(task, cwd, base) {
  const list = (Array.isArray(task.red_tests) ? task.red_tests : [])
    .map(normalizePath)
    .filter(Boolean);
  if (!list.length) return false;
  return list.some((rel) => {
    if (!existsWorking(cwd, rel)) return false;
    if (!existsAtBase(cwd, base, rel)) return true;
    const baseBuf = readAtBase(cwd, base, rel);
    const workBuf = readWorking(cwd, rel);
    return !baseBuf.equals(workBuf);
  });
}

export function markerDir(appDataDir, taskId) {
  return path.join(appDataDir, String(taskId));
}

function writeFileFsync(fullPath, buf) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const fd = fs.openSync(fullPath, "w");
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeMarker({ appDataDir, task, cwd, base, files, startedAt }) {
  const dir = markerDir(appDataDir, task.id);
  fs.mkdirSync(path.join(dir, "copies"), { recursive: true });
  const withCopies = files.map((f, i) => {
    if (f.state === "deleted") return { path: f.path, state: f.state };
    const copy = String(i);
    const buf = readWorking(cwd, f.path) ?? Buffer.alloc(0);
    writeFileFsync(path.join(dir, "copies", copy), buf);
    return { path: f.path, state: f.state, copy };
  });
  const marker = {
    task: task.id,
    number: task.number ?? null,
    cwd,
    base,
    files: withCopies,
    started_at: startedAt,
  };
  writeFileFsync(path.join(dir, "marker.json"), Buffer.from(JSON.stringify(marker, null, 2)));
  return { dir, marker };
}

function applyBase({ cwd, base, files }) {
  for (const f of files) {
    const full = path.join(cwd, f.path);
    if (f.state === "added") {
      fs.rmSync(full, { force: true });
      continue;
    }
    const buf = readAtBase(cwd, base, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
}

function restoreWorker({ dir, cwd, files }) {
  const errors = [];
  for (const f of files) {
    try {
      const full = path.join(cwd, f.path);
      if (f.state === "deleted") {
        fs.rmSync(full, { force: true });
        continue;
      }
      const buf = fs.readFileSync(path.join(dir, "copies", f.copy));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    } catch (err) {
      errors.push(`${f.path}: ${(err && err.message) || err}`);
    }
  }
  return errors;
}

function removeMarkerDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (err) {
    return err;
  }
}

const tailLines = (s, n) => {
  const t = String(s ?? "").trim();
  const lines = t.split(/\r?\n/);
  return lines.length <= n ? t : lines.slice(-n).join("\n");
};

export async function runRedGate({ task, cwd, timeoutMs, appDataDir, runCmd }) {
  const base = task.step_base;
  if (!base)
    return {
      ok: false,
      field: null,
      reason: "red declared but no step_base was recorded before the step ran",
    };
  if (!redTestsChanged(task, cwd, base))
    return {
      ok: false,
      field: null,
      reason: "red-tests unchanged since base — no regression test was written",
    };
  const files = computeRevertSet(task, cwd, base);
  if (!files.length)
    return {
      ok: false,
      field: null,
      reason: "no production file in produces changed — nothing for red to fail against",
    };

  const startedAt = new Date().toISOString();
  const { dir, marker } = writeMarker({ appDataDir, task, cwd, base, files, startedAt });
  const markedFiles = marker.files;

  let result;
  try {
    applyBase({ cwd, base, files: markedFiles });
    const run = await runCmd({ cmd: task.red, cwd, timeoutMs });
    const code = Number(run?.code);
    const output = [run?.stdout, run?.stderr].filter((s) => s && String(s).trim()).join("\n");
    result =
      code === 0
        ? {
            ok: false,
            field: "passed-on-base",
            reason:
              "the regression test passes on the base code — it does not catch the bug\n" +
              tailLines(output, 60),
          }
        : { ok: true, field: "failed-on-base", reason: null };
  } finally {
    const errors = restoreWorker({ dir, cwd, files: markedFiles });
    const rmErr = removeMarkerDir(dir);
    const problems = [...errors, rmErr ? `marker cleanup: ${rmErr.message || rmErr}` : null].filter(
      Boolean,
    );
    if (problems.length) {
      process.stderr.write(
        `red gate: restore failed for #${task.number ?? task.id} — ${problems.join("; ")}\n`,
      );
      result = {
        ok: false,
        field: result ? result.field : "failed-on-base",
        reason:
          `red gate restore FAILED after running — the working tree may still be reverted: ${problems.join("; ")}` +
          (result ? `\n(gate verdict before restore failure: ${result.ok ? "passed" : "issue"}${result.reason ? ` — ${result.reason}` : ""})` : ""),
      };
    }
  }
  return result;
}

export function recoverMarkers({ appDataDir, cwd }) {
  const restored = [];
  let entries;
  try {
    entries = fs.readdirSync(appDataDir);
  } catch {
    return restored;
  }
  for (const name of entries) {
    const dir = path.join(appDataDir, name);
    const markerPath = path.join(dir, "marker.json");
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {
      continue;
    }
    if (!marker || !sameDir(marker.cwd, cwd)) continue;
    const errors = restoreWorker({ dir, cwd: marker.cwd, files: marker.files || [] });
    const rmErr = removeMarkerDir(dir);
    const problems = [...errors, rmErr ? `marker cleanup: ${rmErr.message || rmErr}` : null].filter(
      Boolean,
    );
    if (problems.length) {
      process.stderr.write(
        `red gate recovery: restore failed for task ${marker.task} — ${problems.join("; ")}\n`,
      );
    } else {
      process.stderr.write(
        `red gate recovery: restored ${(marker.files || []).length} file(s) for t#${marker.number ?? "?"}, interrupted gate run cleaned up\n`,
      );
    }
    restored.push(marker.task);
  }
  return restored;
}
