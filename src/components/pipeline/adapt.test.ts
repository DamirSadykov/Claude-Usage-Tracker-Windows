import { describe, it, expect } from "vitest";
import {
    focusRows,
    hubIds,
    laneIndex,
    laneTotals,
    moneyOf,
    nodeStatus,
    refEdges,
    specPorts,
    toLanes,
    toProjectBands,
    toSpecLanes,
    toTaskLinks,
    toTaskNodes,
    wavesOf,
    specTree,
    commonAncestor,
    type BoardTodo,
    type BoardChange,
} from "./adapt";
import type { RunGraphNode } from "../../graphModel";

function todo(p: Partial<BoardTodo> & { id: string }): BoardTodo {
    return { subject: p.id, status: "queue", ...p };
}

function runNode(p: Partial<RunGraphNode> & { id: string }): RunGraphNode {
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

describe("nodeStatus", () => {
    const board = [
        todo({ id: "a", status: "done" }),
        todo({ id: "b", status: "queue" }),
        todo({ id: "c", status: "queue", depends_on: ["b"] }),
        todo({ id: "d", status: "queue", depends_on: ["a"], kind: "auto" }),
    ];
    const byId = new Map(board.map((t) => [t.id, t]));

    it("закрытая задача — done", () => {
        expect(nodeStatus(byId.get("a")!, byId)).toBe("done");
    });

    it("незакрытая зависимость — blocked", () => {
        expect(nodeStatus(byId.get("c")!, byId)).toBe("blocked");
    });

    it("свободная auto-нода — ready", () => {
        expect(nodeStatus(byId.get("d")!, byId)).toBe("ready");
    });

    it("свободная ручная задача ждёт человека", () => {
        expect(nodeStatus(byId.get("b")!, byId)).toBe("waiting");
    });
});

describe("wavesOf", () => {
    it("уровень — длиннейший путь предшественников", () => {
        const waves = wavesOf(
            ["a", "b", "c", "d"],
            [
                { from: "a", to: "b" },
                { from: "b", to: "c" },
                { from: "a", to: "c" },
                { from: "d", to: "c" },
            ],
        );
        expect(waves.get("a")).toBe(1);
        expect(waves.get("d")).toBe(1);
        expect(waves.get("b")).toBe(2);
        expect(waves.get("c")).toBe(3);
    });

    it("рёбра наружу набора игнорируются", () => {
        const waves = wavesOf(["a"], [{ from: "x", to: "a" }]);
        expect(waves.get("a")).toBe(1);
    });

    it("цикл не вешает обход", () => {
        const waves = wavesOf(
            ["a", "b"],
            [
                { from: "a", to: "b" },
                { from: "b", to: "a" },
            ],
        );
        expect(waves.size).toBe(2);
    });
});

describe("laneIndex", () => {
    const board = [
        todo({ id: "root", number: 337, change: true, depends_on: ["x", "y"] }),
        todo({ id: "x", depends_on: ["z"] }),
        todo({ id: "y" }),
        todo({ id: "z" }),
        todo({ id: "loose" }),
    ];

    it("дорожка забирает всё поддерево change'а", () => {
        const index = laneIndex(board);
        expect(index.laneOf.get("x")).toBe("root");
        expect(index.laneOf.get("z")).toBe("root");
    });

    it("задача вне тем попадает в свободную дорожку своего проекта", () => {
        const index = laneIndex(board);
        expect(index.laneOf.get("loose")).toBe("free:");
        expect(index.members.get("free:")).toEqual(["loose"]);
    });

    it("у каждого проекта своя свободная дорожка", () => {
        const index = laneIndex([
            todo({ id: "a", project: "alpha" }),
            todo({ id: "b", project: "beta" }),
            todo({ id: "c", project: "beta" }),
        ]);
        expect(index.laneOf.get("a")).toBe("free:alpha");
        expect(index.laneOf.get("b")).toBe("free:beta");
        expect(index.members.get("free:beta")).toEqual(["b", "c"]);
        expect(index.members.get("free:alpha")).toEqual(["a"]);
    });

    it("вложенный change остаётся своей дорожкой", () => {
        const nested = [
            todo({ id: "r1", number: 1, change: true, depends_on: ["r2"] }),
            todo({ id: "r2", number: 2, change: true, depends_on: ["k"] }),
            todo({ id: "k" }),
        ];
        const index = laneIndex(nested);
        expect(index.laneOf.get("r2")).toBe("r2");
        expect(index.laneOf.get("k")).toBe("r2");
    });
});

describe("moneyOf", () => {
    it("измеренная задача отдаёт сумму", () => {
        expect(moneyOf(runNode({ id: "a", cost: 12.5, measurability: "measured" }))).toEqual(
            { text: "$12.50", known: true },
        );
    });

    it("без замера это «неизвестно», а не ноль", () => {
        const m = moneyOf(runNode({ id: "a", measurability: "no_blocks" }));
        expect(m.text).toBe("неизвестно");
        expect(m.known).toBe(false);
        expect(m.reason).toBe("нет блоков в журнале");
    });

    it("при известной привязке по задаче показывается она", () => {
        const m = moneyOf(runNode({ id: "a", task_cost: 0.9 }));
        expect(m.text).toBe("$0.90");
        expect(m.known).toBe(true);
        expect(m.reason).toContain("по задаче целиком");
    });
});

describe("laneTotals", () => {
    it("считает измеренные, помнит число незамеренных", () => {
        const totals = laneTotals([
            runNode({ id: "a", cost: 10, duration_minutes: 90, measurability: "measured" }),
            runNode({ id: "b" }),
        ]);
        expect(totals.cost).toBe(10);
        expect(totals.minutes).toBe(90);
        expect(totals.unknown).toBe(1);
    });

    it("календарное время change-рута не складывается со временем шагов", () => {
        const totals = laneTotals([
            runNode({ id: "root", duration_minutes: 4000, duration_calendar: true }),
            runNode({ id: "a", duration_minutes: 30, measurability: "measured", cost: 1 }),
        ]);
        expect(totals.minutes).toBe(30);
    });
});

describe("specPorts", () => {
    it("показанный раздел — чтение, вердикт updated — запись", () => {
        const ports = specPorts(
            todo({
                id: "a",
                spec: ["tasks#registry", "tasks#gate"],
                spec_seen: [{ address: "tasks#registry" }, { address: "tasks#gate" }],
                spec_answers: [{ address: "tasks#gate", verdict: "updated" }],
            }),
        );
        expect(ports).toEqual([
            { dir: "R", kind: "spec", label: "tasks#registry" },
            { dir: "W", kind: "spec", label: "tasks#gate" },
        ]);
    });
});

describe("toTaskLinks", () => {
    const board = [
        todo({
            id: "a",
            number: 1,
            spec_answers: [{ address: "tasks#registry", verdict: "updated" }],
        }),
        todo({ id: "b", number: 2, depends_on: ["a"], spec: ["tasks#registry"] }),
        todo({ id: "c", number: 3, depends_on: ["b"] }),
    ];

    it("артефакт ребра — раздел, который один написал, а другой читает", () => {
        const links = toTaskLinks(board, laneIndex(board));
        const edge = links.find((l) => l.from === "#1" && l.to === "#2");
        expect(edge?.artifact?.kind).toBe("spec");
        expect(edge?.artifact?.address).toBe("tasks#registry");
    });

    it("без общего артефакта ребро остаётся голым", () => {
        const links = toTaskLinks(board, laneIndex(board));
        expect(links.find((l) => l.from === "#2" && l.to === "#3")?.artifact).toBeUndefined();
    });
});

describe("refEdges и хабы", () => {
    const board = [
        todo({ id: "a", number: 1, links: ["b"], description: "смотри t#3 и #4" }),
        todo({ id: "b", number: 2 }),
        todo({ id: "c", number: 3 }),
        todo({ id: "d", number: 4 }),
    ];

    it("берёт links и инлайновые t#N, голый #N игнорирует", () => {
        const edges = refEdges(board);
        expect(edges).toContainEqual({ from: "a", to: "b" });
        expect(edges).toContainEqual({ from: "a", to: "c" });
        expect(edges.some((e) => e.to === "d")).toBe(false);
    });

    it("хаб — узел с порогом входящих", () => {
        expect(hubIds(board, 2).size).toBe(0);
        expect(hubIds(board, 1).has("b")).toBe(true);
    });

    it("строки панели фокуса делятся на входящие и исходящие", () => {
        const rows = focusRows(board, "a");
        expect(rows.outgoing.map((r) => r.id)).toEqual(["#2", "#3"]);
        expect(rows.incoming).toEqual([]);
    });
});

describe("вью-модель дорожек", () => {
    const board = [
        todo({ id: "root", number: 337, change: true, depends_on: ["x"], subject: "Тема" }),
        todo({ id: "x", number: 338, status: "done", kind: "auto" }),
    ];

    it("свободные дорожки не смешивают проекты", () => {
        const mixed = [
            todo({ id: "a", number: 1, project: "alpha" }),
            todo({ id: "b", number: 2, project: "beta" }),
        ];
        const index = laneIndex(mixed);
        const lanes = toLanes(mixed, new Map(), index, new Map());
        expect(lanes.map((l) => l.id).sort()).toEqual(["free:alpha", "free:beta"]);
    });

    it("свежий change идёт первым, свободные задачи остаются под темами", () => {
        const many = [
            todo({
                id: "old",
                number: 10,
                change: true,
                depends_on: ["o1"],
                subject: "Старая",
                created_at: "2026-06-01T10:00:00Z",
            }),
            todo({ id: "o1", number: 11 }),
            todo({
                id: "new",
                number: 12,
                change: true,
                depends_on: ["n1"],
                subject: "Свежая",
                created_at: "2026-08-01T10:00:00Z",
            }),
            todo({ id: "n1", number: 13 }),
            todo({ id: "free", number: 14 }),
        ];
        const index = laneIndex(many);
        const lanes = toLanes(many, new Map(), index, new Map());
        expect(lanes.map((l) => l.id)).toEqual(["new", "old", "free:"]);
    });

    it("без даты порядок задаёт номер, свежий сверху", () => {
        const many = [
            todo({ id: "old", number: 10, change: true, depends_on: ["o1"], subject: "Старая" }),
            todo({ id: "o1", number: 11 }),
            todo({ id: "new", number: 20, change: true, depends_on: ["n1"], subject: "Свежая" }),
            todo({ id: "n1", number: 21 }),
        ];
        const index = laneIndex(many);
        const lanes = toLanes(many, new Map(), index, new Map());
        expect(lanes.map((l) => l.id)).toEqual(["new", "old"]);
    });

    it("прогресс и суммы собираются из графа прогона", () => {
        const index = laneIndex(board);
        const waves = wavesOf(
            ["root", "x"],
            [{ from: "x", to: "root" }],
        );
        const run = new Map<string, RunGraphNode>([
            ["x", runNode({ id: "x", cost: 6.2, duration_minutes: 45, measurability: "measured" })],
            ["root", runNode({ id: "root", duration_minutes: 900, duration_calendar: true })],
        ]);
        const lanes = toLanes(board, run, index, waves);
        expect(lanes[0].cost).toBe("$6.20");
        expect(lanes[0].duration).toBe("45м");
        expect(lanes[0].progressLabel).toContain("1 / 2 готово");
        expect(lanes[0].progressLabel).toContain("1 без замера");
    });

    it("карточка без замера не показывает нулевую стоимость", () => {
        const index = laneIndex(board);
        const nodes = toTaskNodes(
            board,
            new Map([["x", runNode({ id: "x" })]]),
            index,
            new Map([["x", 1]]),
        );
        const card = nodes.find((n) => n.id === "#338")!;
        expect(card.cost).toBe("неизвестно");
        expect(card.costKnown).toBe(false);
        expect(card.costShare).toBeUndefined();
    });
});

describe("specTree", () => {
    const board: BoardTodo[] = [
        todo({
            id: "root",
            number: 337,
            change: true,
            depends_on: ["a", "b"],
            spec: ["tasks#registry"],
            project: "tracker",
        }),
        todo({ id: "a", number: 338, project: "tracker", spec: ["tasks#gate"] }),
        todo({ id: "b", number: 339, project: "tracker", links: ["loose"] }),
        todo({ id: "loose", number: 400, project: "landing" }),
    ];

    it("раздел спеки — корень, тема под ним, задачи под темой", () => {
        const tree = specTree(board);
        expect(tree.byId.get("root")?.parent).toBe("tasks#registry");
        expect(tree.byId.get("a")?.parent).toBe("root");
        expect(tree.byId.get("tasks#registry")?.parent).toBeNull();
    });

    it("задача вне темы висит под своим проектом", () => {
        const tree = specTree(board);
        expect(tree.byId.get("loose")?.parent).toBe("project:landing");
    });

    it("ссылка на чужой раздел спеки остаётся кросс-связью, а не веткой", () => {
        const tree = specTree(board);
        expect(tree.cross).toContainEqual({
            from: "a",
            to: "tasks#gate",
            kind: "spec",
        });
        expect(tree.byId.get("a")?.parent).toBe("root");
    });

    it("ссылки между задачами живут поверх дерева", () => {
        const tree = specTree(board);
        expect(tree.cross).toContainEqual({ from: "b", to: "loose", kind: "ref" });
    });

    it("общий предок находится для бандлинга кросс-связей", () => {
        const tree = specTree(board);
        expect(commonAncestor(tree, "a", "b")).toBe("root");
        expect(commonAncestor(tree, "a", "loose")).toBeNull();
    });
});

describe("дорожки из записей change'а", () => {
    const changes = [
        {
            id: "ch-1",
            number: 4,
            title: "CHANGE: записи вместо корней",
            delta: "что меняем в этом заходе\nвторая строка",
            project: "board",
            created_at: "2026-08-01T10:00:00Z",
        },
        {
            id: "ch-2",
            number: 2,
            title: "CHANGE: прошлый заход",
            project: "board",
            created_at: "2026-06-01T10:00:00Z",
        },
    ];
    const board = [
        todo({ id: "a", number: 1, change_id: "ch-1", status: "done" }),
        todo({ id: "b", number: 2, change_id: "ch-1" }),
        todo({ id: "c", number: 3, change_id: "ch-2", status: "done" }),
        todo({ id: "d", number: 4 }),
    ];

    it("принадлежность читается полем, а не обходом рёбер", () => {
        const index = laneIndex(board, changes);
        expect(index.laneOf.get("a")).toBe("ch-1");
        expect(index.laneOf.get("d")).toBe("free:");
        expect(index.members.get("ch-1")).toEqual(["a", "b"]);
    });

    it("дорожка собирается из записи, свежая сверху, свободные под ними", () => {
        const index = laneIndex(board, changes);
        const lanes = toLanes(board, new Map(), index, new Map());
        expect(lanes.map((l) => l.id)).toEqual(["ch-1", "ch-2", "free:"]);
        expect(lanes[0].kicker).toBe("тема · change c#4");
        expect(lanes[0].title).toBe("CHANGE: записи вместо корней");
        expect(lanes[0].note).toBe("что меняем в этом заходе");
        expect(lanes[0].progressLabel).toContain("1 / 2 готово");
    });

    it("закрытая запись помечается закрытой дорожкой", () => {
        const index = laneIndex(board, changes);
        const lanes = toLanes(board, new Map(), index, new Map());
        expect(lanes.find((l) => l.id === "ch-2")?.done).toBe(true);
        expect(lanes.find((l) => l.id === "ch-1")?.done).toBe(false);
    });

    it("немигрированный корень и запись живут на одной доске", () => {
        const mixed = [
            ...board,
            todo({ id: "root", number: 9, change: true, depends_on: ["leaf"], subject: "Старая тема" }),
            todo({ id: "leaf", number: 10 }),
        ];
        const index = laneIndex(mixed, changes);
        const lanes = toLanes(mixed, new Map(), index, new Map());
        expect(lanes.map((l) => l.id)).toEqual(["ch-1", "ch-2", "root", "free:"]);
        expect(index.laneOf.get("leaf")).toBe("root");
    });
});

describe("specTree читает записи change'ей наравне со старыми корнями", () => {
    const changes: BoardChange[] = [
        {
            id: "ch-1",
            number: 4,
            title: "CHANGE: записи вместо корней",
            project: "tracker",
            spec: ["tasks#registry"],
        },
    ];
    const board: BoardTodo[] = [
        todo({ id: "a", number: 1, change_id: "ch-1", project: "tracker" }),
        todo({ id: "b", number: 2, change_id: "ch-1", project: "tracker", spec: ["tasks#gate"] }),
        todo({ id: "loose", number: 3, project: "tracker" }),
    ];

    it("тема записи висит под её собственным разделом", () => {
        const tree = specTree(board, changes);
        expect(tree.byId.get("ch-1")?.kind).toBe("theme");
        expect(tree.byId.get("ch-1")?.parent).toBe("tasks#registry");
        expect(tree.byId.get("ch-1")?.label).toBe("c#4");
    });

    it("задача с change_id висит под темой записи, а не в свободных", () => {
        const tree = specTree(board, changes);
        expect(tree.byId.get("a")?.parent).toBe("ch-1");
        expect(tree.byId.get("loose")?.parent).toBe("project:tracker");
    });

    it("собственный spec задачи внутри записи остаётся кросс-связью", () => {
        const tree = specTree(board, changes);
        expect(tree.cross).toContainEqual({ from: "b", to: "tasks#gate", kind: "spec" });
    });
});

describe("toSpecLanes считает и записи, и старые корни", () => {
    const board: BoardTodo[] = [
        todo({ id: "root", number: 9, change: true, spec: ["tasks#registry"] }),
    ];
    const changes: BoardChange[] = [
        { id: "ch-1", number: 4, title: "CHANGE", spec: ["tasks#registry"] },
    ];
    const section = {
        address: "tasks#registry",
        entry: { title: "Реестр" },
    };

    it("счётчик change'ей берёт и записи, и немигрированные корни", () => {
        const lanes = toSpecLanes([section], board, changes);
        expect(lanes[0].metrics).toContain("2 change'а");
    });

    it("без записей считает только старые корни", () => {
        const lanes = toSpecLanes([section], board);
        expect(lanes[0].metrics).toContain("1 change'а");
    });
});

describe("статус карточки различает колонки доски", () => {
    const board = [
        todo({ id: "prev", number: 1, status: "done" }),
        todo({ id: "review", number: 2, status: "review", depends_on: ["prev"] }),
        todo({ id: "work", number: 3, status: "in_progress", depends_on: ["open"] }),
        todo({ id: "open", number: 4, status: "queue" }),
    ];
    const byId = new Map(board.map((t) => [t.id, t]));

    it("задача на приёмке — свой статус, не «ждёт тебя»", () => {
        expect(nodeStatus(byId.get("review")!, byId)).toBe("review");
    });

    it("взятая в работу не выглядит заблокированной", () => {
        expect(nodeStatus(byId.get("work")!, byId)).toBe("ready");
    });
});

describe("полосы проектов", () => {
    const board = [
        todo({ id: "old-1", project: "давний", created_at: "2026-01-05T10:00:00Z" }),
        todo({ id: "old-2", project: "давний", created_at: "2026-08-10T10:00:00Z" }),
        todo({ id: "mid-1", project: "средний", created_at: "2026-06-01T10:00:00Z" }),
    ];

    it("ставит выше проект, в котором работа появилась позже", () => {
        const bands = toProjectBands(board, [], laneIndex(board));
        expect(bands.map((b) => b.name)).toEqual(["давний", "средний"]);
    });

    it("датирует полосу самой свежей задачей, а не самой старой", () => {
        const older = [
            todo({ id: "a", project: "один", created_at: "2026-01-01T10:00:00Z" }),
            todo({ id: "b", project: "два", created_at: "2026-02-01T10:00:00Z" }),
            todo({ id: "c", project: "один", created_at: "2026-03-01T10:00:00Z" }),
        ];
        expect(toProjectBands(older, [], laneIndex(older)).map((b) => b.name)).toEqual([
            "один",
            "два",
        ]);
    });

    it("проект без дат не вытесняет датированный", () => {
        const mixed = [
            todo({ id: "x", project: "без дат" }),
            todo({ id: "y", project: "с датой", created_at: "2026-05-01T10:00:00Z" }),
        ];
        expect(toProjectBands(mixed, [], laneIndex(mixed)).map((b) => b.name)).toEqual([
            "с датой",
            "без дат",
        ]);
    });
});
