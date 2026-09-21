import { readFileSync } from "node:fs";
import path from "node:path";
import { roamingBase } from "../kernel/settings.mjs";

export function meterFile() {
  return path.join(roamingBase(), "com.claude-usage-tracker.app", "spec-match.jsonl");
}

export function readAsks(file = meterFile()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function coverageOf(asks, project) {
  const rows = project ? asks.filter((a) => a.project === project) : asks;
  const empty = rows.filter((a) => a.zero);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].zero; i--) streak++;
  const byQuery = new Map();
  for (const a of empty) {
    const key = String(a.query ?? "").toLowerCase();
    byQuery.set(key, (byQuery.get(key) ?? 0) + 1);
  }
  return {
    asks: rows.length,
    empty: empty.length,
    hit: rows.length - empty.length,
    share: rows.length ? Number((empty.length / rows.length).toFixed(2)) : 0,
    streak,
    recent: empty.slice(-10).map((a) => ({ at: String(a.ts).slice(0, 10), query: a.query, task: a.task ?? null })),
    repeated: [...byQuery.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
  };
}
