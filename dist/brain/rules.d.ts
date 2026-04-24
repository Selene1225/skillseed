/**
 * Rule engine for scope/sensitivity inference — synchronous, millisecond-level.
 * Falls back to this when Brain CLI is unavailable.
 */
import type { ExperienceFrontmatter } from "../store/file-store.js";
type ScopeLevel = ExperienceFrontmatter["scope"];
type Sensitivity = ExperienceFrontmatter["sensitivity"];
interface InferredMeta {
    scope: ScopeLevel;
    sensitivity: Sensitivity;
    tags: string[];
    domain?: string;
}
/** Infer scope, sensitivity, and tags from content */
export declare function inferMeta(content: string, hints?: {
    scope?: ScopeLevel;
    company?: string;
    team?: string;
    project?: string;
}): InferredMeta;
/** Check if content might be misclassified as too low sensitivity */
export declare function checkSensitivityTooLow(content: string, declared: Sensitivity): string | null;
/** Check content granularity */
export declare function checkGranularity(content: string): {
    ok: boolean;
    message?: string;
};
/** Basic prompt injection sanitization */
export declare function sanitize(content: string): string;
export {};
//# sourceMappingURL=rules.d.ts.map