// Canonical catalog of dashboard sections in AnalyticsWindow. The Settings
// "Dashboard" tab uses this list to render the visibility/order controls, and
// AnalyticsWindow uses it as the fallback when no preference is stored yet.
// Order in this array = default order on first run.

export interface DashboardSectionDef {
  id: string;
  /** i18n key — both Settings list and the section header (if any) read it. */
  labelKey: string;
}

export const DASHBOARD_SECTIONS: DashboardSectionDef[] = [
  { id: "kpi", labelKey: "sectionKpi" },
  { id: "quality", labelKey: "sectionQuality" },
  { id: "productivity", labelKey: "sectionProductivity" },
  { id: "insights", labelKey: "sectionInsights" },
  { id: "charts", labelKey: "sectionCharts" },
  { id: "subagents", labelKey: "sectionSubagents" },
  { id: "tools", labelKey: "sectionTools" },
  { id: "costly", labelKey: "sectionCostly" },
];

export interface SectionPref {
  id: string;
  visible: boolean;
}

/** Default preference list — every section visible, in catalog order. */
export function defaultSectionPrefs(): SectionPref[] {
  return DASHBOARD_SECTIONS.map((s) => ({ id: s.id, visible: true }));
}

/**
 * Merge a stored preference list with the canonical catalog: drop unknown ids,
 * append any new sections at the end (visible by default). This keeps old
 * settings.json working after we add a new section to the catalog.
 */
export function reconcileSectionPrefs(stored: unknown): SectionPref[] {
  const known = new Set(DASHBOARD_SECTIONS.map((s) => s.id));
  const out: SectionPref[] = [];
  const seen = new Set<string>();
  if (Array.isArray(stored)) {
    for (const raw of stored) {
      if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { id?: unknown }).id === "string" &&
        known.has((raw as { id: string }).id)
      ) {
        const id = (raw as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          visible: (raw as { visible?: unknown }).visible !== false,
        });
      }
    }
  }
  for (const s of DASHBOARD_SECTIONS) {
    if (!seen.has(s.id)) out.push({ id: s.id, visible: true });
  }
  return out;
}
