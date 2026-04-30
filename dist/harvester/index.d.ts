/**
 * Harvester — unified re-export for all harvest functionality.
 *
 * Module structure:
 *   llm.ts      — callLlm, parseLlmJson (stateless CLI bridge)
 *   prompts.ts  — all LLM prompt templates as pure builder functions
 *   dedup.ts    — tokenize, Jaccard, Union-Find, LLM semantic dedup
 *   pipeline.ts — scan, chunk, score, extract, harvest main entry
 *   review.ts   — interactive/auto review, approve-all
 *   tools.ts    — backfillTitles, export, sanitize, reclassify
 */
export { harvest, discoverHistoryFiles } from "./pipeline.js";
export type { HarvestOptions } from "./pipeline.js";
export { reviewPending, approveAll, autoReview } from "./review.js";
export { dedup } from "./dedup.js";
export { backfillTitles, exportExperiences, sanitizeAll, reclassify } from "./tools.js";
//# sourceMappingURL=index.d.ts.map