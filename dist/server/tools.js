/**
 * MCP Tool definitions — thin adapters over service layer.
 * seed_log, seed_recall, seed_preference_get, seed_preference_set
 */
import { z } from "zod";
import { logExperience } from "../service/experience.js";
import { recall } from "../service/recall.js";
import { preferenceGet, preferenceSet } from "../service/preference.js";
export function registerTools(server) {
    // seed_log — Record a work experience
    server.tool("seed_log", "Record a work experience, lesson, or best practice. Use when the user discovers something useful, makes a mistake, or establishes a pattern.", {
        content: z.string().describe("The experience content in natural language"),
        scope: z.enum(["universal", "domain", "company", "team", "project", "personal"]).optional()
            .describe("Scope level (auto-inferred if not provided)"),
        category: z.enum(["good_practice", "problem", "correction", "knowledge", "preference"]).optional()
            .describe("Category (default: knowledge)"),
        tags: z.array(z.string()).optional().describe("Topic tags for retrieval"),
        sensitivity: z.enum(["public", "internal", "confidential", "private"]).optional()
            .describe("Sensitivity level (auto-inferred if not provided)"),
        source_cli: z.string().optional().describe("Which CLI is calling (claude/gemini/copilot)"),
        company: z.string().optional(),
        team: z.string().optional(),
        project: z.string().optional(),
    }, async (params) => {
        const result = logExperience(params);
        const text = result.success
            ? `✅ Experience logged: ${result.id}${result.warnings.length > 0 ? "\n⚠️ " + result.warnings.join("\n⚠️ ") : ""}`
            : `❌ Failed to log: ${result.warnings.join(", ")}`;
        return { content: [{ type: "text", text }] };
    });
    // seed_recall — Search past experiences
    server.tool("seed_recall", "Search past work experiences. Use before starting tasks to bring relevant context, or when the user asks about past lessons.", {
        query: z.string().describe("What to search for"),
        scope: z.enum(["universal", "domain", "company", "team", "project", "personal"]).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().optional().describe("Max results (default: 5)"),
        maxTokens: z.number().optional().describe("Token budget (default: 1500)"),
    }, async (params) => {
        const result = recall(params);
        if (result.hint) {
            return { content: [{ type: "text", text: result.hint }] };
        }
        const lines = result.results.map((r, i) => `${i + 1}. ${r.summary}`);
        const text = `Found ${result.total} experience(s):\n${lines.join("\n")}`;
        return { content: [{ type: "text", text }] };
    });
    // seed_preference_get — Get user preferences
    server.tool("seed_preference_get", "Get user preferences (language, email style, work hours, etc). Call at conversation start to personalize responses.", {
        key: z.string().optional().describe("Preference key, or omit to get all"),
    }, async (params) => {
        const result = preferenceGet(params.key);
        if (result === null) {
            return { content: [{ type: "text", text: `No preference found for "${params.key}".` }] };
        }
        const text = typeof result === "string"
            ? `${params.key}: ${result}`
            : Object.entries(result).map(([k, v]) => `${k}: ${v}`).join("\n") || "No preferences set.";
        return { content: [{ type: "text", text }] };
    });
    // seed_preference_set — Set a user preference
    server.tool("seed_preference_set", "Set a user preference. Use when the user expresses a consistent preference about how they like things done.", {
        key: z.string().describe("Preference key"),
        value: z.string().describe("Preference value"),
    }, async (params) => {
        const result = preferenceSet(params.key, params.value);
        return { content: [{ type: "text", text: `✅ Preference set: ${result.key} = ${result.value}` }] };
    });
}
//# sourceMappingURL=tools.js.map