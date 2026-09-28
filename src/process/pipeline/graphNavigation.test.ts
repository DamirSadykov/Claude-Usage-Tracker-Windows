import { describe, expect, it } from "vitest";
import { graphHits, stepGraphHit } from "./graphNavigation";

describe("pipeline graph navigation", () => {
    const nodes = [
        { id: "#12", title: "Build filters" },
        { id: "#2", title: "Search graph" },
        { id: "#30", title: "Deploy" },
    ];

    it("finds title and numeric hits in graph order", () => {
        expect(graphHits(nodes, "graph")).toEqual(["#2"]);
        expect(graphHits(nodes, "2")).toEqual(["#2", "#12"]);
    });

    it("cycles in either direction and wraps", () => {
        const hits = ["#2", "#12", "#30"];
        expect(stepGraphHit(hits, "#12")).toBe("#30");
        expect(stepGraphHit(hits, "#2", -1)).toBe("#30");
        expect(stepGraphHit(hits, null, -1)).toBe("#30");
    });
});
