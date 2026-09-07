// Unit tests for the HANDOFF guard (`cli.mjs stop-hook`, issue #59).
//
// Two judgements, tested separately:
//   auditTasks(todos, project, sinceMs, movedBy, mode) — which tasks this
//     session owes a baton for, and whether the baton is fresh (`handoff_at`).
//   batonComplaints(body, own) — substance: is the fresh text a baton at all,
//     or a receipt / a parrot of the task's own subject.
// (The plan/phases half of the guard was removed with the phases entity, t#254.)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
import {
  auditTasks,
  auditSpecAnswers,
  batonComplaints,
  parseSessionMoves,
} from "./stop-hook.mjs";

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

  it("extracts a status transition keyed by the ref the command used", () => {
    const raw = line(`cd "/x" && node scripts/cli.mjs todos set status 84 in_progress`);
    const moved = parseSessionMoves(raw);
    expect(moved.get("84")).toEqual(new Set(["in_progress"]));
  });

  // The command was `set-status` until t#310 renamed it to `set status`, and a
  // transcript written before that is still a real record of a real move.
  it("still reads the pre-t#310 `set-status` spelling", () => {
    const raw = line(`cd "/x" && node scripts/cli.mjs todos set-status 84 in_progress`);
    expect(parseSessionMoves(raw).get("84")).toEqual(new Set(["in_progress"]));
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

// --- the spec-delta guard (t#341) --------------------------------------------
//
// Same two axes as the baton guard, one layer up: is there an answer at all,
// and is it THIS session's. What differs is the scope (closing only) and the
// unit (one answer per addressed section, not one per task).

describe("auditSpecAnswers", () => {
  const iso = (h) => new Date(at(`2026-07-14T${h}:00Z`)).toISOString();
  const NOTE = "раздел про done-gate после этой работы всё ещё описывает её верно";

  const task = (over = {}) => ({
    id: "id-1",
    number: 341,
    subject: "Гард дельты спеки",
    project: "tracker",
    status: "review",
    spec: ["tasks#done-gate"],
    spec_answers: [
      { address: "tasks#done-gate", verdict: "unchanged", note: NOTE, at: iso("14:40") },
    ],
    ...over,
  });
  const moved = (status = "review", ref = "341") => new Map([[ref, new Set([status])]]);
  // Production injects the board's up-walk here; the tests inject the field.
  const own = (t) => (Array.isArray(t.spec) ? t.spec : []);

  it("clears a closing task that answered every section this session", () => {
    expect(auditSpecAnswers([task()], "tracker", SESSION_START, moved(), own)).toEqual([]);
  });

  it("flags a closing task that answered nothing", () => {
    const found = auditSpecAnswers(
      [task({ spec_answers: [] })],
      "tracker",
      SESSION_START,
      moved(),
      own,
    );
    expect(found).toHaveLength(1);
    expect(found[0].owed).toEqual([{ address: "tasks#done-gate", state: "missing" }]);
  });

  it("treats an answer from an EARLIER session as no answer for this work", () => {
    const found = auditSpecAnswers(
      [task({ spec_answers: [{ address: "tasks#done-gate", verdict: "unchanged", note: NOTE, at: iso("09:00") }] })],
      "tracker",
      SESSION_START,
      moved(),
      own,
    );
    expect(found[0].owed).toEqual([
      { address: "tasks#done-gate", state: "stale", verdict: "unchanged" },
    ]);
  });

  it("names only the sections still unanswered when a task addresses several", () => {
    const found = auditSpecAnswers(
      [task({ spec: ["tasks#done-gate", "tasks#model"] })],
      "tracker",
      SESSION_START,
      moved(),
      own,
    );
    expect(found[0].owed).toEqual([{ address: "tasks#model", state: "missing" }]);
  });

  it("ignores a task left in_progress — the guard sits on CLOSING", () => {
    expect(
      auditSpecAnswers(
        [task({ status: "in_progress", spec_answers: [] })],
        "tracker",
        SESSION_START,
        moved("in_progress"),
        own,
      ),
    ).toEqual([]);
  });

  it("ignores a task with no spec link", () => {
    expect(
      auditSpecAnswers([task({ spec: [], spec_answers: [] })], "tracker", SESSION_START, moved(), own),
    ).toEqual([]);
  });

  it("ignores a task THIS session did not move (another session's close)", () => {
    expect(
      auditSpecAnswers([task({ spec_answers: [] })], "tracker", SESSION_START, new Map(), own),
    ).toEqual([]);
  });

  it("ignores another project's board", () => {
    expect(
      auditSpecAnswers([task({ spec_answers: [] })], "other", SESSION_START, moved(), own),
    ).toEqual([]);
  });

  it("stands down entirely when the setting is off", () => {
    expect(
      auditSpecAnswers([task({ spec_answers: [] })], "tracker", SESSION_START, moved(), own, "off"),
    ).toEqual([]);
  });

  it("never blocks on a board whose shape surprises the up-walk", () => {
    const throws = () => {
      throw new Error("boom");
    };
    expect(
      auditSpecAnswers([task({ spec_answers: [] })], "tracker", SESSION_START, moved(), throws),
    ).toEqual([]);
  });
});

// --- end-to-end: the hook as Claude Code actually runs it ---------------------
//
// The unit tests above judge the audit; this one judges the WIRING — that the
// area really loads the board's up-walk and the registry, exits 2, and prints
// the addressed section in full, which is the whole point of putting the guard
// at closing time (README §8). A guard that audits correctly and never fires is
// indistinguishable from no guard.

describe("cli stop-hook — the spec guard end to end", () => {
  let dir;
  let transcript;

  const specMd = [
    "---",
    "id: tasks",
    "version: 1",
    "updated: 2026-08-03",
    "---",
    "",
    "# tasks",
    "",
    "## done-gate — Инварианты закрытия",
    "",
    "part: инварианты",
    "",
    "СТРОКА-МАЯК: перевод в done отклоняется, пока открыт прямой prerequisite.",
    "",
  ].join("\n");

  const board = (...todos) =>
    writeFileSync(
      path.join(dir, "com.claude-usage-tracker.app", "todos.json"),
      JSON.stringify({ version: 1, todos }, null, 2),
    );

  // A transcript whose first record dates the session, and whose Bash tool_use
  // is the attribution signal ("this session moved #1 to review").
  function writeTranscript(startIso) {
    transcript = path.join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "summary", timestamp: startIso }),
        JSON.stringify({
          type: "assistant",
          timestamp: startIso,
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: `node "${cli}" todos set status 1 review` },
              },
            ],
          },
        }),
      ].join("\n"),
    );
  }

  const runHook = () => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [cli, "stop-hook"], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, APPDATA: dir },
          input: JSON.stringify({ cwd: dir, transcript_path: transcript }),
          windowsHide: true,
        }),
      };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  const GOOD_BATON_LOCAL =
    "гард собран; следующий шаг — вкладка Specs в TodoWindow.vue, данные берёт spec.mjs";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-stop-e2e-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    mkdirSync(path.join(dir, "docs", "specs", "tasks"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "specs", "tasks", "spec.md"), specMd);
    writeTranscript(new Date(Date.now() - 60_000).toISOString());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const closing = (extra = {}) => ({
    id: "id-1",
    number: 1,
    subject: "закрываемая задача",
    project: path.basename(dir),
    status: "review",
    spec: ["tasks#done-gate"],
    handoff: GOOD_BATON_LOCAL,
    handoff_at: new Date().toISOString(),
    ...extra,
  });

  it("blocks the stop and prints the addressed section in full", () => {
    board(closing());
    const { code, out } = runHook();
    expect(code).toBe(2);
    expect(out).toMatch(/tasks#done-gate: нет ответа/);
    expect(out).toMatch(/СТРОКА-МАЯК/); // the section itself, not just its address
    expect(out).toMatch(/spec answer 1 unchanged/);
  });

  it("lets the stop through once the section is answered", () => {
    board(
      closing({
        spec_answers: [
          {
            address: "tasks#done-gate",
            verdict: "unchanged",
            note: "инварианты закрытия эта работа не трогала — гард сидит рядом, но done-gate не меняет",
            at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(runHook().code).toBe(0);
  });

  it("reports BOTH a missing baton and a missing spec answer in one block", () => {
    // They cannot be reported one after the other: the hook fires once per stop
    // cycle (`stop_hook_active`), so the second complaint would never be seen.
    board(closing({ handoff: "", handoff_at: undefined }));
    const { code, out } = runHook();
    expect(code).toBe(2);
    expect(out).toMatch(/leaves no usable HANDOFF/);
    expect(out).toMatch(/left the section unanswered/);
  });

  it("stays silent when the guard is switched off in settings", () => {
    writeFileSync(
      path.join(dir, "com.claude-usage-tracker.app", "settings.json"),
      JSON.stringify({ specDeltaGuard: "off" }),
    );
    board(closing());
    expect(runHook().code).toBe(0);
  });
});

// An answer is about the WORK CYCLE — the stretch that starts when the section
// was put in front of the session. An answer older than that was written about
// a different state of the work; anything after it counts, however many times
// the task is moved afterwards (t#356).
describe("auditSpecAnswers — the answer must come after the section was SHOWN", () => {
  const iso = (h) => new Date(at(`2026-07-14T${h}:00Z`)).toISOString();
  const NOTE = "раздел про done-gate после этой работы всё ещё описывает её верно";
  const moved = new Map([["341", new Set(["review"])]]);
  const own = (t) => (Array.isArray(t.spec) ? t.spec : []);

  const task = (answerAt, history, seenAt) => ({
    id: "id-1",
    number: 341,
    subject: "Гард дельты спеки",
    project: "tracker",
    status: "review",
    spec: ["tasks#done-gate"],
    status_history: history,
    ...(seenAt ? { spec_seen: [{ address: "tasks#done-gate", hash: "abc", at: seenAt }] } : {}),
    spec_answers: [
      { address: "tasks#done-gate", verdict: "unchanged", note: NOTE, at: answerAt },
    ],
  });
  const closedAt14 = [
    { status: "in_progress", at: iso("13:00") },
    { status: "review", at: iso("14:00") },
  ];

  it("clears an answer written during the work cycle", () => {
    expect(
      auditSpecAnswers([task(iso("13:30"), closedAt14)], "tracker", SESSION_START, moved, own),
    ).toEqual([]);
  });

  it("flags an answer written BEFORE the work started, even inside this session", () => {
    const found = auditSpecAnswers(
      [task(iso("12:30"), closedAt14)],
      "tracker",
      SESSION_START,
      moved,
      own,
    );
    expect(found[0].owed).toEqual([
      { address: "tasks#done-gate", state: "stale", verdict: "unchanged" },
    ]);
  });

  // The whole point of t#356: answer, close, move again — the guard used to
  // measure from the CURRENT status, so every move demanded a fresh answer
  // about text that had not moved.
  it("a later move does not re-arm the guard", () => {
    const movedTwice = new Map([["341", new Set(["review", "done"])]]);
    const closedThenDone = [
      ...closedAt14,
      { status: "done", at: iso("15:00") },
    ];
    const t = { ...task(iso("13:30"), closedThenDone), status: "done" };
    expect(auditSpecAnswers([t], "tracker", SESSION_START, movedTwice, own)).toEqual([]);
  });

  it("the baseline wins over the status history when both are there", () => {
    // Shown at 13:45, answered at 13:30 — the answer cannot be about a text it
    // had not been given yet, whatever the transition says.
    const found = auditSpecAnswers(
      [task(iso("13:30"), closedAt14, iso("13:45"))],
      "tracker",
      SESSION_START,
      moved,
      own,
    );
    expect(found[0].owed[0].state).toBe("stale");
  });

  it("re-opening the task retires the previous cycle's answer", () => {
    // A new baseline is taken on the way back into in_progress, so the answer
    // from the earlier cycle goes stale by itself — no bookkeeping.
    const found = auditSpecAnswers(
      [task(iso("13:30"), closedAt14, iso("16:00"))],
      "tracker",
      SESSION_START,
      moved,
      own,
    );
    expect(found[0].owed[0].state).toBe("stale");
  });

  it("falls back to the session window when there is nothing to read", () => {
    expect(
      auditSpecAnswers([task(iso("14:30"), undefined)], "tracker", SESSION_START, moved, own),
    ).toEqual([]);
    const found = auditSpecAnswers(
      [task(iso("09:00"), undefined)], // before SESSION_START (12:00)
      "tracker",
      SESSION_START,
      moved,
      own,
    );
    expect(found[0].owed[0].state).toBe("stale");
  });

  it("a task that never reached in_progress is judged against the session", () => {
    // No baseline and no work cycle to point at: the session window is the only
    // honest floor left, not the review transition.
    const straightToReview = [{ status: "review", at: iso("09:00") }];
    const found = auditSpecAnswers(
      [task(iso("10:00"), straightToReview)],
      "tracker",
      SESSION_START,
      moved,
      own,
    );
    expect(found[0].owed[0].state).toBe("stale");
  });

  it("freshness is judged per address, not per task", () => {
    // Two sections shown at different moments; one answer is fresh, the other
    // predates its own baseline.
    const t = {
      id: "id-2",
      number: 341,
      subject: "Две секции",
      project: "tracker",
      status: "review",
      spec: ["tasks#done-gate", "tasks#ui"],
      status_history: closedAt14,
      spec_seen: [
        { address: "tasks#done-gate", hash: "a", at: iso("13:00") },
        { address: "tasks#ui", hash: "b", at: iso("14:30") },
      ],
      spec_answers: [
        { address: "tasks#done-gate", verdict: "unchanged", note: NOTE, at: iso("13:30") },
        { address: "tasks#ui", verdict: "unchanged", note: NOTE, at: iso("13:30") },
      ],
    };
    const found = auditSpecAnswers([t], "tracker", SESSION_START, moved, own);
    expect(found[0].owed).toEqual([
      { address: "tasks#ui", state: "stale", verdict: "unchanged" },
    ]);
  });
});
