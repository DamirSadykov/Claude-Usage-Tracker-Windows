import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { runFlowGate } from "./flow-gate.mjs";

const task = (extra = {}) => ({ step_base: "base-sha", flow: { file: "src/Notifier.cs", method: "Send" }, produces: ["src/Notifier.cs", "docs/note.md"], ...extra });
const exe = process.execPath;

describe("runFlowGate", () => {
  it.each([[0, "pass"], [1, "issue"], [2, "cannot"]])("maps executable code %i to %s", async (code, status) => {
    const result = await runFlowGate({
      task: task(), cwd: process.cwd(), exe,
      runCmd: async (_exe, args) => {
        expect(args).toContain("--base");
        expect(args).toContain("base-sha");
        expect(args).toContain("shadow");
        expect(args).toEqual(expect.arrayContaining(["--diagram", "result"]));
        return { code, stdout: JSON.stringify({ coverage: { findings: ["coverage"] }, unchecked: [{ file: "src/Other.cs" }], diagram: "```mermaid\\nflowchart TD\\n```" }), stderr: code ? "reason" : "" };
      },
    });
    expect(result.status).toBe(status);
    expect(result.coverage).toEqual(["coverage"]);
    expect(result.unchecked).toEqual(expect.arrayContaining([{ file: "docs/note.md", kind: "unsupported-produce", method: null, reason: expect.any(String) }]));
    expect(result.duration_ms).toEqual(expect.any(Number));
    expect(result.diagram).toContain("mermaid");
  });

  it("cannot when no executable is configured", async () => {
    const result = await runFlowGate({ task: task(), cwd: process.cwd(), exe: "" });
    expect(result).toMatchObject({ status: "cannot", reason: expect.stringMatching(/unavailable/) });
  });

  it("cannot when the runner did not record step_base", async () => {
    const result = await runFlowGate({ task: task({ step_base: "" }), cwd: process.cwd(), exe });
    expect(result).toMatchObject({ status: "cannot", reason: expect.stringMatching(/step_base/) });
  });

  it("does not turn flow: n/a into an empty flowcheck spec", async () => {
    const result = await runFlowGate({
      task: task({ flow: "n/a no C# method body" }), cwd: process.cwd(), exe,
      runCmd: async () => { throw new Error("must not execute"); },
    });
    expect(result).toMatchObject({ status: "cannot", reason: expect.stringMatching(/method delta or a list of them/) });
  });

  it("writes the delta to a temporary file and removes it after a pass", async () => {
    let spec;
    const result = await runFlowGate({
      task: task(), cwd: process.cwd(), exe,
      runCmd: async (_exe, args) => {
        spec = args[args.indexOf("--spec") + 1];
        expect(existsSync(spec)).toBe(true);
        return { code: 0, stdout: JSON.stringify({ coverage: { findings: [] }, unchecked: [] }), stderr: "" };
      },
    });
    expect(result.status).toBe("pass");
    expect(existsSync(spec)).toBe(false);
  });

  it("passes a list of deltas to flowcheck as one spec file", async () => {
    let written;
    const flow = [{ file: "src/Notifier.cs", method: "SendSms" }, { file: "src/Notifier.cs", method: "SendEmail" }];
    const result = await runFlowGate({
      task: task({ flow }), cwd: process.cwd(), exe,
      runCmd: async (_exe, args) => {
        written = JSON.parse(readFileSync(args[args.indexOf("--spec") + 1], "utf8"));
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(result.status).toBe("pass");
    expect(written).toEqual(flow);
  });

  it("does not mark supported Rust and TS/JS produces unchecked", async () => {
    const result = await runFlowGate({
      task: task({ produces: ["src/notify.rs", "src/view.tsx", "src/check.js", "docs/note.md"] }), cwd: process.cwd(), exe,
      runCmd: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    });
    expect(result.unchecked).toEqual([{ file: "docs/note.md", kind: "unsupported-produce", method: null, reason: expect.any(String) }]);
  });
});
