import { cmdClose } from "../board/change.mjs";
import { collectRetroFacts } from "./retro-facts.mjs";

export function run(args) {
  return cmdClose(args, { collectFacts: collectRetroFacts });
}
