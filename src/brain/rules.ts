/**
 * Rule engine for scope/sensitivity inference — synchronous, millisecond-level.
 * Falls back to this when Brain CLI is unavailable.
 */

import type { ExperienceFrontmatter } from "../store/file-store.js";

type ScopeLevel = ExperienceFrontmatter["scope"];
type Sensitivity = ExperienceFrontmatter["sensitivity"];

interface InferredMeta {
  scope: ScopeLevel;
  sensitivity: Sensitivity;
  tags: string[];
  domain?: string;
}

// Sensitive patterns (V1 regex)
const SENSITIVE_PATTERNS = [
  { pattern: /\b(api[_-]?key|token|secret|password|bearer)\s*[=:]/i, label: "credential" },
  { pattern: /\.(corp|internal)\./i, label: "internal-domain" },
  { pattern: /dev\.azure\.com/i, label: "azure-devops" },
  { pattern: /pkgs\.dev\.azure\.com/i, label: "azure-artifacts" },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: "ip-address" },
  { pattern: /[A-Za-z]:\\Users\\[^\\]+\\/i, label: "windows-path" },
  { pattern: /\/home\/[^/]+\//i, label: "unix-path" },
];

// Company-specific keyword patterns
const COMPANY_KEYWORDS: Record<string, string[]> = {
  microsoft: ["azure", "ado", "devops", "teams", "sharepoint", "onedrive", "outlook", "m365", "vscode", "icm"],
  google: ["gcp", "googleapis", "firebase", "chrome"],
  aws: ["aws", "s3", "ec2", "lambda", "dynamodb"],
};

// Domain keyword patterns
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  "web-dev": ["react", "vue", "angular", "html", "css", "javascript", "typescript", "webpack", "vite", "frontend"],
  "cloud-infra": ["kubernetes", "k8s", "docker", "terraform", "helm", "ci/cd", "pipeline", "deployment"],
  "data-eng": ["sql", "etl", "spark", "hadoop", "airflow", "databricks", "warehouse"],
  "ai-ml": ["model", "training", "inference", "embedding", "llm", "gpt", "claude", "prompt"],
};

// Tag extraction keywords
const TAG_KEYWORDS: Record<string, string[]> = {
  git: ["git", "commit", "branch", "merge", "rebase", "pr", "pull request"],
  deployment: ["deploy", "staging", "production", "release", "rollback"],
  testing: ["test", "unit test", "integration test", "e2e", "coverage"],
  "code-review": ["review", "pr", "pull request", "feedback"],
  security: ["security", "auth", "token", "credential", "encrypt"],
  performance: ["performance", "latency", "cache", "optimize", "slow"],
  documentation: ["doc", "readme", "documentation", "comment"],
};

/** Infer scope, sensitivity, and tags from content */
export function inferMeta(content: string, hints?: {
  scope?: ScopeLevel;
  company?: string;
  team?: string;
  project?: string;
}): InferredMeta {
  const lower = content.toLowerCase();

  // 1. Detect sensitivity from patterns
  let sensitivity: Sensitivity = "public";
  for (const { pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      sensitivity = "internal";
      break;
    }
  }

  // 2. Detect scope
  let scope: ScopeLevel = hints?.scope ?? "universal";
  let domain: string | undefined;

  if (!hints?.scope) {
    // Check company keywords
    for (const [company, keywords] of Object.entries(COMPANY_KEYWORDS)) {
      if (keywords.some(kw => lower.includes(kw))) {
        scope = "company";
        if (!hints?.company) {
          // Don't auto-assign company name from content — too risky
        }
        break;
      }
    }

    // Check domain keywords (only if still universal)
    if (scope === "universal") {
      for (const [dom, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) {
          scope = "domain";
          domain = dom;
          break;
        }
      }
    }
  }

  // Apply scope → sensitivity defaults if not already elevated
  if (sensitivity === "public") {
    switch (scope) {
      case "company":
      case "team":
      case "project":
        sensitivity = "internal";
        break;
      case "personal":
        sensitivity = "private";
        break;
    }
  }

  // 3. Extract tags
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.push(tag);
    }
  }

  return { scope, sensitivity, tags, domain };
}

/** Check if content might be misclassified as too low sensitivity */
export function checkSensitivityTooLow(content: string, declared: Sensitivity): string | null {
  if (declared === "confidential" || declared === "private") return null; // Already high
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      if (declared === "public") {
        return `⚠️ Content contains ${label} pattern but marked as public. Consider raising to internal or confidential.`;
      }
    }
  }
  return null;
}

/** Check content granularity */
export function checkGranularity(content: string): { ok: boolean; message?: string } {
  const words = content.trim().split(/\s+/).length;
  if (words < 5) {
    return { ok: false, message: "Experience too short — consider adding more context." };
  }
  if (words > 500) {
    return { ok: false, message: "Experience too long — consider splitting into multiple entries." };
  }
  return { ok: true };
}

/** Basic prompt injection sanitization */
export function sanitize(content: string): string {
  // Remove patterns that look like system prompts or injection
  return content
    .replace(/\bsystem:\s*/gi, "")
    .replace(/\bignore\s+(previous|above)\s+instructions?\b/gi, "[filtered]")
    .replace(/\bdo\s+not\s+follow\b/gi, "[filtered]")
    .trim();
}
