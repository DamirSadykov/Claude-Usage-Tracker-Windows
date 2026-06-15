<script setup lang="ts">
import { onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { useUpdater } from "../updater";
import {
    useChangelog,
    renderNotes,
    cleanNotes,
    REPO_URL,
    type Release,
} from "../changelog";

const { t, locale } = useI18n();
const { currentVersion } = useUpdater();
const { releases, loading, ensureLoaded } = useChangelog();

const COPYRIGHT_YEAR = "2026";

onMounted(() => {
    void ensureLoaded();
});

async function openExternal(url: string) {
    try {
        await invoke("open_url", { url });
    } catch {
        // not running under Tauri (plain vite preview)
        window.open(url, "_blank");
    }
}

function fmtDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(locale.value, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

// Notes ready for in-app rendering: strip the version heading and the installer
// footer git-cliff appends, then convert the markdown subset to HTML.
function notesHtml(r: Release): string {
    return renderNotes(cleanNotes(r.body));
}

const empty = computed(() => !loading.value && releases.value.length === 0);
</script>

<template>
    <div class="cards">
        <!-- About -->
        <div class="card about-card">
            <div class="about-head">
                <div class="about-title">Claude Usage Tracker</div>
                <span class="about-ver" v-if="currentVersion"
                    >v{{ currentVersion }}</span
                >
            </div>
            <p class="about-desc">{{ t("aboutDescription") }}</p>
            <p class="about-copy">© {{ COPYRIGHT_YEAR }} Damir Sadykov · Apache-2.0</p>
            <button class="about-link" @click="openExternal(REPO_URL)">
                <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path
                        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                    />
                </svg>
                {{ t("openRepo") }}
            </button>
        </div>

        <!-- What's new -->
        <div class="whatsnew-head">
            <span>{{ t("whatsNew") }}</span>
            <button
                class="changelog-refresh"
                :class="{ spin: loading }"
                :disabled="loading"
                @click="ensureLoaded(true)"
                :title="t('refresh')"
            >
                <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <path d="M14 8A6 6 0 1 1 8 2" stroke-linecap="round" />
                    <path
                        d="M8 2 L11 2 L8 5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </button>
        </div>

        <div v-if="loading && releases.length === 0" class="changelog-state">
            <div class="spinner"></div>
        </div>
        <div v-else-if="empty" class="changelog-state">
            <p>{{ t("changelogEmpty") }}</p>
        </div>

        <div
            v-for="r in releases"
            :key="r.version"
            class="card release-card"
            @click="openExternal(r.url)"
            :title="t('openRelease')"
        >
            <div class="release-head">
                <span class="release-ver">v{{ r.version }}</span>
                <span class="release-date">{{ fmtDate(r.date) }}</span>
            </div>
            <div
                v-if="cleanNotes(r.body)"
                class="release-notes"
                v-html="notesHtml(r)"
            ></div>
            <p v-else class="release-empty">{{ t("changelogNoNotes") }}</p>
        </div>
    </div>
</template>

<style scoped>
.about-card {
    cursor: default;
}
.about-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
}
.about-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
}
.about-ver {
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
}
.about-desc {
    font-size: 12.5px;
    color: var(--text-2);
    line-height: 1.4;
    margin: 8px 0 0;
}
.about-copy {
    font-size: 11px;
    color: var(--text-4);
    margin: 8px 0 0;
}
.about-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding: 5px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--segoe);
    cursor: pointer;
    transition:
        background 120ms,
        color 120ms;
}
.about-link:hover {
    background: var(--card-bg-hover);
    color: var(--text);
}

.whatsnew-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
    margin: 6px 2px 0;
}
.changelog-refresh {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    border: none;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    border-radius: 4px;
    transition: color 120ms;
}
.changelog-refresh:hover:not(:disabled) {
    color: var(--text);
}
.changelog-refresh:disabled {
    cursor: default;
    opacity: 0.6;
}
.changelog-refresh.spin svg {
    animation: changelog-spin 0.7s linear infinite;
}
@keyframes changelog-spin {
    to {
        transform: rotate(360deg);
    }
}

.changelog-state {
    display: flex;
    justify-content: center;
    padding: 24px 0;
    color: var(--text-3);
    font-size: 12px;
}

.release-card {
    cursor: pointer;
}
.release-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
}
.release-ver {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
}
.release-date {
    font-size: 11px;
    color: var(--text-4);
}
.release-notes {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--text-2);
    line-height: 1.45;
}
.release-notes :deep(h5) {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    margin: 8px 0 4px;
}
.release-notes :deep(ul) {
    margin: 0;
    padding-left: 18px;
}
.release-notes :deep(li) {
    margin: 2px 0;
}
.release-notes :deep(p) {
    margin: 4px 0;
}
.release-notes :deep(code) {
    font-family: var(--mono, monospace);
    font-size: 11px;
    background: var(--card-bg-hover);
    padding: 1px 4px;
    border-radius: 3px;
}
.release-empty {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--text-4);
}
</style>
