// Data atom for the run-graph panel (t#307): the shape the UI works with, and
// the one call that fetches it. Everything above this file deals with the
// normalized model only, so a change in the Rust payload (t#306) is absorbed
// here instead of leaking into components.

import { invoke } from "@tauri-apps/api/core";

/// An edge of the run graph, keyed by BOARD NUMBER — the payload keys edges by
/// task id, and the translation happens once, in `normalizeGraph`.
export interface GraphEdge {
  from: number;
  to: number;
}

/// One agent's share of a node's spend — the main loop is the row with a null
/// `agent_id`, so rows sum back to the node total (t#300, analytics::BlockAgent).
export interface NodeAgent {
  agent_id: string | null;
  agent_type: string | null;
  /// What the agent was launched for; names the work in human words.
  description: string | null;
  cost: number;
  messages: number;
}

/// Why a node has no numbers. Distinguishing these is the whole point: only
/// `measured` may show a figure, and each other case has a DIFFERENT reason
/// worth telling the user apart.
///   no_in_progress — the task never entered `in_progress`, so no block exists
///                    (normal for change roots: t#294, t#283, and for t#274/#276)
///   no_blocks      — worked, but the session predates the binding journal
///   empty_blocks   — a block exists but is degenerate (parallel agents closed
///                    it instantly; the work sits in a neighbour's block, t#296)
export type Measurability = "measured" | "no_in_progress" | "no_blocks" | "empty_blocks";

export interface RunGraphNode {
  id: string;
  number: number;
  subject: string;
  status: string;
  /// A gate is a `manual` node — a human closes it (docs/specs/tasks.md §6).
  gate: boolean;
  /// True for a change root. Its span is CALENDAR time (the change stays open
  /// while its children run), so it must not be compared with a step's.
  group: boolean;
  /// Null unless `measurability === "measured"`: a task that never entered
  /// `in_progress`, one whose session predates the journal, and one whose block
  /// is degenerate all have NO cost — which is not the same as costing zero.
  cost: number | null;
  duration_minutes: number | null;
  /// True when the span is the change's CALENDAR time — a change stays open while
  /// its children run, so its minutes must not be read as work.
  duration_calendar: boolean;
  measurability: Measurability;
  blocks: number;
  tokens: number | null;
  messages: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  /// Whole-task attribution, when known — lets an unmeasured node still show
  /// something instead of reading as "nothing happened here".
  task_cost: number | null;
  /// Spend inside the task that no block covers. Not a bug: work between
  /// blocks belongs to no task (see handoff t#298).
  unattributed_cost: number | null;
  agents: NodeAgent[];
}

export interface RunGraphGroup {
  id: string;
  number: number;
  subject: string;
  members: string[];
  duration_minutes: number | null;
  record: boolean;
}

export interface RunGraph {
  nodes: RunGraphNode[];
  edges: GraphEdge[];
  /// Membership edges (member → change) are carried but not drawn: the frame
  /// already says it. Kept so the model stays complete.
  groups: RunGraphGroup[];
  /// Canonical export text (spec §17). The panel draws its own SVG; this is
  /// what the user copies out into a report.
  mermaid: string;
}

const EMPTY: RunGraph = { nodes: [], edges: [], groups: [], mermaid: "" };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function agent(raw: Record<string, unknown>): NodeAgent {
  return {
    agent_id: typeof raw.agent_id === "string" ? raw.agent_id : null,
    agent_type: typeof raw.agent_type === "string" ? raw.agent_type : null,
    description: typeof raw.description === "string" ? raw.description : null,
    cost: num(raw.cost) ?? 0,
    messages: num(raw.messages) ?? 0,
  };
}

const MEASURABILITY: Measurability[] = ["measured", "no_in_progress", "no_blocks", "empty_blocks"];

function measurability(v: unknown): Measurability {
  const s = str(v);
  return (MEASURABILITY as string[]).includes(s) ? (s as Measurability) : "no_blocks";
}

/// Normalize one node. Money and counters stay null unless the node is
/// `measured` — a task that never entered `in_progress` has no block, and a
/// degenerate block is not a measurement either. Collapsing any of that to 0
/// would claim the step was free (see graphLayout.unmeasured).
export function normalizeNode(raw: Record<string, unknown>): RunGraphNode {
  const kind = str(raw.kind);
  const state = measurability(raw.measurability);
  const measured = state === "measured";
  return {
    id: str(raw.id),
    number: num(raw.number) ?? 0,
    subject: str(raw.subject),
    status: str(raw.status),
    gate: typeof raw.gate === "boolean" ? raw.gate : kind !== "auto",
    group: raw.change === true || raw.group === true,
    measurability: state,
    blocks: num(raw.blocks) ?? 0,
    cost: measured ? num(raw.cost) : null,
    duration_minutes: num(raw.duration_minutes),
    duration_calendar: raw.duration_calendar === true,
    tokens: measured ? num(raw.total_tokens ?? raw.tokens) : null,
    messages: measured ? num(raw.messages) : null,
    tool_calls: measured ? num(raw.tool_calls) : null,
    tool_errors: measured ? num(raw.tool_errors) : null,
    task_cost: num(raw.task_cost),
    unattributed_cost: num(raw.unattributed_cost),
    agents: Array.isArray(raw.agents) ? raw.agents.map((a) => agent(a as Record<string, unknown>)) : [],
  };
}

export function normalizeGraph(raw: unknown): RunGraph {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const nodes = Array.isArray(r.nodes)
    ? r.nodes.map((n) => normalizeNode(n as Record<string, unknown>))
    : [];
  // Edges arrive keyed by task id; the layout works in board numbers, so the
  // translation happens once, here. A membership edge (member → change) is
  // dropped: the frame already carries that meaning, drawing it too would
  // clutter every group with one edge per member.
  const numberOf = new Map(nodes.filter((n) => n.id).map((n) => [n.id, n.number]));
  const edges: GraphEdge[] = Array.isArray(r.edges)
    ? (r.edges as Record<string, unknown>[])
        .filter((e) => e.membership !== true)
        .map((e) => ({
          from: numberOf.get(str(e.from)) ?? num(e.from) ?? 0,
          to: numberOf.get(str(e.to)) ?? num(e.to) ?? 0,
        }))
        .filter((e) => e.from && e.to)
    : [];
  const groups: RunGraphGroup[] = Array.isArray(r.groups)
    ? (r.groups as Record<string, unknown>[]).map((g) => ({
        id: str(g.id),
        number: num(g.number) ?? 0,
        subject: str(g.subject),
        members: Array.isArray(g.members) ? (g.members as unknown[]).map((m) => str(m)) : [],
        duration_minutes: num(g.duration_minutes),
        record: g.record === true,
      }))
    : [];
  return { nodes, edges, groups, mermaid: str(r.text ?? r.mermaid) };
}

/// Fetch one change's run graph. A failure yields an empty graph rather than
/// throwing: the panel is a decoration on the task view and must never take
/// the view down with it (same rule as the block list, t#298).
export async function loadRunGraph(change: string): Promise<RunGraph> {
  if (!change) return EMPTY;
  try {
    return normalizeGraph(await invoke("get_task_graph", { change }));
  } catch {
    return EMPTY;
  }
}

/// One block of a task: the stretch a single session worked it. Mirrors
/// `TaskBlockRow` of `get_task_blocks` (t#298); `session` is what opens the
/// transcript.
export interface RunBlock {
  session: string;
  from: string;
  to: string;
  explicit: boolean;
  source: string;
  cost: number;
  total_tokens: number;
  messages: number;
  tool_calls: number;
  tool_errors: number;
}

export interface RunLayer {
  nodes: Map<string, RunGraphNode>;
  groups: Map<string, RunGraphGroup>;
}

export async function loadRunGroups(changes: string[]): Promise<RunLayer> {
  const nodes = new Map<string, RunGraphNode>();
  const groups = new Map<string, RunGraphGroup>();
  const graphs = await Promise.all([...new Set(changes)].filter(Boolean).map(loadRunGraph));
  for (const g of graphs) {
    for (const n of g.nodes) {
      const prev = nodes.get(n.id);
      if (!prev || (n.measurability === "measured" && prev.measurability !== "measured")) {
        nodes.set(n.id, n);
      }
    }
    for (const grp of g.groups) groups.set(grp.id, grp);
  }
  return { nodes, groups };
}

export async function loadRunLayer(changes: string[]): Promise<Map<string, RunGraphNode>> {
  return (await loadRunGroups(changes)).nodes;
}

export async function loadTaskBlocks(task: string): Promise<RunBlock[]> {
  if (!task) return [];
  try {
    const res = await invoke<{ blocks?: unknown[] } | null>("get_task_blocks", { task });
    return Array.isArray(res?.blocks) ? (res!.blocks as RunBlock[]) : [];
  } catch {
    return [];
  }
}

/// Show a block's transcript in the file manager. Returns the path shown, or the
/// backend's reason — a transcript can be gone (cleanupPeriodDays) while its
/// numbers live on in the database.
export async function revealTranscript(
  session: string,
  agent?: string | null,
): Promise<{ path?: string; error?: string }> {
  try {
    return { path: await invoke<string>("reveal_transcript", { session, agent: agent ?? null }) };
  } catch (err) {
    return { error: String(err) };
  }
}
