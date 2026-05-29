<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";

const { t, locale } = useI18n();

const props = defineProps<{
  mutedUntil: string | null;
}>();

const emit = defineEmits<{
  mute: [until: string | null];
  notify: [title: string, body: string];
}>();

const nowMs = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  ticker = setInterval(() => {
    nowMs.value = Date.now();
    if (focusActive.value && nowMs.value >= focusEndsAt.value) {
      stopFocus(true);
    }
  }, 1000);
});

onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

// --- Pause notifications ---

const mutedActive = computed(
  () => !!props.mutedUntil && new Date(props.mutedUntil).getTime() > nowMs.value,
);

const mutedLabel = computed(() => {
  if (!props.mutedUntil) return "";
  const loc = locale.value === "ru" ? "ru-RU" : "en-US";
  return new Date(props.mutedUntil).toLocaleTimeString(loc, {
    hour: "2-digit",
    minute: "2-digit",
  });
});

function pauseFor(minutes: number) {
  emit("mute", new Date(Date.now() + minutes * 60000).toISOString());
}

function pauseUntilMorning() {
  const target = new Date();
  target.setHours(8, 0, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  emit("mute", target.toISOString());
}

function resumeNotifications() {
  emit("mute", null);
}

// --- Focus timer ---

const focusActive = ref(false);
const focusEndsAt = ref(0);
const focusDuration = ref(25);

const focusRemaining = computed(() => {
  const ms = Math.max(0, focusEndsAt.value - nowMs.value);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
});

function startFocus() {
  const mins = Math.max(1, Math.round(focusDuration.value));
  focusEndsAt.value = Date.now() + mins * 60000;
  focusActive.value = true;
}

function stopFocus(completed: boolean) {
  focusActive.value = false;
  if (completed) {
    emit("notify", t("focusEnded"), t("focusEndedBody"));
  }
}
</script>

<template>
  <div class="cards focus-controls">
    <div class="card focus-card">
      <!-- Pause notifications -->
      <div class="focus-section">
        <div class="focus-head">{{ t("pauseNotif") }}</div>
        <div v-if="mutedActive" class="focus-active-row">
          <span class="focus-status">{{ t("pausedUntil", { time: mutedLabel }) }}</span>
          <button class="chip-btn" @click="resumeNotifications">
            {{ t("resumeNotif") }}
          </button>
        </div>
        <div v-else class="chip-row">
          <button class="chip-btn" @click="pauseFor(30)">{{ t("pause30m") }}</button>
          <button class="chip-btn" @click="pauseFor(60)">{{ t("pause1h") }}</button>
          <button class="chip-btn" @click="pauseUntilMorning">
            {{ t("pauseMorning") }}
          </button>
        </div>
      </div>

      <div class="focus-divider"></div>

      <!-- Focus timer -->
      <div class="focus-section">
        <div class="focus-head">{{ t("focusTitle") }}</div>
        <div v-if="focusActive" class="focus-active-row">
          <span class="focus-countdown">{{ focusRemaining }}</span>
          <button class="chip-btn" @click="stopFocus(false)">{{ t("focusStop") }}</button>
        </div>
        <div v-else class="focus-start-row">
          <label class="focus-dur">
            <input
              type="number"
              min="1"
              max="240"
              v-model.number="focusDuration"
            />
            <span>{{ t("focusDuration") }}</span>
          </label>
          <button class="chip-btn primary" @click="startFocus">
            {{ t("focusStart") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.focus-controls {
  padding-top: 0;
}
.focus-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.focus-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.focus-head {
  font-size: 12px;
  color: var(--text-3);
}
.focus-divider {
  height: 1px;
  background: var(--stroke-strong);
  opacity: 0.5;
}
.chip-row,
.focus-active-row,
.focus-start-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.focus-active-row {
  justify-content: space-between;
}
.chip-btn {
  padding: 5px 10px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--card-radius);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-2);
  font-size: 12px;
  font-family: var(--segoe);
  cursor: pointer;
  transition: background 120ms;
}
.chip-btn:hover {
  background: var(--card-bg-hover);
}
.chip-btn.primary {
  background: var(--accent);
  color: white;
  border-color: transparent;
}
.focus-status {
  font-size: 12px;
  color: var(--text-2);
}
.focus-countdown {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}
.focus-dur {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.focus-dur input {
  width: 56px;
  padding: 5px 8px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--card-radius);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-2);
  font-size: 12px;
  font-family: var(--segoe);
}
</style>
