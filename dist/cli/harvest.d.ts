/**
 * Harvest — extract experiences from Claude CLI conversation history.
 *
 * Strategy: heuristic filter → LLM extraction → pending review.
 */
export declare function discoverHistoryFiles(): Array<{
    file: string;
    project: string;
    size: number;
    mtime: string;
}>;
export interface HarvestOptions {
    brainCli?: string;
    minScore?: number;
    maxFiles?: number;
    dryRun?: boolean;
}
export declare function harvest(opts?: HarvestOptions): {
    scanned: number;
    extracted: number;
    pending: number;
};
export declare function reviewPending(): Promise<void>;
export declare function approveAll(): number;
//# sourceMappingURL=harvest.d.ts.map