import { describe, expect, it } from "vitest";
import { modelFamily } from "./modelFamily";

describe("modelFamily", () => {
  it("colors named OpenAI and Anthropic families independently", () => {
    expect(modelFamily("gpt-5.6-sol")).toBe("openai-sol");
    expect(modelFamily("gpt-5.6-terra")).toBe("openai-terra");
    expect(modelFamily("gpt-5.6-luna")).toBe("openai-luna");
    expect(modelFamily("claude-opus-4-7")).toBe("anthropic-opus");
    expect(modelFamily("sonnet")).toBe("anthropic-sonnet");
    expect(modelFamily("haiku")).toBe("anthropic-haiku");
  });

  it("uses the provider when a custom model name has no recognizable family", () => {
    expect(modelFamily("custom", "openai")).toBe("openai");
    expect(modelFamily("custom", "anthropic")).toBe("anthropic");
    expect(modelFamily("custom")).toBe("unknown");
  });
});
