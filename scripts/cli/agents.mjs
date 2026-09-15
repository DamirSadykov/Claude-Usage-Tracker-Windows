// Global lifecycle routing: each responsibility resolves to one provider/model.
// Tasks never carry model assignments. The configuration lives beside
// todos.json rather than in settings.json so the Tauri settings writer cannot
// race this CLI.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { READ_ONLY_TOOLS, parseProviderResult, providerArgv } from "./providers.mjs";
import { dutyModeReader } from "./duty-mode.mjs";

export const AGENT_PROVIDER_MANIFEST = JSON.parse(
  readFileSync(new URL("./agent-providers.json", import.meta.url), "utf8"),
);
export const AGENT_CONFIG_VERSION = 4;
export const PROVIDERS = Object.keys(AGENT_PROVIDER_MANIFEST.providers);
export const DUTIES = ["critic", "architect", "worker", "review"];
export const PROVIDER_MODELS = Object.fromEntries(
  Object.entries(AGENT_PROVIDER_MANIFEST.providers).map(([provider, config]) => [
    provider,
    [...config.models],
  ]),
);
export const STARTER_DUTIES = structuredClone(AGENT_PROVIDER_MANIFEST.duties);
// WHO performs a duty, one field per duty, values declared per duty in the
// manifest. `off` — the step does not happen. `session` — the main session does
// the pass itself, spending no second model. `agent` — the configured
// provider/model is called. `always` — the duty is the executor and cannot be
// turned off (worker). Before v4 this lived in two places at once, a `hooks`
// map of booleans plus a separate `criticMode`, which is why nothing could be
// rendered or set uniformly. The single reading of that migration lives in
// duty-mode.mjs, shared with the Vue settings panel.
const dutyMode = dutyModeReader(AGENT_PROVIDER_MANIFEST);
export const DUTY_MODES = Object.fromEntries(DUTIES.map((duty) => [duty, dutyMode.dutyModes(duty)]));
export const dutyModes = dutyMode.dutyModes;
export const starterMode = dutyMode.starterMode;
export const cleanMode = dutyMode.cleanMode;

function appDataBase(appData) {
  return (
    appData ||
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming")
  );
}

export function agentsPath(appData) {
  return path.join(
    appDataBase(appData),
    "com.claude-usage-tracker.app",
    "agents.json",
  );
}

export function emptyAgentConfig() {
  return {
    version: AGENT_CONFIG_VERSION,
    duties: structuredClone(STARTER_DUTIES),
  };
}

function cleanProfile(value, duty) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = String(value.provider || "").trim().toLowerCase();
  const model = String(value.model || "").trim();
  if (!PROVIDERS.includes(provider) || !PROVIDER_MODELS[provider].includes(model)) return null;
  const out = { mode: cleanMode(duty, value.mode) || starterMode(duty), provider, model };
  for (const key of ["role", "instructions", "reasoning_effort"]) {
    const v = String(value[key] || "").trim();
    if (v) out[key] = v;
  }
  for (const key of ["input_cost_per_million", "cached_input_cost_per_million", "output_cost_per_million"]) {
    const v = Number(value[key]);
    if (Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

export function readAgentConfig(appData) {
  const file = agentsPath(appData);
  if (!existsSync(file)) return emptyAgentConfig();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // v1 used arbitrary task profiles. Read its conventional names once so an
    // existing architect/reviewer setup keeps working after the lifecycle map.
    const source = raw?.duties || {
      architect: raw?.profiles?.architect,
      worker: raw?.profiles?.worker,
      review: raw?.profiles?.review || raw?.profiles?.reviewer,
    };
    const duties = structuredClone(STARTER_DUTIES);
    for (const [name, value] of Object.entries(source || {})) {
      const key = String(name).trim().toLowerCase();
      if (!DUTIES.includes(key)) continue;
      const profile = cleanProfile(value, key);
      if (profile) duties[key] = profile;
    }
    // A duty whose own `mode` was absent (v1–v3 files, or a profile the manifest
    // rejected) takes the mode the legacy switches implied, and the starter mode
    // only when they said nothing either.
    for (const duty of DUTIES) {
      duties[duty].mode = dutyMode.resolveMode(duty, source?.[duty], raw);
    }
    return { version: AGENT_CONFIG_VERSION, duties };
  } catch {
    return emptyAgentConfig();
  }
}

export function saveAgentConfig(config, appData) {
  const file = agentsPath(appData);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

// The lifecycle chooses the duty; tasks do not carry model assignments. A
// missing worker mapping preserves the historical unpinned Claude executor.
// `enabled` says the step happens at all, `runsAsAgent` that performing it
// spends the configured model — the two differ exactly for a `session` critic.
export function resolveDuty(duty, appData) {
  if (!DUTIES.includes(duty)) throw new Error(`unknown model duty "${duty}"`);
  const cfg = readAgentConfig(appData);
  const base = cfg.duties[duty] || {};
  const provider = String(base.provider || "anthropic").toLowerCase();
  const model = String(base.model || "").trim();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider "${provider}" for duty "${duty}"`);
  }
  const mode = cleanMode(duty, base.mode) || starterMode(duty);
  return {
    name: duty,
    duty,
    ...base,
    provider,
    model: model || null,
    mode,
    enabled: mode !== "off",
    runsAsAgent: mode === "agent" || mode === "always",
  };
}

// `off` | `session` | `agent`. Callers that inject context ask for the mode; the
// one caller that can spend a model asks whether it runs as an agent.
export function criticMode(appData) {
  return resolveDuty("critic", appData).mode;
}

export function criticRunsAsAgent(appData) {
  return resolveDuty("critic", appData).runsAsAgent;
}

// Hook-safe, bounded role call. Failures are returned to the hook, whose policy
// decides whether to fail open; credentials come from the provider CLI itself.
export function invokeDutySync(duty, prompt, {
  cwd = process.cwd(), timeoutMs = 90_000,
  claudeBin = process.env.CLAUDE_BIN || "claude",
  codexBin = process.env.CODEX_BIN || "codex",
} = {}) {
  const p = resolveDuty(duty);
  if (!p.runsAsAgent || !p.model) return { skipped: true, ok: true, text: "", profile: p };
  const { file, args } = providerArgv(p, {
    bin: p.provider === "openai" ? codexBin : claudeBin,
    sandbox: "read-only",
    allowedTools: READ_ONLY_TOOLS,
  });
  const fullPrompt = [p.instructions, prompt].filter(Boolean).join("\n\n");
  const run = spawnSync(file, args, {
    cwd, input: String(fullPrompt), encoding: "utf8", windowsHide: true,
    timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    // A child CLI can use the same global lifecycle hook as an interactive
    // session. Tell that hook the assigned duty explicitly: model inference is
    // only a fallback and must not turn an Opus reviewer into an architect.
    env: {
      ...process.env,
      TRACKER_DUTY: p.role || duty,
      TRACKER_SESSION_KIND: "runner",
    },
  });
  if (run.error || run.status !== 0)
    return { ok: false, error: run.error?.message || String(run.stderr || `exit ${run.status}`), text: "", profile: p };
  const parsed = parseProviderResult(p.provider, run.stdout);
  const text = String(parsed?.answer || "");
  return { ok: !!text && !parsed?.error, error: parsed?.error || "", text, profile: p };
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) positional.push(a);
    else {
      const key = a.slice(2);
      const next = args[i + 1];
      flags[key] = next === undefined || next.startsWith("--") ? true : next;
      if (flags[key] !== true) i++;
    }
  }
  return { positional, flags };
}

function fail(message) {
  throw new Error(message);
}

function cmdInit(args) {
  const { flags } = parseFlags(args);
  if (existsSync(agentsPath()) && !flags.force)
    fail("agents.json already has a duty map; pass --force to replace it with the starter set");
  const config = emptyAgentConfig();
  const file = saveAgentConfig(config);
  process.stdout.write(`ok: wrote ${Object.keys(config.duties).length} duty mappings -> ${file}\n`);
}

function cmdSet(args) {
  const { positional, flags } = parseFlags(args);
  const name = String(positional[0] || "").trim().toLowerCase();
  if (!DUTIES.includes(name)) fail(`usage: cli agents set <${DUTIES.join("|")}> --provider anthropic|openai --model <id>`);
  const cfg = readAgentConfig();
  const before = cfg.duties[name] || {};
  const candidate = {
    ...before,
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(flags.provider ? { provider: flags.provider } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.role ? { role: flags.role } : {}),
    ...(flags.instructions ? { instructions: flags.instructions } : {}),
    ...(flags.reasoning ? { reasoning_effort: flags.reasoning } : {}),
  };
  if (flags.mode && !cleanMode(name, flags.mode))
    fail(`${name} takes mode ${dutyModes(name).join(" | ")}`);
  const profile = cleanProfile(candidate, name);
  if (!profile) fail(`model does not belong to provider (anthropic: ${PROVIDER_MODELS.anthropic.join(", ")}; openai: ${PROVIDER_MODELS.openai.join(", ")})`);
  cfg.duties[name] = profile;
  saveAgentConfig(cfg);
  process.stdout.write(`ok: ${name} [${profile.mode}] -> ${profile.provider}/${profile.model}\n`);
}

function setMode(duty, value) {
  const name = String(duty || "").trim().toLowerCase();
  if (!DUTIES.includes(name)) fail(`usage: cli agents mode <${DUTIES.join("|")}> <value>`);
  const mode = cleanMode(name, value);
  if (!mode) fail(`${name} takes mode ${dutyModes(name).join(" | ")}`);
  const cfg = readAgentConfig();
  cfg.duties[name].mode = mode;
  saveAgentConfig(cfg);
  process.stdout.write(`ok: ${name} -> ${mode}\n`);
}

function cmdMode(args) {
  setMode(args[0], args[1]);
}

// The v3 spelling, kept because it is in muscle memory and in older notes.
function cmdHook(args) {
  const state = String(args[1] || "").trim().toLowerCase();
  if (!["on", "off"].includes(state))
    fail("usage: cli agents hook <critic|architect|review> <on|off>");
  const duty = String(args[0] || "").trim().toLowerCase();
  const on = duty === "critic" ? "session" : "agent";
  setMode(duty, state === "on" ? on : "off");
}

function cmdCriticMode(args) {
  setMode("critic", args[0]);
}

function cmdList(json = false) {
  const cfg = readAgentConfig();
  if (json) return process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  for (const name of DUTIES) {
    const p = cfg.duties[name];
    if (!p) continue;
    process.stdout.write(
      `${name.padEnd(10)} ${String(p.mode).padEnd(8)} ${p.provider}/${p.model}\n`,
    );
  }
}

function usage() {
  process.stdout.write(
    "cli agents - lifecycle duty -> provider/model map\n\n" +
      "  init [--force]\n" +
      "  list [--json]\n" +
      "  set <critic|architect|worker|review> --provider anthropic|openai --model <id> [--mode <value>]\n" +
      "             [--role <name>] [--instructions <text>] [--reasoning <level>]\n" +
      `  mode <duty> <value>   who performs the duty — ${DUTIES.map((d) => `${d}: ${dutyModes(d).join("|")}`).join("; ")}\n` +
      "  hook <critic|architect|review> <on|off>   the v3 spelling of `mode`\n" +
      "  critic-mode <session|agent>               the v3 spelling of `mode critic`\n" +
      "  path\n\n" +
      "The lifecycle selects the duty; individual tasks do not select models.\n",
  );
}

export function run(args) {
  const [cmd, ...rest] = args;
  if (cmd === "init") return cmdInit(rest);
  if (cmd === "set") return cmdSet(rest);
  if (cmd === "mode") return cmdMode(rest);
  if (cmd === "hook") return cmdHook(rest);
  if (cmd === "critic-mode") return cmdCriticMode(rest);
  if (cmd === "list") return cmdList(rest.includes("--json"));
  if (cmd === "path") return process.stdout.write(agentsPath() + "\n");
  if (cmd === undefined || ["help", "-h", "--help"].includes(cmd)) return usage();
  fail(`unknown agents command: ${cmd}`);
}
