<script setup lang="ts">
withDefaults(
    defineProps<{ tone?: "muted" | "theme" | "accent" }>(),
    { tone: "muted" },
);
</script>

<template>
    <span class="kicker" :class="`tone-${tone}`">
        <slot />
    </span>
</template>

<style scoped>
.kicker {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.13em;
}
.kicker.tone-muted {
    color: var(--text-4);
}
.kicker.tone-theme {
    color: var(--theme);
}
.kicker.tone-accent {
    color: var(--accent);
}
</style>
