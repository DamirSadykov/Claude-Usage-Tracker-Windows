export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface SpecAnswer {
  address: string;
  verdict: string;
  note: string;
  at: string;
  blocks?: string[];
  after?: string;
}

export interface SpecSeen {
  address: string;
  hash: string;
  at: string;
  blocks?: string[];
  text?: string;
}

export interface Todo {
  id: string;
  number?: number;
  subject: string;
  description: string;
  status: string;
  priority?: string;
  kind?: string;
  change?: boolean;
  change_id?: string;
  scheduled_for?: string | null;
  plan: string;
  project?: string | null;
  from?: string | null;
  comments?: Comment[];
  links?: string[];
  depends_on?: string[];
  handoff?: string;
  spec?: string[];
  spec_answers?: SpecAnswer[];
  spec_seen?: SpecSeen[];
  ext?: Record<string, unknown>;
  imported_at?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface BoardChange {
  id: string;
  number: number;
  title: string;
  delta?: string;
  out?: ChangeOut[];
  measure?: ChangeMeasure[];
  plan?: string | null;
  project?: string | null;
  spec?: string[];
  budget_usd?: number;
  parallel_limit?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
}

export interface ChangeOut {
  what: string;
  why: string;
  ref?: string | null;
}

export interface ChangeMeasure {
  what: string;
  how: string;
  target?: string | null;
  actual?: string | null;
  ok?: boolean | null;
  note?: string | null;
}

export interface ReviewCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface RunReview {
  session?: string | null;
  counts?: ReviewCounts;
  approved?: boolean;
  findings?: unknown[];
}

export interface RunEvent {
  ts: string;
  task: string;
  kind: string;
  attempt?: number;
  limit?: number;
  route?: string;
  counts?: ReviewCounts;
  approved?: boolean;
  findings?: unknown[];
}

export interface WorkTree {
  sessionId?: string;
  transcriptPath: string;
  startedAt?: string;
  endedAt?: string;
  compacted: boolean;
  compactionAt: string[];
  turns: WorkTurn[];
}

export interface WorkToolResult {
  timestamp: string;
  isError: boolean;
  content: unknown;
}

export interface WorkToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: WorkToolResult;
  subagent?: WorkTree;
}

export interface WorkTurn {
  id: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  calls: WorkToolCall[];
}

/** Scenario output calculated by Rust for one candidate clean-agent restart. */
export interface RestartScenario {
  rho: number;
  k: number | null;
  saveUsd: number;
  savePct: number;
  lastPositiveK: number | null;
}

/** Observed transcript facts and model-versioned restart scenarios. */
export interface RestartPoint {
  observed: {
    calls: number;
    ctx: number[];
    cached: number[];
    firstEditCall: number | null;
    ctxAtFirstEdit: number | null;
    firstCachedShare: number | null;
  };
  scenarios: RestartScenario[];
  modelVersion: number;
}

export interface TaskWorkContext {
  mode: "fresh" | "fork" | "continued" | "unknown";
  parentTask?: number | null;
  parentSession?: string | null;
  role?: "worker" | "review" | null;
}

export interface TaskWorkSession {
  session: string;
  from: string;
  to: string;
  source: string;
  tree: WorkTree;
  context: TaskWorkContext;
  restartPoint: RestartPoint;
}

export interface TaskWorkAttempt {
  number: number;
  startedAt: string;
  endedAt: string;
  events: RunEvent[];
  review?: RunReview;
  result?: string;
}
