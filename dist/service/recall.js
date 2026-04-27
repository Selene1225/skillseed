/**
 * Recall service — search experiences with token budget.
 */
import { search, formatSummary, formatDetail } from "../store/file-store.js";
export function recall(input) {
    const opts = {
        query: input.query,
        scope: input.scope,
        tags: input.tags,
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
export async function recallDetail(id) {
    const { getExperienceById } = await import("./experience.js");
    const exp = getExperienceById(id);
    if (!exp)
        return null;
    return { id: exp.id, fullText: formatDetail(exp) };
}
//# sourceMappingURL=recall.js.map