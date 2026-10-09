export interface FlowDiagramSection {
  title: string;
  sources: string[];
}

export interface FlowDiagram {
  plan?: string;
  result?: string;
}

export function flowDiagramForTodo(todo: {
  flow_diagram?: FlowDiagram;
  ext?: Record<string, unknown>;
} | null | undefined): FlowDiagram | undefined {
  if (todo?.flow_diagram) return todo.flow_diagram;
  const process = todo?.ext?.process;
  if (!process || typeof process !== "object") return undefined;
  const diagram = (process as Record<string, unknown>).flow_diagram;
  return diagram && typeof diagram === "object" ? diagram as FlowDiagram : undefined;
}

export function parseFlowDiagram(markdown: string): FlowDiagramSection[] {
  const sections: FlowDiagramSection[] = [];
  let title = "";
  let current: FlowDiagramSection | undefined;
  const pattern = /^##\s+(.+)$|^```mermaid\s*\r?\n([\s\S]*?)\r?\n```/gm;

  for (const match of markdown.matchAll(pattern)) {
    if (match[1] !== undefined) {
      title = match[1].trim();
      current = undefined;
      continue;
    }

    const source = match[2].trim();
    if (!source) continue;
    if (!current || current.title !== title) {
      current = { title, sources: [] };
      sections.push(current);
    }
    current.sources.push(source);
  }

  return sections;
}
