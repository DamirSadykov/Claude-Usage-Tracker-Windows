// Shared access to the project merge links (issue #13) for the UI badges. Any
// component that shows a project name can call `useProjectLinks()` to learn
// whether a name is a canonical that absorbed others (→ list its aliases) or is
// itself an alias merged into a canonical. Auto-refreshes on the app-wide
// `project-links-changed` event so badges stay in sync after a merge/unmerge.
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ProjectLink {
  alias: string;
  canonical: string;
}

export function useProjectLinks() {
  const aliasesByCanonical = ref<Record<string, string[]>>({});
  const canonicalByAlias = ref<Record<string, string>>({});

  async function refresh() {
    try {
      const links = await invoke<ProjectLink[]>("get_project_links");
      const byCanon: Record<string, string[]> = {};
      const byAlias: Record<string, string> = {};
      for (const l of links) {
        (byCanon[l.canonical] ??= []).push(l.alias);
        byAlias[l.alias] = l.canonical;
      }
      aliasesByCanonical.value = byCanon;
      canonicalByAlias.value = byAlias;
    } catch {
      /* analytics may not be initialised yet — leave maps empty */
    }
  }

  // Aliases merged INTO `name` (non-empty only when it's a canonical with merges).
  function aliasesOf(name: string | null | undefined): string[] {
    return name ? aliasesByCanonical.value[name] ?? [] : [];
  }
  // The canonical `name` is merged into (null unless `name` is itself an alias).
  function canonicalOf(name: string | null | undefined): string | null {
    return name ? canonicalByAlias.value[name] ?? null : null;
  }

  let unlisten: UnlistenFn | null = null;
  onMounted(async () => {
    await refresh();
    unlisten = await listen("project-links-changed", () => void refresh());
  });
  onUnmounted(() => unlisten?.());

  return { aliasesOf, canonicalOf, refresh };
}
