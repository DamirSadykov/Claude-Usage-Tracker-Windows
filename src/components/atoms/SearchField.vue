<script setup lang="ts">
withDefaults(
    defineProps<{
        modelValue?: string;
        placeholder?: string;
        width?: number;
    }>(),
    { modelValue: "", placeholder: "", width: 230 },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

function onInput(event: Event) {
    emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
    <label class="search-field" :style="{ width: `${width}px` }">
        <svg
            class="search-icon"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
        >
            <circle
                cx="5.1"
                cy="5.1"
                r="3.5"
                stroke="currentColor"
                stroke-width="1.2"
            />
            <path
                d="M7.9 7.9 L10.7 10.7"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
            />
        </svg>
        <input
            type="text"
            :value="modelValue"
            :placeholder="placeholder"
            @input="onInput"
        />
    </label>
</template>

<style scoped>
.search-field {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 10px;
    background: var(--input-bg);
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    color: var(--text-4);
    font-size: 12.5px;
}
.search-icon {
    flex: none;
    color: var(--text-4);
}
.search-field input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font: inherit;
    outline: none;
}
.search-field input::placeholder {
    color: var(--text-4);
}
</style>
