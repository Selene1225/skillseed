/**
 * Recall service — search experiences with token budget.
 */

import { search, formatSummary, formatDetail, type SearchOptions, type SearchResult } from "../store/file-store.js";

export interface RecallInput {
  query: string;
  scope?: string;
  tags?: string[];
  limit?: number;
  maxTokens?: number;
  detail?: string; // experience ID for full-text retrieval
}

export interface RecallResult {
  results: Array<{
    id: string;
    summary: string;
    score: number;
  }>;
  total: number;
  hint?: string;
}

export interface DetailResult {
  id: string;
  fullText: string;
}

export function recall(input: RecallInput): RecallResult {
  const opts: SearchOptions = {
    query: input.query,
    scope: input.scope,
    tags: input.tags,
    limit: input.limit ?? 5,
    maxTokens: input.maxTokens ?? 1500,
  };

  const results = search(opts);

  if (results.length === 0) {
    return {
      results: [],
      total: 0,
      hint: `No experiences found for "${input.query}". Try broader keywords, or log some experiences first with seed_log.`,
    };
  }

  return {
    results: results.map(r => ({
      id: r.experience.id,
      summary: formatSummary(r.experience),
      score: r.score,
    })),
    total: results.length,
  };
}

export async function recallDetail(id: string): Promise<DetailResult | null> {
  const { getExperienceById } = await import("./experience.js");
  const exp = getExperienceById(id);
  if (!exp) return null;
  return { id: exp.id, fullText: formatDetail(exp) };
}
