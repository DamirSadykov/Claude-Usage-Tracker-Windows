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
  project?: string;
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

export interface BoardTreeOptions {
  flat?: boolean;
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
  allMembers: readonly BoardTreeRow[] = rows,
  project?: string,
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
    closed: closed || (allMembers.length > 0 && allMembers.every(closedTask)),
    project,
  };
}

function changeMatchesQuery(change: Pick<BoardChange, "number" | "title">, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return false;
  if (change.title.toLocaleLowerCase().includes(normalized)) return true;
  const numberQuery = normalized.match(/^(?:c#|#)?(\d+)$/)?.[1];
  return !!numberQuery && String(change.number).includes(numberQuery);
}

export function buildBoardTree(
  rows: readonly BoardTreeRow[],
  changes: readonly BoardChange[],
  filters: TodoFilters,
  indexes?: Pick<BoardIndexes, "search">,
  options: BoardTreeOptions = {},
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

  const visibleWithoutQueryIds = new Set(visibleIds);
  if (options.flat && filters.query.trim()) {
    const withoutQuery = { ...filters, query: "" };
    const rowsWithoutQuery = projectTodos(rows, withoutQuery, indexes).visible;
    visibleWithoutQueryIds.clear();
    rowsWithoutQuery.forEach((row) => visibleWithoutQueryIds.add(row.id));
    if (!withoutQuery.showDone && !withoutQuery.status) {
      const includingDone = projectTodos(rows, { ...withoutQuery, showDone: true }, indexes).visible;
      for (const row of includingDone) {
        if (row.status !== "done" || !row.change_id) continue;
        const change = changeById.get(row.change_id);
        if (change && !change.closed_at) visibleWithoutQueryIds.add(row.id);
      }
    }
  }

  const memberRows = new Map<string, BoardTreeRow[]>();
  const allMemberRows = new Map<string, BoardTreeRow[]>();
  const groups = new Map<string, BoardTreeRow[]>();

  for (const row of rows) {
    if (row.change) continue;
    if (row.change_id && (changeById.has(row.change_id) || legacyById.has(row.change_id))) {
      const allMembers = allMemberRows.get(row.change_id) ?? [];
      allMembers.push(row);
      allMemberRows.set(row.change_id, allMembers);
      if (visibleIds.has(row.id)) {
        const members = memberRows.get(row.change_id) ?? [];
        members.push(row);
        memberRows.set(row.change_id, members);
      }
      continue;
    }
    if (!visibleIds.has(row.id)) continue;
    const project = row.filterProject ?? row.project ?? "";
    const members = groups.get(project) ?? [];
    members.push(row);
    groups.set(project, members);
  }

  const changeNodes: Array<{ node: BoardTreeNode; activity: string; created: string; project: string }> = [];
  for (const change of changes) {
    const titleMatch = options.flat && changeMatchesQuery(change, filters.query);
    const members = titleMatch
      ? (allMemberRows.get(change.id) ?? []).filter((row) => visibleWithoutQueryIds.has(row.id))
      : memberRows.get(change.id) ?? [];
    const project = members[0]?.filterProject ?? change.project ?? members[0]?.project ?? "";
    if (!members.length && (!titleMatch || (filters.project && project !== filters.project))) continue;
    changeNodes.push({
      node: membersNode("change", change.id, change.number, change.title, members, !!change.closed_at, allMemberRows.get(change.id), project),
      activity: change.updated_at ?? members.reduce((latest, row) => latest > activityOf(row) ? latest : activityOf(row), ""),
      created: change.created_at ?? "",
      project,
    });
  }
  for (const legacy of legacyById.values()) {
    const titleMatch = options.flat && changeMatchesQuery({ number: legacy.number, title: legacy.subject }, filters.query);
    const members = titleMatch
      ? (allMemberRows.get(legacy.id) ?? []).filter((row) => visibleWithoutQueryIds.has(row.id))
      : memberRows.get(legacy.id) ?? [];
    const project = legacy.filterProject ?? legacy.project ?? "";
    if (!members.length && !visibleIds.has(legacy.id) && (!titleMatch || (filters.project && project !== filters.project))) continue;
    const allRows = members.length ? members : [legacy];
    changeNodes.push({
      node: membersNode("legacy", legacy.id, legacy.number, legacy.subject, allRows, closedTask(legacy), allMemberRows.get(legacy.id), project),
      activity: activityOf(legacy),
      created: legacy.created_at,
      project,
    });
  }
  changeNodes.sort((left, right) => Number(left.node.closed) - Number(right.node.closed)
    || (options.flat ? right.created.localeCompare(left.created) : right.activity.localeCompare(left.activity))
    || (right.node.number ?? 0) - (left.node.number ?? 0));

  if (options.flat) return changeNodes.map((entry) => entry.node);

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
