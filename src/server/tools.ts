/**
 * MCP Tool definitions — thin adapters over service layer.
 * seed_log, seed_recall, seed_preference_get, seed_preference_set
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logExperience } from "../service/experience.js";
import { recall, recallDetail } from "../service/recall.js";
import { preferenceGet, preferenceSet } from "../service/preference.js";

export function registerTools(server: McpServer): void {
  // seed_log — Record a work experience
  server.tool(
    "seed_log",
    "Record a work experience or lesson learned. Call when: (1) user corrects you, (2) a non-obvious solution is found after debugging, (3) user describes project-specific processes or conventions, (4) user says 记住/remember and the content is a fact or experience (not a preference). Do NOT call for trivial facts or well-known information.",
    {
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
    },
    async (params) => {
      const result = logExperience(params);
      const text = result.success
        ? `✅ Experience logged: ${result.id}${result.warnings.length > 0 ? "\n⚠️ " + result.warnings.join("\n⚠️ ") : ""}`
        : `❌ Failed to log: ${result.warnings.join(", ")}`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // seed_recall — Search past experiences
  server.tool(
    "seed_recall",
    "Search past work experiences. Call when: (1) writing code or configs and need project-specific context, (2) user corrected you — check for similar past corrections, (3) stuck or failing repeatedly. Do NOT call for simple questions, greetings, or general knowledge. NEVER call when user says 记住/remember/记得 — use seed_preference_set or seed_log instead.",
    {
      query: z.string().describe("What to search for"),
      scope: z.enum(["universal", "domain", "company", "team", "project", "personal"]).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().optional().describe("Max results (default: 5)"),
      maxTokens: z.number().optional().describe("Token budget (default: 1500)"),
      detail: z.string().optional().describe("Experience ID to get full text instead of search"),
    },
    async (params) => {
      if (params.detail) {
        const d = await recallDetail(params.detail);
        if (!d) return { content: [{ type: "text" as const, text: `Experience "${params.detail}" not found.` }] };
        return { content: [{ type: "text" as const, text: d.fullText }] };
      }
      const result = recall(params);
      if (result.hint) {
        return { content: [{ type: "text" as const, text: result.hint }] };
      }
      const HIGH_SCORE = 80;
      const lines = result.results.map((r, i) => {
        const prefix = `${i + 1}.`;
        // High-score: full content; low-score: title-based summary
        return r.score >= HIGH_SCORE
          ? `${prefix} ${r.content}`
          : `${prefix} ${r.summary}`;
      });
      const text = `Found ${result.total} experience(s):\n${lines.join("\n")}`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // seed_preference_get — Get user preferences
  server.tool(
    "seed_preference_get",
    "Get user preferences. Call once at start ONLY if producing output (code, docs, emails). Do NOT call for simple Q&A or greetings.",
    {
      key: z.string().optional().describe("Preference key, or omit to get all"),
    },
    async (params) => {
      const result = preferenceGet(params.key);
      if (result === null) {
        return { content: [{ type: "text" as const, text: `No preference found for "${params.key}".` }] };
      }
      const text = typeof result === "string"
        ? `${params.key}: ${result}`
        : Object.entries(result).map(([k, v]) => `${k}: ${v}`).join("\n") || "No preferences set.";
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // seed_preference_set — Set a user preference
  server.tool(
    "seed_preference_set",
    "Set a user preference. Call when user says 记住/remember/记得 about preferences, styles, or behaviors (e.g. 'remember I prefer dark mode', '记住用中文回复').",
    {
      key: z.string().describe("Preference key"),
      value: z.string().describe("Preference value"),
    },
    async (params) => {
      const result = preferenceSet(params.key, params.value);
      return { content: [{ type: "text" as const, text: `✅ Preference set: ${result.key} = ${result.value}` }] };
    }
  );
}
