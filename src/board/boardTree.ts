import type { BoardChange } from "../contracts/board";
import type { BoardIndexes, BoardRow } from "./boardStore";
import { projectTodos, type TodoFilters } from "./todoFilter";

export type BoardTreeNodeKind = "change" | "legacy" | "group" | "ungrouped" | "task";

export interface BoardTreeProgress {
  done: number;
  total: number;
}

export interface BoardTreeNode {
  kind: BoardTreeNodeKind;
  id: string;
  number: number | null;
  title: string;
  status: string | null;
  progress: BoardTreeProgress;
  cost: number;
  children: readonly BoardTreeNode[];
  closed: boolean;
}

export interface BoardTreeRow extends BoardRow {
  cost?: number | null;
  filterProject?: string | null;
}

export interface VisibleBoardTreeRow {
  node: BoardTreeNode;
  depth: number;
}

export interface BoardTreeSummary {
  active: number;
  total: number;
  cost: number;
}

const taskSort = (left: BoardTreeRow, right: BoardTreeRow) => left.number - right.number || left.id.localeCompare(right.id);
const activityOf = (row: Pick<BoardTreeRow, "updated_at" | "created_at">) => row.updated_at || row.created_at || "";
const closedTask = (row: BoardTreeRow) => row.status === "done";
const costOf = (row: BoardTreeRow) => Number.isFinite(row.cost) ? row.cost as number : 0;

function progress(rows: readonly BoardTreeRow[]): BoardTreeProgress {
  return { done: rows.filter(closedTask).length, total: rows.length };
}

function taskNode(row: BoardTreeRow): BoardTreeNode {
  return {
    kind: "task",
    id: row.id,
    number: row.number,
    title: row.subject,
    status: row.status,
    progress: { done: closedTask(row) ? 1 : 0, total: 1 },
    cost: costOf(row),
    children: [],
    closed: closedTask(row),
  };
}

function membersNode(
  kind: "change" | "legacy",
  id: string,
  number: number,
  title: string,
  rows: readonly BoardTreeRow[],
  closed: boolean,
): BoardTreeNode {
  const children = [...rows].sort(taskSort).map(taskNode);
  return {
    kind,
    id,
    number,
    title,
    status: null,
    progress: progress(rows),
    cost: rows.reduce((total, row) => total + costOf(row), 0),
    children,
    closed,
  };
}

export function buildBoardTree(
  rows: readonly BoardTreeRow[],
  changes: readonly BoardChange[],
  filters: TodoFilters,
  indexes?: Pick<BoardIndexes, "search">,
): readonly BoardTreeNode[] {
  const visible = projectTodos(rows, filters, indexes).visible;
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const legacyById = new Map(rows.filter((row) => row.change).map((row) => [row.id, row]));
  const visibleIds = new Set(visible.map((row) => row.id));

  if (!filters.showDone && !filters.status) {
    const includingDone = projectTodos(rows, { ...filters, showDone: true }, indexes).visible;
    for (const row of includingDone) {
      if (row.status !== "done" || !row.change_id) continue;
      const change = changeById.get(row.change_id);
      if (change && !change.closed_at) visibleIds.add(row.id);
    }
  }

  const memberRows = new Map<string, BoardTreeRow[]>();
  const groups = new Map<string, BoardTreeRow[]>();

  for (const row of rows) {
    if (!visibleIds.has(row.id) || row.change) continue;
    if (row.change_id && (changeById.has(row.change_id) || legacyById.has(row.change_id))) {
      const members = memberRows.get(row.change_id) ?? [];
      members.push(row);
      memberRows.set(row.change_id, members);
      continue;
    }
    const project = row.filterProject ?? row.project ?? "";
    const members = groups.get(project) ?? [];
    members.push(row);
    groups.set(project, members);
  }

  const changeNodes: Array<{ node: BoardTreeNode; activity: string; project: string }> = [];
  for (const change of changes) {
    const members = memberRows.get(change.id) ?? [];
    if (!members.length) continue;
    changeNodes.push({
      node: membersNode("change", change.id, change.number, change.title, members, !!change.closed_at),
      activity: change.updated_at ?? members.reduce((latest, row) => latest > activityOf(row) ? latest : activityOf(row), ""),
      project: members[0].filterProject ?? change.project ?? members[0].project ?? "",
    });
  }
  for (const legacy of legacyById.values()) {
    const members = memberRows.get(legacy.id) ?? [];
    if (!members.length && !visibleIds.has(legacy.id)) continue;
    const allRows = members.length ? members : [legacy];
    changeNodes.push({
      node: membersNode("legacy", legacy.id, legacy.number, legacy.subject, allRows, closedTask(legacy)),
      activity: activityOf(legacy),
      project: legacy.filterProject ?? legacy.project ?? "",
    });
  }
  changeNodes.sort((left, right) => Number(left.node.closed) - Number(right.node.closed)
    || right.activity.localeCompare(left.activity) || (right.node.number ?? 0) - (left.node.number ?? 0));

  const projects = new Set<string>([...groups.keys(), ...changeNodes.map((entry) => entry.project)]);
  const projectNodes = [...projects].map((project) => {
    const loose = [...(groups.get(project) ?? [])].sort(taskSort);
    const changeChildren = changeNodes.filter((entry) => entry.project === project).map((entry) => entry.node);
    const looseChildren = loose.map(taskNode);
    const children: BoardTreeNode[] = looseChildren.length
      ? [...changeChildren, {
        kind: "ungrouped" as const,
        id: `project:${project}:ungrouped`,
        number: null,
        title: "",
        status: null,
        progress: progress(loose),
        cost: looseChildren.reduce((sum, node) => sum + node.cost, 0),
        children: looseChildren,
        closed: looseChildren.every((node) => node.closed),
      }]
      : changeChildren;
    const done = changeChildren.reduce((sum, node) => sum + node.progress.done, 0) + loose.filter(closedTask).length;
    const total = changeChildren.reduce((sum, node) => sum + node.progress.total, 0) + loose.length;
    return {
      kind: "group" as const,
      id: `project:${project}`,
      number: null,
      title: project,
      status: null,
      progress: { done, total },
      cost: children.reduce((sum, node) => sum + node.cost, 0),
      children,
      closed: children.every((node) => node.closed),
    };
  });
  projectNodes.sort((left, right) => Number(left.closed) - Number(right.closed) || left.title.localeCompare(right.title));
  return projectNodes;
}

export function findBoardTreeNode(tree: readonly BoardTreeNode[], id: string): BoardTreeNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const hit = findBoardTreeNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

export function visibleBoardTreeRows(
  tree: readonly BoardTreeNode[],
  collapsed: ReadonlySet<string>,
): readonly VisibleBoardTreeRow[] {
  const visible: VisibleBoardTreeRow[] = [];
  const visit = (node: BoardTreeNode, depth: number) => {
    visible.push({ node, depth });
    if (collapsed.has(node.id)) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of tree) visit(node, 0);
  return visible;
}

export function boardTreeSummary(tree: readonly BoardTreeNode[]): BoardTreeSummary {
  const summary: BoardTreeSummary = { active: 0, total: 0, cost: 0 };
  const visit = (node: BoardTreeNode) => {
    if (node.kind === "task") {
      summary.total += 1;
      summary.active += Number(!node.closed);
      summary.cost += node.cost;
      return;
    }
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return summary;
}
