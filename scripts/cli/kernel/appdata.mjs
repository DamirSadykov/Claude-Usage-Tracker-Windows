import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { roamingBase } from "./settings.mjs";

export function appDataDir(appData) {
  return path.join(roamingBase(appData), "com.claude-usage-tracker.app");
}

export function appDataFile(name, appData) {
  return path.join(appDataDir(appData), name);
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}
