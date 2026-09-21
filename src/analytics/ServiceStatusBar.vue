<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";

interface Incident {
    id: string;
    name: string;
    status: string;
    impact: string;
    shortlink: string | null;
    updated_at: string | null;
    components: string[];
}

interface ServiceStatus {
    indicator: string;
    description: string;
    incidents: Incident[];
}

const { t, locale } = useI18n();

const props = defineProps<{
    sessionActive: boolean;
    serviceEnabled: boolean;
}>();

const status = ref<ServiceStatus | null>(null);
const reachable = ref(true);
const expanded = ref(false);

const unlisteners: Array<() => void> = [];

// `none` (green) is the resting state; anything else is degraded. When the
// status page itself can't be reached we show a neutral grey, never red, so a
// network blip isn't mistaken for an outage.
const level = computed(() => {
    if (!reachable.value) return "unknown";
    return status.value?.indicator || "none";
});

const incidents = computed(() => status.value?.incidents ?? []);
const hasIncidents = computed(() => incidents.value.length > 0);

const label = computed(() => {
    switch (level.value) {
        case "none":
            return t("statusNone");
        case "minor":
            return t("statusMinor");
        case "major":
            return t("statusMajor");
        case "critical":
            return t("statusCritical");
        default:
            return t("statusUnknown");
    }
});

const INCIDENT_STATUS: Record<string, string> = {
    investigating: "incInvestigating",
    identified: "incIdentified",
    monitoring: "incMonitoring",
    resolved: "incResolved",
};

function incidentStatusLabel(s: string): string {
    const key = INCIDENT_STATUS[s];
    return key ? t(key) : s;
}

function formatTime(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(locale.value, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function toggle() {
    if (hasIncidents.value) expanded.value = !expanded.value;
}

async function openStatusPage() {
    try {
        await invoke("open_status_page");
    } catch {
        // ignore — best effort
    }
}

onMounted(async () => {
    if (!props.serviceEnabled) return;

    try {
        const snap = await invoke<{
            status: ServiceStatus | null;
            reachable: boolean;
        }>("get_service_status");
        // Only trust `reachable` once there's a real result — before the first
        // poll completes, stay optimistic rather than flashing "unavailable".
        if (snap.status) {
            status.value = snap.status;
            reachable.value = snap.reachable;
        }
    } catch {
        // backend not ready yet — events will fill it in
    }

    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
        await listen<ServiceStatus>("service-status", (e) => {
            status.value = e.payload;
            reachable.value = true;
        }),
        await listen("service-status-error", () => {
            reachable.value = false;
        }),
    );
});

onUnmounted(() => {
    unlisteners.forEach((u) => u());
    unlisteners.length = 0;
});
</script>

<template>
    <div class="svc">
        <div class="svc-row">
            <div
                v-if="serviceEnabled"
                class="svc-chip"
                :class="[`svc-${level}`, { clickable: hasIncidents }]"
                @click="toggle"
            >
                <span class="svc-dot"></span>
                <span class="svc-label">{{ label }}</span>
                <span v-if="hasIncidents" class="svc-count">{{
                    incidents.length
                }}</span>
                <svg
                    v-if="hasIncidents"
                    class="svc-chev"
                    :class="{ open: expanded }"
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <path
                        d="M4 6l4 4 4-4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </div>

            <span
                v-if="serviceEnabled && sessionActive"
                class="svc-sep"
            ></span>

            <div v-if="sessionActive" class="svc-chip svc-session">
                <span class="svc-dot"></span>
                <span class="svc-label">{{ t("sessionActive") }}</span>
            </div>

            <span class="svc-spacer"></span>

            <button
                v-if="serviceEnabled"
                class="svc-link"
                :title="t('statusOpen')"
                @click.stop="openStatusPage"
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <path
                        d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"
                        stroke-linecap="round"
                    />
                    <path
                        d="M9 3h4v4M13 3L7 9"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </button>
        </div>

        <div v-if="expanded && hasIncidents" class="svc-incidents">
            <div v-for="inc in incidents" :key="inc.id" class="svc-inc">
                <div class="svc-inc-hd">
                    <span class="svc-inc-badge">{{
                        incidentStatusLabel(inc.status)
                    }}</span>
                    <span class="svc-inc-name">{{ inc.name }}</span>
                </div>
                <div v-if="inc.components.length" class="svc-inc-meta">
                    {{ inc.components.join(", ") }}
                </div>
                <div v-if="inc.updated_at" class="svc-inc-meta">
                    {{ formatTime(inc.updated_at) }}
                </div>
            </div>
            <button class="svc-more" @click="openStatusPage">
                {{ t("statusMore") }}
            </button>
        </div>
    </div>
</template>

<style scoped>
.svc {
    margin: 8px 10px 0;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--card-radius);
    background: rgba(255, 255, 255, 0.03);
    overflow: hidden;
}

.svc-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
}

.svc-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
}

.svc-chip.clickable {
    cursor: pointer;
}

.svc-sep {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-4);
    opacity: 0.6;
    flex-shrink: 0;
}

.svc-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-4);
}

.svc-none .svc-dot {
    background: #3fb950;
}
.svc-minor .svc-dot {
    background: #ffc107;
}
.svc-major .svc-dot {
    background: #d97757;
}
.svc-critical .svc-dot {
    background: #f87171;
}

.svc-session .svc-dot {
    background: var(--success);
    box-shadow: 0 0 8px rgba(108, 203, 95, 0.6);
}

.svc-label {
    font-size: 12px;
    color: var(--text-2);
}

.svc-count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
    background: rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 0 6px;
    line-height: 16px;
}

.svc-spacer {
    flex: 1;
}

.svc-chev {
    color: var(--text-3);
    transition: transform 150ms;
    flex-shrink: 0;
}

.svc-chev.open {
    transform: rotate(180deg);
}

.svc-link {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    border-radius: 3px;
    transition: color 120ms, background 120ms;
}

.svc-link:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
}

.svc-incidents {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 10px 10px;
}

.svc-inc {
    border-left: 2px solid var(--stroke-strong);
    padding-left: 8px;
}

.svc-inc-hd {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
}

.svc-inc-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-3);
    flex-shrink: 0;
}

.svc-inc-name {
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.3;
}

.svc-inc-meta {
    font-size: 11px;
    color: var(--text-4);
    margin-top: 2px;
}

.svc-more {
    align-self: flex-start;
    margin-top: 2px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    font-family: var(--segoe);
    cursor: pointer;
}

.svc-more:hover {
    text-decoration: underline;
}
</style>
