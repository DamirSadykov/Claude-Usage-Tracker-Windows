// Canonical catalog of every insight `kind` the Rust backend can emit. Keep in
// sync with `build_insights` in `src-tauri/src/stats/analytics.rs` — adding a
// rule there means adding one entry here. SettingsPanel.vue reads from this
// file to render the per-kind toggle list.

// Backend now emits only "recommendation" insights; the "observation" category
// is retained in the type so any persisted/legacy data still type-checks, but no
// catalog entry uses it anymore.
export type InsightCategory = "observation" | "recommendation";

export interface InsightKindDef {
  kind: string;
  category: InsightCategory;
  /** Full sentence with `{placeholders}` — used to render a triggered card. */
  labelKey: string;
  /** Short, placeholder-free label — used in toggle lists / Hidden expander. */
  shortLabelKey: string;
  /** Can fire as a real-time toast about the active session (issue #46). Keep in
   *  sync with `RUNTIME_KINDS` / `default_runtime_insight_kinds` in Rust. */
  runtimeCapable?: boolean;
}

export const INSIGHT_KINDS: InsightKindDef[] = [
  // recommendations — what to change
  { kind: "cache_churn", category: "recommendation", labelKey: "insightCacheChurn", shortLabelKey: "insightLabelCacheChurn" },
  { kind: "bloated_session", category: "recommendation", labelKey: "insightBloatedSession", shortLabelKey: "insightLabelBloatedSession" },
  { kind: "long_session", category: "recommendation", labelKey: "insightLongSession", shortLabelKey: "insightLabelLongSession", runtimeCapable: true },
  { kind: "mixed_models", category: "recommendation", labelKey: "insightMixedModels", shortLabelKey: "insightLabelMixedModels" },
  // Cold cache rewrites — one metric on two surfaces: the dashboard card shows a
  // per-cause breakdown (compaction / idle / model switch); the runtime toast
  // fires the moment one happens. Same `kind` drives both toggles in Settings.
  { kind: "cold_rewrites", category: "recommendation", labelKey: "insightColdRewrites", shortLabelKey: "insightLabelColdRewrites", runtimeCapable: true },
  // subagent_efficacy uses one of two label_keys depending on sign; the toggle
  // list shows the help variant by default.
  { kind: "subagent_efficacy", category: "recommendation", labelKey: "insightSubagentEfficacyHelp", shortLabelKey: "insightLabelSubagentEfficacy" },
  { kind: "tool_heavy_writes", category: "recommendation", labelKey: "insightToolHeavyWrites", shortLabelKey: "insightLabelToolHeavyWrites" },
  { kind: "subagent_no_attribution", category: "recommendation", labelKey: "insightSubagentNoAttribution", shortLabelKey: "insightLabelSubagentNoAttribution" },
  { kind: "low_cache_hit", category: "recommendation", labelKey: "insightLowCacheHit", shortLabelKey: "insightLabelLowCacheHit" },
  { kind: "tool_error_rate", category: "recommendation", labelKey: "insightToolErrorRate", shortLabelKey: "insightLabelToolErrorRate" },
  { kind: "low_roi", category: "recommendation", labelKey: "insightLowRoi", shortLabelKey: "insightLabelLowRoi" },
];

export function findInsightKind(kind: string): InsightKindDef | undefined {
  return INSIGHT_KINDS.find((k) => k.kind === kind);
}
