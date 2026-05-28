<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ALERT_TIER_KEYS, normalizeAlertTiers } from "../thresholds";
import type { AlertTiers, AlertTierKey } from "../thresholds";

const TIER_LABELS: Record<AlertTierKey, string> = {
  five_hour: "session5h",
  seven_day: "weekly7d",
  seven_day_opus: "opusWeekly",
  seven_day_sonnet: "sonnetWeekly",
  extra_usage: "extraUsage",
};

const { t } = useI18n();

const props = defineProps<{
  sessionKey: string;
  orgId: string;
  refreshInterval: number;
  autoStartSession: boolean;
  thresholds: number[];
  notificationsEnabled: boolean;
  notifyForecastMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  alertTiers: AlertTiers;
  locale: string;
}>();

const emit = defineEmits<{
  save: [settings: {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    thresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    alertTiers: AlertTiers;
    locale: string;
  }];
}>();

const localSessionKey = ref(props.sessionKey);
const localOrgId = ref(props.orgId);
const localInterval = ref(props.refreshInterval);
const localAutoStart = ref(props.autoStartSession);
const localT1 = ref(props.thresholds[0] ?? 25);
const localT2 = ref(props.thresholds[1] ?? 50);
const localT3 = ref(props.thresholds[2] ?? 75);
const localNotify = ref(props.notificationsEnabled);
const localForecast = ref(props.notifyForecastMinutes);
const localQuiet = ref(props.quietHoursEnabled);
const localQuietStart = ref(props.quietHoursStart);
const localQuietEnd = ref(props.quietHoursEnd);
const localTiers = ref<AlertTiers>(normalizeAlertTiers(props.alertTiers));
const localLocale = ref(props.locale);

watch(() => props.sessionKey, (v) => (localSessionKey.value = v));
watch(() => props.orgId, (v) => (localOrgId.value = v));
watch(() => props.autoStartSession, (v) => (localAutoStart.value = v));
watch(() => props.thresholds, (v) => {
  localT1.value = v[0] ?? 25;
  localT2.value = v[1] ?? 50;
  localT3.value = v[2] ?? 75;
});
watch(() => props.notificationsEnabled, (v) => (localNotify.value = v));
watch(() => props.notifyForecastMinutes, (v) => (localForecast.value = v));
watch(() => props.quietHoursEnabled, (v) => (localQuiet.value = v));
watch(() => props.quietHoursStart, (v) => (localQuietStart.value = v));
watch(() => props.quietHoursEnd, (v) => (localQuietEnd.value = v));
watch(() => props.alertTiers, (v) => (localTiers.value = normalizeAlertTiers(v)));
watch(() => props.locale, (v) => (localLocale.value = v));

// Keep thresholds strictly ascending with a 1% gap so the colour bands can't
// overlap. Fixed slider scale (5..99) + clamping — dynamic min/max would make
// neighbouring thumbs visually drift when their range changes.
const GAP = 1;
watch(localT1, (v) => {
  if (v >= localT2.value) localT1.value = localT2.value - GAP;
});
watch(localT2, (v) => {
  if (v <= localT1.value) localT2.value = localT1.value + GAP;
  else if (v >= localT3.value) localT2.value = localT3.value - GAP;
});
watch(localT3, (v) => {
  if (v <= localT2.value) localT3.value = localT2.value + GAP;
});

function handleSave() {
  emit("save", {
    sessionKey: localSessionKey.value.trim(),
    orgId: localOrgId.value.trim(),
    refreshInterval: localInterval.value,
    autoStartSession: localAutoStart.value,
    thresholds: [localT1.value, localT2.value, localT3.value],
    notificationsEnabled: localNotify.value,
    notifyForecastMinutes: localForecast.value,
    quietHoursEnabled: localQuiet.value,
    quietHoursStart: localQuietStart.value,
    quietHoursEnd: localQuietEnd.value,
    alertTiers: { ...localTiers.value },
    locale: localLocale.value,
  });
}
</script>

<template>
  <form class="settings-form" @submit.prevent="handleSave">
    <div class="cards">
      <!-- Session Key -->
      <div class="card">
        <div class="field-label">{{ t('sessionKey') }}</div>
        <input
          v-model="localSessionKey"
          type="password"
          class="field-input"
          :placeholder="t('sessionKeyPlaceholder')"
          autocomplete="off"
        />
        <div class="field-hint">{{ t('sessionKeyHint') }}</div>
      </div>

      <!-- Org ID -->
      <div class="card">
        <div class="field-label">{{ t('orgId') }}</div>
        <input
          v-model="localOrgId"
          type="text"
          class="field-input"
          :placeholder="t('orgIdPlaceholder')"
          autocomplete="off"
        />
        <div class="field-hint">{{ t('orgIdHint') }}</div>
      </div>

      <!-- Refresh interval -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('refreshInterval') }}</div>
          <span class="pct muted" style="font-size: 14px">{{ localInterval }}s</span>
        </div>
        <input
          v-model.number="localInterval"
          type="range"
          class="field-range"
          min="10"
          max="300"
          step="5"
        />
      </div>

      <!-- Language -->
      <div class="card">
        <div class="card-row" style="align-items: center">
          <div class="field-label" style="margin-bottom: 0">{{ t('language') }}</div>
          <div class="lang-switch">
            <button
              type="button"
              class="lang-btn"
              :class="{ active: localLocale === 'en' }"
              @click="localLocale = 'en'"
            >EN</button>
            <button
              type="button"
              class="lang-btn"
              :class="{ active: localLocale === 'ru' }"
              @click="localLocale = 'ru'"
            >RU</button>
          </div>
        </div>
      </div>

      <!-- Auto-start toggle -->
      <div class="card toggle-card" @click="localAutoStart = !localAutoStart">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('autoStartSession') }}</div>
          <div class="card-sub">{{ t('autoStartDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localAutoStart }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Color thresholds (drive tray, panels and alerts) -->
      <div class="card">
        <div class="field-label">{{ t('thresholdsTitle') }}</div>
        <div class="thr-row">
          <span class="thr-dot tier-yellow"></span>
          <span class="thr-label">{{ t('thresholdYellow') }}</span>
          <input v-model.number="localT1" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localT1 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-orange"></span>
          <span class="thr-label">{{ t('thresholdOrange') }}</span>
          <input v-model.number="localT2" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localT2 }}%</span>
        </div>
        <div class="thr-row">
          <span class="thr-dot tier-red"></span>
          <span class="thr-label">{{ t('thresholdRed') }}</span>
          <input v-model.number="localT3" type="range" class="field-range thr-range" min="5" max="99" step="1" />
          <span class="thr-val">{{ localT3 }}%</span>
        </div>
        <div class="field-hint">{{ t('thresholdsDesc') }}</div>
      </div>

      <!-- Notifications toggle -->
      <div class="card toggle-card" @click="localNotify = !localNotify">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 13px">{{ t('notifications') }}</div>
          <div class="card-sub">{{ t('notificationsDesc') }}</div>
        </div>
        <div class="toggle" :class="{ on: localNotify }">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <!-- Notification settings (shown when enabled) -->
      <template v-if="localNotify">
        <!-- Per-tier toggles -->
        <div class="card">
          <div class="field-label">{{ t('alertTiersTitle') }}</div>
          <div
            v-for="key in ALERT_TIER_KEYS"
            :key="key"
            class="tier-row"
            @click="localTiers[key] = !localTiers[key]"
          >
            <span class="tier-name">{{ t(TIER_LABELS[key]) }}</span>
            <div class="toggle" :class="{ on: localTiers[key] }">
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>

        <!-- Forecast minutes -->
        <div class="card">
          <div class="card-row" style="align-items: center">
            <div class="field-label" style="margin-bottom: 0">{{ t('notifyForecast') }}</div>
            <span class="pct muted" style="font-size: 14px">{{ localForecast }} {{ t('minutesShort') }}</span>
          </div>
          <input
            v-model.number="localForecast"
            type="range"
            class="field-range"
            min="5"
            max="120"
            step="5"
          />
          <div class="field-hint">{{ t('notifyForecastDesc') }}</div>
        </div>

        <!-- Quiet hours toggle -->
        <div class="card toggle-card" @click="localQuiet = !localQuiet">
          <div style="flex: 1; min-width: 0">
            <div class="card-title" style="font-size: 13px">{{ t('quietHours') }}</div>
            <div class="card-sub">{{ t('quietHoursDesc') }}</div>
          </div>
          <div class="toggle" :class="{ on: localQuiet }">
            <div class="toggle-knob"></div>
          </div>
        </div>

        <!-- Quiet hours window -->
        <div v-if="localQuiet" class="card">
          <div class="card-row" style="align-items: center; gap: 12px">
            <div style="flex: 1">
              <div class="field-label">{{ t('quietHoursStart') }}</div>
              <input v-model="localQuietStart" type="time" class="field-input" />
            </div>
            <div style="flex: 1">
              <div class="field-label">{{ t('quietHoursEnd') }}</div>
              <input v-model="localQuietEnd" type="time" class="field-input" />
            </div>
          </div>
        </div>
      </template>
    </div>

    <div style="padding: 8px 10px 12px">
      <button type="submit" class="save-btn" :disabled="!localSessionKey || !localOrgId">
        {{ t('save') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.thr-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.thr-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.thr-dot.tier-yellow { background: #ffc107; }
.thr-dot.tier-orange { background: #d97757; }
.thr-dot.tier-red { background: #f87171; }

.thr-label {
  font-size: 12px;
  color: var(--text-3);
  width: 64px;
  flex-shrink: 0;
}

.thr-range {
  flex: 1;
  margin-top: 0;
}

.thr-val {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

.tier-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  cursor: pointer;
}

.tier-name {
  font-size: 13px;
  color: var(--text-2);
}

.field-label {
  font-size: 11.5px;
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
  font-size: 11px;
  color: var(--text-4);
  margin-top: 6px;
}

.field-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  margin-top: 8px;
  height: 20px;
  background: transparent;
  cursor: pointer;
}

.field-range::-webkit-slider-runnable-track {
  height: 4px;
  background: var(--stroke-strong);
  border-radius: 2px;
}

.field-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: -5px;
  border: none;
  transition: transform 100ms;
}

.field-range::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.toggle-card {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.toggle {
  width: 40px;
  height: 20px;
  background: var(--stroke-strong);
  border-radius: 10px;
  position: relative;
  transition: background 200ms;
  flex-shrink: 0;
}

.toggle.on {
  background: var(--accent);
}

.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  background: white;
  border-radius: 50%;
  transition: transform 200ms;
}

.toggle.on .toggle-knob {
  transform: translateX(20px);
}

.lang-switch {
  display: flex;
  gap: 0;
  border: 1px solid var(--stroke-strong);
  border-radius: 4px;
  overflow: hidden;
}

.lang-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.lang-btn + .lang-btn {
  border-left: 1px solid var(--stroke-strong);
}

.lang-btn.active {
  background: var(--accent);
  color: white;
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
</style>
