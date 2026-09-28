import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gitHead,
  gitBase,
  snapshotTree,
  UNTRACKED_SNAPSHOT_LIMIT,
  diffNameStatus,
  computeNeighbourDamage,
  computeRevertSet,
  redTestsChanged,
  markerDir,
  runRedGate,
  recoverMarkers,
} from "./red-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function initRepo(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.safecrlf", "false"]);
  return dir;
}

function write(dir, rel, buf) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, buf);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

const CRLF_TEXT = "function fix() {\r\n  return 1;\r\n}\r\n";
const CRLF_TEXT_FIXED = "function fix() {\r\n  return 2;\r\n}\r\n";
const BINARY_BASE = Buffer.from([0, 1, 2, 253, 254, 255, 10, 13, 0, 9]);
const BINARY_WORKER = Buffer.from([9, 8, 7, 254, 253, 252, 0, 0, 255, 1]);

function appDataDirFor(dir) {
  return path.join(dir, "app-data", "red-gate");
}

describe("red-gate — the mechanics", () => {
  it("red fails on base -> gate passes, worker files restored byte-exact, marker gone", async () => {
    const dir = initRepo("cut-redgate-pass-");
    try {
      write(dir, "src/fix.js", CRLF_TEXT);
      write(dir, "bin/data.bin", BINARY_BASE);
      const base = commitAll(dir, "base");

      write(dir, "src/fix.js", CRLF_TEXT_FIXED);
      write(dir, "bin/data.bin", BINARY_WORKER);
      write(dir, "test/regression.spec.js", "it('repros the bug', () => {})\n");

      const task = {
        id: "task-1",
        number: 1,
        red: "the-red-cmd",
        step_base: base,
        red_tests: ["test/regression.spec.js"],
        produces: ["src/fix.js", "bin/data.bin"],
      };

      const seenDuringRun = {};
      const runCmd = async ({ cmd }) => {
        seenDuringRun.cmd = cmd;
        seenDuringRun.fixDuringRed = readFileSync(path.join(dir, "src/fix.js"));
        seenDuringRun.binDuringRed = readFileSync(path.join(dir, "bin/data.bin"));
        return { code: 1, stdout: "1 failing\n", stderr: "" };
      };

      const appDataDir = appDataDirFor(dir);
      const result = await runRedGate({ task, cwd: dir, timeoutMs: 5000, appDataDir, runCmd });

      expect(result.ok).toBe(true);
      expect(result.field).toBe("failed-on-base");
      expect(seenDuringRun.cmd).toBe("the-red-cmd");
      expect(seenDuringRun.fixDuringRed.equals(Buffer.from(CRLF_TEXT))).toBe(true);
      expect(seenDuringRun.binDuringRed.equals(BINARY_BASE)).toBe(true);

      expect(readFileSync(path.join(dir, "src/fix.js")).equals(Buffer.from(CRLF_TEXT_FIXED))).toBe(true);
      expect(readFileSync(path.join(dir, "bin/data.bin")).equals(BINARY_WORKER)).toBe(true);
      expect(existsSync(markerDir(appDataDir, task.id))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("red passes on base -> issue, files restored", async () => {
    const dir = initRepo("cut-redgate-issue-");
    try {
      write(dir, "src/fix.js", "base\n");
      const base = commitAll(dir, "base");
      write(dir, "src/fix.js", "worker fixed it\n");
      write(dir, "test/regression.spec.js", "it('repros', () => {})\n");

      const task = {
        id: "task-2",
        number: 2,
        red: "the-red-cmd",
        step_base: base,
        red_tests: ["test/regression.spec.js"],
        produces: ["src/fix.js"],
      };
      const runCmd = async () => ({ code: 0, stdout: "1 passing\n", stderr: "" });
      const appDataDir = appDataDirFor(dir);
      const result = await runRedGate({ task, cwd: dir, timeoutMs: 5000, appDataDir, runCmd });

      expect(result.ok).toBe(false);
      expect(result.field).toBe("passed-on-base");
      expect(result.reason).toContain("does not catch the bug");
      expect(result.reason).toContain("1 passing");
      expect(readFileSync(path.join(dir, "src/fix.js"), "utf8")).toBe("worker fixed it\n");
      expect(existsSync(markerDir(appDataDir, task.id))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("red-tests unchanged since base -> issue without touching the tree", async () => {
    const dir = initRepo("cut-redgate-unchanged-");
    try {
      write(dir, "src/fix.js", "base\n");
      write(dir, "test/regression.spec.js", "it('repros', () => {})\n");
      const base = commitAll(dir, "base");
      write(dir, "src/fix.js", "worker fixed it\n");

      const task = {
        id: "task-3",
        number: 3,
        red: "the-red-cmd",
        step_base: base,
        red_tests: ["test/regression.spec.js"],
        produces: ["src/fix.js"],
      };
      let called = false;
      const runCmd = async () => {
        called = true;
        return { code: 1, stdout: "", stderr: "" };
      };
      const result = await runRedGate({
        task,
        cwd: dir,
        timeoutMs: 5000,
        appDataDir: appDataDirFor(dir),
        runCmd,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/red-tests unchanged since base/);
      expect(called).toBe(false);
      expect(readFileSync(path.join(dir, "src/fix.js"), "utf8")).toBe("worker fixed it\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("a produces entry that is not a real file (an interface string) is ignored", () => {
    const dir = initRepo("cut-redgate-interface-");
    try {
      write(dir, "src/fix.js", "base\n");
      const base = commitAll(dir, "base");
      write(dir, "src/fix.js", "worker fixed it\n");

      const task = {
        id: "task-4",
        red_tests: ["test/regression.spec.js"],
        produces: ["src/fix.js", "the shape of the Foo interface"],
      };
      const set = computeRevertSet(task, dir, base);
      expect(set).toEqual([{ path: "src/fix.js", state: "modified" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no production file in produces changed -> issue, nothing touched", async () => {
    const dir = initRepo("cut-redgate-noprod-");
    try {
      write(dir, "src/fix.js", "base\n");
      write(dir, "test/regression.spec.js", "old\n");
      const base = commitAll(dir, "base");
      write(dir, "test/regression.spec.js", "it('repros', () => {})\n");

      const task = {
        id: "task-5",
        red: "the-red-cmd",
        step_base: base,
        red_tests: ["test/regression.spec.js"],
        produces: ["src/fix.js"],
      };
      let called = false;
      const result = await runRedGate({
        task,
        cwd: dir,
        timeoutMs: 5000,
        appDataDir: appDataDirFor(dir),
        runCmd: async () => {
          called = true;
          return { code: 1 };
        },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/nothing for red to fail against/);
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("handles a worker-added file and a worker-deleted file", async () => {
    const dir = initRepo("cut-redgate-addrm-");
    try {
      write(dir, "src/keep.js", "base keep\n");
      write(dir, "src/removed.js", "base removed\n");
      const base = commitAll(dir, "base");
      write(dir, "src/new.js", "worker added\n");
      execFileSync("git", ["rm", "-q", "src/removed.js"], { cwd: dir });
      write(dir, "test/regression.spec.js", "it('repros', () => {})\n");

      const task = {
        id: "task-6",
        red: "the-red-cmd",
        step_base: base,
        red_tests: ["test/regression.spec.js"],
        produces: ["src/keep.js", "src/new.js", "src/removed.js"],
      };

      const set = computeRevertSet(task, dir, base);
      expect(set.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "src/new.js", state: "added" },
        { path: "src/removed.js", state: "deleted" },
      ]);

      const seenDuringRed = {};
      const runCmd = async () => {
        seenDuringRed.newExists = existsSync(path.join(dir, "src/new.js"));
        seenDuringRed.removedContent = readFileSync(path.join(dir, "src/removed.js"), "utf8");
        return { code: 1, stdout: "", stderr: "" };
      };
      const result = await runRedGate({
        task,
        cwd: dir,
        timeoutMs: 5000,
        appDataDir: appDataDirFor(dir),
        runCmd,
      });

      expect(result.ok).toBe(true);
      expect(seenDuringRed.newExists).toBe(false);
      expect(seenDuringRed.removedContent).toBe("base removed\n");
      expect(readFileSync(path.join(dir, "src/new.js"), "utf8")).toBe("worker added\n");
      expect(existsSync(path.join(dir, "src/removed.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("gitHead fails cleanly on a directory that is not a git work tree", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-redgate-nogit-"));
    try {
      const r = gitHead(dir);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("red-gate — crash recovery", () => {
  it("a killed gate leaves the tree at base; recovery restores the worker's files and removes the marker", async () => {
    const dir = initRepo("cut-redgate-crash-");
    try {
      write(dir, "src/fix.js", "base\n");
      const base = commitAll(dir, "base");
      write(dir, "src/fix.js", "worker fixed it\n");
      write(dir, "test/regression.spec.js", "it('repros', () => {})\n");

      const task = { id: "task-crash", red: "sleep-forever", step_base: base, red_tests: ["test/regression.spec.js"], produces: ["src/fix.js"] };
      const appDataDir = appDataDirFor(dir);
      const child = spawn(
        process.execPath,
        [path.join(HERE, "..", "..", "..", "tests", "fixtures", "red-gate-hang.mjs")],
        {
          cwd: dir,
          env: {
            ...process.env,
            RED_GATE_MODULE: path.join(HERE, "red-gate.mjs"),
            RED_GATE_TASK: JSON.stringify(task),
            RED_GATE_CWD: dir,
            RED_GATE_APPDATA: appDataDir,
          },
          stdio: "ignore",
        },
      );

      const markerFile = path.join(markerDir(appDataDir, task.id), "marker.json");
      const fixFile = path.join(dir, "src/fix.js");
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (existsSync(markerFile) && existsSync(fixFile) && readFileSync(fixFile, "utf8") === "base\n") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(markerFile)).toBe(true);
      expect(readFileSync(fixFile, "utf8")).toBe("base\n");

      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));

      const restored = recoverMarkers({ appDataDir, cwd: dir });
      expect(restored).toEqual([task.id]);
      expect(readFileSync(fixFile, "utf8")).toBe("worker fixed it\n");
      expect(existsSync(markerDir(appDataDir, task.id))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("leaves a marker for a different cwd untouched", () => {
    const dirA = mkdtempSync(path.join(os.tmpdir(), "cut-redgate-recover-a-"));
    const dirB = mkdtempSync(path.join(os.tmpdir(), "cut-redgate-recover-b-"));
    try {
      const appDataDir = appDataDirFor(dirA);
      const dir = markerDir(appDataDir, "elsewhere");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "marker.json"),
        JSON.stringify({ task: "elsewhere", cwd: dirB, base: "x", files: [] }),
      );
      const restored = recoverMarkers({ appDataDir, cwd: dirA });
      expect(restored).toEqual([]);
      expect(existsSync(path.join(dir, "marker.json"))).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("redTestsChanged", () => {
  it("is false when the declared file was never written in the working tree", () => {
    const dir = initRepo("cut-redgate-rtc-");
    try {
      write(dir, "src/a.js", "base\n");
      const base = commitAll(dir, "base");
      expect(redTestsChanged({ red_tests: ["test/never-written.spec.js"] }, dir, base)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true for a brand-new test file that did not exist at base", () => {
    const dir = initRepo("cut-redgate-rtc2-");
    try {
      write(dir, "src/a.js", "base\n");
      const base = commitAll(dir, "base");
      write(dir, "test/new.spec.js", "it()\n");
      expect(redTestsChanged({ red_tests: ["test/new.spec.js"] }, dir, base)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitBase and the revert set", () => {
  it("takes the base from the working tree as the step found it, not from HEAD", async () => {
    const dir = initRepo("cut-redgate-snap-");
    try {
      write(dir, "src/a.js", "v1\n");
      const head = commitAll(dir, "base");
      write(dir, "src/a.js", "v2 from an earlier step\n");

      const snap = gitBase(dir);
      expect(snap.ok).toBe(true);
      expect(snap.sha).not.toBe(head);

      write(dir, "src/a.js", "v3 the fix\n");
      write(dir, "test/r.test.js", "regression\n");
      const task = {
        id: "task-snap",
        number: 7,
        red: "r",
        step_base: snap.sha,
        red_tests: ["test/r.test.js"],
        produces: ["src/a.js"],
      };
      let during;
      const gate = await runRedGate({
        task,
        cwd: dir,
        timeoutMs: 5000,
        appDataDir: appDataDirFor(dir),
        runCmd: async () => {
          during = readFileSync(path.join(dir, "src/a.js"), "utf8");
          return { code: 1, stdout: "", stderr: "" };
        },
      });
      expect(gate.ok).toBe(true);
      expect(during).toBe("v2 from an earlier step\n");
      expect(readFileSync(path.join(dir, "src/a.js"), "utf8")).toBe("v3 the fix\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD on a clean tree", () => {
    const dir = initRepo("cut-redgate-clean-");
    try {
      write(dir, "a.txt", "x\n");
      const head = commitAll(dir, "base");
      expect(gitBase(dir)).toEqual({ ok: true, sha: head });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reverts a produces path that points outside the work tree", () => {
    const dir = initRepo("cut-redgate-out-");
    try {
      write(dir, "a.txt", "x\n");
      const base = commitAll(dir, "base");
      write(dir, "a.txt", "y\n");
      const task = { red_tests: [], produces: ["../outside.txt", "a.txt"] };
      expect(computeRevertSet(task, dir, base).map((f) => f.path)).toEqual(["a.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshotTree", () => {
  it("includes an untracked file, excludes an ignored file, and leaves the real index/HEAD/status untouched", () => {
    const dir = initRepo("cut-snapshot-");
    try {
      write(dir, ".gitignore", "ignored.txt\n");
      write(dir, "tracked.txt", "base\n");
      commitAll(dir, "base");
      write(dir, "untracked.txt", "new\n");
      write(dir, "ignored.txt", "should not appear\n");

      const beforeStatus = git(dir, ["status", "--porcelain"]);
      const beforeHead = git(dir, ["rev-parse", "HEAD"]).trim();

      const snap = snapshotTree(dir);
      expect(snap.ok).toBe(true);
      expect(snap.sha).toBeTruthy();

      const afterStatus = git(dir, ["status", "--porcelain"]);
      const afterHead = git(dir, ["rev-parse", "HEAD"]).trim();
      expect(afterStatus).toBe(beforeStatus);
      expect(afterHead).toBe(beforeHead);

      const files = git(dir, ["ls-tree", "-r", "--name-only", snap.sha]).trim().split(/\r?\n/);
      expect(files).toContain("untracked.txt");
      expect(files).not.toContain("ignored.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps tracked files only when untracked files exceed the limit", () => {
    const dir = initRepo("cut-snapshot-many-");
    try {
      write(dir, "tracked.txt", "base\n");
      commitAll(dir, "base");
      write(dir, "tracked.txt", "changed\n");
      for (let i = 0; i <= UNTRACKED_SNAPSHOT_LIMIT; i += 1) write(dir, `out/f${i}.txt`, "x");

      const snap = snapshotTree(dir);
      expect(snap.ok).toBe(true);
      const files = git(dir, ["ls-tree", "-r", "--name-only", snap.sha]).trim().split(/\r?\n/);
      expect(files).toEqual(["tracked.txt"]);
      expect(git(dir, ["show", `${snap.sha}:tracked.txt`])).toBe("changed\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly outside a git work tree", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cut-snapshot-nogit-"));
    try {
      const r = snapshotTree(dir);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeNeighbourDamage", () => {
  it("separates executor edits from concurrent changes while retaining declared produces", () => {
    const dir = initRepo("cut-damage-outside-");
    try {
      write(dir, "a.txt", "base a\n");
      write(dir, "b.txt", "base b\n");
      const head = commitAll(dir, "base");
      const stepBase = snapshotTree(dir).sha;
      write(dir, "a.txt", "step a\n");
      write(dir, "b.txt", "other session b\n");
      const end = snapshotTree(dir).sha;

      const scoped = computeNeighbourDamage({ cwd: dir, head, stepBase, end, produces: [], edited: ["a.txt"] });
      expect(scoped.own).toEqual([{ status: "M", path: "a.txt" }]);
      expect(scoped.outside).toEqual([{ status: "M", path: "b.txt" }]);
      const legacy = computeNeighbourDamage({ cwd: dir, head, stepBase, end, produces: [], edited: null });
      expect(legacy.own.map((change) => change.path).sort()).toEqual(["a.txt", "b.txt"]);
      expect(legacy.outside).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a path outside produces that an earlier step touched and this step reverted or deleted", () => {
    const dir = initRepo("cut-damage-revert-");
    try {
      write(dir, "src/sum.mjs", "export const sum = (a, b) => a + b + 1;\n");
      const head = commitAll(dir, "base");
      write(dir, "src/sum.mjs", "export const sum = (a, b) => a + b;\n");
      write(dir, "test/sum.regression.test.mjs", "it('sums', () => {})\n");
      const stepBase = snapshotTree(dir).sha;
      write(dir, "src/sum.mjs", "export const sum = (a, b) => a + b + 1;\n");
      rmSync(path.join(dir, "test/sum.regression.test.mjs"));
      write(dir, "src/greet.mjs", "export const greet = () => 'hi';\n");
      const end = snapshotTree(dir).sha;

      const result = computeNeighbourDamage({ cwd: dir, head, stepBase, end, produces: ["src/greet.mjs"] });
      expect(result.ok).toBe(true);
      const paths = result.damaged.map((d) => d.path).sort();
      expect(paths).toEqual(["src/sum.mjs", "test/sum.regression.test.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag a step that only adds its own file", () => {
    const dir = initRepo("cut-damage-ownadd-");
    try {
      write(dir, "src/a.js", "base\n");
      const head = commitAll(dir, "base");
      const stepBase = snapshotTree(dir).sha;
      write(dir, "src/greet.mjs", "export const greet = () => 'hi';\n");
      const end = snapshotTree(dir).sha;

      const result = computeNeighbourDamage({ cwd: dir, head, stepBase, end, produces: ["src/greet.mjs"] });
      expect(result.ok).toBe(true);
      expect(result.damaged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag a prior file the step modified when that path IS in its own produces", () => {
    const dir = initRepo("cut-damage-produces-");
    try {
      write(dir, "src/sum.mjs", "v1\n");
      const head = commitAll(dir, "base");
      write(dir, "src/sum.mjs", "v2 from an earlier step\n");
      const stepBase = snapshotTree(dir).sha;
      write(dir, "src/sum.mjs", "v3 the fix\n");
      const end = snapshotTree(dir).sha;

      const result = computeNeighbourDamage({ cwd: dir, head, stepBase, end, produces: ["src/sum.mjs"] });
      expect(result.ok).toBe(true);
      expect(result.damaged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
