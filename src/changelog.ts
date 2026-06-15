// Changelog ("What's new") data layer. Release notes are authored in CI by
// git-cliff (see cliff.toml / release.yml) and published as GitHub Releases;
// the app reads them back through the public GitHub API and caches the result
// in the settings store so the About panel works offline between fetches.
import { ref } from "vue";
import { logError } from "./logging";

export interface Release {
    version: string; // "0.4.7" — tag without the leading "v"
    name: string; // release title (falls back to the tag)
    body: string; // raw markdown notes
    date: string; // ISO published_at ("" if unpublished)
    url: string; // html_url of the release page
}

interface GithubRelease {
    tag_name: string;
    name: string | null;
    body: string | null;
    published_at: string | null;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
}

interface CacheEntry {
    fetchedAt: number; // epoch ms
    releases: Release[];
}

const REPO = "DamirSadykov/Claude-Usage-Tracker-Windows";
export const REPO_URL = `https://github.com/${REPO}`;
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const CACHE_KEY = "releasesCache";
const TTL_MS = 6 * 3_600_000; // re-fetch at most every 6 hours

// --- Pure helpers (unit-tested) -------------------------------------------

// Map the GitHub API payload to our slim shape, dropping drafts/pre-releases.
export function parseReleases(raw: GithubRelease[]): Release[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((r) => r && !r.draft && !r.prerelease)
        .map((r) => ({
            version: (r.tag_name ?? "").replace(/^v/, ""),
            name: r.name?.trim() || r.tag_name || "",
            body: (r.body ?? "").trim(),
            date: r.published_at ?? "",
            url: r.html_url ?? "",
        }));
}

// Strip the parts of a git-cliff release body that the About panel renders
// separately: the leading "## <version> — <date>" heading and the trailing
// installer block we append after a horizontal rule in release.yml. Bodies of
// older releases without these markers just get trimmed.
export function cleanNotes(body: string): string {
    let s = (body ?? "").replace(/\r\n/g, "\n");
    s = s.replace(/^\s*##\s+[^\n]*\n/, "");
    const cut = s.search(/\n-{3,}\s*\n/);
    if (cut !== -1) s = s.slice(0, cut);
    return s.trim();
}

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function inline(s: string): string {
    // Escape first, then layer `code` and **bold** on top of escaped text.
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return out;
}

// Minimal markdown→HTML for release notes. Notes come from our own releases
// (semi-trusted), so we still escape every character before adding markup.
// Handles the subset git-cliff emits: `###`/`##` headings, `- bullets`,
// blank-line paragraphs, **bold** and `inline code`.
export function renderNotes(md: string): string {
    const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let para: string[] = [];
    let listItems: string[] | null = null;

    const flushPara = () => {
        if (para.length === 0) return;
        out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
    };
    const flushList = () => {
        if (listItems === null) return;
        out.push(
            "<ul>" +
                listItems.map((i) => `<li>${inline(i)}</li>`).join("") +
                "</ul>",
        );
        listItems = null;
    };

    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") {
            flushPara();
            flushList();
            continue;
        }
        const heading = line.match(/^(#{2,4})\s+(.*)$/);
        if (heading) {
            flushPara();
            flushList();
            out.push(`<h5>${inline(heading[2])}</h5>`);
            continue;
        }
        if (line.startsWith("- ")) {
            flushPara();
            if (listItems === null) listItems = [];
            listItems.push(line.slice(2));
            continue;
        }
        flushList();
        para.push(line);
    }
    flushPara();
    flushList();
    return out.join("");
}

// --- Fetch + cache (Tauri runtime) ----------------------------------------

async function loadStore() {
    const { load } = await import("@tauri-apps/plugin-store");
    return load("settings.json");
}

async function readCache(): Promise<CacheEntry | null> {
    try {
        const store = await loadStore();
        return (await store.get<CacheEntry>(CACHE_KEY)) ?? null;
    } catch {
        return null;
    }
}

async function writeCache(releases: Release[]): Promise<void> {
    try {
        const store = await loadStore();
        await store.set(CACHE_KEY, { fetchedAt: Date.now(), releases });
        await store.save();
    } catch {
        /* store unavailable (e.g. plain vite preview) */
    }
}

// Returns releases newest-first. Serves a fresh cache without hitting the
// network; on a stale/missing cache it fetches and, if that fails, falls back
// to whatever cache exists (possibly empty).
export async function fetchReleases(force = false): Promise<Release[]> {
    const cached = await readCache();
    if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
        return cached.releases;
    }
    try {
        const resp = await fetch(API, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
        const releases = parseReleases(await resp.json());
        await writeCache(releases);
        return releases;
    } catch (err) {
        void logError(`changelog: fetch failed: ${String(err)}`);
        return cached?.releases ?? [];
    }
}

// --- Composable -----------------------------------------------------------

const releases = ref<Release[]>([]);
const loading = ref(false);
const loaded = ref(false);

export function useChangelog() {
    async function ensureLoaded(force = false) {
        if (loaded.value && !force) return;
        loading.value = true;
        try {
            releases.value = await fetchReleases(force);
            loaded.value = true;
        } finally {
            loading.value = false;
        }
    }
    return { releases, loading, loaded, ensureLoaded };
}
