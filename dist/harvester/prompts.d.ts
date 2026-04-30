/**
 * All LLM prompt templates as pure builder functions.
 * No side effects — easy to test and reuse.
 */
export declare function buildExtractPrompt(conversationText: string): string;
export declare function buildMergePrompt(experienceLines: string): string;
export declare function buildReviewPrompt(existingSection: string, pendingSection: string): string;
export declare function buildTitlePrompt(experienceLines: string): string;
export declare function buildReclassifyPrompt(experienceLines: string): string;
export declare function buildClusterPrompt(experienceLines: string): string;
//# sourceMappingURL=prompts.d.ts.map