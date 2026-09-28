import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { bestAttempt, restoreCheckpoint } from "./checkpoint.mjs";
import { snapshotTree } from "./red-gate.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (cwd, rel, text) => { mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); writeFileSync(path.join(cwd, rel), text); };

describe("checkpoint rollback", () => {
  it("restores the best snapshot, removes later files, and creates no refs", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "cut-checkpoint-"));
    try {
      git(cwd, ["init", "-q"]); git(cwd, ["config", "core.autocrlf", "false"]); git(cwd, ["config", "user.email", "test@example.com"]); git(cwd, ["config", "user.name", "Test"]);
      write(cwd, "src/kept.mjs", "base\n"); write(cwd, "unrelated.txt", "leave me\n");
      git(cwd, ["add", "-A"]); git(cwd, ["commit", "-qm", "base"]);
      write(cwd, "src/kept.mjs", "best\n");
      const best = snapshotTree(cwd).sha;
      const refsBefore = git(cwd, ["for-each-ref"]);
      write(cwd, "src/kept.mjs", "worse\n"); write(cwd, "src/new.mjs", "new\n"); write(cwd, "unrelated.txt", "still leave me\n");

      const restored = restoreCheckpoint({ cwd, sha: best, produces: ["src/kept.mjs"], ownChanges: [{ path: "src/new.mjs" }] });
      expect(restored).toEqual(expect.objectContaining({ ok: true, paths: ["src/kept.mjs", "src/new.mjs"] }));
      expect(readFileSync(path.join(cwd, "src/kept.mjs"), "utf8")).toBe("best\n");
      expect(existsSync(path.join(cwd, "src/new.mjs"))).toBe(false);
      expect(readFileSync(path.join(cwd, "unrelated.txt"), "utf8")).toBe("still leave me\n");
      expect(git(cwd, ["for-each-ref"])).toBe(refsBefore);
      expect(git(cwd, ["for-each-ref", "--format=%(objectname)"])).not.toContain(best);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("keeps the earlier attempt when blocking counts tie", () => {
    const first = { attempt: 1, reviewed: true, counts: { critical: 0, high: 1 } };
    expect(bestAttempt([first, { attempt: 2, reviewed: true, counts: { critical: 1, high: 0 } }])).toBe(first);
  });

  it("does not consider an unreviewed attempt a best checkpoint", () => {
    const reviewed = { attempt: 2, reviewed: true, counts: { critical: 0, high: 1 } };
    expect(bestAttempt([
      { attempt: 1, reviewed: false, counts: { critical: 0, high: 0 } },
      reviewed,
    ])).toBe(reviewed);
  });

  it("keeps a legacy reviewed checkpoint that predates the reviewed flag", () => {
    const legacyReviewed = {
      attempt: 1,
      counts: { critical: 0, high: 0 },
      findings: [],
      snapshot: "legacy-snapshot",
    };
    expect(bestAttempt([
      legacyReviewed,
      { attempt: 2, reviewed: true, counts: { critical: 0, high: 1 } },
    ])).toBe(legacyReviewed);
  });

  it("reports a pruned checkpoint as lost", () => {
    expect(restoreCheckpoint({ cwd: process.cwd(), sha: "0000000000000000000000000000000000000000" })).toEqual(expect.objectContaining({ ok: false, lost: true, reason: "контрольная точка потеряна" }));
  });
});
