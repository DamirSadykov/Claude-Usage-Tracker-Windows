// Unit tests for the HANDOFF freshness guard (`cli.mjs stop-hook`, issue #59).
//
// The guard's whole judgement is `stalePlans(cwd, sinceMs, isTaskDone)` — a pure
// read over file mtimes — so the tests build real plan folders in a temp dir and
// stamp mtimes with utimesSync (no clock waiting, no mocking of fs).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stalePlans } from "./stop-hook.mjs";

// A session that started at T; mutations after it are "this session's work".
const SESSION_START = Date.parse("2026-07-14T12:00:00Z");
const at = (iso) => Date.parse(iso);

let root;

// Write `file` with `content` and stamp its mtime at `ms`.
function put(file, content, ms) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const s = ms / 1000;
  utimesSync(file, s, s);
}

// A plan folder with one phase file; `opts.handoffAt` adds a HANDOFF.md, and
// `opts.task` writes the README's `CC-task: #N` link.
function plan(slug, { phaseAt, handoffAt = null, task = null } = {}) {
  const dir = path.join(root, ".claude", "phases", slug);
  put(
    path.join(dir, "Phase-1.md"),
    "# Phase 1: Do the thing\n\n- [x] 1.1 step\n",
    phaseAt,
  );
  if (task != null) {
    put(path.join(dir, "README.md"), `# ${slug}\n\nCC-task: #${task}\n`, phaseAt);
  }
  if (handoffAt != null) {
    put(path.join(dir, "HANDOFF.md"), "# Handoff (2026-07-14)\n\nbaton\n", handoffAt);
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "phases-guard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stalePlans", () => {
  it("stays silent when the project has no plans at all", () => {
    expect(stalePlans(root, SESSION_START)).toEqual([]);
  });

  it("stays silent when the session never touched the plan", () => {
    // Phase written BEFORE the session started, and no handoff since — that's a
    // plan left stale by an earlier session, not this session's debt.
    plan("Old-plan", { phaseAt: at("2026-07-13T09:00:00Z") });
    expect(stalePlans(root, SESSION_START)).toEqual([]);
  });

  it("flags a plan whose phase was touched with no handoff at all", () => {
    plan("Fresh-work", { phaseAt: at("2026-07-14T14:31:00Z") });
    const stale = stalePlans(root, SESSION_START);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ slug: "Fresh-work", file: "Phase-1.md", handoffAt: null });
  });

  it("flags a plan whose handoff predates this session's mutation", () => {
    plan("Stale-baton", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T12:05:00Z"),
    });
    const stale = stalePlans(root, SESSION_START);
    expect(stale).toHaveLength(1);
    expect(stale[0].slug).toBe("Stale-baton");
    expect(stale[0].handoffAt).toBe(at("2026-07-14T12:05:00Z"));
  });

  it("clears a plan whose handoff was written after the mutation", () => {
    plan("Good-citizen", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T14:40:00Z"),
    });
    expect(stalePlans(root, SESSION_START)).toEqual([]);
  });

  it("skips a plan whose tracker task is done (the work has no next session)", () => {
    // Also the SessionStart hook's own markPlanDoneForDoneTasks rewrite: it ticks
    // such a plan's phase files, which would otherwise read as session work.
    plan("Finished", { phaseAt: at("2026-07-14T14:31:00Z"), task: 42 });
    expect(stalePlans(root, SESSION_START, (n) => n === 42)).toEqual([]);
    // …and it IS flagged while the task is still open.
    expect(stalePlans(root, SESSION_START, () => false)).toHaveLength(1);
  });

  it("reports each touched plan separately when a project has several", () => {
    plan("Plan-A", { phaseAt: at("2026-07-14T13:00:00Z") });
    plan("Plan-B", {
      phaseAt: at("2026-07-14T13:10:00Z"),
      handoffAt: at("2026-07-14T13:20:00Z"),
    });
    plan("Plan-C", { phaseAt: at("2026-07-14T15:00:00Z") });
    const slugs = stalePlans(root, SESSION_START).map((p) => p.slug).sort();
    expect(slugs).toEqual(["Plan-A", "Plan-C"]); // B's baton is fresh
  });

  it("names the most recently touched phase file", () => {
    const dir = plan("Multi-phase", { phaseAt: at("2026-07-14T13:00:00Z") });
    put(path.join(dir, "Phase-2.md"), "# Phase 2: Later\n", at("2026-07-14T15:45:00Z"));
    const stale = stalePlans(root, SESSION_START);
    expect(stale[0].file).toBe("Phase-2.md");
    expect(stale[0].mutatedAt).toBe(at("2026-07-14T15:45:00Z"));
  });

  it("ignores a plan folder with no phase files (a plan skeleton)", () => {
    const dir = path.join(root, ".claude", "phases", "Empty-plan");
    put(path.join(dir, "README.md"), "# Empty\n\nCC-task: #7\n", at("2026-07-14T14:00:00Z"));
    expect(stalePlans(root, SESSION_START)).toEqual([]);
  });
});
