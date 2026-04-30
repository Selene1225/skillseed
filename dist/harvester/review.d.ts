/**
 * Review — interactive, auto-review, approve-all for pending experiences.
 */
export declare function reviewPending(): Promise<void>;
export declare function approveAll(): number;
export declare function autoReview(opts?: {
    brainCli?: string;
    dryRun?: boolean;
}): {
    approved: number;
    rejected: number;
    uncertain: number;
};
//# sourceMappingURL=review.d.ts.map