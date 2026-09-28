import { describe, expect, it } from "vitest";
import { visibleGraph } from "./visibleGraph";
import type { BoardTodo } from "./adapt";

const row = (id: string, extra: Partial<BoardTodo> = {}): BoardTodo => ({ id, subject: id, status: "queue", ...extra });

describe("visibleGraph", () => {
    it("indexes cards by lane and wave without renderer filtering", () => {
        const graph = visibleGraph(7, [
            row("a", { number: 1, project: "one" }),
            row("b", { number: 2, project: "one", depends_on: ["a"] }),
        ]);
        expect(graph.revision).toBe(7);
        expect(graph.tasksByLane.get("free:one")?.map((task) => task.id)).toEqual(["#1", "#2"]);
        expect(graph.tasksByLaneWave.get("free:one")?.get(2)?.[0].id).toBe("#2");
        expect(graph.byId.get("#1")?.title).toBe("a");
    });

    it("does not expose mutable maps or task records", () => {
        const graph = visibleGraph(7, [row("a", { number: 1, project: "one" })]);
        const task = graph.byId.get("#1")!;
        expect(Object.isFrozen(task)).toBe(true);
        expect(Object.isFrozen(graph.tasksByLane.get("free:one"))).toBe(true);
        expect("set" in graph.byId).toBe(false);
        expect("set" in graph.tasksByLaneWave).toBe(false);
    });
});
