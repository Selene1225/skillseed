/**
 * Harvest pipeline — scan, chunk, score, extract, write pending.
 * This is the only module with side effects (file I/O, LLM calls).
 */
export interface ConversationTurn {
    type: "user" | "assistant";
    text: string;
    timestamp: string;
    sessionId: string;
}
export interface ConversationChunk {
    turns: ConversationTurn[];
    file: string;
    project: string;
}
export interface PendingExperience {
    title?: string;
    content: string;
    category: string;
    tags: string[];
    scope: string;
    source_file: string;
}
export interface HarvestOptions {
    brainCli?: string;
    minScore?: number;
    maxFiles?: number;
    dryRun?: boolean;
}
export declare function parseJsonlFile(filePath: string): ConversationTurn[];
export declare function scoreChunk(chunk: ConversationChunk): number;
export declare function chunkConversation(turns: ConversationTurn[], file: string, project: string): ConversationChunk[];
export declare function getPendingDir(): string;
export declare function writePending(exp: PendingExperience, brainCli?: string): string | null;
export declare function listPending(): Array<{
    file: string;
    content: string;
    meta: Record<string, string>;
}>;
export declare function discoverHistoryFiles(): Array<{
    file: string;
    project: string;
    size: number;
    mtime: string;
}>;
export declare function harvest(opts?: HarvestOptions): {
    scanned: number;
    extracted: number;
    pending: number;
};
//# sourceMappingURL=pipeline.d.ts.map