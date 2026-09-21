import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_PROVIDER_MANIFEST,
  DUTY_MODES,
  emptyAgentConfig,
  readAgentConfig,
  resolveDuty,
  saveAgentConfig,
  criticMode,
  criticRunsAsAgent,
} from "./agents.mjs";
import { dutyModeReader } from "./duty-mode.mjs";

describe("lifecycle duty map", () => {
  let dir;
  let previous;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-agents-"));
    previous = process.env.APPDATA;
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the starter duty map when no settings file exists", () => {
    expect(readAgentConfig()).toEqual(emptyAgentConfig());
    expect(resolveDuty("worker")).toMatchObject({ duty: "worker", mode: "always", provider: "anthropic", model: "sonnet" });
    expect(resolveDuty("critic")).toMatchObject({ mode: "session", provider: "openai", model: "gpt-5.6-terra" });
    expect(resolveDuty("architect")).toMatchObject({ mode: "agent", provider: "openai", model: "gpt-5.6-terra" });
    expect(resolveDuty("review")).toMatchObject({ mode: "agent", provider: "anthropic", model: "opus" });
  });

  it("keeps `enabled` and `runsAsAgent` apart for a session critic", () => {
    expect(resolveDuty("critic")).toMatchObject({ enabled: true, runsAsAgent: false });
    expect(resolveDuty("review")).toMatchObject({ enabled: true, runsAsAgent: true });
    expect(resolveDuty("worker")).toMatchObject({ enabled: true, runsAsAgent: true });
  });

  it("resolves models from lifecycle duties, never from task fields", () => {
    saveAgentConfig({
      version: 4,
      duties: {
        architect: { mode: "agent", provider: "openai", model: "gpt-5.6-sol", role: "architect" },
        worker: { mode: "always", provider: "anthropic", model: "sonnet", role: "worker" },
        review: { mode: "agent", provider: "anthropic", model: "opus", role: "reviewer" },
      },
    });
    expect(resolveDuty("architect")).toMatchObject({ duty: "architect", provider: "openai", model: "gpt-5.6-sol", enabled: true });
    expect(resolveDuty("worker")).toMatchObject({ duty: "worker", provider: "anthropic", model: "sonnet" });
  });

  it("rejects a provider/model mismatch and keeps the valid family default", () => {
    saveAgentConfig({ version: 4, duties: { worker: { mode: "always", provider: "openai", model: "opus" } } });
    expect(resolveDuty("worker")).toMatchObject({ provider: "anthropic", model: "sonnet" });
  });

  it("refuses a mode the duty does not offer and falls back to the starter one", () => {
    saveAgentConfig({
      version: 4,
      duties: { review: { mode: "session", provider: "anthropic", model: "opus" } },
    });
    expect(resolveDuty("review").mode).toBe("agent");
    expect(DUTY_MODES.review).toEqual(["off", "agent"]);
    expect(DUTY_MODES.worker).toEqual(["always"]);
  });

  it("migrates the v3 hooks map and criticMode into the one mode field", () => {
    saveAgentConfig({
      version: 3,
      duties: {
        critic: { provider: "openai", model: "gpt-5.6-terra" },
        architect: { provider: "openai", model: "gpt-5.6-terra" },
        worker: { provider: "anthropic", model: "sonnet" },
        review: { provider: "anthropic", model: "opus" },
      },
      hooks: { critic: true, architect: false, review: true },
      criticMode: "agent",
    });
    const cfg = readAgentConfig();
    expect(cfg.version).toBe(4);
    expect(cfg.duties.critic.mode).toBe("agent");
    expect(cfg.duties.architect.mode).toBe("off");
    expect(cfg.duties.review.mode).toBe("agent");
    expect(cfg.duties.worker.mode).toBe("always");
    expect(cfg.hooks).toBeUndefined();
    expect(cfg.criticMode).toBeUndefined();
  });

  it("reads a v3 critic that was switched off, whatever its criticMode said", () => {
    saveAgentConfig({
      version: 3,
      duties: { critic: { provider: "openai", model: "gpt-5.6-terra" } },
      hooks: { critic: false, architect: true, review: true },
      criticMode: "agent",
    });
    expect(criticMode()).toBe("off");
    expect(criticRunsAsAgent()).toBe(false);
  });

  it("resolveMode: a valid stored mode beats the legacy hooks/criticMode reading", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("critic", { mode: "off" }, { hooks: { critic: true }, criticMode: "agent" })).toBe("off");
    expect(resolveMode("review", { mode: "agent" }, { hooks: { review: false } })).toBe("agent");
  });

  it("resolveMode: a stored mode the duty does not allow falls through to the legacy reading", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("review", { mode: "session" }, { hooks: { review: true } })).toBe("agent");
    expect(resolveMode("critic", { mode: "bogus" }, { hooks: { critic: false } })).toBe("off");
  });

  it("resolveMode: no stored mode and no legacy keys lands on the starter mode", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("critic", undefined, undefined)).toBe("session");
    expect(resolveMode("architect", {}, {})).toBe("agent");
    expect(resolveMode("worker", undefined, undefined)).toBe("always");
  });

  it("defaults the critic to the main session and round-trips its mode", () => {
    expect(criticMode()).toBe("session");
    expect(criticRunsAsAgent()).toBe(false);
    const config = emptyAgentConfig();
    config.duties.critic.mode = "agent";
    saveAgentConfig(config);
    expect(readAgentConfig().duties.critic.mode).toBe("agent");
    expect(criticMode()).toBe("agent");
    expect(criticRunsAsAgent()).toBe(true);
  });
});
