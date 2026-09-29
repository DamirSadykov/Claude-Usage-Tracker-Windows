export type ToolCallType = "read" | "edit" | "shell" | "agent" | "web" | "other";
export type WorkNodeKind = "task" | "session" | "run" | "group" | "model" | "tool" | "agent";
export interface TokenBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
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
  children: readonly WorkNode[];
  callType?: ToolCallType;
  tokenBreakdown?: TokenBreakdown;
  ownCost?: number;
  sequence?: number;
  count?: number;
}
export interface ToolCallInput {
  id: string;
  name: string;
  input?: string | null;
  result?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  subagent?: WorkNode | null;
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
      children: agent ? [agent] : [],
      callType,
      sequence: index + 1,
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
