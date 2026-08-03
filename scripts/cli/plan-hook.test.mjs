// Unit tests for the plan-mode ritual hooks (`cli.mjs plan-hook`, t#253).
//
// The pure builders are what's worth testing: the enter format, the exit
// recording instruction (with and without KB warnings), and runMatchPlan's
// contract that the match step is an extra which can never fail the hook.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEnterContext,
  buildExitContext,
  buildDiscussionContext,
  buildRecordedContext,
  approval,
  recordPlan,
  runMatchPlan,
  formatAlreadySent,
  planFormatDoc,
} from "./plan-hook.mjs";
import {
  DOC_FIELDS,
  DSL_DOC_FIELDS,
  DSL_STEP_FIELDS,
  STEP_FIELDS,
  readDocument,
  validate,
} from "./apply.mjs";

describe("buildEnterContext", () => {
  const ctx = buildEnterContext();

  it("asks for the file itself, not for prose to be translated later", () => {
    expect(ctx).toContain("YAML");
    expect(ctx).toContain("one step per task");
    expect(ctx).toContain(planFormatDoc());
  });

  it("names the keys of the language, so the shape is primed before the read", () => {
    for (const key of ["change", "vision", "steps", "title", "why", "needs"])
      expect(ctx).toContain(key);
    for (const field of DSL_STEP_FIELDS) expect(ctx).toContain(field);
  });

  // t#317: the prose is what a later session cannot reconstruct, so it has to
  // survive the move into fields — otherwise the plan becomes a filled-in form.
  it("says where the prose goes instead of dropping it", () => {
    expect(ctx).toMatch(/vision/);
    expect(ctx).toMatch(/why/);
    expect(ctx).toMatch(/risk/i);
  });

  // The guard is the point: a format that is merely asked for gets half-obeyed
  // (t#309), a format that refuses does not.
  it("says a bad plan is refused before the user sees it", () => {
    expect(ctx).toMatch(/REFUSED/);
    expect(ctx).toMatch(/before the user/);
  });

  // t#325: the demand became total, so the injection has to carry the exit with
  // it. A session told "every plan is refused" and not told how a discussion
  // gets out will dress the discussion up as a graph — three tasks nobody asked
  // for, which is worse than the prose the demand was meant to stop.
  it("names the discussion exit together with the demand, and its price", () => {
    expect(ctx).toMatch(/EVERY plan is REFUSED/);
    expect(ctx).toContain("discussion:");
    expect(ctx).toMatch(/reason is required/i);
    expect(ctx).toMatch(/only when true/i);
  });

  it("names the failure mode the plan-mode measurement found: report sections", () => {
    expect(ctx).toContain("Контекст");
  });

  // One wording, and no environment variable behind it: a hook whose text depends
  // on the environment makes every later measurement ask which text was in play.
  it("takes no argument and reads no environment", () => {
    const saved = process.env.PLAN_FORMAT_MODE;
    process.env.PLAN_FORMAT_MODE = "advisory";
    try {
      expect(buildEnterContext()).toBe(ctx);
      expect(buildEnterContext("something-else")).toBe(ctx);
    } finally {
      if (saved === undefined) delete process.env.PLAN_FORMAT_MODE;
      else process.env.PLAN_FORMAT_MODE = saved;
    }
  });
});

// The format itself moved out of the injections and into a file (t#314), so what
// used to be pinned about the TEXT is now pinned about the DOCUMENT: it exists,
// it is reachable at the path both hooks print, it teaches every key the parser
// takes, and the example it shows really parses.
const YAML_BLOCK = /```yaml\n([\s\S]*?)```/g;

describe("the plan-format document", () => {
  const doc = readFileSync(planFormatDoc(), "utf8");

  it("is where both hooks say it is", () => {
    expect(existsSync(planFormatDoc())).toBe(true);
    expect(buildEnterContext("directive")).toContain(planFormatDoc());
    expect(buildExitContext("")).toContain(planFormatDoc());
  });

  it("teaches every key of the language, and only keys the parser takes", () => {
    for (const key of DSL_DOC_FIELDS) expect(doc).toContain(`${key}:`);
    for (const key of DSL_STEP_FIELDS) expect(doc).toContain(`${key}:`);
    expect(doc).toContain("why:");
    const known = new Set([...DOC_FIELDS, ...STEP_FIELDS]);
    const inYaml = [...doc.matchAll(/^\s{2,}([a-z][a-z-]*):/gm)].map((m) => m[1]);
    expect(inYaml.length).toBeGreaterThan(8);
    for (const key of inYaml) expect([...known]).toContain(key);
  });

  it("carries a worked example that the real reader accepts", () => {
    // Three blocks and no more: the shape (§1, placeholders), the one-step plan
    // bound to an existing task (§3, t#324) and the worked example (§4). Each is
    // a different case; a fourth would be the same thing said again.
    const blocks = [...doc.matchAll(YAML_BLOCK)].map((m) => m[1]);
    expect(blocks).toHaveLength(3);
    // The one-step case is a real file of the language, not an illustration:
    // it parses, binds to a task, and breaks no rule.
    const one = readDocument(blocks[1]);
    expect(one.steps).toHaveLength(1);
    expect(one.steps[0].task).toBeTruthy();
    expect(validate(one, { onBoard: () => true }).errors).toEqual([]);
    const parsed = readDocument(blocks.at(-1));
    expect(parsed.steps.length).toBeGreaterThan(3);
    expect(parsed.change).toBeTruthy();
    expect(parsed.vision).toBeTruthy();
    expect(validate(parsed).errors).toEqual([]);
    // …and it shows the things worth showing: declarations, a gate, a loop and a
    // parallel pair, not a list of bare titles.
    expect(parsed.steps.some((s) => s.produces.length && s.verify)).toBe(true);
    expect(parsed.steps.some((s) => s.kind === "manual" && !s.verify)).toBe(true);
    expect(parsed.steps.some((s) => s.onIssue && s.retry)).toBe(true);
    expect(parsed.parallel).toBeTruthy();
    expect(parsed.budget).toBeTruthy();
    const shared = parsed.steps.filter((s) => s.needs.length === 1).map((s) => s.needs[0]);
    expect(new Set(shared).size).toBeLessThan(shared.length);
  });

  // t#317: the prose has to be IN the example, or the example teaches that a
  // plan is a form to fill in. Every step of it says what it rests on.
  it("keeps the reasoning of every step in the example", () => {
    const parsed = readDocument([...doc.matchAll(YAML_BLOCK)].at(-1)[1]);
    expect(parsed.steps.every((s) => s.why.length > 80)).toBe(true);
    // …and the reasoning is prose, not a restatement of the title.
    for (const s of parsed.steps) expect(s.why).not.toBe(s.title);
  });

  // The order exists ONCE, in `needs`. The old `plan:` field held a copy of the
  // ORDER line and rotted the moment an edge changed.
  it("keeps the order in needs alone, with no plan field in sight", () => {
    const parsed = readDocument([...doc.matchAll(YAML_BLOCK)].at(-1)[1]);
    expect(parsed.plan).toBe("");
    expect(parsed.steps.some((s) => s.needs.length)).toBe(true);
  });

  it("names no command the CLI does not have", () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
    const help = execFileSync(process.execPath, [cli, "todos", "--help"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const found = [...doc.matchAll(/<cli> todos ([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(2);
    for (const cmd of new Set(found)) expect(help).toContain(`  ${cmd} `);
  });
});

describe("buildExitContext", () => {
  it("gives the two dry-run/write commands and points at the format", () => {
    const ctx = buildExitContext("");
    expect(ctx).toContain("todos apply");
    expect(ctx).toContain("--go");
    expect(ctx).toContain(planFormatDoc());
    // The instruction names the real bundled CLI path, not a placeholder.
    expect(ctx).toMatch(/node "[^"]*cli\.mjs"/);
  });

  it("says what NOT to do while recording — the failure modes measured", () => {
    const ctx = buildExitContext("");
    expect(ctx).toMatch(/do not re-plan/i);
    // Steps are matched to tasks by their title, so a reworded one forks the
    // graph on the next apply — the instruction has to say so.
    expect(ctx).toMatch(/do not reword/i);
    expect(ctx).toContain("VERBATIM");
  });

  // A one-step plan used to be the exception that had no file: matching by
  // phrase would have duplicated the very task the session sits on. With the
  // binding key (t#324) it is a file like any other, and the instruction must
  // say so — an exception left standing is what keeps the language optional.
  it("sends the one-step plan through apply too, bound to its task", () => {
    const ctx = buildExitContext("");
    expect(ctx).toMatch(/one-step plan is a file too/i);
    expect(ctx).not.toMatch(/no file and no apply/i);
  });

  it("omits the warnings block when the matcher returned nothing", () => {
    expect(buildExitContext("")).not.toContain("KB case-warnings");
    expect(buildExitContext("   \n ")).not.toContain("KB case-warnings");
  });

  it("includes and indents warnings, and asks to persist them as a comment", () => {
    const ctx = buildExitContext("warn A\nwarn B");
    expect(ctx).toContain("KB case-warnings");
    expect(ctx).toContain("  warn A");
    expect(ctx).toContain("  warn B");
    expect(ctx).toContain("todos comment add");
  });
});

// A plan that declared itself a discussion (t#325) leaves plan mode like any
// other, and the hook has to say the one true thing about it: nothing happened.
// The recording instruction would be a lie, and a lie the session can act on —
// `todos apply` over a discussion is how a question becomes tasks.
describe("buildDiscussionContext", () => {
  const ctx = buildDiscussionContext("");

  it("says nothing was recorded, and offers no command to record it", () => {
    expect(ctx).toMatch(/recorded nothing/i);
    expect(ctx).not.toContain("todos apply");
    expect(ctx).not.toContain("--go");
  });

  it("names what turns the discussion back into a plan", () => {
    expect(ctx).toMatch(/plan mode again/i);
    expect(ctx).toMatch(/graph file/i);
  });

  it("still carries KB warnings, which are about the thinking", () => {
    expect(ctx).not.toContain("KB case-warnings");
    const warned = buildDiscussionContext("warn A");
    expect(warned).toContain("KB case-warnings");
    expect(warned).toContain("  warn A");
  });
});

// The exit instruction is the bridge plan -> graph (t#303): the 91-run bridge
// measurement found the TEXT of this instruction to be the only lever that moved
// graph quality, so what it names is a contract, not prose. t#314 changed what
// the text has to CARRY twice over: `todos apply` reads the graph out of a file
// and validates it, and the format of that file lives in a document the hooks
// point at. So the instruction is now three things — where the format is, the
// two commands, and who owns the rules.
describe("buildExitContext · the bridge (t#303, t#314)", () => {
  const ctx = buildExitContext("");

  // The rules moved twice: out of this text into the validator (t#314), and then
  // ahead of it into the guard (t#318) — by the time this fires, the plan has
  // already been refused or accepted. So the instruction states neither.
  it("recites no rule — the guard checked before the user ever saw the plan", () => {
    expect(ctx).not.toMatch(/retry limit/);
    expect(ctx).not.toMatch(/cycle/);
    expect(ctx).not.toMatch(/acyclic/);
  });

  it("recites no field of the language — that is the document's job now", () => {
    // A key spelled out here would be a second place to keep in sync, which is
    // exactly the duplication this task removed.
    for (const key of DSL_STEP_FIELDS.filter((k) => k !== "title"))
      expect(ctx).not.toContain(`${key}:`);
  });

  it("never offers dep add — edges come from `needs` now", () => {
    expect(ctx).not.toContain("dep add");
  });

  it("says a re-apply updates rather than forks the graph", () => {
    expect(ctx).toContain("updates the");
  });

  it("keeps the warnings block pointing at a command that exists", () => {
    const withWarn = buildExitContext("warn A");
    const tail = withWarn.slice(withWarn.indexOf("KB case-warnings"));
    expect(tail).toContain("todos comment add");
  });

  it("stays short — the format is read once, this is repeated per plan", () => {
    // The instruction fires on EVERY exit from plan mode, so its length is the
    // recurring cost. 5328 chars before t#314; a regression past ~1000 means the
    // format is creeping back into the injection. Absolute paths are measured out
    // — they are as long as wherever the tracker happens to be installed.
    const body = ctx.replace(/[A-Za-z]:[\\/][^\s"]+/g, "<path>");
    expect(body.length).toBeLessThan(1000);
  });
});

describe("buildExitContext · commands exist in the real CLI", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
  const help = execFileSync(process.execPath, [cli, "todos", "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const ctx = buildExitContext("");

  // The field list of `set` comes from the CLI itself: `todos set` with no field
  // refuses and prints the table, so the test compares the instruction against
  // the code, not against a copy of the code.
  const fields = (() => {
    let out = "";
    try {
      execFileSync(process.execPath, [cli, "todos", "set"], {
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (e) {
      out = String(e.stderr || "");
    }
    return new Set(
      out
        .split("fields:")[1]
        .split("\n")
        .map((l) => l.trim().split(/\s/)[0])
        .filter(Boolean),
    );
  })();

  it("names no `todos …` invocation the CLI does not have", () => {
    // Single-space-separated lowercase words after the prefix: `apply`,
    // `comment add`, `set plan`… (two+ spaces end the command, they start prose).
    const found = [...ctx.matchAll(/\btodos ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/g)].map(
      (m) => m[1],
    );
    expect(found.length).toBeGreaterThan(0);
    for (const cmd of new Set(found)) {
      if (cmd.startsWith("set ")) expect([...fields]).toContain(cmd.slice(4));
      else expect(help).toContain(`  ${cmd.split(" ")[0]} `);
    }
  });

  // Since t#324 the document teaches no `todos set` at all — the one-step plan
  // is a file like any other, so every declaration arrives through `apply`. What
  // still has to hold: any field it DOES name is spelled the way the CLI spells
  // it, and the commands it names exist.
  it("names every field of `set` the document uses the way the CLI spells it", () => {
    const doc = readFileSync(planFormatDoc(), "utf8");
    const named = new Set(
      [...doc.matchAll(/\bset ([a-z][a-z|-]*)/g)].flatMap((m) => m[1].split("|")),
    );
    for (const f of named) expect([...fields]).toContain(f);
  });

  // The old `set-<field>` verbs are gone (t#310) — not aliased, so a leftover
  // mention in the instruction would be a command that no longer exists.
  it("names no `set-<field>` verb at all", () => {
    expect(ctx).not.toMatch(/\bset-[a-z]/);
  });
});

describe("formatAlreadySent", () => {
  // The one-shot marker is what keeps `prompt` (which fires on EVERY prompt while
  // plan mode is on) from repeating the format, and keeps `enter` quiet when
  // `prompt` already delivered it in the same session.
  it("reports a session already served, and leaves others alone", () => {
    const marker = { "sess-a": "2026-07-26T10:00:00.000Z" };
    expect(formatAlreadySent("sess-a", marker)).toBe(true);
    expect(formatAlreadySent("sess-b", marker)).toBe(false);
  });

  it("treats a missing session id as unserved rather than throwing", () => {
    expect(formatAlreadySent("", {})).toBe(false);
    expect(formatAlreadySent(undefined, {})).toBe(false);
  });

  it("is not fooled by inherited object properties", () => {
    // A session literally named "constructor" must not read as already-served.
    expect(formatAlreadySent("constructor", {})).toBe(false);
    expect(formatAlreadySent("toString", {})).toBe(false);
  });
});

describe("runMatchPlan", () => {
  it("skips silently when no CLI is configured or the plan is empty", () => {
    const boom = () => {
      throw new Error("must not be called");
    };
    expect(runMatchPlan("a plan", "", boom)).toBe("");
    expect(runMatchPlan("", "/kb/cli.mjs", boom)).toBe("");
    expect(runMatchPlan("   ", "/kb/cli.mjs", boom)).toBe("");
  });

  it("passes the plan text as one argv item and formats JSON warnings", () => {
    let seen;
    const out = runMatchPlan(
      "step 1 -> step 2",
      "/kb/cli.mjs",
      (_exe, args) => {
        seen = args;
        return JSON.stringify({
          warnings: [
            { id: "c-1", item: "step 1", cue: "so it went", wanted: "X", lesson: "Y" },
          ],
        });
      },
    );
    expect(out).toContain("c-1");
    expect(out).toContain("Ситуация: so it went");
    expect(out).toContain("→ вывод: Y");
    expect(seen).toContain("match-plan");
    expect(seen).toContain("--json");
    expect(seen[seen.indexOf("--text") + 1]).toBe("step 1 -> step 2");
  });

  it("stays quiet on zero warnings — no block for a clean plan", () => {
    const out = runMatchPlan("a plan", "/kb/cli.mjs", () =>
      JSON.stringify({ warnings: [] }),
    );
    expect(out).toBe("");
  });

  it("returns empty on a matcher failure or unparsable output — never a gate", () => {
    expect(
      runMatchPlan("a plan", "/kb/cli.mjs", () => {
        throw new Error("timeout");
      }),
    ).toBe("");
    expect(runMatchPlan("a plan", "/kb/cli.mjs", () => "not json")).toBe("");
  });
});

// t#321: the hook records the approved plan itself. Two things decide whether it
// may: the harness's verdict in `tool_response`, and whether the plan is a
// document of the language at all.
describe("approval — the harness's own verdict, verbatim", () => {
  // Both wordings are the ones this project's transcripts actually carry
  // (7 ExitPlanMode calls, 19–28 July).
  const APPROVED =
    "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n" +
    "Your plan has been saved to: C:\\Users\\me\\.claude\\plans\\giggly-map.md";
  const REJECTED =
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

  it("reads approval and the path the harness saved the plan to", () => {
    const a = approval({ tool_response: APPROVED });
    expect(a.approved).toBe(true);
    expect(a.savedTo).toMatch(/giggly-map\.md$/);
  });

  it("reads a refusal as a refusal", () => {
    expect(approval({ tool_response: REJECTED }).approved).toBe(false);
  });

  // Silence is not consent: no response, an object shape we don't know, a hook
  // fired for something else — none of them may record a graph.
  it("treats an absent or unreadable response as NOT approved", () => {
    for (const input of [{}, { tool_response: null }, { tool_response: { odd: 1 } }])
      expect(approval(input).approved).toBe(false);
  });

  it("survives a response that arrived as an object", () => {
    expect(approval({ tool_response: { text: APPROVED } }).approved).toBe(true);
  });
});

describe("recordPlan", () => {
  // recordPlan keeps the plan file it recorded, and `keepPlanFile` resolves that
  // directory from APPDATA — so an unguarded test writes into the USER's live
  // app data. It did, for a fortnight: 10 stray fixtures sat next to the real
  // plans and inflated the very count `todos adoption` reports (t#315). Every
  // test that reaches recordPlan points APPDATA at a temp dir.
  let appData;
  const savedAppData = process.env.APPDATA;
  beforeEach(() => {
    appData = mkdtempSync(path.join(os.tmpdir(), "record-plan-"));
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    process.env.APPDATA = savedAppData;
    rmSync(appData, { recursive: true, force: true });
  });

  const PLAN = [
    "Вот план.",
    "",
    "```yaml",
    "change: CHANGE: приём вебхуков",
    "vision: Должен появиться разбор входящих вебхуков.",
    "steps:",
    "  1:",
    "    title: Завожу таблицу событий",
    "    verify: npm test",
    "    kind: auto",
    "  2:",
    "    title: Пишу обработчик",
    "    needs: [1]",
    "```",
  ].join("\n");

  const fakeApply = (calls) => (doc, opts) => {
    calls.push({ doc, opts });
    return {
      ok: true,
      errors: [],
      warnings: [],
      notes: [],
      plan: ["+ change  \"CHANGE: приём вебхуков\"", "+ step 1  \"Завожу таблицу событий\""],
      created: [{ number: 40 }, { number: 41 }],
      root: { number: 40 },
      applied: true,
    };
  };

  it("pulls the document out of the fenced plan and applies it for real", () => {
    const calls = [];
    const out = recordPlan(PLAN, { apply: fakeApply(calls) });
    // Read first, write once: every reading is checked without writing, and only
    // the surviving one is applied.
    expect(calls.filter((c) => c.opts.go)).toHaveLength(1);
    expect(calls.at(-1).opts.go).toBe(true);
    expect(calls.at(-1).doc.steps.map((s) => s.title)).toEqual([
      "Завожу таблицу событий",
      "Пишу обработчик",
    ]);
    expect(out.result.applied).toBe(true);
  });

  // A plan in prose is not a failure — it is the case the instruction still
  // covers, and the hook must fall back to it rather than guess.
  it("returns null when the plan is not a document of the language", () => {
    expect(recordPlan("Просто текст плана, без единого ключа.", { apply: fakeApply([]) })).toBe(null);
  });

  it("returns null when the validator refuses every reading", () => {
    const bad = ["change: CHANGE: X", "steps:", "  1:", "    title: A", "  2:", "    title: B", "    on-issue: 1"].join("\n");
    expect(recordPlan(bad, { apply: () => ({ ok: false, errors: ["nope"] }) })).toBe(null);
  });
});

describe("buildRecordedContext", () => {
  const recorded = {
    doc: { steps: [{}, {}] },
    file: "C:/plans/2026-07-29.yaml",
    result: {
      plan: ["+ step 1  \"A\""],
      notes: ["keep: #7 is done"],
      warnings: ["change without budget"],
      created: [{ number: 40 }, { number: 41 }],
      root: null,
      applied: true,
    },
  };

  it("names the new tasks by number and how to take one", () => {
    const ctx = buildRecordedContext(recorded, "");
    expect(ctx).toContain("#40, #41");
    expect(ctx).toContain("todos take");
    expect(ctx).toContain("2 new step(s)");
  });

  it("does not ask for a second recording", () => {
    const ctx = buildRecordedContext(recorded, "");
    expect(ctx).not.toContain("todos apply");
    expect(ctx).toMatch(/do not record it again/i);
  });

  it("keeps the KB warnings block and the plan file's whereabouts", () => {
    const ctx = buildRecordedContext(recorded, "warn A");
    expect(ctx).toContain("KB case-warnings");
    expect(ctx).toContain("  warn A");
    expect(ctx).toContain("C:/plans/2026-07-29.yaml");
  });
});

// The failure that would cost the most: a plan quoting the format's own example
// above the real plan, and the hook recording the EXAMPLE. The guard is allowed
// to pass such a text on one valid reading; recording is not.
describe("recordPlan · more than one reading", () => {
  // Same isolation as above: recording keeps a file, and it must not be kept in
  // the user's data dir.
  let appData;
  const savedAppData = process.env.APPDATA;
  beforeEach(() => {
    appData = mkdtempSync(path.join(os.tmpdir(), "record-plan-"));
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    process.env.APPDATA = savedAppData;
    rmSync(appData, { recursive: true, force: true });
  });

  const twoFences = [
    "Формат, по которому пишу:",
    "",
    "```yaml",
    "change: CHANGE: образец из документа",
    "steps:",
    "  1:",
    "    title: Шаг образца",
    "```",
    "",
    "А вот сам план:",
    "",
    "```yaml",
    "change: CHANGE: настоящий план",
    "steps:",
    "  1:",
    "    title: Настоящий шаг",
    "```",
  ].join("\n");

  it("records nothing when two different documents can be read", () => {
    const calls = [];
    const apply = (doc, opts) => {
      calls.push(opts.go);
      return { ok: true, applied: !!opts.go, created: [], notes: [], plan: [], warnings: [], root: null };
    };
    expect(recordPlan(twoFences, { apply })).toBe(null);
    // Both were READ, neither was written.
    expect(calls.every((go) => go === false)).toBe(true);
  });

  // The ordinary case reads twice too — the fence, and the whole text trimmed to
  // its first key — and those are the same document. That must not read as
  // ambiguity, or a plain plan would never be recorded.
  it("still records when the two readings are the same document", () => {
    const one = ["Вот план.", "", "```yaml", "change: CHANGE: один", "steps:", "  1:", "    title: Шаг", "```"].join("\n");
    const apply = (doc, opts) => ({
      ok: true,
      applied: !!opts.go,
      created: [],
      notes: [],
      plan: [],
      warnings: [],
      root: null,
    });
    expect(recordPlan(one, { apply })?.result.applied).toBe(true);
  });
});

// The exit journal (t#315). Its whole point is the branches that say NOTHING:
// from outside, a hook that ran and stayed quiet and a hook that was never wired
// look identical — and telling them apart is what the field-run turned on.
describe("the exit journal", () => {
  let dir;
  const payload = (over = {}) =>
    JSON.stringify({
      session_id: "sess-1",
      cwd: "D:\repo",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "change: CHANGE: X\nsteps:\n  1:\n    title: Шаг\n" },
      tool_response: "User has approved your plan.",
      ...over,
    });

  const exitHook = (input) => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
    execFileSync(process.execPath, [cli, "plan-hook", "exit"], {
      input,
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
    const file = path.join(dir, "com.claude-usage-tracker.app", "plan-events.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "plan-events-"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app"), { recursive: true });
    writeFileSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"), JSON.stringify({ version: 1, todos: [] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a line for a plan the user turned down, though it injects nothing", () => {
    const rows = exitHook(payload({ tool_response: "The user doesn't want to proceed with this tool use." }));
    expect(rows).toHaveLength(1);
    expect(rows[0].branch).toBe("silent");
    expect(rows[0].approved).toBe(false);
  });

  // The payload's own shape is the evidence: a harness that stops passing the
  // plan text is diagnosable from the journal alone, without a replay.
  it("records what arrived — the plan size, the keys, the head of the response", () => {
    const rows = exitHook(payload());
    expect(rows[0].plan_chars).toBeGreaterThan(0);
    expect(rows[0].input_keys).toContain("plan");
    expect(rows[0].response_head).toMatch(/approved/);
    expect(rows[0].session).toBe("sess-1");
  });

  it("counts the declarations of a plan it recorded", () => {
    const rows = exitHook(
      payload({
        tool_input: {
          plan: [
            "change: CHANGE: журнал",
            "steps:",
            "  1:",
            "    title: Шаг один",
            "    produces: [a.mjs]",
            "    verify: npm run test",
            "    kind: auto",
            "  2:",
            "    title: Шаг два",
            "    needs: [1]",
          ].join("\n"),
        },
      }),
    );
    expect(rows[0].branch).toBe("recorded");
    expect(rows[0]).toMatchObject({ steps: 2, produces: 1, verify: 1, kind: 1 });
  });

  // A hook that dies leaves the session with nothing at all — no graph and no
  // instruction. The plan is worth more than the recording of it.
  it("falls back to the instruction when recording throws, and says so in the journal", () => {
    // A board that cannot be written: the file's name is taken by a directory,
    // so the atomic tmp+rename fails the way a locked or racing board would.
    rmSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
    mkdirSync(path.join(dir, "com.claude-usage-tracker.app", "todos.json"));
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
    const out = execFileSync(process.execPath, [cli, "plan-hook", "exit"], {
      input: payload(),
      encoding: "utf8",
      env: { ...process.env, APPDATA: dir },
      windowsHide: true,
    });
    expect(out).toContain("record it in the tracker");
    const rows = readFileSync(path.join(dir, "com.claude-usage-tracker.app", "plan-events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows[0].branch).toBe("record-failed");
    expect(rows[0].error).toBeTruthy();
  });
});
