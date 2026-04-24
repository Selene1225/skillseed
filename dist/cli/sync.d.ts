/**
 * Sync module — git-based experience sync across devices via GitHub.
 * Handles: setupSync (init step 6), manual sync, stageChanges, batchCommitAndPush,
 * and sensitive file filtering.
 */
/** Unstage any confidential/private files before commit */
export declare function filterSensitiveFiles(dataDir: string): number;
/** Stage a single file (called after seed_log). Fast, non-blocking. */
export declare function stageChanges(filePath: string): void;
/** Full manual sync: pull → filter → commit → push */
export declare function sync(dataDir?: string): Promise<void>;
/** Batch commit+push for 30-min timer and graceful shutdown */
export declare function batchCommitAndPush(dataDir?: string): Promise<void>;
/** Interactive sync setup during skillseed init */
export declare function setupSync(): Promise<void>;
export declare function getSyncStatus(): {
    state: string;
    detail: string;
};
export declare function audit(): void;
//# sourceMappingURL=sync.d.ts.map