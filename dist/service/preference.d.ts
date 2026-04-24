/**
 * Preference service — thin wrapper around file-store preference functions.
 */
export declare function preferenceGet(key?: string): Record<string, string> | string | null;
export declare function preferenceSet(key: string, value: string): {
    success: boolean;
    key: string;
    value: string;
};
//# sourceMappingURL=preference.d.ts.map