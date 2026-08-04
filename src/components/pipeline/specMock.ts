export interface SpecAnchor {
    slug: string;
    title: string;
}

export interface SpecBlock {
    text: string;
    hash: string;
}

export interface SpecEntry {
    title: string;
    part: string;
    refs: string[];
    updated: string;
    change: string;
}

export interface SpecShowResponse {
    ok: boolean;
    address: string;
    remote: boolean;
    entry: SpecEntry;
    anchor: string | null;
    anchors: SpecAnchor[];
    text: string;
    blocks: SpecBlock[];
}

export interface DomainSection {
    slug: string;
    title: string;
    part: string;
    remote: boolean;
    anchors: SpecAnchor[];
}

export interface SpecDomain {
    id: string;
    version: number | null;
    updated: string | null;
    external: null;
    sections: DomainSection[];
}

export interface SpecAnswer {
    address: string;
    verdict: "unchanged" | "updated";
    note: string;
    at: string;
    blocks?: string[];
    after?: string;
}

export interface SpecSeen {
    address: string;
    hash: string;
    blocks: string[];
    text: string;
    at: string;
}

export interface BoardTask {
    id: string;
    number: number;
    subject: string;
    status: string;
    change?: boolean;
    spec: string[];
    spec_answers?: SpecAnswer[];
    spec_seen?: SpecSeen[];
}

export const SECTION_LINE_CEILING = 120;

export const specProject = "claude-usage-tracker-windows";

export const specFile = "docs/specs/tasks/spec.md";

export const readerAddress = "tasks#spec-registry";

export const domains: SpecDomain[] = [
    {
        id: "tasks",
        version: 5,
        updated: "2026-08-03",
        external: null,
        sections: [
            { slug: "model", title: "Модель и хранение", part: "устройство", remote: false, anchors: [] },
            { slug: "fields", title: "Поля задачи и их роли", part: "требования", remote: false, anchors: [] },
            { slug: "statuses", title: "Статусы: две оси", part: "требования", remote: false, anchors: [] },
            { slug: "edges", title: "Рёбра графа", part: "требования", remote: false, anchors: [] },
            { slug: "done-gate", title: "Инварианты закрытия", part: "инварианты", remote: false, anchors: [] },
            { slug: "kind", title: "Kind: авторитет закрытия", part: "инварианты", remote: false, anchors: [] },
            { slug: "outcome", title: "Исход шага и повтор", part: "инварианты", remote: false, anchors: [] },
            { slug: "handoff", title: "Handoff-батон", part: "требования", remote: false, anchors: [] },
            { slug: "changes", title: "Change: дельта к спеке", part: "устройство", remote: false, anchors: [] },
            { slug: "plan-mode", title: "Ритуал формирования задач", part: "устройство", remote: false, anchors: [] },
            { slug: "triage", title: "Триаж", part: "устройство", remote: false, anchors: [] },
            { slug: "cost", title: "Стоимость задач", part: "устройство", remote: false, anchors: [] },
            {
                slug: "spec-registry",
                title: "Реестр спек и поле spec задачи",
                part: "устройство",
                remote: false,
                anchors: [
                    { slug: "registry", title: "Реестр, адрес, поле задачи" },
                    { slug: "commands", title: "Команды и линт" },
                ],
            },
            { slug: "open", title: "Открытые направления", part: "устройство", remote: false, anchors: [] },
        ],
    },
    {
        id: "usage-tracker",
        version: 2,
        updated: "2026-07-28",
        external: null,
        sections: [
            { slug: "purpose", title: "Назначение", part: "требования", remote: false, anchors: [] },
            { slug: "limits", title: "Мониторинг лимитов", part: "требования", remote: false, anchors: [] },
            { slug: "forecast", title: "Форекаст и бюджет", part: "требования", remote: false, anchors: [] },
            { slug: "notifications", title: "Уведомления", part: "требования", remote: false, anchors: [] },
            { slug: "sessions", title: "Сессии и окна", part: "требования", remote: false, anchors: [] },
            { slug: "blocks", title: "Блоки и токены", part: "требования", remote: false, anchors: [] },
            { slug: "pricing", title: "Цены и планы", part: "требования", remote: false, anchors: [] },
            { slug: "storage", title: "Хранилище и кэш", part: "устройство", remote: false, anchors: [] },
            { slug: "aggregation", title: "Агрегация статистики", part: "устройство", remote: false, anchors: [] },
            { slug: "freshness", title: "Свежесть данных", part: "инварианты", remote: false, anchors: [] },
        ],
    },
];

const B1 = "b1f0a7c94e12";
const B2 = "3c7d51a0e8b4";
const B3 = "9ae2470bd135";
const B4 = "5d8c31f6a0e9";
const B5 = "72b4e0cd91af";
const B6 = "e04a6b23c7d8";

const P1 =
    "Реестр (`scripts/cli/spec.mjs`) читает домен спек `docs/specs/<домен>/spec.md`: шапка даёт `id`, `version`, `updated` и `location` файла, а разделы объявляются в теле — заголовок `## <слаг> — <Название>` и строки метаданных под ним.";
const P2 =
    "Адрес раздела — `<домен>#<слаг>` (например `tasks#done-gate`). `resolveAddress` проверяет существование домена и слага и **никогда** — доступность текста удалённого раздела.";
const P3 =
    "Поле `spec` задачи (`todos set spec <task> <домен>#<слаг>[,…]`) — структурная привязка задачи к одному или нескольким разделам спеки, замена старой текстовой пометки `spec: tasks §N` внутри `description`.";
const P4 =
    "Команды: `cli spec domains` — список доменов и их разделов; `cli spec show <адрес>` — текст раздела; `cli spec refs` — обратные ссылки, вычисляются сканированием всех `refs`; `cli spec lint` — реестр целиком.";
const P5 =
    "**Упомянутый в разделе файл обязан существовать.** Запрет описывать устройство кода стоит на том, что имена протухают, — правило превращает каждое такое упоминание в проверяемое утверждение вместо запрета, который всё равно нарушают.";
const P6 =
    "Прогон линта стоит там, где случается сам: шаг CI на изменение `docs/specs/**`, без него PR, трогающий только CLI, ждал бы лишнюю минуту.";

const readerBlocks: SpecBlock[] = [
    { text: P1, hash: B1 },
    { text: P2, hash: B2 },
    { text: P3, hash: B3 },
    { text: P4, hash: B4 },
    { text: P5, hash: B5 },
    { text: P6, hash: B6 },
];

const readerEntry: SpecEntry = {
    title: "Реестр спек и поле spec задачи",
    part: "устройство",
    refs: ["tasks#changes", "tasks#fields"],
    updated: "2026-08-03",
    change: "t#337",
};

export const readerSection: SpecShowResponse = {
    ok: true,
    address: readerAddress,
    remote: false,
    entry: readerEntry,
    anchor: null,
    anchors: [
        { slug: "registry", title: "Реестр, адрес, поле задачи" },
        { slug: "commands", title: "Команды и линт" },
    ],
    text: [
        "## spec-registry — Реестр спек и поле spec задачи",
        "",
        "part: устройство",
        "refs: tasks#changes, tasks#fields",
        "",
        ...readerBlocks.map((b) => b.text),
    ].join("\n"),
    blocks: readerBlocks,
};

const R2 =
    "Адрес раздела — `<домен>#<слаг>` (например `tasks#done-gate`). `resolveAddress` проверяет существование домена и слага.";
const R4_BEFORE =
    "Команды: `cli spec domains` — список доменов; `cli spec show <адрес>` — текст раздела.";
const R4_AFTER =
    "Команды: `cli spec domains [--json]` — список доменов и их разделов (внешние домены помечены отдельно); `cli spec show <адрес> [--json]` — текст раздела, либо ответ «домен объявлен, текст недоступен» с указанием, чего не хватает; `cli spec refs` — обратные ссылки; `cli spec lint [--json]` — реестр целиком.";
const R5_AFTER =
    "**Упомянутый в разделе файл обязан существовать.** Правило превращает каждое упоминание в проверяемое утверждение вместо запрета, который всё равно нарушают. Претензией считается вставка кода, чья голова похожа на файл: путь с разделителем либо голое имя с исходным расширением.";
const R6_AFTER =
    "Голые данные и конфиги (`todos.json`, `settings.json`) под правило не подпадают — они чаще живут вне репозитория.";

const C2 = "a10f5b7c2e34";
const C4 = "6b03d9e17f28";
const C5 = "f27a4c60b915";
const C6 = "0e5d8a3419cb";

const reviewBlocks: SpecBlock[] = [
    { text: R2, hash: C2 },
    { text: R4_AFTER, hash: C4 },
    { text: R5_AFTER, hash: C5 },
    { text: R6_AFTER, hash: C6 },
];

export const reviewSection: SpecShowResponse = {
    ok: true,
    address: readerAddress,
    remote: false,
    entry: readerEntry,
    anchor: null,
    anchors: readerSection.anchors,
    text: [
        "## spec-registry — Реестр спек и поле spec задачи",
        "",
        "part: устройство",
        "refs: tasks#changes, tasks#fields",
        "",
        ...reviewBlocks.map((b) => b.text),
    ].join("\n"),
    blocks: reviewBlocks,
};

const baselineText = [R2, R4_BEFORE].join("\n");

export const board: BoardTask[] = [
    {
        id: "t-339",
        number: 339,
        subject: "Завожу в CLI реестр спек и адреса разделов",
        status: "in_progress",
        change: true,
        spec: [readerAddress],
        spec_seen: [
            {
                address: readerAddress,
                hash: "7f2a91c4de60b835",
                blocks: [B1, B2, B3],
                text: [P1, P2, P3].join("\n"),
                at: "2026-07-29T09:12:00.000Z",
            },
        ],
        spec_answers: [
            {
                address: readerAddress,
                verdict: "updated",
                note: "Реестр, адрес и поле spec задачи описаны как одна связка: без адреса поле бессмысленно, без поля адрес некуда положить.",
                at: "2026-07-31T18:40:00.000Z",
                blocks: [B1, B2, B3],
                after: [P1, P2, P3].join("\n"),
            },
        ],
    },
    {
        id: "t-341",
        number: 341,
        subject: "Учу stop-hook требованиям языка процесса",
        status: "review",
        change: true,
        spec: [readerAddress],
        spec_seen: [
            {
                address: readerAddress,
                hash: "b904e7215acd3f66",
                blocks: [C2, C4],
                text: baselineText,
                at: "2026-08-01T11:05:00.000Z",
            },
        ],
    },
    {
        id: "t-350",
        number: 350,
        subject: "Учу lint реестра проверять refs и упомянутые файлы",
        status: "review",
        change: true,
        spec: [readerAddress],
        spec_seen: [
            {
                address: readerAddress,
                hash: "b904e7215acd3f66",
                blocks: [C2, C4],
                text: baselineText,
                at: "2026-08-01T14:22:00.000Z",
            },
        ],
        spec_answers: [
            {
                address: readerAddress,
                verdict: "updated",
                note: "Команды реестра описаны вместе с правилом про упомянутые файлы: линт проверяет ровно то, что раздел обещает.",
                at: "2026-08-02T12:03:00.000Z",
                blocks: [B4, B5],
                after: [P4, P5].join("\n"),
            },
        ],
    },
    {
        id: "t-351",
        number: 351,
        subject: "Ставлю прогон spec lint в CI",
        status: "queue",
        change: true,
        spec: [readerAddress],
        spec_seen: [
            {
                address: readerAddress,
                hash: "b904e7215acd3f66",
                blocks: [C2, C4],
                text: baselineText,
                at: "2026-08-02T08:31:00.000Z",
            },
        ],
        spec_answers: [
            {
                address: readerAddress,
                verdict: "updated",
                note: "Прогон линта переехал в CI, и раздел теперь говорит, на какое изменение шаг срабатывает.",
                at: "2026-08-02T20:14:00.000Z",
                blocks: [B6],
                after: P6,
            },
        ],
    },
    {
        id: "t-337",
        number: 337,
        subject: "Реестр спек",
        status: "in_progress",
        spec: [readerAddress],
    },
    {
        id: "t-352",
        number: 352,
        subject: "Линт в CI",
        status: "queue",
        spec: [readerAddress],
    },
    {
        id: "t-344",
        number: 344,
        subject: "Развожу хранение доски и кэш",
        status: "in_progress",
        change: true,
        spec: ["tasks#model"],
    },
    {
        id: "t-348",
        number: 348,
        subject: "Свожу номер и id задачи в одно правило",
        status: "review",
        change: true,
        spec: ["tasks#model"],
    },
    {
        id: "t-347",
        number: 347,
        subject: "Сношу поле estimate_minutes",
        status: "review",
        change: true,
        spec: ["tasks#fields"],
    },
    {
        id: "t-346",
        number: 346,
        subject: "Описываю change как дельту к спеке",
        status: "queue",
        change: true,
        spec: ["tasks#changes"],
    },
    {
        id: "t-353",
        number: 353,
        subject: "Свожу форекаст и средний темп",
        status: "in_progress",
        change: true,
        spec: ["usage-tracker#forecast"],
    },
    {
        id: "t-354",
        number: 354,
        subject: "Правлю бюджет недели после смены плана",
        status: "queue",
        change: true,
        spec: ["usage-tracker#forecast"],
    },
    {
        id: "t-355",
        number: 355,
        subject: "Собираю уведомления в одну очередь",
        status: "review",
        change: true,
        spec: ["usage-tracker#notifications"],
    },
];

export interface ReviewEdit {
    hash: string;
    before: string;
    after: string;
    task: number;
    note: string;
    tone: "change" | "conflict";
    actions: string[];
}

export const reviewEdits: ReviewEdit[] = [
    {
        hash: C4,
        before: R4_BEFORE,
        after: R4_AFTER,
        task: 350,
        note: "Учу lint реестра проверять refs · t#350",
        tone: "change",
        actions: ["accept", "reject", "open"],
    },
    {
        hash: C5,
        before: "",
        after: R5_AFTER,
        task: 350,
        note: "конфликт с #341 на этом абзаце",
        tone: "change",
        actions: ["accept", "reject"],
    },
    {
        hash: C6,
        before: "",
        after: R6_AFTER,
        task: 341,
        note: "Учу stop-hook требованиям · ждёт разрешения конфликта",
        tone: "conflict",
        actions: ["compare"],
    },
];

export const reviewMarks: Record<string, string> = {
    [C2]: "§2",
    [C4]: "§4",
    [C5]: "§5",
    [C6]: "",
};

export interface QueueCard {
    id: string;
    title: string;
    meta: string;
    tone: "ok" | "warn" | "muted";
}

export const changeQueue: QueueCard[] = [
    { id: "#339", title: "Завожу в CLI реестр спек и адреса разделов", meta: "готов к слиянию", tone: "ok" },
    { id: "#350", title: "Учу lint реестра проверять refs и упомянутые файлы", meta: "на ревью · §4, §5", tone: "muted" },
    { id: "#341", title: "Учу stop-hook требованиям языка процесса", meta: "конфликт · §5", tone: "warn" },
    { id: "#351", title: "Ставлю прогон spec lint в CI", meta: "готов к слиянию", tone: "ok" },
];

export interface PanelLine {
    icon: string;
    text: string;
    meta: string;
    tone: "ok" | "warn" | "muted" | "accent" | "crit";
}

export const sectionState: PanelLine[] = [
    { icon: "✓", text: "lint чист", meta: "6 правил", tone: "ok" },
    { icon: "◷", text: "112 строк прозы", meta: "потолок 120", tone: "muted" },
    { icon: "⚡", text: "2 change'а на §5", meta: "предупр.", tone: "warn" },
];

export const mergeSummary: PanelLine[] = [
    { icon: "✓", text: "2 готовых change'а", meta: "§1–3, §6", tone: "ok" },
    { icon: "!", text: "1 конфликт", meta: "§5", tone: "warn" },
    { icon: "◷", text: "1 на ревью", meta: "§4", tone: "muted" },
];

export interface MentionedFile {
    path: string;
    exists: boolean;
}

export const mentionedFiles: MentionedFile[] = [
    { path: "scripts/cli/spec.mjs", exists: true },
    { path: "docs/specs/tasks/spec.md", exists: true },
    { path: "src-tauri/src/todos.rs", exists: true },
    { path: "insightHelp/render.ts", exists: false },
];

export interface SectionRef {
    id: string;
    title: string;
    state: string;
}

export const sectionRefs: SectionRef[] = [
    { id: "t#337", title: "Реестр спек", state: "в работе" },
    { id: "t#352", title: "Линт в CI", state: "очередь" },
    { id: "tasks#changes", title: "", state: "раздел" },
];

const PART_BADGE: Record<string, string> = {
    требования: "треб",
    устройство: "устр",
    инварианты: "инв",
};

const PART_TONE: Record<string, "spec" | "muted" | "theme"> = {
    требования: "spec",
    устройство: "muted",
    инварианты: "theme",
};

export const partBadge = (part: string): string => PART_BADGE[part] ?? part;

export const partTone = (part: string): "spec" | "muted" | "theme" =>
    PART_TONE[part] ?? "muted";

export const sectionCount = (part?: string): number =>
    domains.reduce(
        (sum, d) => sum + d.sections.filter((s) => !part || s.part === part).length,
        0,
    );

const isOpen = (task: BoardTask): boolean => task.status !== "done";

export const editCount = (address: string): number =>
    board.filter((t) => t.change && isOpen(t) && t.spec.includes(address)).length;

export const linkCount = (address: string): number =>
    board.filter((t) => t.spec.includes(address)).length;

export const ownerOf = (address: string, hash: string): number | null => {
    for (const task of board)
        for (const answer of task.spec_answers ?? [])
            if (answer.address === address && (answer.blocks ?? []).includes(hash))
                return task.number;
    return null;
};

export interface Paragraph {
    hash: string;
    text: string;
    mark: string;
    task: string;
}

export const paragraphsOf = (section: SpecShowResponse): Paragraph[] =>
    section.blocks.map((block, index) => {
        const owner = ownerOf(section.address, block.hash);
        return {
            hash: block.hash,
            text: block.text,
            mark: `§${index + 1}`,
            task: owner === null ? "" : `#${owner}`,
        };
    });

export const openChanges = (address: string) =>
    board
        .filter((t) => t.change && isOpen(t) && t.spec.includes(address))
        .map((t) => ({ id: `#${t.number}`, title: t.subject }));

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
};

const escapeHtml = (value: string): string =>
    value.replace(/[&<>]/g, (ch) => ESCAPES[ch]);

const ADDRESS_RE = /^[a-z0-9][a-z0-9-]*#[a-z0-9][a-z0-9-]*(\/[a-z0-9-]+)?$/i;
const PATH_RE = /\.(mjs|cjs|js|ts|tsx|vue|rs|json|md|toml|ya?ml|sh|ps1)$/i;

export function codeTone(span: string): "addr" | "path" | "plain" {
    const head = span.trim();
    if (ADDRESS_RE.test(head)) return "addr";
    if (PATH_RE.test(head) && !/\s/.test(head)) return "path";
    return "plain";
}

export function inlineHtml(text: string): string {
    return String(text)
        .split("`")
        .map((part, index) =>
            index % 2
                ? `<code class="sp-code sp-${codeTone(part)}">${escapeHtml(part)}</code>`
                : escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"),
        )
        .join("");
}
