import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataDir, appDataFile, writeJsonAtomic } from "./appdata.mjs";

describe("app data paths", () => {
  it("uses the explicit roaming base", () => {
    const appData = path.join("C:", "Users", "tester", "AppData", "Roaming");
    const dir = path.join(appData, "com.claude-usage-tracker.app");
    expect(appDataDir(appData)).toBe(dir);
    expect(appDataFile("todos.json", appData)).toBe(path.join(dir, "todos.json"));
  });

  it("uses APPDATA when no roaming base is supplied", () => {
    const previous = process.env.APPDATA;
    const appData = path.join("C:", "Users", "environment", "AppData", "Roaming");
    process.env.APPDATA = appData;
    try {
      expect(appDataDir()).toBe(path.join(appData, "com.claude-usage-tracker.app"));
      expect(appDataFile("settings.json")).toBe(
        path.join(appData, "com.claude-usage-tracker.app", "settings.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
    }
  });
});

describe("writeJsonAtomic", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes formatted JSON and leaves no temporary file", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "appdata-"));
    const file = path.join(dir, "data.json");
    const data = { task: 795, nested: { ready: true } };

    writeJsonAtomic(file, data);

    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});
