export function dutyModeReader(manifest) {
  const modes = manifest?.modes || {};
  const duties = manifest?.duties || {};

  function dutyModes(duty) {
    return [...(modes[duty] || [])];
  }

  function starterMode(duty) {
    return duties[duty]?.mode || dutyModes(duty)[0];
  }

  function cleanMode(duty, value) {
    const mode = String(value || "").trim().toLowerCase();
    return dutyModes(duty).includes(mode) ? mode : "";
  }

  function migratedMode(duty, legacy) {
    if (duty === "worker") return "always";
    const hooks = legacy?.hooks;
    if (hooks && hooks[duty] === false) return "off";
    if (duty === "critic") {
      const legacyCriticMode = cleanMode("critic", legacy?.criticMode);
      if (legacyCriticMode) return legacyCriticMode;
      return hooks && hooks.critic === true ? "session" : "";
    }
    return hooks && hooks[duty] === true ? "agent" : "";
  }

  function resolveMode(duty, profile, legacy) {
    return cleanMode(duty, profile?.mode) || migratedMode(duty, legacy) || starterMode(duty);
  }

  return { dutyModes, starterMode, cleanMode, migratedMode, resolveMode };
}
