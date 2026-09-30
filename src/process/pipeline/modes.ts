export type PipelineMode =
    | "bubbles"
    | "rings"
    | "specs"
    | "reader"
    | "review"
    | "change";

export const SPEC_MODES: PipelineMode[] = ["reader", "review", "change"];
