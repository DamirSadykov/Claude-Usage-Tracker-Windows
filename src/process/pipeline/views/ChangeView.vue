<script setup lang="ts">
import { computed } from "vue";
import AppBar from "../../atoms/AppBar.vue";
import SegControl from "../../atoms/SegControl.vue";
import StatusChip from "../../atoms/StatusChip.vue";
import MetaChip from "../../atoms/MetaChip.vue";
import ToolButton from "../../atoms/ToolButton.vue";
import ChangeDetail from "../ChangeDetail.vue";
import { useChange } from "../useChange";
import { changeAddress } from "../changeAdapt";
import { formatMoney } from "../adapt";

withDefaults(defineProps<{ chrome?: boolean }>(), { chrome: true });
const emit = defineEmits<{
    (e: "mode", value: "lanes" | "wires" | "rings" | "specs" | "reader" | "review" | "change"): void;
    (e: "open", id: string): void;
}>();
const cc = useChange();
const address = computed(() => cc.current.value ? changeAddress(cc.current.value) : "");
const headline = computed(() => cc.current.value ? `CHANGE ${address.value} · ${cc.current.value.title}` : "CHANGE");
const budgetText = computed(() => cc.current.value?.budget_usd !== undefined ? `лимит ${formatMoney(cc.current.value.budget_usd)}` : "лимит не задан");
</script>

<template>
    <AppBar v-if="chrome" :title="headline">
        <template #center><StatusChip v-if="cc.current.value" :text="budgetText" tone="cost" /><StatusChip v-if="cc.current.value" :text="cc.open.value ? 'открыт' : 'закрыт'" :tone="cc.open.value ? 'default' : 'spec'" /></template>
        <template #right>
            <SegControl :model-value="'change'" :options="[{ id: 'graph', label: 'Граф' }, { id: 'specs', label: 'Спеки' }, { id: 'change', label: 'Change' }]" @update:model-value="(value: string) => emit('mode', value === 'specs' ? 'reader' : value === 'change' ? 'change' : 'lanes')" />
            <div class="change-picker"><MetaChip v-for="c in cc.changes.value" :key="c.id" class="picker-chip" :tone="changeAddress(c) === address ? 'spec' : 'muted'" @click="cc.select(changeAddress(c))">{{ changeAddress(c) }}</MetaChip></div>
            <ToolButton v-if="cc.current.value && cc.live.value" variant="warn" :active="cc.closing.value" @click="cc.closeChange()">Закрыть change</ToolButton>
        </template>
    </AppBar>
    <div class="pipe-canvas plain change-shell"><ChangeDetail :address="address" @open="emit('open', $event)" /></div>
</template>

<style scoped>
.change-shell { padding: 14px 20px 28px; overflow-y: auto; }.change-picker { display: flex; align-items: center; gap: 4px; max-width: 260px; overflow-x: auto; }.picker-chip { cursor: pointer; flex: none; }
</style>
