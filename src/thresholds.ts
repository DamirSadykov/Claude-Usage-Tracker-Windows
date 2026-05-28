// Single source of truth for usage colour buckets. Three thresholds define
// four levels (0=green, 1=yellow, 2=orange, 3=red). The same thresholds drive
// the tray icon, the mini panel, the usage panel, and notification alerts.

export type Thresholds = [number, number, number];

export const DEFAULT_THRESHOLDS: Thresholds = [25, 50, 75];

export function normalize(th: number[] | null | undefined): Thresholds {
  if (!th || th.length < 3) return [...DEFAULT_THRESHOLDS];
  const s = [th[0], th[1], th[2]].sort((a, b) => a - b);
  return [s[0], s[1], s[2]];
}

/** Returns 0..3 — the number of thresholds the value has reached. */
export function tierLevel(pct: number, th: number[]): number {
  const [a, b, c] = normalize(th);
  if (pct < a) return 0;
  if (pct < b) return 1;
  if (pct < c) return 2;
  return 3;
}
