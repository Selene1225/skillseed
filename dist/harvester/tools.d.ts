/**
 * Harvest tools — backfillTitles, exportExperiences, sanitizeAll, reclassify.
 * Batch operations on existing experiences.
 */
export declare function backfillTitles(opts?: {
    dryRun?: boolean;
    brainCli?: string;
}): {
    total: number;
    updated: number;
};
export declare function exportExperiences(outPath: string): void;
export declare function sanitizeAll(opts?: {
    dryRun?: boolean;
}): {
    scanned: number;
    updated: number;
};
export declare function reclassify(opts?: {
    dryRun?: boolean;
    brainCli?: string;
}): {
    total: number;
    updated: number;
};
//# sourceMappingURL=tools.d.ts.map