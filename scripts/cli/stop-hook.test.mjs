// Unit tests for the HANDOFF guard (`cli.mjs stop-hook`, issue #59).
//
// Two judgements, tested separately:
//   auditTasks(todos, project, sinceMs, movedBy, mode) — which tasks this
//     session owes a baton for, and whether the baton is fresh (`handoff_at`).
//   batonComplaints(body, own) — substance: is the fresh text a baton at all,
//     or a receipt / a parrot of the task's own subject.
// (The plan/phases half of the guard was removed with the phases entity, t#254.)

import { describe, it, expect } from "vitest";
import { auditTasks, batonComplaints, parseSessionMoves } from "./stop-hook.mjs";

// A session that started at T; mutations after it are "this session's work".
const SESSION_START = Date.parse("2026-07-14T12:00:00Z");
const at = (iso) => Date.parse(iso);

// A baton that passes every substance check — used wherever a test is about
// freshness and the content must not get in the way.
const GOOD_BATON =
  "task closed; hook.mjs truncates vision at 500 chars, that's the real leak; next: lift the cap in todos.mjs";

describe("auditTasks", () => {
  const iso = (h) => new Date(at(`2026-07-14T${h}:00Z`)).toISOString();
  // A task this session left in review with a fresh, real baton.
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
  // The transcript-derived signal "this session set task #59 to <status>".
  const moved = (status = "review", ref = "59") => new Map([[ref, new Set([status])]]);

  it("clears a submitted task that left a real, freshly written baton", () => {
    expect(auditTasks([task()], "tracker", SESSION_START, moved())).toEqual([]);
  });

  it("flags a task this session moved to review with no handoff", () => {
    const found = auditTasks(
      [task({ handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
      moved(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ number: 59, kind: "submitted", stale: true, hadBaton: false });
  });

  it("flags a baton left by an EARLIER session (handoff_at is not enough)", () => {
    // This session made the transition, but the only baton on the task predates
    // the session — its own findings never made it in.
    const found = auditTasks(
      [task({ handoff_at: iso("09:00") })], // before SESSION_START (12:00)
      "tracker",
      SESSION_START,
      moved(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ stale: true, hadBaton: true });
  });

  it("flags a task this session left in_progress as unfinished work", () => {
    const found = auditTasks(
      [task({ status: "in_progress", handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
      moved("in_progress"),
    );
    expect(found[0].kind).toBe("unfinished");
  });

  it("matches the moved task by id as well as number", () => {
    const found = auditTasks(
      [task({ handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
      moved("review", "id-1"),
    );
    expect(found).toHaveLength(1);
  });

  it("flags a fresh task baton that is only a receipt", () => {
    const found = auditTasks([task({ handoff: "готово" })], "tracker", SESSION_START, moved());
    expect(found[0]).toMatchObject({ stale: false, kind: "submitted" });
    expect(found[0].complaints.length).toBeGreaterThan(0);
  });

  it("flags a task baton that just parrots the task's own subject", () => {
    const found = auditTasks([task({ handoff: "Guard свежести HANDOFF" })], "tracker", SESSION_START, moved());
    expect(found[0].complaints.join(" ")).toMatch(/restates/);
  });

  it("ignores a review task this session never moved, even without a baton (#219)", () => {
    // The core fix: the task is in review with no fresh baton, but THIS session
    // never ran set-status on it — an earlier/other session did. Absent from the
    // transcript-derived map → out of the gate.
    const found = auditTasks(
      [task({ handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
      new Map(), // this session moved nothing
    );
    expect(found).toEqual([]);
  });

  it("ignores a task this session moved into a DIFFERENT status than it now has", () => {
    // Session set it to in_progress; another session then pushed it to review.
    // We didn't make the review transition, so no baton is owed for it.
    const found = auditTasks(
      [task({ status: "review", handoff: "", handoff_at: undefined })],
      "tracker",
      SESSION_START,
      moved("in_progress"),
    );
    expect(found).toEqual([]);
  });

  it("ignores tasks of another project", () => {
    const other = task({ project: "some-other-app", handoff: "", handoff_at: undefined });
    expect(auditTasks([other], "tracker", SESSION_START, moved())).toEqual([]);
  });

  it("honours the mode: off / submitted / unfinished / both", () => {
    const submitted = task({ id: "s", number: 1, status: "review", handoff: "", handoff_at: undefined });
    const unfinished = task({ id: "u", number: 2, status: "in_progress", handoff: "", handoff_at: undefined });
    const all = [submitted, unfinished];
    const mv = new Map([
      ["1", new Set(["review"])],
      ["2", new Set(["in_progress"])],
    ]);
    const nums = (mode) => auditTasks(all, "tracker", SESSION_START, mv, mode).map((t) => t.number);
    expect(nums("off")).toEqual([]);
    expect(nums("submitted")).toEqual([1]);
    expect(nums("unfinished")).toEqual([2]);
    expect(nums("both")).toEqual([1, 2]);
  });
});

describe("parseSessionMoves", () => {
  // One transcript line = a Bash tool_use whose command runs the tracker CLI.
  const line = (command) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    });

  it("extracts a set-status transition keyed by the ref the command used", () => {
    const raw = line(`cd "/x" && node scripts/cli.mjs todos set-status 84 in_progress`);
    const moved = parseSessionMoves(raw);
    expect(moved.get("84")).toEqual(new Set(["in_progress"]));
  });

  it("accumulates every status a task was set to, and strips a leading #", () => {
    const raw = [
      line(`node scripts/cli.mjs todos set-status #59 in_progress`),
      line(`node scripts/cli.mjs todos set-status 59 review`),
    ].join("\n");
    const moved = parseSessionMoves(raw);
    expect(moved.get("59")).toEqual(new Set(["in_progress", "review"]));
  });

  it("keys a uuid ref too", () => {
    const raw = line(`node cli.mjs todos set-status aa0d4a5e-0000 done`);
    expect(parseSessionMoves(raw).get("aa0d4a5e-0000")).toEqual(new Set(["done"]));
  });

  it("ignores a set-status string not run through the CLI (a stray echo)", () => {
    const raw = line(`echo "run: todos set-status 5 review"`);
    expect(parseSessionMoves(raw).size).toBe(0);
  });

  it("is empty on junk / no moves", () => {
    expect(parseSessionMoves("").size).toBe(0);
    expect(parseSessionMoves("not json\n{bad").size).toBe(0);
    expect(parseSessionMoves(line(`node cli.mjs todos list`)).size).toBe(0);
  });
});

describe("batonComplaints", () => {
  const own = { title: "Wire the Stop hook", desc: "block a stop with a stale baton" };

  it("accepts a baton with substance, a next step and an anchor", () => {
    expect(batonComplaints(GOOD_BATON, own)).toEqual([]);
  });

  it("rejects an empty baton", () => {
    expect(batonComplaints("   \n ", own)).toEqual(["it is empty"]);
  });

  it("rejects a one-line receipt", () => {
    const c = batonComplaints("done", own);
    expect(c.join(" ")).toMatch(/receipt, not a baton/);
  });

  it("rejects a long note that never says what comes next", () => {
    const c = batonComplaints(
      "Reworked the parser in todos.mjs and cleaned up a few things along the way.",
      own,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/no next step/);
  });

  it("rejects a forward-looking note with nothing concrete in it", () => {
    const c = batonComplaints(
      "Made good progress on the work; some issues remain, next session should continue where this left off.",
      own,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/nothing concrete/);
  });

  it("takes a file, a code span, a task ref or a locator as concrete", () => {
    const forward = (anchor) =>
      batonComplaints(`Reworked the guard, next: pick up ${anchor} and finish it off.`, own);
    expect(forward("src-tauri/src/lib.rs")).toEqual([]);
    expect(forward("`wire_hook_event`")).toEqual([]);
    expect(forward("t#84")).toEqual([]);
    expect(forward("section 2.3")).toEqual([]);
  });

  it("rejects a baton that only parrots the task's own subject", () => {
    const c = batonComplaints("Wire the Stop hook", own);
    expect(c.join(" ")).toMatch(/restates the task/);
  });

  it("accepts a Russian baton (the next-step marker isn't English-only)", () => {
    expect(
      batonComplaints(
        "Задача закрыта: guard читает handoff_at, окно берём из транскрипта; далее — прогнать stop-hook.mjs на живой сессии.",
        own,
      ),
    ).toEqual([]);
  });

  it("skips the parroting check when no own text is supplied", () => {
    expect(batonComplaints(GOOD_BATON, null)).toEqual([]);
  });
});
