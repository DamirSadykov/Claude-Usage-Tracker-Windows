<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

interface DutyState {
  mode: string;
  provider: string;
  model: string;
}

interface FlowNode {
  key: string;
  label: string;
  sub?: string;
  note?: string;
  warn?: string;
  dimmed?: boolean;
  struck?: boolean;
}

const props = defineProps<{
  critic: DutyState;
  architect: DutyState;
  worker: DutyState;
  review: DutyState;
  planInstalled: boolean;
}>();

const { t } = useI18n();

const criticOff = computed(() => props.critic.mode === "off");
const criticSub = computed(() => {
  if (criticOff.value) return t("agentMode_off");
  if (props.critic.mode === "session") return t("agentMode_session");
  return `${props.critic.provider}/${props.critic.model}`;
});

const architectOff = computed(() => props.architect.mode === "off");
const gateSub = computed(() => {
  if (!props.planInstalled) return t("wfGateNotWired");
  if (architectOff.value) return t("wfGateFormatOnly");
  return `${props.architect.provider}/${props.architect.model}`;
});

const reviewOff = computed(() => props.review.mode === "off");
const reviewSub = computed(() => (reviewOff.value ? t("agentMode_off") : `${props.review.provider}/${props.review.model}`));

const interactiveNodes = computed<FlowNode[]>(() => [
  { key: "request", label: t("wfUserRequest") },
  {
    key: "critic",
    label: t("agentDuty_critic"),
    sub: criticSub.value,
    dimmed: criticOff.value,
    struck: criticOff.value,
  },
  { key: "planmode", label: t("wfPlanMode") },
  {
    key: "gate",
    label: t("wfPlanGate"),
    sub: gateSub.value,
    dimmed: !props.planInstalled,
    warn: !props.planInstalled ? t("wfGateWarning") : "",
    note: props.planInstalled && architectOff.value ? t("wfGateArchitectOffNote") : "",
  },
  { key: "implementation", label: t("wfImplementation") },
  { key: "verify1", label: t("wfVerify") },
]);

const runnerNodes = computed<FlowNode[]>(() => [
  { key: "ready", label: t("wfReadyStep") },
  { key: "worker", label: t("agentDuty_worker"), sub: `${props.worker.provider}/${props.worker.model}` },
  {
    key: "review",
    label: t("agentDuty_review"),
    sub: reviewSub.value,
    dimmed: reviewOff.value,
  },
  { key: "verify2", label: t("wfVerifyReconcile") },
  { key: "next", label: t("wfNextStep") },
]);
</script>

<template>
  <div class="card wf-card">
    <div class="card-title">{{ t('workflowGraphTitle') }}</div>
    <div class="card-sub">{{ t('workflowGraphDesc') }}</div>

    <div class="wf-lane-label">
      <span class="wf-lane-dot wf-lane-dot-interactive"></span>
      {{ t('wfLaneInteractive') }}
    </div>
    <div class="wf-lane-scroll">
      <div class="wf-lane">
        <template v-for="(n, i) in interactiveNodes" :key="n.key">
          <div class="wf-node" :class="{ dimmed: n.dimmed, struck: n.struck }">
            <div class="wf-node-label">{{ n.label }}</div>
            <div v-if="n.sub" class="wf-node-sub">{{ n.sub }}</div>
            <div v-if="n.note" class="wf-node-note">{{ n.note }}</div>
            <div v-if="n.warn" class="wf-node-warn">{{ n.warn }}</div>
          </div>
          <div v-if="i < interactiveNodes.length - 1" class="wf-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 10" width="24" height="10">
              <line x1="0" y1="5" x2="18" y2="5" stroke="currentColor" stroke-width="1.6" />
              <path d="M14 1 L20 5 L14 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
            </svg>
          </div>
        </template>
      </div>
    </div>

    <div class="wf-lane-label">
      <span class="wf-lane-dot wf-lane-dot-runner"></span>
      {{ t('wfLaneRunner') }}
      <span class="wf-lane-tag">{{ t('wfLaneRunnerTag') }}</span>
    </div>
    <div class="wf-lane-scroll">
      <div class="wf-lane">
        <template v-for="(n, i) in runnerNodes" :key="n.key">
          <div class="wf-node" :class="{ dimmed: n.dimmed, struck: n.struck }">
            <div class="wf-node-label">{{ n.label }}</div>
            <div v-if="n.sub" class="wf-node-sub">{{ n.sub }}</div>
          </div>
          <div v-if="i < runnerNodes.length - 1" class="wf-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 10" width="24" height="10">
              <line x1="0" y1="5" x2="18" y2="5" stroke="currentColor" stroke-width="1.6" />
              <path d="M14 1 L20 5 L14 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
            </svg>
          </div>
        </template>
      </div>
    </div>

    <div class="wf-legend">
      <span class="wf-legend-item"><span class="wf-lane-dot wf-lane-dot-interactive"></span>{{ t('wfLegendInteractive') }}</span>
      <span class="wf-legend-item"><span class="wf-lane-dot wf-lane-dot-runner"></span>{{ t('wfLegendRunner') }}</span>
      <span class="wf-legend-item"><span class="wf-legend-swatch wf-legend-dimmed"></span>{{ t('wfLegendDimmed') }}</span>
    </div>
  </div>
</template>

<style scoped>
.wf-card {
  cursor: default;
}
.wf-lane-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  margin: 14px 0 6px;
}
.wf-lane-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wf-lane-dot-interactive {
  background: var(--accent);
}
.wf-lane-dot-runner {
  background: var(--text-3);
}
.wf-lane-tag {
  font-size: 10px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  padding: 1px 7px;
  border: 1px solid var(--stroke-strong);
  border-radius: 999px;
  color: var(--text-4);
}
.wf-lane-scroll {
  overflow-x: auto;
  padding-bottom: 4px;
}
.wf-lane {
  display: flex;
  align-items: stretch;
  gap: 2px;
  min-width: max-content;
  padding: 2px;
}
.wf-node {
  flex: 0 0 auto;
  width: 118px;
  padding: 8px 8px;
  border: 1px solid var(--stroke-strong);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  text-align: center;
}
.wf-node-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.25;
}
.wf-node-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.25;
  word-break: break-word;
}
.wf-node-note {
  font-size: 10.5px;
  color: var(--text-4);
  margin-top: 3px;
  line-height: 1.3;
}
.wf-node-warn {
  font-size: 10.5px;
  color: var(--warning);
  margin-top: 4px;
  line-height: 1.3;
}
.wf-node.dimmed {
  opacity: 0.5;
  border-style: dashed;
  background: transparent;
}
.wf-node.dimmed .wf-node-label {
  color: var(--text-4);
}
.wf-node.struck .wf-node-label {
  text-decoration: line-through;
}
.wf-arrow {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  color: var(--text-4);
}
.wf-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--stroke);
  font-size: 11px;
  color: var(--text-4);
}
.wf-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wf-legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  border: 1px dashed var(--stroke-strong);
  opacity: 0.5;
  flex-shrink: 0;
}
</style>
