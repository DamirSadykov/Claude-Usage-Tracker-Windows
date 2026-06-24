# Phase 2: Tracker watcher

Add spawn_triage_loop in lib.rs modeled on spawn_memory_loop: watch triage-digest.json, on a fresh digest emit("triage-alert"); frontend raises a desktop notification like memory-alert/service-alert. Debounce so the same digest fires once.
