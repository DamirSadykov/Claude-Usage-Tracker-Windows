import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { calibrate } from "./trace.mjs";

const cli = path.resolve("scripts/cli.mjs");
// This is the Rust t#847 wire shape, deliberately not a hand-normalized alias.
const point = (session, task = "task-a", role = null) => ({ v: 1, session, task, task_number: 849, provider: "openai", model: "gpt-5.6-terra", role, stamp: { size: 1, mtime_ns: 1 }, computed_at: "2026-09-30T00:00:00Z", observed: { calls: 4, ctx: [100, 130, 160, 200], cached: [61, 80, 98, 122], firstEditCall: 2, ctxAtFirstEdit: 130, firstCachedShare: .61 }, scenarios: [{ rho: .25, k: 2, saveUsd: 1, savePct: 10 }, { rho: .38, k: 3, saveUsd: .8, savePct: 8 }, { rho: .64, k: null, saveUsd: 0, savePct: 0 }], params: { h: 300, R: 3, rhos: [.25, .38, .64], rho_source: "default" }, model_version: 1 });

describe("trace restart", () => {
  it("prints the Rust fixture's role, calls, edit, k, and scenario interval", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "trace-")); const app = path.join(dir, "com.claude-usage-tracker.app"); mkdirSync(app);
    writeFileSync(path.join(app, "restart-points.jsonl"), JSON.stringify(point("s1")) + "\n");
    writeFileSync(path.join(app, "task-sessions.jsonl"), JSON.stringify({ session: "s1", task: "task-a", event: "start", agent: "worker" }) + "\n");
    const out = spawnSync(process.execPath, [cli, "trace", "restart", "task-a"], { encoding: "utf8", env: { ...process.env, APPDATA: dir } });
    expect(out.status).toBe(0); expect(out.stdout).toMatch(/роль=worker; вызовы=4; первая правка=2; k=2\/3\/—/);
    expect(out.stdout).toMatch(/экономия входа, сценарий: 10\.0%–0\.0% \(медиана 8\.0%; ρ=0\.25\/0\.38\/0\.64, h=300, R=3\)/);
  });
});

describe("trace calibrate", () => {
  it("uses the task-qualified prior record and one-based firstEditCall fallback", () => {
    const prior = point("one"); prior.observed.ctx = [100, 200];
    const next = point("two"); delete next.observed.ctxAtFirstEdit; next.observed.ctx = [50, 90, 120]; next.observed.firstEditCall = 2;
    const wrongTask = point("one", "task-b"); wrongTask.observed.ctx = [100, 900];
    const result = calibrate([prior, next, wrongTask], [{ session: "one", task: "task-a", event: "start", agent: "worker", ts: "1" }, { session: "two", task: "task-a", event: "start", agent: "worker", ts: "2" }]);
    expect(result).toMatchObject({ rhos: [.4, .4, .4], pairs: 1, total: 1, dropped: {} });
  });
});
