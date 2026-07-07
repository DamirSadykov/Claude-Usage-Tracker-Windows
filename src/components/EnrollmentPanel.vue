<script setup lang="ts">
// Integrations tab (plan External-integration-public-side, phase 4.2). Flow B:
// the corp service issues a pairing code; the user pastes it here and the device
// redeems it at the resolver's /enroll/bind. This panel is self-contained — it
// owns the resolver URL (persisted to settings.json) and drives the enrollment
// commands directly, so it doesn't touch App.vue's settings pipeline.
import { ref, onMounted, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import {
  EXT_BUCKETS,
  resolveBucket,
  STATUS_MAP_KEY,
  type StatusMap,
  type ExtBucketId,
} from "../externalStatus";

const { t } = useI18n();

// Buckets offered in each status <select> (labels resolved via i18n in template).
const buckets = EXT_BUCKETS;

type EnrollmentStatus = {
  device_id: string;
  public_key: string;
  account: string | null;
  enrolled_at: string | null;
};

const resolverUrl = ref("");
const pairingCode = ref("");
const status = ref<EnrollmentStatus | null>(null);
const binding = ref(false);
const errorMsg = ref("");

// Status mapper: the distinct source statuses seen in the mirror, each mapped onto
// one of our kanban buckets. The original list is DERIVED from received data (no
// hardcoded status set), the mapping is user-owned and persisted to settings.json.
const seenStatuses = ref<string[]>([]);
const statusMap = ref<StatusMap>({});

function bucketOf(s: string): ExtBucketId {
  return resolveBucket(s, statusMap.value);
}

async function loadStatusMapper() {
  // Distinct statuses from whatever has actually been mirrored so far.
  try {
    const cache = await invoke<{ tasks: { status: string }[] }>("get_external_tasks");
    const set = new Set<string>();
    for (const tk of cache.tasks ?? []) if (tk.status) set.add(tk.status);
    seenStatuses.value = [...set].sort((a, b) => a.localeCompare(b));
  } catch {
    // not under Tauri / no mirror yet → empty list
  }
  try {
    const store = await settingsStore();
    statusMap.value = (await store.get<StatusMap>(STATUS_MAP_KEY)) ?? {};
  } catch {
    // first run → no overrides yet
  }
}

async function onBucketChange(sourceStatus: string, e: Event) {
  const bucket = (e.target as HTMLSelectElement).value as ExtBucketId;
  statusMap.value = { ...statusMap.value, [sourceStatus]: bucket };
  try {
    const store = await settingsStore();
    await store.set(STATUS_MAP_KEY, statusMap.value);
    await store.save();
  } catch (err) {
    errorMsg.value = String(err);
  }
}

const bound = computed(() => !!status.value?.account);
const deviceIdShort = computed(() =>
  status.value ? status.value.device_id.slice(0, 12) : "",
);
const enrolledAtShort = computed(() => {
  const at = status.value?.enrolled_at;
  return at ? at.replace("T", " ").slice(0, 16) : "";
});

async function settingsStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("settings.json");
}

async function refreshStatus() {
  try {
    status.value = await invoke<EnrollmentStatus>("enrollment_status");
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function persistResolverUrl() {
  try {
    const store = await settingsStore();
    await store.set("resolverUrl", resolverUrl.value.trim());
    await store.save();
  } catch {
    // Non-fatal: the URL is still used for the current bind (passed as an arg).
  }
}

async function bind() {
  errorMsg.value = "";
  if (!resolverUrl.value.trim()) {
    errorMsg.value = t("resolverUrlHint");
    return;
  }
  if (!pairingCode.value.trim()) return;
  binding.value = true;
  try {
    await persistResolverUrl();
    await invoke("enroll_bind", {
      code: pairingCode.value.trim(),
      url: resolverUrl.value.trim(),
    });
    pairingCode.value = "";
    await refreshStatus();
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    binding.value = false;
  }
}

async function unbind() {
  errorMsg.value = "";
  try {
    await invoke("enroll_reset");
    await refreshStatus();
  } catch (e) {
    errorMsg.value = String(e);
  }
}

onMounted(async () => {
  try {
    const store = await settingsStore();
    resolverUrl.value = (await store.get<string>("resolverUrl")) ?? "";
  } catch {
    // First run — no settings yet.
  }
  await refreshStatus();
  await loadStatusMapper();
});
</script>

<template>
  <div class="intro">{{ t("integrationsIntro") }}</div>

  <!-- Resolver URL -->
  <div class="card">
    <div class="field-label">{{ t("resolverUrl") }}</div>
    <input
      v-model="resolverUrl"
      type="text"
      class="field-input"
      :placeholder="t('resolverUrlPlaceholder')"
      autocomplete="off"
      spellcheck="false"
      @change="persistResolverUrl"
    />
    <div class="field-hint">{{ t("resolverUrlHint") }}</div>
  </div>

  <!-- Connection status -->
  <div class="card">
    <div class="field-label">{{ t("connectionStatus") }}</div>
    <div class="status-row">
      <span class="status-dot" :class="bound ? 'ok' : 'off'" />
      <span class="status-text">
        {{ bound ? t("statusConnected") : t("statusNotConnected") }}
      </span>
    </div>

    <div v-if="bound" class="bound-meta">
      <div class="meta-line">
        <span class="meta-key">{{ t("boundAccount") }}</span>
        <span class="meta-val">{{ status?.account }}</span>
      </div>
      <div v-if="enrolledAtShort" class="meta-line">
        <span class="meta-key">{{ t("boundAt") }}</span>
        <span class="meta-val">{{ enrolledAtShort }}</span>
      </div>
      <div class="meta-line">
        <span class="meta-key">{{ t("deviceIdLabel") }}</span>
        <span class="meta-val mono">{{ deviceIdShort }}…</span>
      </div>
      <button type="button" class="ghost-btn" @click="unbind">
        {{ t("unbindDevice") }}
      </button>
    </div>
  </div>

  <!-- Status mapper: source statuses (from received data) → our kanban columns -->
  <div class="card">
    <div class="field-label">{{ t("statusMapLabel") }}</div>
    <div class="field-hint">{{ t("statusMapHint") }}</div>

    <div v-if="!seenStatuses.length" class="map-empty">{{ t("statusMapEmpty") }}</div>
    <div v-else class="map-list">
      <div v-for="s in seenStatuses" :key="s" class="map-row">
        <span class="map-status" :title="s">{{ s }}</span>
        <span class="map-arrow">→</span>
        <select
          class="field-input map-select"
          :value="bucketOf(s)"
          @change="onBucketChange(s, $event)"
        >
          <option v-for="b in buckets" :key="b.id" :value="b.id">{{ t(b.labelKey) }}</option>
        </select>
      </div>
    </div>
  </div>

  <!-- Pairing code (only while not bound) -->
  <div v-if="!bound" class="card">
    <div class="field-label">{{ t("pairingCode") }}</div>
    <input
      v-model="pairingCode"
      type="text"
      class="field-input"
      :placeholder="t('pairingCodePlaceholder')"
      autocomplete="off"
      spellcheck="false"
      @keyup.enter="bind"
    />
    <div class="field-hint">{{ t("pairingCodeHint") }}</div>
    <button
      type="button"
      class="save-btn bind-btn"
      :disabled="binding || !pairingCode.trim() || !resolverUrl.trim()"
      @click="bind"
    >
      {{ binding ? t("binding") : t("bindDevice") }}
    </button>
  </div>

  <div v-if="errorMsg" class="err">{{ errorMsg }}</div>
</template>

<style scoped>
.intro {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 4px;
}

/* Field styling mirrored from SettingsPanel (its rules are scoped, not global). */
.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.field-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--stroke-strong);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 13px;
  font-family: var(--segoe);
  outline: none;
  color-scheme: dark;
  transition: border-color 120ms, background 120ms;
}
.field-input:focus {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
}
.field-input::placeholder {
  color: var(--text-4);
}
.field-hint {
  font-size: 13px;
  color: var(--text-4);
  margin-top: 6px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.ok {
  background: #4ade80;
}
.status-dot.off {
  background: var(--text-4);
}
.status-text {
  font-size: 13px;
  color: var(--text-2);
}

.bound-meta {
  margin-top: 10px;
}
.meta-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 12.5px;
}
.meta-key {
  color: var(--text-4);
}
.meta-val {
  color: var(--text-2);
  text-align: right;
  word-break: break-all;
}
.meta-val.mono {
  font-family: var(--mono, monospace);
  font-variant-numeric: tabular-nums;
}

.save-btn {
  width: 100%;
  padding: 9px;
  border: none;
  border-radius: var(--card-radius);
  background: var(--accent);
  color: white;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--segoe);
  cursor: pointer;
  transition: filter 120ms;
}
.save-btn:hover {
  filter: brightness(1.15);
}
.save-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.bind-btn {
  margin-top: 12px;
}

.ghost-btn {
  margin-top: 12px;
  padding: 7px 12px;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.ghost-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}

.err {
  font-size: 12.5px;
  color: #f87171;
  padding: 4px 2px;
}

/* Status mapper */
.map-empty {
  font-size: 12.5px;
  color: var(--text-4);
  padding: 6px 0 2px;
}
.map-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.map-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.map-status {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-2);
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.map-arrow {
  flex-shrink: 0;
  color: var(--text-4);
}
.map-select {
  flex: 0 0 140px;
  width: 140px;
  padding: 6px 8px;
  cursor: pointer;
  color-scheme: dark;
}
/* WebView2 renders the native dropdown light by default → white-on-white. Pin the
   option background/text to the dark surface so the list is readable. */
.map-select option {
  background: var(--card-bg);
  color: var(--text);
}
</style>
