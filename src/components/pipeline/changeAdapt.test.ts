import { describe, it, expect } from "vitest";
import {
    attemptsOf,
    blockersFor,
    changeAddress,
    changeIsOpen,
    changeMembers,
    changeProgress,
    costFor,
    historyFor,
    openChangesAt,
    passedFor,
    specAddressesOf,
    specEditsCount,
    specSummaryFor,
    waitingFor,
    type ChangeRecord,
    type ChangeTask,
} from "./changeAdapt";
import type { RunGraphNode } from "../../graphModel";

function change(p: Partial<ChangeRecord> & { id: string; number: number }): ChangeRecord {
    return { title: "change", ...p };
}

function task(p: Partial<ChangeTask> & { id: string }): ChangeTask {
    return { subject: p.id, status: "backlog", ...p };
}

function node(p: Partial<RunGraphNode> & { id: string }): RunGraphNode {
    return {
        number: 0,
        subject: "",
        status: "queue",
        gate: true,
        group: false,
        cost: null,
        duration_minutes: null,
        duration_calendar: false,
        measurability: "no_in_progress",
        blocks: 0,
        tokens: null,
        messages: null,
        tool_calls: null,
        tool_errors: null,
        task_cost: null,
        unattributed_cost: null,
        agents: [],
        ...p,
    };
}

describe("changeMembers / changeProgress / changeIsOpen", () => {
    const c = change({ id: "c1", number: 1 });
    const board = [
        task({ id: "a", change_id: "c1", number: 1, status: "done" }),
        task({ id: "b", change_id: "c1", number: 2, status: "in_progress" }),
        task({ id: "x", change_id: "other", number: 3, status: "done" }),
    ];

    it("отбирает задачи по change_id и сортирует по номеру", () => {
        expect(changeMembers(board, c).map((t) => t.number)).toEqual([1, 2]);
    });

    it("прогресс считает done/total только по членам", () => {
        expect(changeProgress(changeMembers(board, c))).toEqual({ total: 2, done: 1 });
    });

    it("change открыт, пока не все члены done", () => {
        expect(changeIsOpen(changeMembers(board, c))).toBe(true);
    });

    it("change без членов тоже открыт — он ничего не закончил", () => {
        expect(changeIsOpen([])).toBe(true);
    });

    it("change закрыт, когда все члены done", () => {
        const closedBoard = board.map((t) => ({ ...t, status: "done" }));
        expect(changeIsOpen(changeMembers(closedBoard, c))).toBe(false);
    });
});

describe("blockersFor — done-gate: закрыта без ответа на спеку", () => {
    it("флагует задачу, закрытую со ссылкой, но без spec_answers по этому адресу (живой случай t#340 в c#8)", () => {
        const c = change({ id: "c8", number: 8 });
        const members = [
            task({
                id: "t340",
                number: 340,
                status: "done",
                change_id: "c8",
                spec: ["tasks#changes", "tasks#context"],
            }),
        ];
        const found = blockersFor(c, members, [c], members);
        expect(found).toHaveLength(2);
        expect(found.map((b) => b.rule)).toEqual(["spec-answer-missing", "spec-answer-missing"]);
        expect(found[0].title).toMatch(/#340 закрыта без ответа на tasks#changes/);
    });

    it("не флагует, когда ответ по адресу есть", () => {
        const c = change({ id: "c8", number: 8 });
        const members = [
            task({
                id: "t339",
                number: 339,
                status: "done",
                change_id: "c8",
                spec: ["tasks#spec-registry"],
                spec_answers: [
                    { address: "tasks#spec-registry", verdict: "unchanged", note: "ok", at: "2026-08-03T00:00:00Z" },
                ],
            }),
        ];
        expect(blockersFor(c, members, [c], members)).toEqual([]);
    });

    it("не флагует задачу, которая ещё не done", () => {
        const c = change({ id: "c8", number: 8 });
        const members = [task({ id: "t1", number: 1, status: "review", change_id: "c8", spec: ["tasks#ui"] })];
        expect(blockersFor(c, members, [c], members)).toEqual([]);
    });
});

describe("blockersFor — конкурентные change'и на один раздел", () => {
    it("два открытых change'а на один адрес — блокер с именем другого", () => {
        const c1 = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const c2 = change({ id: "c2", number: 2, title: "второй", spec: ["tasks#ui"] });
        const board = [
            task({ id: "a", change_id: "c1", number: 1, status: "in_progress" }),
            task({ id: "b", change_id: "c2", number: 2, status: "in_progress" }),
        ];
        const found = blockersFor(c1, changeMembers(board, c1), [c1, c2], board);
        expect(found).toHaveLength(1);
        expect(found[0].rule).toBe("concurrent-change");
        expect(found[0].detail).toMatch(/c#2 "второй"/);
    });

    it("один открытый change на адрес — не блокер", () => {
        const c1 = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const board = [task({ id: "a", change_id: "c1", number: 1, status: "in_progress" })];
        expect(blockersFor(c1, changeMembers(board, c1), [c1], board)).toEqual([]);
    });

    it("второй change закрыт — конфликта нет", () => {
        const c1 = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const c2 = change({ id: "c2", number: 2, spec: ["tasks#ui"] });
        const board = [
            task({ id: "a", change_id: "c1", number: 1, status: "in_progress" }),
            task({ id: "b", change_id: "c2", number: 2, status: "done" }),
        ];
        expect(blockersFor(c1, changeMembers(board, c1), [c1, c2], board)).toEqual([]);
    });
});

describe("blockersFor — outcome issue / retry исчерпан", () => {
    it("outcome issue флагуется", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "review", outcome: "issue", outcome_reason: "verify:issue" })];
        const found = blockersFor(c, members, [c], members);
        expect(found).toHaveLength(1);
        expect(found[0].rule).toBe("task-outcome-issue");
        expect(found[0].detail).toBe("verify:issue");
    });

    it("попытки сверх retry_limit на незакрытой задаче флагуются", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [
            task({
                id: "a",
                number: 1,
                change_id: "c1",
                status: "review",
                retry_limit: 1,
                status_history: [
                    { status: "in_progress", at: "1" },
                    { status: "review", at: "2" },
                    { status: "in_progress", at: "3" },
                    { status: "review", at: "4" },
                ],
            }),
        ];
        expect(attemptsOf(members[0])).toBe(2);
        const found = blockersFor(c, members, [c], members);
        expect(found.map((b) => b.rule)).toEqual(["retry-exhausted"]);
    });

    it("попытки в пределах лимита не флагуются", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [
            task({
                id: "a",
                number: 1,
                change_id: "c1",
                status: "review",
                retry_limit: 2,
                status_history: [{ status: "in_progress", at: "1" }],
            }),
        ];
        expect(blockersFor(c, members, [c], members)).toEqual([]);
    });
});

describe("blockersFor — спека молча отстаёт (живой случай c#9)", () => {
    it("change открыт, есть done-задачи, но ни у change'а, ни у задач нет ссылки на спеку", () => {
        const c = change({ id: "c9", number: 9, spec: [] });
        const members = [
            task({ id: "a", number: 361, change_id: "c9", status: "done" }),
            task({ id: "b", number: 369, change_id: "c9", status: "backlog" }),
        ];
        const found = blockersFor(c, members, [c], members);
        expect(found.map((b) => b.rule)).toEqual(["spec-silently-behind"]);
    });

    it("не флагуется, если ни одна задача ещё не закрыта", () => {
        const c = change({ id: "c1", number: 1, spec: [] });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "backlog" })];
        expect(blockersFor(c, members, [c], members)).toEqual([]);
    });

    it("не флагуется, если у change'а есть ссылка на спеку", () => {
        const c = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "done" })];
        expect(blockersFor(c, members, [c], members)).toEqual([]);
    });
});

describe("waitingFor", () => {
    it("собирает задачи в review, ручной гейт отмечен отдельно", () => {
        const members = [
            task({ id: "a", number: 1, status: "review", kind: "auto" }),
            task({ id: "b", number: 2, status: "review" }),
            task({ id: "c", number: 3, status: "done" }),
        ];
        const found = waitingFor(members);
        expect(found).toHaveLength(2);
        expect(found[0]).toMatchObject({ taskNumber: 1, gate: false });
        expect(found[1]).toMatchObject({ taskNumber: 2, gate: true });
    });
});

describe("passedFor", () => {
    it("не заявляет проверку про спеку, если ни одна задача на неё не ссылается", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "done" })];
        const passed = passedFor(c, members, [], []);
        expect(passed.map((p) => p.id)).not.toContain("spec-answered");
    });

    it("засчитывает проверку про спеку, когда ссылки есть и блокеров нет", () => {
        const c = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "done" })];
        const passed = passedFor(c, members, [], []);
        expect(passed.map((p) => p.id)).toContain("spec-answered");
    });

    it("не засчитывает чистоту инструментов без измеренных узлов", () => {
        expect(passedFor(change({ id: "c1", number: 1 }), [], [], [])).toEqual([]);
    });

    it("засчитывает чистые прогоны, когда все измеренные узлы без ошибок инструментов", () => {
        const nodes = [node({ id: "a", measurability: "measured", tool_errors: 0 })];
        const passed = passedFor(change({ id: "c1", number: 1 }), [], [], nodes);
        expect(passed.map((p) => p.id)).toContain("no-tool-errors");
    });

    it("не засчитывает чистые прогоны при хотя бы одной ошибке инструмента", () => {
        const nodes = [node({ id: "a", measurability: "measured", tool_errors: 1 })];
        const passed = passedFor(change({ id: "c1", number: 1 }), [], [], nodes);
        expect(passed.map((p) => p.id)).not.toContain("no-tool-errors");
    });
});

describe("specSummaryFor", () => {
    it("считает добавленные/удалённые строки только там, где есть и слепок, и текст ответа", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [
            task({
                id: "a",
                number: 1,
                change_id: "c1",
                status: "done",
                spec: ["tasks#ui"],
                spec_seen: [{ address: "tasks#ui", hash: "h", blocks: [], text: "line1\nline2", at: "t" }],
                spec_answers: [
                    { address: "tasks#ui", verdict: "updated", note: "n", at: "t", after: "line1\nline3" },
                ],
            }),
        ];
        const rows = specSummaryFor(c, members, [c], members);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ address: "tasks#ui", added: 1, removed: 1, concurrent: false });
    });

    it("не считает дифф для задачи без текста слепка", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [
            task({
                id: "a",
                number: 1,
                change_id: "c1",
                status: "review",
                spec: ["tasks#spec-registry"],
            }),
        ];
        const rows = specSummaryFor(c, members, [c], members);
        expect(rows[0]).toMatchObject({ added: 0, removed: 0 });
        expect(rows[0].tasks[0]).toMatchObject({ taskNumber: 1, status: "review", verdict: undefined });
    });

    it("отмечает конкурентность и перечисляет другие открытые change'и", () => {
        const c1 = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const c2 = change({ id: "c2", number: 2, spec: ["tasks#ui"] });
        const board = [
            task({ id: "a", change_id: "c1", number: 1, status: "in_progress" }),
            task({ id: "b", change_id: "c2", number: 2, status: "in_progress" }),
        ];
        const rows = specSummaryFor(c1, changeMembers(board, c1), [c1, c2], board);
        expect(rows[0].concurrent).toBe(true);
        expect(rows[0].openOthers).toEqual(["c#2"]);
    });
});

describe("historyFor", () => {
    it("собирает события change'а и задач и сортирует по убыванию даты", () => {
        const c = change({
            id: "c1",
            number: 1,
            created_at: "2026-08-01T00:00:00Z",
        });
        const members = [
            task({
                id: "a",
                number: 1,
                change_id: "c1",
                status: "done",
                status_history: [
                    { status: "in_progress", at: "2026-08-02T00:00:00Z" },
                    { status: "done", at: "2026-08-03T00:00:00Z" },
                ],
                spec_answers: [
                    { address: "tasks#ui", verdict: "unchanged", note: "заметка", at: "2026-08-02T12:00:00Z" },
                ],
                handoff_at: "2026-08-02T13:00:00Z",
            }),
        ];
        const events = historyFor(c, members);
        expect(events[0].at).toBe("2026-08-03T00:00:00Z");
        expect(events[events.length - 1].at).toBe("2026-08-01T00:00:00Z");
        expect(events.some((e) => e.label.includes("ответил"))).toBe(true);
        expect(events.some((e) => e.label.includes("оставил батон"))).toBe(true);
    });

    it("пропускает события без даты вместо падения", () => {
        const c = change({ id: "c1", number: 1 });
        const members = [task({ id: "a", number: 1, change_id: "c1", status: "backlog" })];
        expect(historyFor(c, members)).toEqual([]);
    });
});

describe("specEditsCount", () => {
    it("считает только ответы updated, unchanged не в счёте", () => {
        const members = [
            task({
                id: "a",
                number: 1,
                spec_answers: [
                    { address: "x#1", verdict: "updated", note: "", at: "t" },
                    { address: "x#2", verdict: "unchanged", note: "", at: "t" },
                ],
            }),
            task({
                id: "b",
                number: 2,
                spec_answers: [{ address: "x#3", verdict: "updated", note: "", at: "t" }],
            }),
        ];
        expect(specEditsCount(members)).toBe(2);
    });
});

describe("costFor", () => {
    it("честно помечает неизмеренную задачу вместо нуля", () => {
        const members = [task({ id: "a", number: 1, subject: "шаг" })];
        const cost = costFor(members, []);
        expect(cost.known).toBe(false);
        expect(cost.rows[0].money).toEqual({ text: "нет данных", known: false });
    });

    it("складывает измеренную стоимость по задачам change'а", () => {
        const members = [task({ id: "a", number: 1 }), task({ id: "b", number: 2 })];
        const nodes = [
            node({ id: "a", cost: 1.5, measurability: "measured" }),
            node({ id: "b", cost: 2.25, measurability: "measured" }),
        ];
        const cost = costFor(members, nodes);
        expect(cost.known).toBe(true);
        expect(cost.cost).toBeCloseTo(3.75);
        expect(cost.measuredCount).toBe(2);
    });

    it("считает unattributed отдельно от cost", () => {
        const members = [task({ id: "a", number: 1 })];
        const nodes = [node({ id: "a", cost: 1, measurability: "measured", unattributed_cost: 0.4 })];
        const cost = costFor(members, nodes);
        expect(cost.unattributed).toBeCloseTo(0.4);
    });
});

describe("openChangesAt / specAddressesOf", () => {
    it("объединяет адреса change'а и его задач без повторов", () => {
        const c = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const members = [task({ id: "a", number: 1, spec: ["tasks#ui", "tasks#spec-registry"] })];
        expect(specAddressesOf(c, members).sort()).toEqual(["tasks#spec-registry", "tasks#ui"]);
    });

    it("openChangesAt возвращает только открытые change'и на адрес", () => {
        const c1 = change({ id: "c1", number: 1, spec: ["tasks#ui"] });
        const c2 = change({ id: "c2", number: 2, spec: ["tasks#ui"] });
        const board = [
            task({ id: "a", change_id: "c1", number: 1, status: "in_progress" }),
            task({ id: "b", change_id: "c2", number: 2, status: "done" }),
        ];
        expect(openChangesAt("tasks#ui", [c1, c2], board).map((c) => changeAddress(c))).toEqual(["c#1"]);
    });
});
