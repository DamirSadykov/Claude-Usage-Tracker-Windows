// Unit tests for the plan-format guard (`cli.mjs plan-guard`, t#318 + t#325).
//
// Four things are worth pinning, and they are not the same thing:
//   • the DEMAND — since t#325 the language is required of EVERY plan, prose
//     included. What used to be the guard's caution (judge only a text that
//     already looked like the language) is now a choice of message.
//   • the EXIT — `discussion: <reason>` is the one way past the demand, and the
//     reason is what keeps it from being the way past every plan. Both halves
//     are load-bearing: no exit means a session trapped in plan mode, a free
//     exit means the format is optional again.
//   • the WORDING — the refusal repeats the validator verbatim, because the whole
//     point of reusing apply.mjs is that a rule is stated once.
//   • the CONTRACT — the PreToolUse deny payload, and the promise that no input
//     whatsoever makes the hook exit non-zero or print anything but that payload.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planCandidates,
  inspectPlan,
  buildRefusal,
  buildFormatRefusal,
  buildBlankDiscussionRefusal,
  buildContradictionRefusal,
  discussionDeclaration,
  isReason,
  decide,
  planFormatDoc,
} from "./plan-guard.mjs";
import { readDocument, validate } from "./apply.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

const VALID = `change: "CHANGE: приём вебхуков"
vision: |
  Должен появиться приём вебхуков, который не теряет события.
parallel: 2
budget: 25
steps:
  1:
    title: Завожу таблицу событий
    why: |
      Приём обязан отвечать быстро и не зависеть от обработчика.
    produces: [migrations/007_events.sql]
    verify: npm run test:webhook
    kind: auto
  2:
    title: Пишу обработчик очереди
    why: |
      Повторная доставка — норма, поэтому обработчик идемпотентен.
    needs: [1]
    verify: npm run test:queue
    retry: 3
    on-issue: 1
    kind: auto
`;

// `on-issue` with no `retry` — the one error whose sentence is long and specific
// enough that "repeated verbatim" is a real claim about it.
const BROKEN = `change: "CHANGE: приём вебхуков"
vision: |
  Должен появиться приём вебхуков.
budget: 25
steps:
  1:
    title: Завожу таблицу событий
    kind: manual
  2:
    title: Пишу обработчик очереди
    needs: [1]
    on-issue: 1
    kind: manual
`;

const fenced = (yaml, lang = "yaml") => "Вот план:\n\n```" + lang + "\n" + yaml + "```\n";

const exitPlan = (plan) => ({ tool_name: "ExitPlanMode", tool_input: { plan } });

// A discussion as it is actually written: the declaration, then prose that has no
// intention of parsing.
const DISCUSSION = [
  "discussion: разбираю, почему повтор вебхука доходит дважды — работу этим",
  "  планом не завожу, решаем после",
  "",
  "## Что я вижу",
  "Провайдер шлёт повтор через 30 секунд, а транзакция ещё открыта.",
].join("\n");

describe("planCandidates · what reads as a document of the language", () => {
  it("takes a bare document and one inside a fence", () => {
    expect(planCandidates(VALID)).toHaveLength(1);
    expect(planCandidates(fenced(VALID)).length).toBeGreaterThan(0);
  });

  it("takes a document introduced by a paragraph of prose", () => {
    // The parser stops at the first line that is not `key: value`, so the
    // candidate has to be trimmed to start at the document's first key.
    const withPreamble = "Посмотрел код, вот что предлагаю.\n\n" + VALID;
    const [doc] = planCandidates(withPreamble);
    expect(doc.startsWith("change:")).toBe(true);
    expect(readDocument(doc).steps).toHaveLength(2);
  });

  // t#325 lowered the bar from two document keys to one. The reason is the
  // message, not the verdict: a text with a key can be answered in the
  // validator's own sentences, a text without one only in general terms — and
  // both are refused either way now.
  it("takes a one-step plan whose only document key is `steps`", () => {
    const oneStep = "steps:\n  1:\n    task: 318\n    why: |\n      Чиню в приёме.\n";
    expect(planCandidates(oneStep)).toHaveLength(1);
    expect(inspectPlan(oneStep, { onBoard: () => true }).errors).toEqual([]);
    expect(decide(exitPlan(oneStep), { onBoard: () => true })).toBeNull();
  });

  it("reads only column 0 — an indented key belongs to a step, not the document", () => {
    expect(planCandidates("  change: X\n  steps:\n    1:\n      title: Шаг\n")).toEqual([]);
  });

  it("finds nothing in a text that never names a key of the language", () => {
    const prose = ["## План", "", "Разберусь, почему парсер роняет `t#299`, и починю."].join("\n");
    expect(planCandidates(prose)).toEqual([]);
    expect(inspectPlan(prose).attempted).toBe(false);
  });
});

// The half of t#325 that is a real change of behaviour: what used to pass now
// does not. Each of these was an explicit "let it through" before.
describe("decide · the language is required of every plan", () => {
  const refusalFor = (text) => {
    const seen = decide(exitPlan(text));
    expect(seen).not.toBeNull();
    expect(seen.permissionDecision).toBe("deny");
    return seen.permissionDecisionReason;
  };

  it("refuses a prose plan, and names both ways forward", () => {
    const prose = [
      "## План",
      "",
      "Разберусь, почему парсер роняет `t#299`, и починю на месте.",
      "",
      "1. Читаю apply.mjs",
      "2. Чиню dequote",
    ].join("\n");
    const reason = refusalFor(prose);
    expect(reason).toContain("REFUSED");
    // Rewrite it as the file…
    expect(reason).toContain(planFormatDoc());
    // …or say it is not work. A refusal that names only the first is the trap
    // this exit exists to avoid.
    expect(reason).toContain("discussion:");
  });

  it("refuses a quoted CI fragment in the validator's own words", () => {
    // A GitHub Actions job: `steps:` at column 0 and list items with no title.
    // It now reads as a broken document rather than as none, which is the more
    // useful answer — the session is told which rule it broke.
    const ci = fenced("steps:\n  - uses: actions/checkout@v4\n  - run: npm ci\n");
    const reason = refusalFor(ci);
    expect(reason).toContain("title");
  });

  it("refuses a plan that is only a heading", () => {
    expect(refusalFor("# План\n\nПочиню на месте.\n")).toContain("REFUSED");
  });
});

describe("discussion · the one declared way past the demand", () => {
  it("reads the reason off the declaration, including its continuation lines", () => {
    const { reason } = discussionDeclaration(DISCUSSION);
    expect(reason).toContain("повтор вебхука");
    expect(reason).toContain("решаем после");
  });

  it("takes a block scalar as well as an inline value", () => {
    const block = "discussion: |\n  Согласую подход к разбору вебхуков, задач не завожу.\n";
    expect(isReason(discussionDeclaration(block).reason)).toBe(true);
  });

  it("lets a declared discussion through untouched, prose and all", () => {
    expect(decide(exitPlan(DISCUSSION))).toBeNull();
  });

  it("is not a document of the language — it records nothing and parses nothing", () => {
    expect(planCandidates(DISCUSSION)).toEqual([]);
  });

  // The exit has to cost more than a word, or it is the exit from every plan.
  it("refuses the declaration without a reason", () => {
    for (const flag of ["discussion: true\n\n## План\nЧиню.", "discussion:\n\n## План\nЧиню."]) {
      const seen = decide(exitPlan(flag));
      expect(seen.permissionDecision).toBe("deny");
      expect(seen.permissionDecisionReason).toContain("without saying what is being");
    }
  });

  it("refuses a label too short to name anything", () => {
    expect(isReason("это разбор")).toBe(false);
    expect(isReason("разбираю причину дублей")).toBe(true);
    expect(decide(exitPlan("discussion: разбор\n\n## План\nЧиню.")).permissionDecision).toBe("deny");
  });

  // The declaration wins over anything else in the text, so a plan that declares
  // it AND writes steps would lose the steps in silence — approved, recorded
  // nowhere. Refused instead of resolved: the guard has no way to know which
  // half the session meant.
  it("refuses a plan that declares a discussion and still carries steps", () => {
    const both = DISCUSSION + "\n\n" + fenced(VALID);
    const seen = decide(exitPlan(both));
    expect(seen.permissionDecision).toBe("deny");
    expect(seen.permissionDecisionReason).toMatch(/2 step/);
    expect(seen.permissionDecisionReason).toMatch(/dropped in silence/);
  });

  it("reads no `discussion` that is not at column 0", () => {
    // Inside a step it is an unknown key, which `apply` warns about — not a
    // declaration about the whole plan.
    const inStep = "steps:\n  1:\n    title: Шаг\n    discussion: обсуждаем подход к делу\n";
    expect(discussionDeclaration(inStep)).toBeNull();
  });
});

describe("inspectPlan · the verdict", () => {
  it("passes a valid graph file, fenced or bare", () => {
    for (const text of [VALID, fenced(VALID), fenced(VALID, "")]) {
      const seen = inspectPlan(text);
      expect(seen.attempted).toBe(true);
      expect(seen.errors).toEqual([]);
    }
  });

  it("refuses a document that breaks a rule", () => {
    const seen = inspectPlan(BROKEN);
    expect(seen.attempted).toBe(true);
    expect(seen.errors).toHaveLength(1);
  });

  // The format document tells the session to read §1, whose sketch is full of
  // `<placeholders>` that do not validate. A model that pastes it above its real
  // plan must not be locked out of plan mode over the quotation.
  it("passes when ANY reading of the text is a valid graph", () => {
    const sketch =
      "Формат:\n\n```yaml\nchange: \"CHANGE: <name>\"\nvision: |\n  <...>\nparallel: <N>\nbudget: <usd>\nsteps:\n  <n>:\n    title: <the step phrase>\n    needs: [<n>, <n>]\n```\n\nМой план:\n\n" +
      fenced(VALID);
    expect(planCandidates(sketch).length).toBeGreaterThan(1);
    expect(inspectPlan(sketch).errors).toEqual([]);
    expect(decide(exitPlan(sketch))).toBeNull();
  });

  // A reference the file does not declare is legal when the board carries it, and
  // the caller is the one who knows. Unable to read the board → answer yes, never
  // refuse on a check that was not run.
  it("asks the caller whether an outside reference resolves", () => {
    const hanging = BROKEN.replace("needs: [1]", "needs: [t#299]").replace("on-issue: 1", "");
    expect(inspectPlan(hanging, { onBoard: () => true }).errors).toEqual([]);
    expect(inspectPlan(hanging, { onBoard: () => false }).errors).toHaveLength(1);
    expect(inspectPlan(hanging).errors).toEqual([]); // default: forgiving
  });

  it("never throws on garbage", () => {
    for (const text of ["", "   ", " ", "```yaml\n", "change:\nvision:\nsteps:\n"])
      expect(() => inspectPlan(text)).not.toThrow();
  });
});

describe("buildRefusal · one wording, owned by the validator", () => {
  const errors = validate(readDocument(BROKEN)).errors;

  it("repeats the validator's sentence VERBATIM", () => {
    // The claim the guard makes is that its refusal and `todos apply`'s refusal
    // are the same text. Compared against the validator's own output, not a copy.
    expect(errors).toHaveLength(1);
    expect(errors[0].length).toBeGreaterThan(40);
    expect(decide(exitPlan(BROKEN)).permissionDecisionReason).toContain(errors[0]);
  });

  it("says the plan never reached the user, and where the format is", () => {
    const reason = buildRefusal(errors);
    expect(reason).toContain("REFUSED");
    expect(reason).toContain("never reached the user");
    expect(reason).toContain(planFormatDoc());
  });

  it("labels warnings as not being the reason, and omits the block when there are none", () => {
    expect(buildRefusal(["e"], ["w"])).toContain("not the reason");
    expect(buildRefusal(["e"], [])).not.toContain("not the reason");
  });

  // The two refusals t#325 added carry no rule of their own — they carry the
  // ways out. A refusal that names only the format is a session trapped in plan
  // mode; one that names only the exit teaches that prose plus a flag is a plan.
  it("offers the format AND the discussion exit when the plan is not the language", () => {
    const reason = buildFormatRefusal();
    expect(reason).toContain(planFormatDoc());
    expect(reason).toContain("discussion:");
    expect(reason).toMatch(/does NOT start work/i);
    expect(reason).toMatch(/discussion: true` is refused/);
  });

  it("names both halves of the contradiction and what each one does", () => {
    const reason = buildContradictionRefusal(3);
    expect(reason).toContain("3 step(s)");
    expect(reason).toMatch(/records NOTHING/);
    expect(reason).toMatch(/opens the tasks/);
  });

  it("asks for the reason, not for the format, when the declaration is bare", () => {
    const reason = buildBlankDiscussionRefusal();
    expect(reason).toMatch(/what is being/i);
    // …and still says where to go if the plan does start work after all.
    expect(reason).toContain(planFormatDoc());
  });

  // A warning is not a refusal: `auto` with no verify and a change with no budget
  // are accepted by `todos apply`, so the guard must accept them too.
  it("does not refuse a plan whose only findings are warnings", () => {
    const warned = "change: \"CHANGE: X\"\nvision: |\n  Что-то.\nsteps:\n  1:\n    title: Делаю\n    kind: auto\n";
    const seen = inspectPlan(warned);
    expect(seen.errors).toEqual([]);
    expect(seen.warnings.length).toBeGreaterThan(0);
    expect(decide(exitPlan(warned))).toBeNull();
  });
});

describe("decide · the PreToolUse contract", () => {
  it("returns the deny payload Claude Code reads", () => {
    expect(decide(exitPlan(BROKEN))).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });

  it("holds no opinion on a valid plan, an empty plan or a missing payload", () => {
    expect(decide(exitPlan(VALID))).toBeNull();
    expect(decide(exitPlan(""))).toBeNull();
    expect(decide(exitPlan("   \n "))).toBeNull();
    expect(decide({ tool_name: "ExitPlanMode" })).toBeNull();
    expect(decide({})).toBeNull();
    expect(decide(null)).toBeNull();
  });

  it("judges nothing but ExitPlanMode, however broadly it gets wired", () => {
    expect(decide({ tool_name: "Bash", tool_input: { plan: BROKEN } })).toBeNull();
    expect(decide({ tool_name: "Write", tool_input: { plan: BROKEN } })).toBeNull();
  });
});

// End to end through the dispatcher, because the promise "a hook never breaks a
// session" is about the PROCESS: exit 0 always, and stdout that is either empty
// or exactly one JSON object.
describe("cli.mjs plan-guard · the process", () => {
  const runGuard = (input) =>
    execFileSync(process.execPath, [CLI, "plan-guard"], {
      encoding: "utf8",
      input,
      windowsHide: true,
    });

  it("emits the deny payload for a broken plan and exits 0", () => {
    const out = runGuard(JSON.stringify(exitPlan(BROKEN)));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("on-issue");
    // One object, nothing else — extra stdout would be parsed as part of it.
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("stays silent on a valid plan, on empty stdin and on garbage", () => {
    for (const input of ["", "   ", "not json at all", "[]", "null", JSON.stringify(exitPlan(VALID))])
      expect(runGuard(input)).toBe("");
  });
});
