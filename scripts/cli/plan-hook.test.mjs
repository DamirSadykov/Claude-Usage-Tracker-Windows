// Unit tests for the plan-mode ritual hooks (`cli.mjs plan-hook`, t#253).
//
// The pure builders are what's worth testing: the enter format, the exit
// recording instruction (with and without KB warnings), and runMatchPlan's
// contract that the match step is an extra which can never fail the hook.

import { describe, it, expect } from "vitest";
import { buildEnterContext, buildExitContext, runMatchPlan } from "./plan-hook.mjs";

describe("buildEnterContext", () => {
  const ctx = buildEnterContext();

  it("carries the three structural parts of the format", () => {
    expect(ctx).toContain("VISION");
    expect(ctx).toContain("ONE STEP = ONE SESSION");
    expect(ctx).toContain("ORDER");
  });

  it("shows the arrow notation the exit hook will transcribe into dep add", () => {
    expect(ctx).toContain("1 -> 2 -> 3 -> 4; 2 -> 5");
  });
});

describe("buildExitContext", () => {
  it("instructs both shapes: theme for several steps, set-plan for one", () => {
    const ctx = buildExitContext("");
    expect(ctx).toContain('todos add "ТЕМА: <name>" --theme');
    expect(ctx).toContain("todos dep add <root> <child>");
    expect(ctx).toContain("todos set-plan <id>");
    // The instruction names the real bundled CLI path, not a placeholder.
    expect(ctx).toMatch(/node "[^"]*cli\.mjs"/);
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
