// Shared access to project association groups (issue #13, "who works with whom").
// Unlike merge links, a group is a PEER relationship — members stay separate in
// every aggregate but are shown as related and can be totalled together (read-only)
// in analytics. Backed by project-groups.json (see src-tauri/src/project_groups.rs),
// the same file the cc-todos CLI reads. Auto-refreshes on `project-groups-changed`.
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ProjectGroup {
  name: string;
  projects: string[];
}

export function useProjectGroups() {
  const groups = ref<ProjectGroup[]>([]);

  async function refresh() {
    try {
      groups.value = await invoke<ProjectGroup[]>("get_project_groups");
    } catch {
      /* file may not exist yet — leave empty */
    }
  }
  // Replace the whole set (the management UI sends the full list). The backend
  // normalizes + emits `project-groups-changed`; refresh immediately for snappiness.
  async function save(next: ProjectGroup[]) {
    await invoke("save_project_groups", { groups: next });
    await refresh();
  }

  // Names of the groups `name` belongs to.
  function groupsOf(name: string | null | undefined): string[] {
    if (!name) return [];
    return groups.value.filter((g) => g.projects.includes(name)).map((g) => g.name);
  }
  // Projects that work with `name` (co-members across its groups, minus itself).
  function relatedOf(name: string | null | undefined): string[] {
    if (!name) return [];
    const set = new Set<string>();
    for (const g of groups.value) {
      if (!g.projects.includes(name)) continue;
      for (const p of g.projects) if (p !== name) set.add(p);
    }
    return [...set].sort();
  }

  let unlisten: UnlistenFn | null = null;
  onMounted(async () => {
    await refresh();
    unlisten = await listen("project-groups-changed", () => void refresh());
  });
  onUnmounted(() => unlisten?.());

  return { groups, refresh, save, groupsOf, relatedOf };
}
