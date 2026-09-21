import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import contract from "./settings-contract.json" with { type: "json" };
import {
  SETTINGS_KEYS,
  hookContextEnabled,
  matchPlanCli,
  specDeltaGuard,
  specRepoPath,
  specRepos,
  specRoot,
  specsEnabled,
  taskContextPriority,
  taskContextMinRank,
  taskHandoffGuard,
  workflowContextEnabled,
} from "./settings.mjs";

const CLI_CONTRACT_KEYS = contract.keys.filter(({ scope }) => scope === "shared" || scope === "hook");

describe("CLI settings contract", () => {
  it("lists exactly the shared and hook keys in the contract", () => {
    expect([...SETTINGS_KEYS].sort()).toEqual(CLI_CONTRACT_KEYS.map(({ key }) => key).sort());
  });

  it("uses each contract default when settings.json is absent", () => {
    const appData = mkdtempSync(path.join(os.tmpdir(), "settings-contract-"));
    const defaults = new Map(CLI_CONTRACT_KEYS.map(({ key, default: value }) => [key, value]));

    try {
      expect(taskContextPriority(appData)).toBe(defaults.get("taskContextPriority"));
      expect(taskContextMinRank(appData)).toBe(2);
      expect(hookContextEnabled(appData)).toBe(defaults.get("hookContextEnabled"));
      expect(workflowContextEnabled(appData)).toBe(defaults.get("workflowContextEnabled"));
      expect(taskHandoffGuard(appData)).toBe(defaults.get("taskHandoffGuard"));
      expect(specDeltaGuard(appData)).toBe(defaults.get("specDeltaGuard"));
      expect(specsEnabled(appData)).toBe(defaults.get("specsEnabled"));
      expect(matchPlanCli(appData)).toBe(defaults.get("matchPlanCli"));
      expect(specRoot(appData)).toBe(defaults.get("specRoot"));
      expect(specRepos(appData)).toEqual(defaults.get("specRepos"));
      expect(specRepoPath("unlisted", appData)).toBe("");
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
