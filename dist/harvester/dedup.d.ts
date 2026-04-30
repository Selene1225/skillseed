/**
 * Dedup engine — tokenization, Jaccard, Union-Find clustering, LLM semantic dedup.
 * Owns all duplicate detection logic; merges via LLM when duplicates found.
 */
import { listAllExperiences } from "../store/file-store.js";
export type Experience = ReturnType<typeof listAllExperiences>[0];
export declare const UNIVERSAL_BLOCKLIST: Set<string>;
export declare const TAG_STOPWORDS: Set<string>;
export declare function tokenize(text: string): Set<string>;
export declare function jaccardSimilarity(a: Set<string>, b: Set<string>): number;
export declare function isDuplicateExperience(newContent: string, newTags: string[]): {
    duplicate: boolean;
    similarExp?: Experience;
};
export declare function fixScopeBeforeDedup(all: Experience[]): number;
export declare function findDupClusters(all: Experience[]): Array<number[]>;
export declare function mergeCluster(exps: Experience[], brainCli: string, dryRun?: boolean): {
    merged: boolean;
    deleted: number;
    title?: string;
};
export declare function buildTagGroups(all: Experience[]): Experience[][];
export declare function dedup(opts?: {
    dryRun?: boolean;
    brainCli?: string;
    jaccard?: boolean;
    semantic?: boolean;
}): {
    clusters: number;
    merged: number;
    deleted: number;
};
//# sourceMappingURL=dedup.d.ts.map