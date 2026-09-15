// Claude Code settings are user-owned, so hook discovery is deliberately
// read-only and forgiving: this test pins the exact evidence it may report.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planGuardWired, wiredHookAreas } from "./claude-hooks.mjs";

describe("Claude Code hook wiring discovery", () => {
  let home;
  let cwd;
  let previousHome;
  let previousUserProfile;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cut-claude-home-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "cut-claude-cwd-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const tracker = (area) => `node "C:/tools/claude-usage-tracker/scripts/cli.mjs" ${area}`;

  it("finds this CLI's areas across user and project settings, ignoring foreign hooks", () => {
    write(path.join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [{ hooks: [{ command: tracker("plan-guard") }] }] } });
    write(path.join(cwd, ".claude", "settings.json"), { hooks: { UserPromptSubmit: [{ hooks: [{ command: tracker("plan-hook prompt") }, { command: "node knowledge-base-hook.mjs" }] }] } });
    expect(wiredHookAreas(cwd)).toEqual(new Set(["plan-guard", "plan-hook prompt"]));
    expect(planGuardWired(cwd)).toBe(true);
  });

  it("tolerates absent and broken settings, and reports no plan guard", () => {
    write(path.join(cwd, ".claude", "settings.local.json"), "{ broken json");
    expect(wiredHookAreas(cwd)).toEqual(new Set());
    expect(planGuardWired(cwd)).toBe(false);
  });
});
