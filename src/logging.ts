// Frontend logging: forwards uncaught errors and unhandled rejections to the
// shared log file (via the Tauri log plugin) and records them as a diagnostic
// report on the backend, so a JS crash is reportable just like a failed fetch.
import { error as logError } from "@tauri-apps/plugin-log";
import { invoke } from "@tauri-apps/api/core";

export {
    error as logError,
    warn as logWarn,
    info as logInfo,
    debug as logDebug,
} from "@tauri-apps/plugin-log";

let installed = false;

export function installErrorLogging() {
    if (installed) return;
    installed = true;

    window.addEventListener("error", (e) => {
        const detail =
            e.error?.stack ||
            `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
        void reportFatal(e.message || "Ошибка в интерфейсе", detail);
    });

    window.addEventListener("unhandledrejection", (e) => {
        const reason: any = e.reason;
        const detail = reason?.stack || String(reason);
        void reportFatal("Необработанное отклонение промиса", detail);
    });
}

async function reportFatal(summary: string, detail: string) {
    // Both calls are best-effort: under a plain `vite preview` (no Tauri) they
    // throw, and that must not cascade into another error.
    try {
        await logError(`[frontend] ${summary}: ${detail}`);
    } catch {
        /* logging unavailable */
    }
    try {
        await invoke("report_frontend_error", { summary, detail });
    } catch {
        /* not running under Tauri */
    }
}
