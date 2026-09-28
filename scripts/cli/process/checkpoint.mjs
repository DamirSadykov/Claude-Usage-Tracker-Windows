import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const normalizePath = (value) => String(value ?? "").trim().replace(/\\/g, "/");

const insideCwd = (cwd, rel) => {
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, rel));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export function blockingCount(attempt) {
  if (attempt?.counts && Number.isFinite(attempt.counts.critical) && Number.isFinite(attempt.counts.high))
    return attempt.counts.critical + attempt.counts.high;
  return (attempt?.findings || []).filter((finding) => finding?.level === "critical" || finding?.level === "high").length;
}

// `attempts` is in journal order.  Deliberately keep the first equal attempt:
// it is the stable, earlier checkpoint requested by the retry policy.
export function bestAttempt(attempts) {
  let best = null;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    // New records explicitly distinguish executor/verify failures from a
    // reviewer verdict.  Earlier journals predate that field, however, and
    // their review checkpoints must remain usable after an upgrade.  Missing
    // therefore means legacy-reviewed; only an explicit false is excluded.
    if (attempt?.reviewed === false) continue;
    if (!best || blockingCount(attempt) < blockingCount(best)) best = attempt;
  }
  return best;
}

export function rollbackPaths({ cwd, produces, ownChanges }) {
  const values = [
    ...(Array.isArray(produces) ? produces : []),
    ...(Array.isArray(ownChanges) ? ownChanges.map((change) => typeof change === "string" ? change : change?.path) : []),
  ];
  const seen = new Set();
  return values.map(normalizePath).filter((rel) => {
    if (!rel || seen.has(rel) || !insideCwd(cwd, rel)) return false;
    seen.add(rel);
    return true;
  });
}

function objectExists(cwd, sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function existsInCheckpoint(cwd, sha, rel) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:./${rel}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Restore only the declared output and the files this attempt actually changed.
// `git checkout <sha> -- <paths>` neither moves HEAD nor creates a ref.
export function restoreCheckpoint({ cwd, sha, produces, ownChanges }) {
  if (!sha || !objectExists(cwd, sha)) return { ok: false, lost: true, reason: "контрольная точка потеряна" };
  const paths = rollbackPaths({ cwd, produces, ownChanges });
  try {
    for (const rel of paths) {
      if (existsInCheckpoint(cwd, sha, rel)) {
        execFileSync("git", ["checkout", sha, "--", rel], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        // A file created after the checkpoint is not touched by checkout, so
        // explicitly remove it from both the working tree and index.
        fs.rmSync(path.join(cwd, rel), { force: true });
        try { execFileSync("git", ["rm", "--cached", "--ignore-unmatch", "--", rel], { cwd, stdio: "ignore" }); } catch {}
      }
    }
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, lost: false, reason: String(err?.message || err) };
  }
}
