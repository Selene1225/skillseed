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
export async function recallDetail(id) {
    const { getExperienceById } = await import("./experience.js");
    const exp = getExperienceById(id);
    if (!exp)
        return null;
    return { id: exp.id, fullText: formatDetail(exp) };
}
//# sourceMappingURL=recall.js.map