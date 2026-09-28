import { describe, expect, it } from "vitest";
import { changeHeaderSummary, referenceIndex, stableBubbleRoots } from "./changeSelectors";

describe("referenceIndex", () => {
    const board = [
        { id: "a", number: 1, subject: "a", status: "queue", description: "t#2", links: ["c"] },
        { id: "b", number: 2, subject: "b", status: "queue" },
        { id: "c", number: 3, subject: "c", status: "queue" },
    ];
    it("parses refs once for an immutable board revision", () => {
        const first = referenceIndex(board);
        expect(referenceIndex(board)).toBe(first);
        expect(first.edges).toEqual([{ from: "a", to: "c" }, { from: "a", to: "b" }]);
        expect(first.outgoing.get("a")).toBe(2);
        expect(first.outgoingNodes.get("a")).toEqual(["c", "b"]);
        expect(first.incomingNodes.get("b")).toEqual(["a"]);
        expect(first.adjacency.get("b")?.has("a")).toBe(true);
    });
});

describe("stableBubbleRoots", () => {
    it("keeps every root in place when a different bubble is opened", () => {
        const roots = [{ id: "spec#a", radius: 90 }, { id: "spec#b", radius: 110 }];
        const before = stableBubbleRoots(roots, 1200, 800);
        const after = stableBubbleRoots(roots, 1200, 800);
        expect(after).toEqual(before);
    });
});

describe("changeHeaderSummary", () => {
    it("uses only current change members", () => {
        const change = { id: "c1", number: 1, title: "one" };
        expect(changeHeaderSummary(change, [
            { id: "a", subject: "a", status: "done", change_id: "c1" },
            { id: "b", subject: "b", status: "queue", change_id: "other" },
        ])).toEqual({ total: 1, done: 1, open: false });
    });
});
