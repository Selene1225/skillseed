/**
 * Experience service — CRUD operations with rule engine + async Brain CLI.
 */

import {
  writeExperience,
  readExperience,
  listAllExperiences,
  formatSummary,
  type ExperienceFrontmatter,
  type Experience,
} from "../store/file-store.js";
import { inferMeta, checkGranularity, checkSensitivityTooLow, sanitize } from "../brain/rules.js";
import { refineAsync } from "../brain/invoker.js";

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

export function logExperience(input: LogInput): LogResult {
  const warnings: string[] = [];

  // Sanitize content
  const content = sanitize(input.content);
  if (!content) {
    return { success: false, warnings: ["Empty content after sanitization."] };
  }

  // Check granularity
  const gran = checkGranularity(content);
  if (!gran.ok && gran.message) {
    warnings.push(gran.message);
    // Still proceed — warning only
  }

  // Infer metadata with rule engine (sync, fast)
  const inferred = inferMeta(content, {
    scope: input.scope,
    company: input.company,
    team: input.team,
    project: input.project,
  });

  const scope = input.scope ?? inferred.scope;
  const sensitivity = input.sensitivity ?? inferred.sensitivity;
  const category = input.category ?? "knowledge";
  const tags = input.tags && input.tags.length > 0
    ? [...new Set([...input.tags, ...inferred.tags])]
    : inferred.tags;

  // Check sensitivity misclassification
  const sensitivityWarn = checkSensitivityTooLow(content, sensitivity);
  if (sensitivityWarn) {
    warnings.push(sensitivityWarn);
  }

  const date = new Date().toISOString().slice(0, 10);
  const meta: ExperienceFrontmatter = {
    scope,
    sensitivity,
    category,
    tags,
    confidence: 0.8,
    source: input.source_cli ? "conversation" : "manual",
    source_cli: input.source_cli,
    created: date,
    updated: date,
    used: 0,
    ...(input.company && { company: input.company }),
    ...(input.team && { team: input.team }),
    ...(input.project && { project: input.project }),
    ...(inferred.domain && { domain: inferred.domain }),
  };

  // Strip undefined values (gray-matter/js-yaml can't dump undefined)
  const cleanMeta = Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== undefined)
  ) as ExperienceFrontmatter;

  const exp = writeExperience(cleanMeta, content);

  // Fire async Brain CLI refinement (never blocks)
  refineAsync(exp.filePath, content, meta);

  return { success: true, id: exp.id, warnings };
}

export function getExperienceById(id: string): Experience | null {
  const all = listAllExperiences();
  return all.find(e => e.id === id) ?? null;
}

export function listExperiences(scope?: string): Experience[] {
  const all = listAllExperiences();
  if (scope) return all.filter(e => e.meta.scope === scope);
  return all;
}

export function getExperienceCount(): number {
  return listAllExperiences().length;
}
