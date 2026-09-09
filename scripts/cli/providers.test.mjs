import { describe, it, expect, vi } from "vitest";
import {
  READ_ONLY_TOOLS,
  providerArgv,
  parseProviderResult,
  observeCodexThread,
  SANDBOXES,
} from "./providers.mjs";

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join("\n");

describe("providerArgv · openai", () => {
  it("builds codex exec argv ending in a bare dash", () => {
    const { file, args } = providerArgv(
      { provider: "openai" },
      { bin: "codex", sandbox: "workspace-write" },
    );
    expect(file).toBe("codex");
    expect(args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-"]);
  });

  it("passes the worker's workspace-write sandbox through untouched", () => {
    const { args } = providerArgv(
      { provider: "openai" },
      { bin: "codex", sandbox: "workspace-write" },
    );
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("read-only");
  });

  it("passes the reviewer/critic's read-only sandbox through untouched", () => {
    const { args } = providerArgv(
      { provider: "openai" },
      { bin: "codex", sandbox: "read-only" },
    );
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });

  it("adds --model only when the profile has one", () => {
    const withModel = providerArgv(
      { provider: "openai", model: "gpt-5.6-terra" },
      { bin: "codex", sandbox: "read-only" },
    );
    expect(withModel.args).toContain("--model");
    expect(withModel.args[withModel.args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");

    const withoutModel = providerArgv({ provider: "openai" }, { bin: "codex", sandbox: "read-only" });
    expect(withoutModel.args).not.toContain("--model");
  });

  it("adds the reasoning effort config only when the profile sets one", () => {
    const withEffort = providerArgv(
      { provider: "openai", reasoning_effort: "high" },
      { bin: "codex", sandbox: "read-only" },
    );
    expect(withEffort.args).toContain("--config");
    expect(withEffort.args[withEffort.args.indexOf("--config") + 1]).toBe(
      'model_reasoning_effort="high"',
    );

    const withoutEffort = providerArgv({ provider: "openai" }, { bin: "codex", sandbox: "read-only" });
    expect(withoutEffort.args).not.toContain("--config");
  });

  it("ends the argv with a bare dash for stdin piping regardless of the other flags", () => {
    const { args } = providerArgv(
      { provider: "openai", model: "gpt-5.6-terra", reasoning_effort: "high" },
      { bin: "codex", sandbox: "read-only" },
    );
    expect(args.at(-1)).toBe("-");
  });
});

describe("providerArgv · anthropic", () => {
  it("builds the -p json argv with the given permission mode", () => {
    const { file, args } = providerArgv(
      { provider: "anthropic" },
      { bin: "claude", permissionMode: "acceptEdits", allowedTools: [] },
    );
    expect(file).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "project",
    ]);
  });

  // t#543: the user layer belongs to the user's session — its hooks brief a
  // human, and a step pays for that briefing in tokens while its own prompt
  // says there is no earlier conversation.
  it("never loads the user settings layer into a child session", () => {
    const { args } = providerArgv({ provider: "anthropic" }, { bin: "claude", session: "sid-1" });
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("project");
  });

  it("forks the inherited session instead of minting an id, and never passes both", () => {
    const { args } = providerArgv(
      { provider: "anthropic" },
      { bin: "claude", session: "sid-mine", inherit: "sid-parent" },
    );
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sid-parent");
    expect(args).toContain("--fork-session");
    expect(args).not.toContain("--session-id");
  });

  it("adds --session-id only when a session is passed", () => {
    const withSession = providerArgv({ provider: "anthropic" }, { bin: "claude", session: "sid-1" });
    expect(withSession.args).toContain("--session-id");
    expect(withSession.args[withSession.args.indexOf("--session-id") + 1]).toBe("sid-1");

    const withoutSession = providerArgv({ provider: "anthropic" }, { bin: "claude" });
    expect(withoutSession.args).not.toContain("--session-id");
  });

  it("expands allowedTools as separate argv entries", () => {
    const { args } = providerArgv(
      { provider: "anthropic" },
      { bin: "claude", allowedTools: ["Read", "Glob", "Grep"] },
    );
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(args.slice(i + 1, i + 4)).toEqual(["Read", "Glob", "Grep"]);
  });

  it("defaults allowedTools to the read-only set", () => {
    const { args } = providerArgv({ provider: "anthropic" }, { bin: "claude" });
    const i = args.indexOf("--allowedTools");
    expect(args.slice(i + 1, i + 1 + READ_ONLY_TOOLS.length)).toEqual(READ_ONLY_TOOLS);
  });

  it("omits --allowedTools when the list is empty", () => {
    const { args } = providerArgv({ provider: "anthropic" }, { bin: "claude", allowedTools: [] });
    expect(args).not.toContain("--allowedTools");
  });

  it("places --model last", () => {
    const { args } = providerArgv(
      { provider: "anthropic", model: "opus" },
      { bin: "claude", session: "sid-1", allowedTools: ["Read"] },
    );
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("omits --model when the profile has none", () => {
    const { args } = providerArgv({ provider: "anthropic" }, { bin: "claude" });
    expect(args).not.toContain("--model");
  });

  it("omits --session-id the way agents.mjs's synchronous duty call does, passing none", () => {
    const { args } = providerArgv(
      { provider: "anthropic", model: "opus" },
      { bin: "claude", sandbox: "read-only", allowedTools: READ_ONLY_TOOLS },
    );
    expect(args).not.toContain("--session-id");
  });
});

describe("providerArgv · bin shapes", () => {
  it("accepts a plain string binary", () => {
    const { file, args } = providerArgv({ provider: "anthropic" }, { bin: "claude" });
    expect(file).toBe("claude");
    expect(args[0]).toBe("-p");
  });

  it("splits an array binary into file and an argv prefix ahead of everything else, anthropic branch", () => {
    const { file, args } = providerArgv({ provider: "anthropic" }, { bin: ["npx", "claude"] });
    expect(file).toBe("npx");
    expect(args[0]).toBe("claude");
    expect(args[1]).toBe("-p");
  });

  it("splits an array binary into file and an argv prefix ahead of everything else, openai branch", () => {
    const { file, args } = providerArgv(
      { provider: "openai" },
      { bin: ["npx", "codex"], sandbox: "read-only" },
    );
    expect(file).toBe("npx");
    expect(args.slice(0, 4)).toEqual(["codex", "exec", "--json", "--sandbox"]);
  });
});

describe("parseProviderResult · anthropic", () => {
  it("normalizes a claude -p --output-format json result object", () => {
    const stdout = JSON.stringify({
      session_id: "sid-abc",
      result: "the answer",
      total_cost_usd: 0.042,
      is_error: false,
      usage: { input_tokens: 10 },
    });
    const r = parseProviderResult("anthropic", stdout);
    expect(r).toMatchObject({
      sessionId: "sid-abc",
      answer: "the answer",
      costUsd: 0.042,
      error: "",
    });
    expect(r.usage).toEqual({ input_tokens: 10 });
  });

  it("surfaces a non-empty error when is_error is true", () => {
    const stdout = JSON.stringify({ session_id: "sid-abc", result: "", is_error: true });
    const r = parseProviderResult("anthropic", stdout);
    expect(r.error).toBeTruthy();
  });

  it("returns null for unparseable stdout", () => {
    expect(parseProviderResult("anthropic", "not json at all")).toBe(null);
  });

  it("returns null for empty stdout", () => {
    expect(parseProviderResult("anthropic", "")).toBe(null);
  });
});

describe("parseProviderResult · openai", () => {
  it("normalizes a codex exec JSONL stream into thread id, final message and usage", () => {
    const stdout = jsonl(
      { type: "thread.started", thread_id: "thread-9" },
      { type: "item.completed", item: { type: "agent_message", text: "first" } },
      { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
    );
    const r = parseProviderResult("openai", stdout);
    expect(r).toMatchObject({
      sessionId: "thread-9",
      answer: "final answer",
      error: "",
      costUsd: null,
    });
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it("takes the last item.completed agent_message when several arrive", () => {
    const stdout = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "draft" } },
      { type: "item.completed", item: { type: "agent_message", text: "revised" } },
    );
    expect(parseProviderResult("openai", stdout).answer).toBe("revised");
  });

  it("surfaces a turn.failed event as the error", () => {
    const stdout = jsonl({ type: "turn.failed", message: "ran out of turns" });
    expect(parseProviderResult("openai", stdout).error).toBe("ran out of turns");
  });

  it("surfaces a bare error event as the error", () => {
    const stdout = jsonl({ type: "error", error: { message: "sandbox denied" } });
    expect(parseProviderResult("openai", stdout).error).toBe("sandbox denied");
  });

  it("costUsd is always null — the caller prices usage itself", () => {
    const stdout = jsonl({ type: "turn.completed", usage: { input_tokens: 1 } });
    expect(parseProviderResult("openai", stdout).costUsd).toBe(null);
  });

  it("returns null when the stream carries none of the tracked facts", () => {
    expect(parseProviderResult("openai", jsonl({ type: "some.other.event" }))).toBe(null);
    expect(parseProviderResult("openai", "")).toBe(null);
    expect(parseProviderResult("openai", "not json")).toBe(null);
  });
});

describe("observeCodexThread", () => {
  it("fires once with the thread id even when the JSONL line is split across chunk boundaries", () => {
    const onThread = vi.fn();
    const observe = observeCodexThread(onThread);
    const full = JSON.stringify({ type: "thread.started", thread_id: "split-thread" }) + "\n";
    const mid = Math.floor(full.length / 2);
    observe(full.slice(0, mid));
    observe(full.slice(mid));
    expect(onThread).toHaveBeenCalledTimes(1);
    expect(onThread).toHaveBeenCalledWith("split-thread");
  });

  it("recognizes session.started the same as thread.started", () => {
    const onThread = vi.fn();
    const observe = observeCodexThread(onThread);
    observe(JSON.stringify({ type: "session.started", session_id: "sess-1" }) + "\n");
    expect(onThread).toHaveBeenCalledWith("sess-1");
  });

  it("ignores non-JSON and unrelated lines without throwing", () => {
    const onThread = vi.fn();
    const observe = observeCodexThread(onThread);
    expect(() => observe('not json\n{"type":"item.completed"}\n')).not.toThrow();
    expect(onThread).not.toHaveBeenCalled();
  });

  it("holds an incomplete trailing line until the rest of it arrives", () => {
    const onThread = vi.fn();
    const observe = observeCodexThread(onThread);
    observe('{"type":"thread.started","thread_id":"held"}');
    expect(onThread).not.toHaveBeenCalled();
    observe("\n");
    expect(onThread).toHaveBeenCalledWith("held");
  });
});

describe("providerArgv sandbox allowlist", () => {
  it("refuses a sandbox value outside the known set", () => {
    expect(() => providerArgv({ provider: "openai", model: "gpt-5.6-terra" }, { bin: "codex", sandbox: "readonly" }))
      .toThrow(/unknown sandbox/);
    expect(() => providerArgv({ provider: "anthropic", model: "opus" }, { bin: "claude", sandbox: "" }))
      .toThrow(/unknown sandbox/);
  });

  it("accepts every value the seam declares", () => {
    for (const sandbox of SANDBOXES) {
      expect(providerArgv({ provider: "openai", model: "gpt-5.6-terra" }, { bin: "codex", sandbox }).args)
        .toContain(sandbox);
    }
  });
});
