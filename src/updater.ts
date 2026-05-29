import { ref } from "vue";
import { logError, logInfo } from "./logging";

// State machine for the in-app updater. Module-scoped refs make this a shared
// singleton so the banner (App.vue) and the settings block (SettingsPanel.vue)
// observe the same state without prop plumbing.
export type UpdateStatus =
    | "idle"
    | "checking"
    | "uptodate"
    | "available"
    | "downloading"
    | "ready"
    | "error";

const status = ref<UpdateStatus>("idle");
const currentVersion = ref("");
const availableVersion = ref("");
const notes = ref("");
const progress = ref(0); // 0..100
const errorMessage = ref("");
const checkHours = ref(6);

// The Update handle returned by check(), kept until installed.
let pending: { version: string; body?: string; downloadAndInstall: Function } | null =
    null;
let periodicTimer: number | null = null;
let initialized = false;

async function loadStore() {
    const { load } = await import("@tauri-apps/plugin-store");
    return load("settings.json");
}

export async function saveUpdaterSettings() {
    const store = await loadStore();
    await store.set("updateCheckHours", checkHours.value);
    await store.save();
    schedulePeriodic();
}

async function downloadAndInstall() {
    if (!pending) return;
    status.value = "downloading";
    progress.value = 0;
    let total = 0;
    let received = 0;
    try {
        await pending.downloadAndInstall((e: any) => {
            switch (e.event) {
                case "Started":
                    total = e.data?.contentLength ?? 0;
                    break;
                case "Progress":
                    received += e.data?.chunkLength ?? 0;
                    progress.value = total
                        ? Math.round((received / total) * 100)
                        : 0;
                    break;
                case "Finished":
                    progress.value = 100;
                    break;
            }
        });
        status.value = "ready";
    } catch (err) {
        status.value = "error";
        errorMessage.value = String(err);
        void logError(`updater: download/install failed: ${String(err)}`);
    }
}

export async function relaunchApp() {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
}

export async function installUpdate() {
    await downloadAndInstall();
    if (status.value === "ready") await relaunchApp();
}

// silent: a background/startup check — swallow "no update" and network errors
// so they don't surface as a banner. Manual checks (silent=false) show feedback.
export async function checkForUpdate(silent = false) {
    if (status.value === "checking" || status.value === "downloading") return;
    status.value = "checking";
    errorMessage.value = "";
    try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
            void logInfo(`updater: update available ${update.version}`);
            pending = update as any;
            availableVersion.value = update.version;
            notes.value = update.body ?? "";
            status.value = "available";
        } else {
            pending = null;
            status.value = silent ? "idle" : "uptodate";
        }
    } catch (err) {
        void logError(`updater: check failed (silent=${silent}): ${String(err)}`);
        if (silent) {
            status.value = "idle";
        } else {
            status.value = "error";
            errorMessage.value = String(err);
        }
    }
}

export function dismissUpdate() {
    if (status.value !== "downloading") status.value = "idle";
}

function schedulePeriodic() {
    if (periodicTimer !== null) {
        clearInterval(periodicTimer);
        periodicTimer = null;
    }
    const hours = Math.max(1, checkHours.value);
    periodicTimer = window.setInterval(
        () => void checkForUpdate(true),
        hours * 3_600_000,
    );
}

export async function initUpdater() {
    if (initialized) return;
    initialized = true;
    try {
        const { getVersion } = await import("@tauri-apps/api/app");
        currentVersion.value = await getVersion();
    } catch {
        // running outside Tauri (e.g. plain vite preview)
    }
    try {
        const store = await loadStore();
        checkHours.value = (await store.get<number>("updateCheckHours")) ?? 6;
    } catch {
        // first run
    }
    schedulePeriodic();
    void checkForUpdate(true); // check on startup
}

export function useUpdater() {
    return {
        status,
        currentVersion,
        availableVersion,
        notes,
        progress,
        errorMessage,
        checkHours,
        checkForUpdate,
        installUpdate,
        relaunchApp,
        dismissUpdate,
        saveUpdaterSettings,
    };
}
