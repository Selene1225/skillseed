/**
 * Experience service — CRUD operations with rule engine + async Brain CLI.
 */
import { type ExperienceFrontmatter, type Experience } from "../store/file-store.js";
export interface LogInput {
    content: string;
    scope?: ExperienceFrontmatter["scope"];
    category?: ExperienceFrontmatter["category"];
    tags?: string[];
    sensitivity?: ExperienceFrontmatter["sensitivity"];
    source_cli?: string;
    company?: string;
    team?: string;
    project?: string;
}
export interface LogResult {
    success: boolean;
    id?: string;
    warnings: string[];
}
export declare function logExperience(input: LogInput): LogResult;
export declare function getExperienceById(id: string): Experience | null;
export declare function listExperiences(scope?: string): Experience[];
export declare function getExperienceCount(): number;
//# sourceMappingURL=experience.d.ts.map