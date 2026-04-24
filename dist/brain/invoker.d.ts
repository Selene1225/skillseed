/**
 * Brain CLI invoker — async background refinement of scope/sensitivity.
 * Forks user's chosen CLI (claude/gemini) for one-shot LLM inference.
 * Never blocks seed_log writes.
 */
import type { ExperienceFrontmatter } from "../store/file-store.js";
/** Async refinement — fire and forget, never blocks */
export declare function refineAsync(filePath: string, content: string, currentMeta: Partial<ExperienceFrontmatter>): void;
//# sourceMappingURL=invoker.d.ts.map