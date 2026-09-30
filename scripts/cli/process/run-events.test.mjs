import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRunEvent, formatRunEvent, watchRunEvents } from "./run-events.mjs";

describe("run events", () => {
  it("appends JSON lines and formats a review", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    try {
      expect(appendRunEvent({ run: "r1", change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } }, file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ run: "r1", change: 62, task: 790, kind: "review" });
      expect(formatRunEvent({ change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } })).toBe("c#62 t#790 attempt 2/3: review high 1, medium 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watches one change and ends on park", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    const lines = [];
    try {
      const watching = watchRunEvents({ change: "c#62", file, from: "start", onLine: (line) => lines.push(line) });
      appendRunEvent({ change: 99, task: 1, kind: "review", counts: { high: 1 } }, file);
      appendRunEvent({ change: 62, task: 790, kind: "park", park_kind: "retry", reason: "spent" }, file);
      await watching;
      expect(lines).toEqual(["c#62 t#790: park retry — spent"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays from the latest run start of the change, not from an older run's park", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    const lines = [];
    try {
      appendRunEvent({ change: 62, kind: "run_start" }, file);
      appendRunEvent({ change: 62, task: 790, kind: "park", park_kind: "retry", reason: "old" }, file);
      appendRunEvent({ change: 62, kind: "run_start" }, file);
      appendRunEvent({ change: 62, task: 791, kind: "step_start", attempt: 1, limit: 2 }, file);
      appendRunEvent({ change: 99, kind: "run_start" }, file);
      const watching = watchRunEvents({ change: "c#62", file, from: "start", onLine: (line) => lines.push(line) });
      appendRunEvent({ change: 62, kind: "run_end" }, file);
      await watching;
      expect(lines).toEqual(["c#62: run start", "c#62 t#791 attempt 1/2: step start", "c#62: run end"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
