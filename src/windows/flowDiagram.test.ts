import { describe, expect, it } from "vitest";
import { flowDiagramForTodo, parseFlowDiagram } from "./flowDiagram";

describe("parseFlowDiagram", () => {
  it("reads the diagram from the backend ext.process payload", () => {
    expect(flowDiagramForTodo({
      ext: { process: { flow_diagram: { plan: "```mermaid\ngraph TD\n```" } } },
    })).toEqual({ plan: "```mermaid\ngraph TD\n```" });
  });

  it("keeps split parts of one method together", () => {
    expect(parseFlowDiagram("## src/notify.rs — send_sms\n```mermaid\nflowchart TD\n  a-->b\n```\n\n```mermaid\nflowchart TD\n  b-->c\n```"))
      .toEqual([{ title: "src/notify.rs — send_sms", sources: ["flowchart TD\n  a-->b", "flowchart TD\n  b-->c"] }]);
  });

  it("starts a new section at the next method heading", () => {
    expect(parseFlowDiagram("## first\n```mermaid\ngraph TD\n```\n## second\n```mermaid\ngraph LR\n```"))
      .toEqual([{ title: "first", sources: ["graph TD"] }, { title: "second", sources: ["graph LR"] }]);
  });
});
