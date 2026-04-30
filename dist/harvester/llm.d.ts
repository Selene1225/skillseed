/**
 * LLM invocation helpers — stateless, no business logic.
 * Responsible only for: fork CLI → clean ANSI/fences → return parsed JSON.
 */
/**
 * Call a brain CLI with a prompt and return raw string output.
 */
export declare function callLlm(prompt: string, brainCli: string, timeout?: number): string;
/**
 * Parse LLM output as JSON, stripping markdown fences and ANSI codes.
 * Returns parsed object or null if parsing fails.
 */
export declare function parseLlmJson(output: string): unknown;
//# sourceMappingURL=llm.d.ts.map