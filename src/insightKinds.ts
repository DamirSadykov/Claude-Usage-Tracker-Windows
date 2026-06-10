// Canonical catalog of every insight `kind` the Rust backend can emit. Keep in
// sync with `build_insights` in `src-tauri/src/stats/analytics.rs` — adding a
// rule there means adding one entry here. SettingsPanel.vue reads from this
// file to render the per-kind toggle list.

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
  // observations — what happened
  { kind: "top_project", category: "observation", labelKey: "insightTopProject", shortLabelKey: "insightLabelTopProject" },
  { kind: "cache_share", category: "observation", labelKey: "insightCacheShare", shortLabelKey: "insightLabelCacheShare" },
  { kind: "subagent_share", category: "observation", labelKey: "insightSubagentShare", shortLabelKey: "insightLabelSubagentShare" },
  { kind: "top_subagent", category: "observation", labelKey: "insightTopSubagent", shortLabelKey: "insightLabelTopSubagent" },
  { kind: "peak_day", category: "observation", labelKey: "insightPeakDay", shortLabelKey: "insightLabelPeakDay" },
  { kind: "bash_heavy", category: "observation", labelKey: "insightBashHeavy", shortLabelKey: "insightLabelBashHeavy" },

  // recommendations — what to change
  { kind: "cache_churn", category: "recommendation", labelKey: "insightCacheChurn", shortLabelKey: "insightLabelCacheChurn" },
  { kind: "bloated_session", category: "recommendation", labelKey: "insightBloatedSession", shortLabelKey: "insightLabelBloatedSession" },
  { kind: "long_session", category: "recommendation", labelKey: "insightLongSession", shortLabelKey: "insightLabelLongSession", runtimeCapable: true },
  { kind: "mixed_models", category: "recommendation", labelKey: "insightMixedModels", shortLabelKey: "insightLabelMixedModels" },
  { kind: "cold_restarts", category: "recommendation", labelKey: "insightColdRestarts", shortLabelKey: "insightLabelColdRestarts" },
  // subagent_efficacy uses one of two label_keys depending on sign; the toggle
  // list shows the help variant by default.
  { kind: "subagent_efficacy", category: "recommendation", labelKey: "insightSubagentEfficacyHelp", shortLabelKey: "insightLabelSubagentEfficacy" },
  { kind: "tool_heavy_writes", category: "recommendation", labelKey: "insightToolHeavyWrites", shortLabelKey: "insightLabelToolHeavyWrites" },
  { kind: "subagent_no_attribution", category: "recommendation", labelKey: "insightSubagentNoAttribution", shortLabelKey: "insightLabelSubagentNoAttribution" },
  { kind: "idle_cache_gap", category: "recommendation", labelKey: "insightIdleCacheGap", shortLabelKey: "insightLabelIdleCacheGap", runtimeCapable: true },

  // expensive_session is an observation, not a recommendation — the user
  // doesn't need to "do" anything, but the session is worth opening.
  { kind: "expensive_session", category: "observation", labelKey: "insightExpensiveSession", shortLabelKey: "insightLabelExpensiveSession" },
];

export function findInsightKind(kind: string): InsightKindDef | undefined {
  return INSIGHT_KINDS.find((k) => k.kind === kind);
}
