// Shared status→column logic for external (readonly) tasks.
//
// External tasks carry SOURCE-NATIVE status strings (arbitrary per service). The
// tracker maps them onto four fixed kanban buckets. Two consumers share this:
//   - TodoWindow's External board — buckets tasks into columns, colours the pill;
//   - the Integrations settings panel — lets the user map each seen status by hand.
//
// The mapping is USER-OWNED (persisted in settings.json under STATUS_MAP_KEY). The
// keyword heuristic below is only the DEFAULT used to pre-fill a status the user
// hasn't mapped yet — so the board is sensible out of the box but fully overridable.

export type ExtBucketId = "open" | "active" | "done" | "other";

/** Column order + presentation. `labelKey` resolves through vue-i18n at the call site. */
export const EXT_BUCKETS: { id: ExtBucketId; labelKey: string; dot: string }[] = [
  { id: "open", labelKey: "extColOpen", dot: "#9aa0aa" },
  { id: "active", labelKey: "extColActive", dot: "#4cc2ff" },
  { id: "done", labelKey: "extColDone", dot: "#6ccb5f" },
  { id: "other", labelKey: "extColOther", dot: "#b388ff" },
];

/** settings.json key holding the user's `{ [sourceStatus]: bucket }` overrides. */
export const STATUS_MAP_KEY = "externalStatusMap";

export type StatusMap = Record<string, ExtBucketId>;

/**
 * Best-effort keyword match, used ONLY as the default for an unmapped status. A
 * status the heuristic doesn't recognise lands in "other" — visible, never dropped.
 */
export function defaultBucket(status: string): ExtBucketId {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|complete|fixed|merged|shipped)/.test(s)) return "done";
  if (/(progress|review|doing|active|testing)/.test(s)) return "active";
  if (/(open|new|backlog|todo|to.do|created)/.test(s)) return "open";
  return "other";
}

/** Resolve a status to a bucket: the user's explicit mapping wins, else the heuristic. */
export function resolveBucket(status: string, map: StatusMap | null | undefined): ExtBucketId {
  return map?.[status] ?? defaultBucket(status);
}

/** CSS modifier for a bucket's status pill (matches the `.s-*` rules in TodoWindow). */
export function bucketClass(bucket: ExtBucketId): string {
  return bucket === "other" ? "" : `s-${bucket}`;
}
