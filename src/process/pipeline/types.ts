export type NodeStatus = "blocked" | "ready" | "waiting" | "review" | "done";

export type ArtifactKind = "spec" | "file" | "handoff" | "after";

export interface Artifact {
    kind: ArtifactKind;
    address: string;
    short: string;
    exists: boolean;
}

export interface PortRef {
    dir: "R" | "W";
    kind: ArtifactKind;
    label: string;
    exists?: boolean;
}

export interface TaskNode {
    id: string;
    title: string;
    status: NodeStatus;
    auto?: boolean;
    done?: boolean;
    active?: boolean;
    selected?: boolean;
    wave: number;
    lane: string;
    cost?: string;
    costKnown?: boolean;
    costNote?: string;
    costShare?: number;
    runs?: number;
    ports?: PortRef[];
    warn?: string;
}

export interface TaskLink {
    from: string;
    to: string;
    artifact?: Artifact;
}

export interface LanePort {
    side: "left" | "right";
    label: string;
    sub: string;
}

export interface Lane {
    id: string;
    kicker: string;
    title: string;
    note?: string;
    progress?: number;
    progressLabel?: string;
    cost?: string;
    duration?: string;
    tone?: "theme" | "plain" | "warn";
    done?: boolean;
    ports?: LanePort[];
    artifactSummary?: string[];
    tail?: { label: string; note: string };
    more?: { text: string; action: string };
}

export interface ProjectBand {
    name: string;
    tasks: string;
    cost: string;
    lanes: string[];
}

export interface SpecLaneRef {
    id: string;
    title: string;
    state?: string;
    tone?: "task" | "spec" | "external";
}

export interface SpecFileRef {
    path: string;
    anchor: string;
    exists: boolean;
    note?: string;
}

export interface SpecLane {
    id: string;
    kicker: string;
    address: string;
    title: string;
    note?: string;
    part?: string;
    partWarn?: string;
    prose?: string;
    lintLabel?: string;
    lintTone?: "ok" | "warn";
    metrics?: string[];
    chips?: { text: string; tone: "theme" | "ok" | "warn" }[];
    tone?: "spec" | "warn" | "plain";
    incoming: SpecLaneRef[];
    outgoing: SpecLaneRef[];
    files: SpecFileRef[];
    more?: { text: string; action: string };
}

export interface RingNode {
    id: string;
    label: string;
    title: string;
    ring: 0 | 1 | 2;
    angle: number;
    radius: number;
    tone?: "focus" | "hub" | "spec" | "plain";
    badge?: string;
    counter?: string;
    dashed?: boolean;
}

export interface RingCluster {
    id: string;
    title: string;
    note: string;
    x: number;
    y: number;
    size: number;
}

export interface RingLink {
    from: string;
    to: string;
    dashed?: boolean;
}

export interface FocusRow {
    id: string;
    title: string;
    count: number;
    kind?: "task" | "spec";
}
