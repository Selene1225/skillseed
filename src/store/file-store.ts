/**
 * Markdown file store with frontmatter — primary storage for experiences and preferences.
 * Git-friendly: each experience = one .md file with YAML frontmatter.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";

export interface ExperienceFrontmatter {
  scope: "universal" | "domain" | "company" | "team" | "project" | "personal";
  sensitivity: "public" | "internal" | "confidential" | "private";
  category: "good_practice" | "problem" | "correction" | "knowledge" | "preference";
  tags: string[];
  company?: string;
  team?: string;
  project?: string;
  domain?: string;
  confidence: number;
  source: "manual" | "conversation" | "correction" | "observation" | "import";
  source_cli?: string;
  created: string;
  updated: string;
  used: number;
  last_used?: string;
}

export interface Experience {
  id: string; // relative file path as ID
  meta: ExperienceFrontmatter;
  content: string;
  filePath: string;
}

export interface SearchOptions {
  query?: string;
  scope?: string;
  tags?: string[];
  limit?: number;
  maxTokens?: number;
}

export interface SearchResult {
  experience: Experience;
  score: number;
}

const SKILLSEED_DIR = path.join(os.homedir(), ".skillseed");
const EXPERIENCES_DIR = path.join(SKILLSEED_DIR, "experiences");
const SKILLS_DIR = path.join(SKILLSEED_DIR, "skills");

export function getSkillseedDir(): string {
  return SKILLSEED_DIR;
}

export function getExperiencesDir(): string {
  return EXPERIENCES_DIR;
}

export function getSkillsDir(): string {
  return SKILLS_DIR;
}

function generateSlug(content: string): string {
  // Take first 50 chars, lowercase, replace non-alphanumeric with dashes
  const raw = content.slice(0, 50).toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || "experience";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

function scopeToDir(meta: ExperienceFrontmatter): string {
  switch (meta.scope) {
    case "universal": return "universal";
    case "domain": return `domain--${meta.domain || "general"}`;
    case "company": return `company--${meta.company || "unknown"}`;
    case "team": return `team--${meta.team || "unknown"}`;
    case "project": return `project--${meta.project || "unknown"}`;
    case "personal": return "personal";
    default: return "universal";
  }
}

export function writeExperience(meta: ExperienceFrontmatter, content: string): Experience {
  const dir = path.join(EXPERIENCES_DIR, scopeToDir(meta));
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const slug = generateSlug(content);
  const rand = randomSuffix();
  const filename = `${date}-${slug}-${rand}.md`;
  const filePath = path.join(dir, filename);

  const fileContent = matter.stringify(content.trim() + "\n", meta);
  fs.writeFileSync(filePath, fileContent, "utf-8");

  const id = path.relative(EXPERIENCES_DIR, filePath).replace(/\\/g, "/");
  return { id, meta, content: content.trim(), filePath };
}

export function readExperience(filePath: string): Experience | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const id = path.relative(EXPERIENCES_DIR, filePath).replace(/\\/g, "/");
    return {
      id,
      meta: data as ExperienceFrontmatter,
      content: content.trim(),
      filePath,
    };
  } catch {
    return null;
  }
}

export function updateExperienceMeta(filePath: string, updates: Partial<ExperienceFrontmatter>): void {
  const exp = readExperience(filePath);
  if (!exp) return;
  const newMeta = { ...exp.meta, ...updates, updated: new Date().toISOString().slice(0, 10) };
  const fileContent = matter.stringify(exp.content + "\n", newMeta);
  fs.writeFileSync(filePath, fileContent, "utf-8");
}

export function listAllExperiences(): Experience[] {
  const results: Experience[] = [];
  if (!fs.existsSync(EXPERIENCES_DIR)) return results;

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const exp = readExperience(full);
        if (exp) results.push(exp);
      }
    }
  }
  walk(EXPERIENCES_DIR);
  return results;
}

/** Search experiences — interface designed for future index swap */
export function search(opts: SearchOptions): SearchResult[] {
  const all = listAllExperiences();
  let scored: SearchResult[] = [];

  for (const exp of all) {
    let score = 0;

    // Tag matching
    if (opts.tags && opts.tags.length > 0) {
      const matched = opts.tags.filter(t =>
        exp.meta.tags.some(et => et.toLowerCase() === t.toLowerCase())
      );
      score += matched.length * 20;
    }

    // Keyword matching (query against content + tags)
    if (opts.query) {
      const q = opts.query.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      for (const w of words) {
        if (exp.content.toLowerCase().includes(w)) score += 10;
        if (exp.meta.tags.some(t => t.toLowerCase().includes(w))) score += 15;
      }
    }

    // Scope filtering
    if (opts.scope && exp.meta.scope !== opts.scope) {
      continue; // skip non-matching scope
    }

    // Boost by usage and recency
    score += Math.min(exp.meta.used, 10);
    score += exp.meta.confidence * 5;

    if (score > 0) {
      scored.push({ experience: exp, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply limit
  const limit = opts.limit ?? 5;
  scored = scored.slice(0, limit);

  // Apply token budget (rough estimate: 1 token ≈ 4 chars for English)
  if (opts.maxTokens) {
    let totalTokens = 0;
    const budgeted: SearchResult[] = [];
    for (const r of scored) {
      const estTokens = Math.ceil(r.experience.content.length / 4) + 30; // 30 for metadata
      if (totalTokens + estTokens > opts.maxTokens) break;
      totalTokens += estTokens;
      budgeted.push(r);
    }
    return budgeted;
  }

  return scored;
}

/** Format experience as summary line (~30-50 tokens) */
export function formatSummary(exp: Experience): string {
  const scopeTag = `[${exp.meta.scope}${exp.meta.company ? ":" + exp.meta.company : ""}]`;
  const tags = exp.meta.tags.length > 0 ? ` [${exp.meta.tags.join(",")}]` : "";
  const firstLine = exp.content.split("\n")[0].slice(0, 120);
  return `${scopeTag}${tags} ${firstLine} (confidence:${exp.meta.confidence} | used:${exp.meta.used} | ${exp.meta.created})`;
}

/** Format experience as full detail */
export function formatDetail(exp: Experience): string {
  return matter.stringify(exp.content + "\n", exp.meta);
}

// Preferences stored as personal-scope experiences with category=preference
export function getPreference(key: string): string | null {
  const all = listAllExperiences();
  const pref = all.find(e =>
    e.meta.category === "preference" && e.meta.scope === "personal" &&
    e.content.startsWith(`${key}: `)
  );
  return pref ? pref.content.slice(key.length + 2).trim() : null;
}

export function getAllPreferences(): Record<string, string> {
  const all = listAllExperiences();
  const prefs: Record<string, string> = {};
  for (const e of all) {
    if (e.meta.category === "preference" && e.meta.scope === "personal") {
      const colonIdx = e.content.indexOf(": ");
      if (colonIdx > 0) {
        prefs[e.content.slice(0, colonIdx)] = e.content.slice(colonIdx + 2).trim();
      }
    }
  }
  return prefs;
}

export function setPreference(key: string, value: string): Experience {
  // Check if preference already exists
  const all = listAllExperiences();
  const existing = all.find(e =>
    e.meta.category === "preference" && e.meta.scope === "personal" &&
    e.content.startsWith(`${key}: `)
  );

  if (existing) {
    // Update existing
    const newContent = `${key}: ${value}`;
    const fileContent = matter.stringify(newContent + "\n", {
      ...existing.meta,
      updated: new Date().toISOString().slice(0, 10),
    });
    fs.writeFileSync(existing.filePath, fileContent, "utf-8");
    return { ...existing, content: newContent };
  }

  // Create new
  const date = new Date().toISOString().slice(0, 10);
  return writeExperience({
    scope: "personal",
    sensitivity: "private",
    category: "preference",
    tags: ["preference", key],
    confidence: 1.0,
    source: "manual",
    created: date,
    updated: date,
    used: 0,
  }, `${key}: ${value}`);
}
