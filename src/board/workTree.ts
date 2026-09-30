export type ToolCallType = "read" | "edit" | "shell" | "agent" | "web" | "other";
/** Shared by the trace bars and the type chips. */
export const TRACE_TYPE_COLORS = {
  read: "#4cc2ff",
  edit: "#6ccb5f",
  shell: "#b388ff",
  text: "#8a8a8a",
  agent: "#f0a0c8",
  web: "#e79878",
  other: "var(--text-4)",
} as const satisfies Record<ToolCallType | "text", string>;
export type WorkNodeKind = "task" | "session" | "run" | "group" | "model" | "tool" | "agent";
export interface TokenBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export interface TokenCostBreakdown extends TokenBreakdown {
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
}
export interface WorkNode {
  id: string;
  kind: WorkNodeKind;
  name: string;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
  cost: number;
  input: string | null;
  result: string | null;
  transcriptPath: string | null;
  isError?: boolean;
  children: readonly WorkNode[];
  callType?: ToolCallType;
  tokenBreakdown?: TokenBreakdown;
  ownCost?: number;
  sequence?: number;
  count?: number;
  contextLabels?: readonly ContextLabel[];
  role?: "worker" | "review" | null;
  compactionAt?: readonly number[];
  review?: AttemptReview | null;
}
export interface AttemptReview {
  approved?: boolean;
  counts?: ReviewCounts;
  findings: readonly ReviewFinding[];
}
export type ReviewLevel = "critical" | "high" | "medium" | "low";
export interface ReviewCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}
export interface ReviewFinding {
  level: ReviewLevel | null;
  file: string | null;
  line: number | null;
  text: string;
  evidence: string | null;
}
export interface AttemptReviewSummary {
  passed: boolean;
  counts: ReviewCounts;
  findings: readonly ReviewFinding[];
}
export type ContextLabelKind = "fresh" | "inherits" | "continued" | "compacted";
export interface ContextLabel {
  kind: ContextLabelKind;
  parentTask?: number;
  parentSession?: string;
}
export interface WorkContextInput {
  mode?: "fresh" | "fork" | "continued" | "unknown";
  parentTask?: number | null;
  parentSession?: string | null;
  compacted?: boolean;
  agentType?: string | null;
  fork?: boolean;
}
export interface ToolCallInput {
  id: string;
  name: string;
  input?: string | null;
  result?: string | null;
  isError?: boolean;
  startedAt?: number | null;
  endedAt?: number | null;
  subagent?: WorkNode | null;
  contextLabels?: readonly ContextLabel[];
}
export interface ModelCallInput {
  id: string;
  name?: string;
  model: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  cost?: number;
  tokenBreakdown?: Partial<TokenBreakdown>;
  calls?: readonly ToolCallInput[];
  input?: string | null;
  result?: string | null;
  transcriptPath?: string | null;
}
export interface TracePoint {
  index: number;
  nodeId: string;
  type: ToolCallType | "text";
  value: number;
}
export interface TraceSeries {
  context: readonly TracePoint[];
  cacheRead: readonly TracePoint[];
  cost: readonly TracePoint[];
}
export interface TraceMarkerPart {
  kind: "attempt" | "session" | "compacted";
  attempt: string | null;
  role: "worker" | "review" | null;
}
export interface TraceMarker {
  index: number;
  kind: TraceMarkerPart["kind"];
  parts: readonly TraceMarkerPart[];
}
export interface TypeSummary {
  type: ToolCallType | "text";
  nodes: number;
  cost: number;
  share: number;
}
export interface TreeViewOptions {
  types?: ReadonlySet<ToolCallType | "text">;
  headersOnly?: boolean;
}
const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);
const READ_BASH =
  /^(?:cat|type|rg|grep|findstr|ls|dir|pwd|git\s+(?:status|diff|log|show)|Get-Content|Get-ChildItem|Select-String)\b/i;
const WRITE_BASH =
  /(?:^|\s)(?:>|>>|rm\b|del\b|remove-item\b|move-item\b|copy-item\b|cp\b|mv\b|mkdir\b|new-item\b|set-content\b|add-content\b|tee\b|npm\s+(?:install|run|test|build)|npx\b|node\b|python\b|cargo\b|git\s+(?:add|commit|push|checkout|reset|clean))/i;
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
const REVIEW_LEVELS: readonly ReviewLevel[] = ["critical", "high", "medium", "low"];
function reviewLevel(value: unknown): ReviewLevel | null {
  return typeof value === "string" && REVIEW_LEVELS.includes(value as ReviewLevel) ? (value as ReviewLevel) : null;
}
function reviewCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function reviewCounts(value: unknown): ReviewCounts {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    critical: reviewCount(raw.critical),
    high: reviewCount(raw.high),
    medium: reviewCount(raw.medium),
    low: reviewCount(raw.low),
  };
}
export function attemptReview(value: unknown): AttemptReview | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const findings = Array.isArray(raw.findings)
    ? raw.findings.flatMap((item): ReviewFinding[] => {
        if (!item || typeof item !== "object") return [];
        const finding = item as Record<string, unknown>;
        if (typeof finding.text !== "string" || !finding.text.trim()) return [];
        return [{
          level: reviewLevel(finding.level),
          file: typeof finding.file === "string" ? finding.file : null,
          line: typeof finding.line === "number" && Number.isFinite(finding.line) ? Math.floor(finding.line) : null,
          text: finding.text,
          evidence: typeof finding.evidence === "string" ? finding.evidence : null,
        }];
      })
    : [];
  return {
    approved: typeof raw.approved === "boolean" ? raw.approved : undefined,
    counts: raw.counts && typeof raw.counts === "object" ? reviewCounts(raw.counts) : undefined,
    findings,
  };
}
export function attemptReviewSummary(result: string | null | undefined, review: AttemptReview | null | undefined): AttemptReviewSummary | null {
  if (!review) return null;
  const derived = review.findings.reduce<ReviewCounts>(
    (counts, finding) => (finding.level ? { ...counts, [finding.level]: counts[finding.level] + 1 } : counts),
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
  const counts = review.counts ?? derived;
  const rank = (finding: ReviewFinding) => (finding.level ? REVIEW_LEVELS.indexOf(finding.level) : REVIEW_LEVELS.length);
  return {
    passed: result === "done" || result === "ok",
    counts,
    findings: [...review.findings].sort((left, right) => rank(left) - rank(right)),
  };
}
export function tokenBreakdown(value?: Partial<TokenBreakdown>): TokenBreakdown {
  return {
    input: number(value?.input),
    cacheRead: number(value?.cacheRead),
    cacheWrite: number(value?.cacheWrite),
    output: number(value?.output),
  };
}
export function contextTokens(usage?: Partial<TokenBreakdown>): number {
  const normalized = tokenBreakdown(usage);
  return normalized.input + normalized.cacheRead + normalized.cacheWrite;
}
export function totalTokens(usage?: Partial<TokenBreakdown>): number {
  const normalized = tokenBreakdown(usage);
  return contextTokens(normalized) + normalized.output;
}
export function tokenCosts(model: string | null, usage?: Partial<TokenBreakdown>): TokenCostBreakdown {
  const tokens = tokenBreakdown(usage),
    name = model?.toLowerCase() ?? "";
  let input = 0,
    cacheRead = 0,
    output = 0;
  if (name.includes("fable")) [input, cacheRead, output] = [10, 1, 50];
  else if (name.includes("opus")) [input, cacheRead, output] = [5, 0.5, 25];
  else if (name.includes("sonnet")) [input, cacheRead, output] = [3, 0.3, 15];
  else if (name.includes("haiku")) [input, cacheRead, output] = [1, 0.1, 5];
  else if (name.includes("gpt-5.6-terra")) [input, cacheRead, output] = [2, 0.2, 12];
  else if (name.includes("gpt-5.6-luna")) [input, cacheRead, output] = [0.2, 0.02, 1.2];
  else if (name === "gpt-5.6" || name.includes("gpt-5.6-sol")) [input, cacheRead, output] = [4, 0.4, 20];
  else if (name.includes("gpt-5.3-codex") || name.includes("gpt-5.2-codex") || name === "gpt-5.2")
    [input, cacheRead, output] = [1.75, 0.175, 14];
  const codex = name.includes("gpt-");
  const freshInput = codex ? Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite) : tokens.input;
  return {
    ...tokens,
    inputCost: (freshInput * input) / 1_000_000,
    cacheReadCost: (tokens.cacheRead * cacheRead) / 1_000_000,
    cacheWriteCost: (tokens.cacheWrite * input * 1.25) / 1_000_000,
    outputCost: (tokens.output * output) / 1_000_000,
  };
}
export function classifyToolCall(name: string, input?: string | null): ToolCallType {
  const tool = name.trim(),
    normalized = tool.toLowerCase(),
    command = input?.trim() ?? "";
  if (READ_TOOLS.has(normalized) || normalized.startsWith("mcp__fff__")) return "read";
  if (["write", "edit", "notebookedit", "apply_patch"].includes(normalized)) return "edit";
  if (["agent", "task"].includes(normalized)) return "agent";
  if (["webfetch", "websearch"].includes(normalized)) return "web";
  if (["bash", "exec"].includes(normalized))
    return READ_BASH.test(command) && !WRITE_BASH.test(command) ? "read" : "shell";
  return "other";
}
export function nodeType(node: Pick<WorkNode, "kind" | "children" | "callType">): ToolCallType | "text" {
  if (node.kind !== "model") return node.callType ?? "text";
  const calls = node.children.filter((child) => child.kind === "tool" || child.kind === "agent");
  if (!calls.length) return "text";
  const counts = new Map<ToolCallType, number>();
  for (const call of calls) {
    const type = call.callType ?? "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return (
    calls.reduce((best, call) =>
      counts.get(call.callType ?? "other")! > counts.get(best.callType ?? "other")! ? call : best,
    ).callType ?? "other"
  );
}
export function modelCallNode(value: ModelCallInput): WorkNode {
  const calls = (value.calls ?? []).map((call, index): WorkNode => {
    const callType = classifyToolCall(call.name, call.input),
      agent = call.subagent ?? null;
    return {
      id: call.id,
      kind: callType === "agent" ? "agent" : "tool",
      name: call.name,
      model: null,
      startedAt: call.startedAt ?? value.startedAt ?? null,
      endedAt: call.endedAt ?? value.endedAt ?? null,
      tokens: agent?.tokens ?? 0,
      cost: agent?.cost ?? 0,
      input: call.input ?? null,
      result: call.result ?? null,
      transcriptPath: agent?.transcriptPath ?? null,
      isError: call.isError,
      children: agent ? [agent] : [],
      callType,
      sequence: index + 1,
      contextLabels: call.contextLabels,
    };
  });
  const usage = tokenBreakdown(value.tokenBreakdown),
    nestedTokens = calls.reduce((sum, call) => sum + call.tokens, 0),
    nestedCost = calls.reduce((sum, call) => sum + call.cost, 0),
    ownCost = number(value.cost);
  return {
    id: value.id,
    kind: "model",
    name: value.name ?? callSummary(calls),
    model: value.model,
    startedAt: value.startedAt ?? null,
    endedAt: value.endedAt ?? null,
    tokens: totalTokens(usage) + nestedTokens,
    cost: ownCost + nestedCost,
    ownCost,
    input: value.input ?? null,
    result: value.result ?? null,
    transcriptPath: value.transcriptPath ?? null,
    children: calls,
    tokenBreakdown: usage,
  };
}
export function contextLabels(context?: WorkContextInput): readonly ContextLabel[] {
  if (!context) return [];
  const mode = context.fork || context.agentType === "fork" ? "fork" : context.mode;
  const labels: ContextLabel[] = [];
  if (mode === "fresh") labels.push({ kind: "fresh" });
  const rawParentTask = context.parentTask,
    parentTask =
      typeof rawParentTask === "number" && Number.isInteger(rawParentTask) && rawParentTask > 0
        ? rawParentTask
        : undefined,
    parentSession = context.parentSession?.slice(0, 8);
  if (mode === "fork") labels.push({ kind: "inherits", parentTask, parentSession });
  if (mode === "continued") labels.push({ kind: "continued" });
  if (context.compacted) labels.push({ kind: "compacted" });
  return labels;
}
export function aggregateTree(node: WorkNode): WorkNode {
  const children = node.children.map(aggregateTree),
    container = ["task", "session", "run"].includes(node.kind),
    wrappedAgent = node.kind === "agent" && children.length > 0,
    ownTokens =
      container || wrappedAgent ? 0 : node.tokenBreakdown ? totalTokens(node.tokenBreakdown) : number(node.tokens),
    ownCost =
      container || wrappedAgent ? 0 : node.kind === "model" ? number(node.ownCost ?? node.cost) : number(node.cost);
  if (["model", "task", "session", "run", "agent"].includes(node.kind))
    return {
      ...node,
      children,
      tokens: ownTokens + children.reduce((sum, child) => sum + child.tokens, 0),
      cost: ownCost + children.reduce((sum, child) => sum + child.cost, 0),
    };
  return { ...node, children };
}
export function callSummary(calls: readonly Pick<WorkNode, "name">[]): string {
  const counts = new Map<string, number>();
  calls.forEach((call) => counts.set(call.name, (counts.get(call.name) ?? 0) + 1));
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
}
export function singleCall(node: WorkNode): WorkNode | null {
  const [call, ...rest] = node.kind === "model" ? node.children : [];
  return call && !rest.length && call.kind === "tool" && !call.children.length ? call : null;
}
export function groupModelCalls(node: WorkNode): WorkNode {
  const children: WorkNode[] = [];
  let run: WorkNode[] = [];
  const flush = () => {
    if (run.length > 1) {
      const first = run[0],
        last = run[run.length - 1],
        members = run.map((member, index) => ({ ...member, sequence: index + 1 }));
      children.push({
        id: `group:${first.id}`,
        kind: "group",
        name: singleCall(first)!.name,
        model: members.every((member) => member.model === first.model) ? first.model : null,
        startedAt: first.startedAt,
        endedAt: last.endedAt,
        tokens: members.reduce((sum, member) => sum + member.tokens, 0),
        cost: members.reduce((sum, member) => sum + member.cost, 0),
        input: null,
        result: null,
        transcriptPath: first.transcriptPath,
        children: members,
      });
    } else children.push(...run);
    run = [];
  };
  for (const child of node.children.map(groupModelCalls)) {
    const call = singleCall(child);
    if (call && run.length && singleCall(run[0])!.name === call.name) run.push(child);
    else {
      flush();
      if (call) run.push(child);
      else children.push(child);
    }
  }
  flush();
  return { ...node, children };
}
export function pathTo(root: WorkNode, id: string): WorkNode[] | null {
  if (root.id === id) return [root];
  for (const child of root.children) {
    const path = pathTo(child, id);
    if (path) return [root, ...path];
  }
  return null;
}
export function modelCalls(root: WorkNode): WorkNode[] {
  const found: WorkNode[] = [];
  const visit = (node: WorkNode) => {
    if (node.kind === "model") found.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return found;
}
export function traceSeries(root: WorkNode): TraceSeries {
  let cacheRead = 0,
    cost = 0;
  const context: TracePoint[] = [],
    cache: TracePoint[] = [],
    prices: TracePoint[] = [];
  modelCalls(root).forEach((node, index) => {
    const usage = tokenBreakdown(node.tokenBreakdown),
      type = nodeType(node),
      point = { index: index + 1, nodeId: node.id, type };
    cacheRead += usage.cacheRead;
    cost += number(node.ownCost ?? node.cost);
    context.push({ ...point, value: contextTokens(usage) });
    cache.push({ ...point, value: cacheRead });
    prices.push({ ...point, value: cost });
  });
  return { context, cacheRead: cache, cost: prices };
}
export function traceMarkers(root: WorkNode): readonly TraceMarker[] {
  const calls = modelCalls(root);
  const indexAt = (at: number | null) => {
    if (at === null) return calls.length;
    const next = calls.findIndex((call) => call.startedAt !== null && call.startedAt >= at);
    return next < 0 ? calls.length : next + 1;
  };
  const markers: TraceMarker[] = [];
  const attemptNumber = (node: WorkNode) => node.id.match(/^attempt:(\d+)/)?.[1] ?? node.name.match(/(\d+)/)?.[1] ?? "?";
  const push = (at: number | null, part: TraceMarkerPart) => markers.push({ index: indexAt(at), kind: part.kind, parts: [part] });
  const visit = (node: WorkNode, attempt: string | null) => {
    const currentAttempt = node.kind === "run" ? attemptNumber(node) : attempt;
    if (node.kind === "run" && !node.children.some((child) => child.kind === "session"))
      push(node.startedAt, { kind: "attempt", attempt: currentAttempt, role: null });
    if (node.kind === "session") push(node.startedAt, { kind: "session", attempt: currentAttempt, role: node.role ?? null });
    for (const at of node.compactionAt ?? []) push(at, { kind: "compacted", attempt: currentAttempt, role: null });
    node.children.forEach((child) => visit(child, currentAttempt));
  };
  root.children.forEach((child) => visit(child, null));
  const merged = new Map<number, TraceMarker>();
  for (const marker of markers.filter((entry) => entry.index > 0)) {
    const existing = merged.get(marker.index);
    if (existing) merged.set(marker.index, { ...existing, parts: [...existing.parts, ...marker.parts] });
    else merged.set(marker.index, marker);
  }
  return [...merged.values()].sort((left, right) => left.index - right.index);
}
export function typeSummary(root: WorkNode): readonly TypeSummary[] {
  const calls = modelCalls(root),
    totalCost = calls.reduce((sum, node) => sum + number(node.ownCost ?? node.cost), 0),
    groups = new Map<ToolCallType | "text", { nodes: number; cost: number }>();
  for (const call of calls) {
    const type = nodeType(call),
      group = groups.get(type) ?? { nodes: 0, cost: 0 };
    group.nodes++;
    group.cost += number(call.ownCost ?? call.cost);
    groups.set(type, group);
  }
  return [...groups.entries()].map(([type, group]) => ({
    type,
    ...group,
    share: totalCost ? group.cost / totalCost : 0,
  }));
}
export function filterTree(node: WorkNode, types?: ReadonlySet<ToolCallType | "text">): WorkNode | null {
  const children = node.children
      .map((child) => filterTree(child, types))
      .filter((child): child is WorkNode => child !== null),
    matches = !types?.size || node.kind !== "model" || types.has(nodeType(node));
  if (node.kind === "model" && !matches) {
    const branches = children.filter((child) => child.kind === "agent" && child.children.length > 0);
    return branches.length ? { ...node, children: branches } : null;
  }
  if (["task", "session", "run", "agent"].includes(node.kind) && children.length === 0 && types?.size) return null;
  return { ...node, children };
}
export function headersOnlyTree(node: WorkNode): WorkNode {
  const children = node.children.flatMap((child) =>
    child.kind === "tool" || child.kind === "agent" ? child.children.map(headersOnlyTree) : [headersOnlyTree(child)],
  );
  return { ...node, children };
}
export function treeView(node: WorkNode, options: TreeViewOptions = {}): WorkNode | null {
  const filtered = filterTree(node, options.types);
  const view = filtered && options.headersOnly ? headersOnlyTree(filtered) : filtered;
  return view && groupModelCalls(view);
}
