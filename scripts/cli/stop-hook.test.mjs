// Unit tests for the HANDOFF guard (`cli.mjs stop-hook`, issue #59).
//
// Two judgements, tested separately:
//   auditPlans(cwd, sinceMs, isTaskDone, phaseOf) — freshness, over real file
//     mtimes: plan folders in a temp dir, stamped with utimesSync (no clock
//     waiting, no fs mocking).
//   batonComplaints(body, phase) — substance: is the fresh text a baton at all,
//     or a receipt / a parrot of the phase title.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditPlans, auditTasks, batonComplaints } from "./stop-hook.mjs";

// A session that started at T; mutations after it are "this session's work".
const SESSION_START = Date.parse("2026-07-14T12:00:00Z");
const at = (iso) => Date.parse(iso);

// A baton that passes every substance check — used wherever a test is about
// freshness and the content must not get in the way.
const GOOD_BATON =
  "phase 1 done; hook.mjs truncates vision at 500 chars, that's the real leak; next: lift the cap in phases.mjs";

let root;

// Write `file` with `content` and stamp its mtime at `ms`.
function put(file, content, ms) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const s = ms / 1000;
  utimesSync(file, s, s);
}

// A plan folder with one phase file; `handoffAt`/`handoffText` add a HANDOFF.md,
// and `task` writes the README's `CC-task: #N` link.
function plan(slug, { phaseAt, handoffAt = null, handoffText = GOOD_BATON, task = null } = {}) {
  const dir = path.join(root, ".claude", "phases", slug);
  put(path.join(dir, "Phase-1.md"), "# Phase 1: Do the thing\n\n- [x] 1.1 step\n", phaseAt);
  if (task != null) {
    put(path.join(dir, "README.md"), `# ${slug}\n\nCC-task: #${task}\n`, phaseAt);
  }
  if (handoffAt != null) {
    put(
      path.join(dir, "HANDOFF.md"),
      `# Handoff (2026-07-14)\n\n${handoffText}\n`,
      handoffAt,
    );
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "phases-guard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("auditPlans — freshness", () => {
  it("stays silent when the project has no plans at all", () => {
    expect(auditPlans(root, SESSION_START)).toEqual([]);
  });

  it("stays silent when the session never touched the plan", () => {
    // Phase written BEFORE the session started, and no handoff since — that's a
    // plan left stale by an earlier session, not this session's debt.
    plan("Old-plan", { phaseAt: at("2026-07-13T09:00:00Z") });
    expect(auditPlans(root, SESSION_START)).toEqual([]);
  });

  it("flags a plan whose phase was touched with no handoff at all", () => {
    plan("Fresh-work", { phaseAt: at("2026-07-14T14:31:00Z") });
    const found = auditPlans(root, SESSION_START);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ slug: "Fresh-work", kind: "stale", handoffAt: null });
  });

  it("flags a plan whose handoff predates this session's mutation", () => {
    plan("Stale-baton", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T12:05:00Z"),
    });
    const found = auditPlans(root, SESSION_START);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ slug: "Stale-baton", kind: "stale" });
  });

  it("clears a plan whose handoff was written after the mutation and carries content", () => {
    plan("Good-citizen", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T14:40:00Z"),
    });
    expect(auditPlans(root, SESSION_START)).toEqual([]);
  });

  it("skips a plan whose tracker task is done (the work has no next session)", () => {
    // Also the SessionStart hook's own markPlanDoneForDoneTasks rewrite: it ticks
    // such a plan's phase files, which would otherwise read as session work.
    plan("Finished", { phaseAt: at("2026-07-14T14:31:00Z"), task: 42 });
    expect(auditPlans(root, SESSION_START, (n) => n === 42)).toEqual([]);
    expect(auditPlans(root, SESSION_START, () => false)).toHaveLength(1);
  });

  it("reports each touched plan separately when a project has several", () => {
    plan("Plan-A", { phaseAt: at("2026-07-14T13:00:00Z") });
    plan("Plan-B", {
      phaseAt: at("2026-07-14T13:10:00Z"),
      handoffAt: at("2026-07-14T13:20:00Z"),
    });
    plan("Plan-C", { phaseAt: at("2026-07-14T15:00:00Z") });
    const slugs = auditPlans(root, SESSION_START).map((p) => p.slug).sort();
    expect(slugs).toEqual(["Plan-A", "Plan-C"]); // B's baton is fresh and real
  });

  it("names the most recently touched phase file", () => {
    const dir = plan("Multi-phase", { phaseAt: at("2026-07-14T13:00:00Z") });
    put(path.join(dir, "Phase-2.md"), "# Phase 2: Later\n", at("2026-07-14T15:45:00Z"));
    const found = auditPlans(root, SESSION_START);
    expect(found[0].file).toBe("Phase-2.md");
    expect(found[0].mutatedAt).toBe(at("2026-07-14T15:45:00Z"));
  });

  it("ignores a plan folder with no phase files (a plan skeleton)", () => {
    const dir = path.join(root, ".claude", "phases", "Empty-plan");
    put(path.join(dir, "README.md"), "# Empty\n\nCC-task: #7\n", at("2026-07-14T14:00:00Z"));
    expect(auditPlans(root, SESSION_START)).toEqual([]);
  });
});

describe("auditPlans — substance of a FRESH baton", () => {
  it("flags a fresh but empty-calorie baton as weak, not stale", () => {
    plan("Receipt", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T14:40:00Z"),
      handoffText: "phase 1 done",
    });
    const found = auditPlans(root, SESSION_START);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("weak");
    expect(found[0].complaints.length).toBeGreaterThan(0);
  });

  it("flags a baton that only parrots the phase's own title", () => {
    plan("Parrot", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T14:40:00Z"),
      // Long enough, has a next-step word and a locator — but says only what
      // Phase-1.md already says.
      handoffText: "Do the thing",
    });
    const found = auditPlans(root, SESSION_START, () => false, () => ({
      title: "Do the thing",
      desc: "",
    }));
    expect(found[0].kind).toBe("weak");
    expect(found[0].complaints.join(" ")).toMatch(/restates the phase/);
  });

  it("lets a real baton through", () => {
    plan("Real", {
      phaseAt: at("2026-07-14T14:31:00Z"),
      handoffAt: at("2026-07-14T14:40:00Z"),
    });
    expect(
      auditPlans(root, SESSION_START, () => false, () => ({ title: "Do the thing", desc: "" })),
    ).toEqual([]);
  });
});

describe("auditTasks", () => {
  const iso = (h) => new Date(at(`2026-07-14T${h}:00Z`)).toISOString();
  // A task this session touched: `updated_at` after the session start.
  const task = (over = {}) => ({
    id: "id-1",
    number: 59,
    subject: "Guard свежести HANDOFF",
    description: "",
    project: "tracker",
    status: "review",
    updated_at: iso("14:31"),
    handoff: GOOD_BATON,
    handoff_at: iso("14:40"),
    ...over,
  });

  it("clears a submitted task that left a real, freshly written baton", () => {
    expect(auditTasks([task()], "tracker", SESSION_START)).toEqual([]);
  });

  it("flags a task moved to review with no handoff", () => {
    const found = auditTasks(
      [task({ handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ number: 59, kind: "submitted", stale: true, hadBaton: false });
  });

  it("flags a baton left by an EARLIER session (updated_at is not enough)", () => {
    // The trap the dedicated handoff_at stamp exists for: any edit bumps
    // updated_at, so an old baton on a task touched today would look fresh.
    const found = auditTasks(
      [task({ handoff_at: iso("09:00") })], // before SESSION_START (12:00)
      "tracker",
      SESSION_START,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ stale: true, hadBaton: true });
  });

  it("flags a task left in_progress as unfinished work owing a baton", () => {
    const found = auditTasks(
      [task({ status: "in_progress", handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
    );
    expect(found[0].kind).toBe("unfinished");
  });

  it("flags a fresh task baton that is only a receipt", () => {
    const found = auditTasks(
      [task({ handoff: "готово" })],
      "tracker",
      SESSION_START,
    );
    expect(found[0]).toMatchObject({ stale: false, kind: "submitted" });
    expect(found[0].complaints.length).toBeGreaterThan(0);
  });

  it("flags a task baton that just parrots the task's own subject", () => {
    const found = auditTasks([task({ handoff: "Guard свежести HANDOFF" })], "tracker", SESSION_START);
    expect(found[0].complaints.join(" ")).toMatch(/restates/);
  });

  it("ignores a task the session never touched, and one it merely re-prioritized", () => {
    const untouched = task({ id: "old", updated_at: iso("09:00"), handoff: "", handoff_at: undefined });
    const backlog = task({ id: "b", number: 22, status: "backlog", handoff: "", handoff_at: undefined });
    expect(auditTasks([untouched, backlog], "tracker", SESSION_START)).toEqual([]);
  });

  it("ignores tasks of another project", () => {
    const other = task({ project: "some-other-app", handoff: "", handoff_at: undefined });
    expect(auditTasks([other], "tracker", SESSION_START)).toEqual([]);
  });

  it("honours the mode: off / submitted / unfinished / both", () => {
    const submitted = task({ id: "s", number: 1, status: "review", handoff: "", handoff_at: undefined });
    const unfinished = task({ id: "u", number: 2, status: "in_progress", handoff: "", handoff_at: undefined });
    const all = [submitted, unfinished];
    const nums = (mode) => auditTasks(all, "tracker", SESSION_START, mode).map((t) => t.number);
    expect(nums("off")).toEqual([]);
    expect(nums("submitted")).toEqual([1]);
    expect(nums("unfinished")).toEqual([2]);
    expect(nums("both")).toEqual([1, 2]);
  });
});

describe("batonComplaints", () => {
  const phase = { title: "Wire the Stop hook", desc: "block a stop with a stale baton" };

  it("accepts a baton with substance, a next step and an anchor", () => {
    expect(batonComplaints(GOOD_BATON, phase)).toEqual([]);
  });

  it("rejects an empty baton", () => {
    expect(batonComplaints("   \n ", phase)).toEqual(["it is empty"]);
  });

  it("rejects a one-line receipt", () => {
    const c = batonComplaints("done", phase);
    expect(c.join(" ")).toMatch(/receipt, not a baton/);
  });

  it("rejects a long note that never says what comes next", () => {
    const c = batonComplaints(
      "Reworked the parser in phases.mjs and cleaned up a few things along the way.",
      phase,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/no next step/);
  });

  it("rejects a forward-looking note with nothing concrete in it", () => {
    const c = batonComplaints(
      "Made good progress on the work; some issues remain, next session should continue where this left off.",
      phase,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/nothing concrete/);
  });

  it("takes a file, a code span, a task ref or a locator as concrete", () => {
    const forward = (anchor) =>
      batonComplaints(`Reworked the guard, next: pick up ${anchor} and finish it off.`, phase);
    expect(forward("src-tauri/src/lib.rs")).toEqual([]);
    expect(forward("`wire_hook_event`")).toEqual([]);
    expect(forward("t#84")).toEqual([]);
    expect(forward("subphase 2.3")).toEqual([]);
  });

  it("accepts a Russian baton (the next-step marker isn't English-only)", () => {
    expect(
      batonComplaints(
        "Фаза 1 закрыта: guard читает mtime, окно берём из транскрипта; далее — прогнать stop-hook.mjs на живой сессии.",
        phase,
      ),
    ).toEqual([]);
  });

  it("skips the parroting check when the plan has no current phase (it just finished)", () => {
    // A finished plan has no `current` — nothing to parrot, so only the generic
    // checks apply and a real baton still passes.
    expect(batonComplaints(GOOD_BATON, null)).toEqual([]);
  });
});
