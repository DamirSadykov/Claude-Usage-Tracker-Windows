import { describe, expect, it } from "vitest";
import { blockingTasks, commentAttempt, commentSeverity, parseHandoff, reviewOutcome, sessionRoleCosts } from "./taskOverview";

describe("task overview helpers", () => {
  it("splits labelled handoff and preserves unlabelled text", () => {
    expect(parseHandoff("Сделано: UI\nПодвох: cache\nДальше: test")).toMatchObject({ fallback: false, parts: [{ part: "done", text: "UI" }, { part: "gotcha", text: "cache" }, { part: "next", text: "test" }] });
    expect(parseHandoff("carry this whole note")).toEqual({ fallback: true, parts: [{ part: "done", text: "carry this whole note" }] });
  });
  it("takes severity only from architect review prefixes", () => {
    expect(commentSeverity("architect", "[HIGH] Broken flow")).toBe("high");
    expect(commentSeverity("claude", "[high] not a review")).toBeNull();
    expect(commentSeverity("architect", "ARCHITECT attempt 1\n[medium] a\n[high] b")).toBe("high");
    expect(commentSeverity("review", "ISSUE attempt 2/2\nreview model\n- [high] file:1 broken")).toBe("high");
  });
  it("reads the attempt number from the review comment itself", () => {
    expect(commentAttempt("ARCHITECT attempt 1\n[high] x")).toBe(1);
    expect(commentAttempt("ISSUE attempt 2/2")).toBe(2);
    expect(commentAttempt("plain note")).toBeNull();
  });
  it("builds same-project reverse dependencies", () => {
    const todo = { id: "a", project: "p" };
    expect(blockingTasks(todo, [todo, { id: "b", project: "p", depends_on: ["a"] }, { id: "c", project: "other", depends_on: ["a"] }])).toMatchObject([{ id: "b" }]);
  });
  it("uses the final review and sums attempt session roles", () => {
    expect(reviewOutcome([{ review: { approved: false, counts: { critical: 0, high: 1, medium: 0, low: 0 } } }, { review: { approved: true } }])).toBe("approved");
    expect(sessionRoleCosts({ attempts: [{ sessions: [{ context: { role: "worker" }, tree: { cost: 1.2 } }, { context: { role: "review" }, tree: { cost: .3 } }] }] })).toEqual({ worker: 1.2, review: .3 });
    expect(sessionRoleCosts({ sessions: [{ context: { role: "worker" }, tree: { cost: 2 } }], attempts: [{}] })).toEqual({ worker: 2, review: 0 });
  });
});
