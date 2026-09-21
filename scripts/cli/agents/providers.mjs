// The one place that knows what a provider's CLI looks like.
//
// Before this module the same two shapes were spelled out five times — worker
// and review, each in a codex and a claude branch inside run-step.mjs, plus the
// synchronous role call in agents.mjs. They drifted the way duplicated argv
// always drifts: the review branches pinned `--allowedTools Read Glob Grep`
// inline while the worker branch took a list, and only one of the five passed
// `--session-id`. Adding a third provider meant five edits.
//
// What lives here is the provider's SYNTAX: how a profile becomes argv, and how
// that CLI's stdout becomes `{sessionId, answer, usage, error, costUsd}`.
// What stays with the caller is everything about the RUN — spawning, streaming,
// session binding, pricing, retry — because that is the runner's business and
// identical across providers.

// Read-only work: inspect the repo, change nothing. The write-side list belongs
// to the caller (run-step's DEFAULT_ALLOWED_TOOLS), which knows what a step is
// allowed to touch.
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

// The write/read distinction is the one thing a caller must not get wrong by a
// typo: `readonly` without the hyphen would reach codex as an unknown value and
// be answered by whatever it defaults to. Refuse it here instead.
export const SANDBOXES = ["read-only", "workspace-write"];

const split = (bin) => {
  const parts = Array.isArray(bin) ? bin : [bin];
  const [file, ...prefix] = parts;
  return { file, prefix };
};

// `sandbox` is the one axis on which a duty's call really differs: a reviewer or
// a critic reads, a worker writes. Codex takes it as a flag, Claude Code as the
// allowed-tool list, so the caller declares the intent and each adapter spells
// it its own way.
// A child session is NOT the user's session, and the user's settings layer is
// written for the latter: hooks that brief a human on the board, the workflow
// map, the KB index. A step gets its whole world from its prompt and pays for
// everything else twice — once in tokens, once in a briefing that contradicts
// "there is no earlier conversation to recall". Measured on the demo graph
// (t#543): dropping the user layer took the run from $0.4936 to $0.3228, same
// work, all checks green. Permissions are unaffected — a step carries its own
// --allowedTools and --permission-mode, and the model comes from the profile.
const CLAUDE_SETTING_SOURCES = "project";

export function providerArgv(profile, {
  bin,
  session = "",
  // Inherit a finished session's context instead of starting cold: --resume
  // hands the fork the warm prefix, --fork-session gives it its own id, so cost
  // attribution and the produces evidence stay per-step (t#543). The caller
  // that spawned the step decides; nothing here reads it off the graph.
  inherit = "",
  sandbox = "read-only",
  allowedTools = READ_ONLY_TOOLS,
  permissionMode = "acceptEdits",
} = {}) {
  const provider = String(profile?.provider || "").toLowerCase();
  const model = String(profile?.model || "").trim();
  const { file, prefix } = split(bin);
  if (!SANDBOXES.includes(sandbox)) throw new Error(`unknown sandbox "${sandbox}"`);
  if (provider === "openai") {
    const args = [...prefix, "exec", "--json", "--sandbox", sandbox];
    if (model) args.push("--model", model);
    if (profile.reasoning_effort)
      args.push("--config", `model_reasoning_effort=\"${profile.reasoning_effort}\"`);
    args.push("-");
    return { file, args };
  }
  const args = [...prefix, "-p"];
  // --resume brings its own id along; passing --session-id too is a conflict.
  if (inherit) args.push("--resume", inherit, "--fork-session");
  else if (session) args.push("--session-id", session);
  args.push("--output-format", "json", "--permission-mode", permissionMode);
  args.push("--setting-sources", CLAUDE_SETTING_SOURCES);
  if (allowedTools && allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (model) args.push("--model", model);
  return { file, args };
}

// `claude -p --output-format json` ends with one result object; older/edge
// builds may print other JSON before it, so the LAST parseable object wins.
export function parseClaudeResult(stdout) {
  const s = String(stdout ?? "").trim();
  if (!s) return null;
  try {
    const whole = JSON.parse(s);
    if (whole && typeof whole === "object") return whole;
  } catch {}
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    try {
      const rec = JSON.parse(l);
      if (rec && typeof rec === "object") return rec;
    } catch {}
  }
  return null;
}

// `codex exec --json` is an event stream. Keep parsing tolerant across CLI
// versions: the stable facts are the thread id, completed agent messages and a
// terminal usage object; unknown events are ignored.
export function parseCodexResult(stdout) {
  let sessionId = "";
  let answer = "";
  let error = "";
  let usage = null;
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (["thread.started", "session.started"].includes(rec.type))
      sessionId = String(rec.thread_id || rec.session_id || rec.id || "");
    const item = rec.item || rec.payload?.item;
    if (rec.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string")
      answer = item.text;
    if (["turn.completed", "response.completed"].includes(rec.type) && rec.usage)
      usage = rec.usage;
    if (rec.type === "error" || rec.type === "turn.failed")
      error = String(rec.message || rec.error?.message || rec.error || rec.type);
  }
  if (!sessionId && !answer && !usage && !error) return null;
  return { sessionId, answer, usage, error };
}

// The shape the callers agreed on. `raw` stays available for the few facts that
// belong to one provider only (Claude reports its own cost, Codex does not).
export function parseProviderResult(provider, stdout) {
  if (String(provider || "").toLowerCase() === "openai") {
    const parsed = parseCodexResult(stdout);
    if (!parsed) return null;
    return { ...parsed, costUsd: null, raw: parsed };
  }
  const parsed = parseClaudeResult(stdout);
  if (!parsed) return null;
  return {
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id.trim() : "",
    answer: typeof parsed.result === "string" ? parsed.result : "",
    usage: parsed.usage || null,
    error: parsed.is_error ? "the model reported an error" : "",
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    raw: parsed,
  };
}

// Codex prints its thread id long before it finishes. Watching stdout for it
// lets the runner bind the session while the step is still running, so a step
// that later times out is still attributed.
export function observeCodexThread(onThread) {
  let pending = "";
  return (chunk) => {
    pending += String(chunk || "");
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (["thread.started", "session.started"].includes(rec.type)) {
        const id = String(rec.thread_id || rec.session_id || rec.id || "");
        if (id) onThread(id);
      }
    }
  };
}
