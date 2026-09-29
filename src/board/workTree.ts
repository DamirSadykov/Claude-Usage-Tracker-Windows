export type WorkNodeKind = "task" | "session" | "run" | "turn" | "tool" | "agent" | "reads";

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
  count?: number;
}

export interface TimelineScale {
  start: number;
  end: number;
  duration: number;
  minimumWidth: number;
}

export interface TimelineBar {
  start: number;
  width: number;
}

export const MIN_TIMELINE_WIDTH = 1;
export const EXPENSIVE_NODE_COST = 1;

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const READ_BASH = /^(?:cat|type|rg|grep|findstr|ls|dir|pwd|git\s+(?:status|diff|log|show)|Get-Content|Get-ChildItem|Select-String)\b/i;
const WRITE_BASH = /(?:^|\s)(?:>|>>|rm\b|del\b|remove-item\b|move-item\b|copy-item\b|cp\b|mv\b|mkdir\b|new-item\b|set-content\b|add-content\b|tee\b|npm\s+(?:install|run|test|build)|npx\b|node\b|python\b|cargo\b|git\s+(?:add|commit|push|checkout|reset|clean))/i;

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function bounds(node: WorkNode): [number, number] | null {
  const start = finite(node.startedAt);
  const end = finite(node.endedAt);
  if (start === null && end === null) return null;
  if (start === null) return [end!, end!];
  if (end === null) return [start, start];
  return [Math.min(start, end), Math.max(start, end)];
}

export function isReadingNode(node: Pick<WorkNode, "kind" | "name" | "input">): boolean {
  if (node.kind !== "tool") return false;
  const tool = node.name.split(" · ", 1)[0].trim().toLowerCase();
  if (READ_TOOLS.has(tool)) return true;
  if (tool !== "bash") return false;
  const command = node.input?.trim() ?? "";
  return !!command && READ_BASH.test(command) && !WRITE_BASH.test(command);
}

function aggregate(nodes: readonly WorkNode[]): Pick<WorkNode, "startedAt" | "endedAt" | "tokens" | "cost"> {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let tokens = 0;
  let cost = 0;
  for (const node of nodes) {
    const span = bounds(node);
    if (span) {
      startedAt = startedAt === null ? span[0] : Math.min(startedAt, span[0]);
      endedAt = endedAt === null ? span[1] : Math.max(endedAt, span[1]);
    }
    tokens += Number.isFinite(node.tokens) ? node.tokens : 0;
    cost += Number.isFinite(node.cost) ? node.cost : 0;
  }
  return { startedAt, endedAt, tokens, cost };
}

function readingGroup(nodes: readonly WorkNode[]): WorkNode {
  const totals = aggregate(nodes);
  return {
    id: `reads:${nodes.map((node) => node.id).join(",")}`,
    kind: "reads",
    name: "Reads",
    model: null,
    ...totals,
    input: null,
    result: null,
    transcriptPath: null,
    children: nodes,
    count: nodes.length,
  };
}

export function collapseReadingNodes(nodes: readonly WorkNode[]): readonly WorkNode[] {
  const collapsed: WorkNode[] = [];
  let run: WorkNode[] = [];
  const flush = () => {
    if (run.length === 1) collapsed.push(run[0]);
    else if (run.length > 1) collapsed.push(readingGroup(run));
    run = [];
  };
  for (const node of nodes) {
    const nested = node.children.length ? { ...node, children: collapseReadingNodes(node.children) } : node;
    if (isReadingNode(nested)) run.push(nested);
    else {
      flush();
      collapsed.push(nested);
    }
  }
  flush();
  return collapsed;
}

export const collapseReads = collapseReadingNodes;

export function timelineScale(root: WorkNode, minimumWidth = MIN_TIMELINE_WIDTH): TimelineScale {
  const span = bounds(root);
  const start = span?.[0] ?? 0;
  const end = span?.[1] ?? start;
  return { start, end, duration: Math.max(0, end - start), minimumWidth: Math.max(0, minimumWidth) };
}

export function timelineBar(node: WorkNode, scale: TimelineScale): TimelineBar | null {
  const span = bounds(node);
  if (!span) return null;
  if (scale.duration === 0) return { start: 0, width: 100 };
  const start = Math.max(0, Math.min(100 - scale.minimumWidth, (span[0] - scale.start) / scale.duration * 100));
  const naturalWidth = Math.max(0, (span[1] - span[0]) / scale.duration * 100);
  return { start, width: Math.min(100 - start, Math.max(scale.minimumWidth, naturalWidth)) };
}

export function isExpensiveNode(node: Pick<WorkNode, "cost">, threshold = EXPENSIVE_NODE_COST): boolean {
  return Number.isFinite(node.cost) && node.cost >= threshold;
}
