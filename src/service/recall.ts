/**
 * Recall service — search experiences with token budget.
 */

import { search, formatSummary, formatDetail, type SearchOptions, type SearchResult } from "../store/file-store.js";

export interface RecallInput {
  query: string;
  scope?: string;
  tags?: string[];
  project?: string;
  limit?: number;
  maxTokens?: number;
  detail?: string; // experience ID for full-text retrieval
}

export interface RecallResult {
  results: Array<{
    id: string;
    summary: string;
    content: string;
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
    project: input.project,
    limit: input.limit ?? 5,
    maxTokens: input.maxTokens ?? 1500,
  };

  const results = search(opts);

  // Filter low-score results (minimum relevance threshold)
  const MIN_SCORE = 10;
  const relevant = results.filter(r => r.score >= MIN_SCORE);

  if (relevant.length === 0) {
    return {
      results: [],
      total: 0,
      hint: "No relevant experiences found.",
    };
  }

  return {
    results: relevant.map(r => ({
      id: r.experience.id,
      summary: formatSummary(r.experience),
      content: r.experience.content,
      score: r.score,
    })),
    total: relevant.length,
  };
}

export async function recallDetail(id: string): Promise<DetailResult | null> {
  const { getExperienceById } = await import("./experience.js");
  const exp = getExperienceById(id);
  if (!exp) return null;
  return { id: exp.id, fullText: formatDetail(exp) };
}
