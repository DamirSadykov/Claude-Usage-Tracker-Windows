export type PipelineMode =
    | "lanes"
    | "wires"
    | "bubbles"
    | "rings"
    | "specs"
    | "reader"
    | "review"
    | "change";

export const SPEC_MODES: PipelineMode[] = ["reader", "review", "change"];

export const linkModes = [
    { id: "deps", label: "Зависимости" },
    { id: "refs", label: "Ссылки" },
];

export const layoutModes = [
    { id: "lanes", label: "Дорожки по темам" },
    { id: "canvas", label: "Свободный холст" },
];
