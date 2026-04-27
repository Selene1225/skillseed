/**
 * Markdown file store with frontmatter — primary storage for experiences and preferences.
 * Git-friendly: each experience = one .md file with YAML frontmatter.
 */
export interface ExperienceFrontmatter {
    scope: "universal" | "domain" | "company" | "team" | "project" | "personal";
    sensitivity: "public" | "internal" | "confidential" | "private";
    category: "good_practice" | "problem" | "correction" | "knowledge" | "preference";
    tags: string[];
    title?: string;
    company?: string;
    team?: string;
    project?: string;
    domain?: string;
    confidence: number;
    source: "manual" | "conversation" | "correction" | "observation" | "import";
    source_cli?: string;
    created: string;
    updated: string;
    used: number;
    last_used?: string;
}
export interface Experience {
    id: string;
    meta: ExperienceFrontmatter;
    content: string;
    filePath: string;
}
export interface SearchOptions {
    query?: string;
    scope?: string;
    tags?: string[];
    limit?: number;
    maxTokens?: number;
}
export interface SearchResult {
    experience: Experience;
    score: number;
}
export declare function getSkillseedDir(): string;
export declare function getExperiencesDir(): string;
export declare function getSkillsDir(): string;
export declare function writeExperience(meta: ExperienceFrontmatter, content: string): Experience;
export declare function readExperience(filePath: string): Experience | null;
export declare function updateExperienceMeta(filePath: string, updates: Partial<ExperienceFrontmatter>): void;
export declare function listAllExperiences(): Experience[];
/** Search experiences — interface designed for future index swap */
export declare function search(opts: SearchOptions): SearchResult[];
/** Format experience as summary line (~30-50 tokens) */
export declare function formatSummary(exp: Experience): string;
/** Format experience as full detail */
export declare function formatDetail(exp: Experience): string;
export declare function getPreference(key: string): string | null;
export declare function getAllPreferences(): Record<string, string>;
export declare function setPreference(key: string, value: string): Experience;
//# sourceMappingURL=file-store.d.ts.map