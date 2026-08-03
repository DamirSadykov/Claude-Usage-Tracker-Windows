// Unit tests for `cli todos adoption` (t#315) — the field-run metric.
//
// What is worth pinning here is the metric's HONESTY, because every number it
// prints is an argument about whether the language survives: a scan that
// mistakes echoed text for a real approval, or a declined command for a
// validator refusal, reports adoption that never happened. Each test below is
// one such way of lying, taken from the first live run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { branchOf, scanTranscripts, readJournal, boardSlice, textSizes, THRESHOLD } from "./adoption.mjs";

// A transcript is JSONL of harness entries; these builders write only the
// fields the scan reads.
const use = (id, name, input, ts) => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const result = (id, content, ts, isError = false) => ({
  type: "user",
  timestamp: ts,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
  },
});

const hook = (name, toolUseID, context, ts) => ({
  type: "attachment",
  timestamp: ts,
  attachment: {
    type: "hook_success",
    hookName: name,
    toolUseID,
    stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: context } }),
  },
});

const APPROVED = "User has approved your plan. You can now start coding.";
const REJECTED = "The user doesn't want to proceed with this tool use.";

describe("the transcript scan", () => {
  let root;
  const write = (session, entries) =>
    writeFileSync(path.join(root, "proj", session + ".jsonl"), entries.map((e) => JSON.stringify(e)).join("\n"));

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "adoption-"));
    mkdirSync(path.join(root, "proj"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const since = "2026-08-01T00:00:00.000Z";
  const at = (m) => `2026-08-02T10:${m}:00.000Z`;

  it("counts a plan by the verdict of ITS OWN call", () => {
    write("s1", [
      use("plan-1", "ExitPlanMode", { plan: "change: X" }, at("00")),
      result("plan-1", APPROVED, at("01")),
    ]);
    const scan = scanTranscripts(since, root);
    expect(scan.plans).toHaveLength(1);
    expect(scan.plans[0].verdict).toBe("approved");
  });

  // The failure that made the first live run overstate the ritual: the harness's
  // approval sentence turns up inside ordinary tool output whenever a session
  // reads a transcript or greps a fixture. Without the tool-use link those read
  // as four approvals of plans that were never written.
  it("does not read an echoed approval as a plan being approved", () => {
    write("s2", [
      use("bash-1", "Bash", { command: "grep -r approved ." }, at("00")),
      result("bash-1", `matched: ${APPROVED}`, at("01")),
    ]);
    expect(scanTranscripts(since, root).plans).toHaveLength(0);
  });

  it("separates a plan the hook answered from one it stayed silent on", () => {
    write("s3", [
      use("plan-1", "ExitPlanMode", { plan: "change: X" }, at("00")),
      result("plan-1", APPROVED, at("01")),
      hook("PostToolUse:ExitPlanMode", "plan-1", "──────── PLAN · recorded by the tracker ────────", at("02")),
      use("plan-2", "ExitPlanMode", { plan: "change: Y" }, at("03")),
      result("plan-2", APPROVED, at("04")),
    ]);
    const plans = scanTranscripts(since, root).plans;
    expect(plans.map((p) => p.hook)).toEqual(["recorded", ""]);
  });

  it("keeps a rejected plan out of the approved count", () => {
    write("s4", [
      use("plan-1", "ExitPlanMode", { plan: "change: X" }, at("00")),
      result("plan-1", REJECTED, at("01")),
    ]);
    expect(scanTranscripts(since, root).plans[0].verdict).toBe("rejected");
  });

  it("sees the format doc being read, per session", () => {
    write("s5", [
      use("plan-1", "ExitPlanMode", { plan: "change: X" }, at("00")),
      use("read-1", "Read", { file_path: "D:\\repo\\docs\\plan-format.md" }, at("01")),
    ]);
    expect([...scanTranscripts(since, root).formatReads]).toEqual(["s5"]);
  });

  // A declined Bash call never reached the validator. Counting it as a refusal
  // credits the rules with a stop they did not make.
  it("does not count a command the user declined as a validator refusal", () => {
    write("s6", [
      use("bash-1", "Bash", { command: 'node cli.mjs todos apply plan.yaml --go' }, at("00")),
      result("bash-1", "Permission to use Bash with command … has been denied.", at("01"), true),
      use("bash-2", "Bash", { command: 'node cli.mjs todos apply other.yaml' }, at("02")),
      result("bash-2", "refusing: step \"2\" needs \"9\", which is neither a step of this file nor a task", at("03"), true),
    ]);
    const applies = scanTranscripts(since, root).applies;
    expect(applies).toHaveLength(2);
    expect(applies.filter((a) => a.ok === false)).toHaveLength(1);
    expect(applies.find((a) => a.ok === false).head).toMatch(/refusing/);
    expect(applies.find((a) => a.go).ok).toBeNull();
  });

  it("ignores everything older than the window", () => {
    write("s7", [
      use("plan-1", "ExitPlanMode", { plan: "change: X" }, "2026-07-01T10:00:00.000Z"),
      result("plan-1", APPROVED, "2026-07-01T10:01:00.000Z"),
    ]);
    expect(scanTranscripts(since, root).plans).toHaveLength(0);
  });
});

describe("branchOf", () => {
  it("names each ending of the exit hook, including the wording it used to have", () => {
    expect(branchOf("──────── PLAN · recorded by the tracker ────────")).toBe("recorded");
    expect(branchOf("──────── PLAN · record it in the tracker ────────")).toBe("instruction");
    expect(branchOf("──────── PLAN accepted · now record it in the tracker ────────")).toBe("instruction");
    expect(branchOf("──────── PLAN · declared a discussion ────────")).toBe("discussion");
    expect(branchOf("──────── PLAN · not approved ────────")).toBe("not-approved");
  });
});

describe("the exit journal", () => {
  let dir;
  beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), "journal-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the lines inside the window and survives a torn one", () => {
    const file = path.join(dir, "plan-events.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", branch: "recorded" }),
        JSON.stringify({ ts: "2026-08-02T00:00:00.000Z", branch: "silent" }),
        "{ half a line",
      ].join("\n") + "\n",
    );
    const rows = readJournal("2026-08-01T00:00:00.000Z", file);
    expect(rows).toHaveLength(1);
    expect(rows[0].branch).toBe("silent");
  });

  it("is empty, never a throw, when nothing has been journalled yet", () => {
    expect(readJournal("2026-08-01T00:00:00.000Z", path.join(dir, "absent.jsonl"))).toEqual([]);
  });
});

describe("the board slice", () => {
  const task = (n, extra = {}) => ({
    id: `t${n}`,
    number: n,
    subject: `узел ${n}`,
    status: "queue",
    created_at: "2026-08-02T00:00:00.000Z",
    ...extra,
  });

  it("counts produces and verify over steps, leaving change roots out", () => {
    const slice = boardSlice(
      {
        todos: [
          task(1, { change: true }),
          task(2, { produces: ["a.mjs"], verify: "npm run test" }),
          task(3, { produces: [] }),
          task(4, { created_at: "2026-01-01T00:00:00.000Z", produces: ["old.mjs"] }),
        ],
      },
      "2026-08-01T00:00:00.000Z",
    );
    expect(slice.created).toBe(3);
    expect(slice.steps).toBe(2);
    expect(slice.produces).toBe(1);
    expect(slice.verify).toBe(1);
  });

  // Re-apply matches a step to its task by exact subject, so a reworded phrase
  // forks the graph instead of updating it — the whole reason the exit
  // instruction says VERBATIM.
  it("finds steps recorded twice under the same phrase", () => {
    const slice = boardSlice(
      { todos: [task(1, { subject: "Собираю граф" }), task(2, { subject: "собираю  граф" }), task(3)] },
      "2026-08-01T00:00:00.000Z",
    );
    expect(slice.doubles).toHaveLength(1);
    expect(slice.doubles[0].map((t) => t.number)).toEqual([1, 2]);
  });
});

describe("the text sizes", () => {
  // Metric 5 is a ratchet: the injections were cut from 5328 to about 1100 by
  // moving the format into a document, and the way that is lost is one addition
  // at a time. The numbers are read off the live builders so the check cannot go
  // stale against them.
  it("measures the injections as the code stands, not from a note", () => {
    const t = textSizes();
    expect(t.enter).toBeGreaterThan(0);
    expect(t.enter).toBeLessThan(2500);
    expect(t.exit_instruction).toBeLessThan(2500);
    expect(t.format_doc).toBeGreaterThan(t.enter);
  });
});

describe("the §18 threshold", () => {
  it("is the 70% the spec states", () => {
    expect(THRESHOLD).toBe(0.7);
  });
});
