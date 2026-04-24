/**
 * Recall service — search experiences with token budget.
 */
export interface RecallInput {
    query: string;
    scope?: string;
    tags?: string[];
    limit?: number;
    maxTokens?: number;
    detail?: string;
}
export interface RecallResult {
    results: Array<{
        id: string;
        summary: string;
        score: number;
    }>;
    total: number;
    hint?: string;
}
export interface DetailResult {
    id: string;
    fullText: string;
}
export declare function recall(input: RecallInput): RecallResult;
export declare function recallDetail(id: string): Promise<DetailResult | null>;
//# sourceMappingURL=recall.d.ts.map