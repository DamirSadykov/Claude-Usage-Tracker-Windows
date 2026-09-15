export type ModelFamily =
  | "openai-sol"
  | "openai-terra"
  | "openai-luna"
  | "openai"
  | "anthropic-opus"
  | "anthropic-sonnet"
  | "anthropic-haiku"
  | "anthropic"
  | "unknown";

/** Stable visual family independent of aliases such as `opus` vs full IDs. */
export function modelFamily(model?: string | null, provider?: string | null): ModelFamily {
  const m = (model ?? "").toLowerCase();
  const p = (provider ?? "").toLowerCase();
  if (m.includes("sol")) return "openai-sol";
  if (m.includes("terra")) return "openai-terra";
  if (m.includes("luna")) return "openai-luna";
  if (m.includes("gpt") || m.includes("codex") || p === "openai") return "openai";
  if (m.includes("opus")) return "anthropic-opus";
  if (m.includes("sonnet")) return "anthropic-sonnet";
  if (m.includes("haiku")) return "anthropic-haiku";
  if (m.includes("claude") || p === "anthropic") return "anthropic";
  return "unknown";
}

export function modelFamilyClass(model?: string | null, provider?: string | null): string {
  return `model-${modelFamily(model, provider)}`;
}
