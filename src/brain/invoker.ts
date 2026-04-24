/**
 * Brain CLI invoker — async background refinement of scope/sensitivity.
 * Forks user's chosen CLI (claude/gemini) for one-shot LLM inference.
 * Never blocks seed_log writes.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { updateExperienceMeta } from "../store/file-store.js";
import type { ExperienceFrontmatter } from "../store/file-store.js";

interface BrainConfig {
  cli: "claude" | "gemini" | "none";
}

function loadConfig(): BrainConfig {
  const configPath = path.join(os.homedir(), ".skillseed", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return { cli: cfg.brain_cli ?? "none" };
  } catch {
    return { cli: "none" };
  }
}

function buildPrompt(content: string, currentMeta: Partial<ExperienceFrontmatter>): string {
  return `Analyze this work experience entry and suggest better scope and tags.
Current scope: ${currentMeta.scope ?? "unknown"}
Current tags: ${currentMeta.tags?.join(", ") ?? "none"}

Experience content:
${content}

Respond with ONLY a JSON object (no markdown):
{
  "scope": "universal|domain|company|team|project|personal",
  "tags": ["tag1", "tag2"],
  "domain": "optional domain name",
  "confidence": 0.0-1.0
}`;
}

/** Async refinement — fire and forget, never blocks */
export function refineAsync(filePath: string, content: string, currentMeta: Partial<ExperienceFrontmatter>): void {
  const config = loadConfig();
  if (config.cli === "none") return;

  const prompt = buildPrompt(content, currentMeta);
  const cmd = config.cli === "claude" ? "claude" : "gemini";
  const args = ["-p", prompt];

  try {
    const child = execFile(cmd, args, { timeout: 30000 }, (err, stdout) => {
      if (err) return; // Silently fail — rule engine already handled the sync path
      try {
        // Parse LLM response
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        const result = JSON.parse(jsonMatch[0]);

        const updates: Partial<ExperienceFrontmatter> = {};
        if (result.scope && result.scope !== currentMeta.scope) {
          updates.scope = result.scope;
        }
        if (result.tags && Array.isArray(result.tags)) {
          updates.tags = result.tags;
        }
        if (result.domain) {
          updates.domain = result.domain;
        }

        if (Object.keys(updates).length > 0) {
          updateExperienceMeta(filePath, updates);
        }
      } catch {
        // Parse failure — ignore
      }
    });
    child.unref(); // Don't keep parent alive
  } catch {
    // CLI not available — ignore
  }
}
