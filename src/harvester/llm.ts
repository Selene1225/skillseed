/**
 * LLM invocation helpers — stateless, no business logic.
 * Responsible only for: fork CLI → clean ANSI/fences → return parsed JSON.
 */

import { execFileSync } from "node:child_process";

/**
 * Call a brain CLI with a prompt and return raw string output.
 */
export function callLlm(prompt: string, brainCli: string, timeout = 60_000): string {
  if (brainCli === "claude") {
    return execFileSync("claude", ["-p", "--bare"], {
      encoding: "utf-8", timeout, input: prompt,
      stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
    }).trim();
  }
  return execFileSync(brainCli, ["-p"], {
    encoding: "utf-8", timeout, input: prompt,
    stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
  }).trim();
}

/**
 * Parse LLM output as JSON, stripping markdown fences and ANSI codes.
 * Returns parsed object or null if parsing fails.
 */
export function parseLlmJson(output: string): unknown {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch {
    for (const line of cleaned.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      try { return JSON.parse(trimmed); } catch { /* skip */ }
    }
  }
  return null;
}
