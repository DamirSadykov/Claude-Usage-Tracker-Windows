export type HandoffPart = "done" | "gotcha" | "next";

export interface HandoffSummary {
  fallback: boolean;
  parts: ReadonlyArray<{ part: HandoffPart; text: string }>;
}

const HANDOFF_LABELS: ReadonlyArray<[HandoffPart, RegExp]> = [
  ["done", /^(?:сделано|done)\s*:\s*/im],
  ["gotcha", /^(?:подвох|gotcha)\s*:\s*/im],
  ["next", /^(?:дальше|next)\s*:\s*/im],
];

export function parseHandoff(text: string | null | undefined): HandoffSummary {
  const source = text?.trim() ?? "";
  const found = HANDOFF_LABELS.flatMap(([part, label]) => {
    const match = label.exec(source);
    return match ? [{ part, start: match.index, end: match.index + match[0].length }] : [];
  }).sort((a, b) => a.start - b.start);
  if (!source || !found.length) return { fallback: true, parts: source ? [{ part: "done", text: source }] : [] };
  const parts = found.map((item, index) => ({
    part: item.part,
    text: source.slice(item.end, found[index + 1]?.start).trim(),
  })).filter((item) => item.text);
  return parts.length ? { fallback: false, parts } : { fallback: true, parts: [{ part: "done", text: source }] };
}

export type CommentSeverity = "critical" | "high" | "medium" | "low" | null;
export function commentSeverity(author: string, body: string): CommentSeverity {
  if (author !== "architect" && author !== "review") return null;
  const levels = [...body.matchAll(/^\s*(?:-\s*)?\[(critical|high|medium|low)\]/gim)].map((match) => match[1].toLowerCase() as Exclude<CommentSeverity, null>);
  return levels.reduce<CommentSeverity>((top, level) => !top || SEVERITY_RANK.indexOf(level) > SEVERITY_RANK.indexOf(top) ? level : top, null);
}
const SEVERITY_RANK = ["low", "medium", "high", "critical"] as const;
export function commentAttempt(body: string): number | null {
  const match = /\battempt\s+(\d+)/i.exec(body);
  return match ? Number(match[1]) : null;
}

export interface DependencyTodo { id: string; project?: string | null; depends_on?: readonly string[]; }
export function blockingTasks<T extends DependencyTodo>(current: T, todos: readonly T[]): T[] {
  return todos.filter((todo) => todo.project === current.project && (todo.depends_on ?? []).includes(current.id));
}

export interface AttemptReview { approved?: boolean; counts?: { critical: number; high: number; medium: number; low: number } | null; }
export function reviewOutcome(attempts: readonly { review?: AttemptReview | null }[]): "approved" | "findings" | null {
  const review = [...attempts].reverse().find((attempt) => attempt.review)?.review;
  if (!review) return null;
  if (review.approved) return "approved";
  const counts = review.counts;
  return counts && counts.critical + counts.high + counts.medium + counts.low > 0 ? "findings" : null;
}

export interface WorkSession { context?: { role?: "worker" | "review" | null }; tree?: { cost?: number }; }
export function sessionRoleCosts(payload: { sessions?: readonly WorkSession[]; attempts?: readonly { sessions?: readonly WorkSession[] }[] } | null): { worker: number; review: number } {
  const sessions = [
    ...(payload?.sessions ?? []),
    ...(payload?.attempts?.flatMap((attempt) => attempt.sessions ?? []) ?? []),
  ];
  return sessions.reduce((total, session) => {
    const cost = Number(session.tree?.cost);
    if (Number.isFinite(cost)) {
      if (session.context?.role === "review") total.review += cost;
      else total.worker += cost;
    }
    return total;
  }, { worker: 0, review: 0 });
}
