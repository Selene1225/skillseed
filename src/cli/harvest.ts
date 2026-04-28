/**
 * Harvest — extract experiences from Claude CLI conversation history.
 *
 * Strategy: heuristic filter → LLM extraction → pending review.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { getSkillseedDir, writeExperience, listAllExperiences, sanitizeContent, moveExperienceScope, updateExperienceMeta, type ExperienceFrontmatter } from "../store/file-store.js";
import matter from "gray-matter";

// --- Types ---

interface ConversationTurn {
  type: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
}

interface ConversationChunk {
  turns: ConversationTurn[];
  file: string;
  project: string;
}

interface PendingExperience {
  title?: string;
  content: string;
  category: string;
  tags: string[];
  scope: string;
  source_file: string;
}

// --- Heuristic patterns ---

const CORRECTION_PATTERNS = [
  /不对|不是这样|应该是|错了|wrong|actually,?\s+(?:you|it|the)|fix(?:ed)?\s+(?:by|with)|instead\s+of/i,
  /纠正|修正|改成|换成|correct(?:ion|ed)|mistake/i,
];

const LESSON_PATTERNS = [
  /原来|学到|注意|记住|关键是|诀窍|trick|learned|turns?\s+out|gotcha|caveat|workaround/i,
  /根本原因|root\s+cause|the\s+(?:issue|problem)\s+was/i,
];

const PROCESS_PATTERNS = [
  /流程|步骤|pipeline|deploy|部署|发布|release|先.*然后.*最后/i,
  /our\s+(?:team|project|company)|我们团队|我们项目/i,
];

const SOLUTION_PATTERNS = [
  /solved|resolved|fix(?:ed)?.*by|solution|最终.*解决|搞定了/i,
  /the\s+(?:answer|key)\s+(?:is|was)/i,
];

// Skip trivial conversations
const SKIP_PATTERNS = [
  /^ping$/i,
  /^(?:hi|hello|hey|你好|test)\s*$/i,
  /^(?:yes|no|y|n|ok|好|是|对)\s*$/i,
];

// Pre-filter: discard test residue and garbage data before LLM extraction
const GARBAGE_PATTERNS = [
  /Count test\b/i,
  /test\s+(?:alpha|beta|gamma|delta)\b/i,
  /test\s+\d{10,}/i, // test + timestamp
  /\b(?:foo|bar|baz|lorem ipsum)\b/i,
  /^TODO:?\s*$/i,
  /^placeholder/i,
];

// Tags that force scope downgrade from universal → domain
const UNIVERSAL_BLOCKLIST = new Set([
  "python", "azure", "npm", "playwright", "teams", "edge", "github", "windows",
  "sqlite", "react", "asyncio", "fastapi", "typescript", "node", "docker",
  "kubernetes", "redis", "postgresql", "mongodb", "nextjs", "vue", "angular",
  "django", "flask", "express", "graphql", "rest", "grpc", "terraform",
  "powershell", "bash", "linux", "macos", "chrome", "firefox", "safari",
  "webpack", "vite", "eslint", "jest", "vitest", "pytest", "junit",
]);

// High-frequency low-signal tags excluded from Union-Find graph edges
const TAG_STOPWORDS = new Set([
  "bug", "fix", "error", "issue", "problem", "solution", "workaround",
  "debugging", "troubleshooting", "best-practice", "tip", "note",
  "configuration", "setup", "config",
]);

// --- JSONL Parsing ---

function parseJsonlFile(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return turns;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "user" && obj.type !== "assistant") continue;

      let text = "";
      const msg = obj.message;
      if (!msg?.content) continue;

      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");
      }

      if (!text.trim()) continue;

      turns.push({
        type: obj.type,
        text: text.trim(),
        timestamp: obj.timestamp || "",
        sessionId: obj.sessionId || "",
      });
    } catch {
      // skip malformed lines
    }
  }
  return turns;
}

function projectNameFromPath(filePath: string): string {
  // ~/.claude/projects/c--Users-yiliu4-code-PROJECT/session.jsonl
  const parts = filePath.split(path.sep);
  const projIdx = parts.indexOf("projects");
  if (projIdx >= 0 && projIdx + 1 < parts.length) {
    const dirName = parts[projIdx + 1];
    // Extract last segment: c--Users-yiliu4-code-PROJECT → PROJECT
    const segments = dirName.split("-");
    return segments[segments.length - 1] || dirName;
  }
  return "unknown";
}

// --- Heuristic Filter ---

function scoreChunk(chunk: ConversationChunk): number {
  let score = 0;
  const fullText = chunk.turns.map(t => t.text).join("\n");

  for (const p of CORRECTION_PATTERNS) if (p.test(fullText)) score += 30;
  for (const p of LESSON_PATTERNS) if (p.test(fullText)) score += 25;
  for (const p of PROCESS_PATTERNS) if (p.test(fullText)) score += 20;
  for (const p of SOLUTION_PATTERNS) if (p.test(fullText)) score += 20;

  // Longer substantive conversations are more likely to contain insights
  const wordCount = fullText.split(/\s+/).length;
  if (wordCount > 200) score += 10;
  if (wordCount > 500) score += 10;

  return score;
}

function isSkippable(text: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(text.trim()));
}

function isGarbage(text: string): boolean {
  return GARBAGE_PATTERNS.some(p => p.test(text.trim()));
}

// --- Chunking ---

function chunkConversation(turns: ConversationTurn[], file: string, project: string): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  const CHUNK_SIZE = 20; // turns per chunk

  // Filter out trivial single-word turns for scoring purposes
  const substantiveTurns = turns.filter(t => !isSkippable(t.text));
  if (substantiveTurns.length < 4) return chunks; // too short

  for (let i = 0; i < substantiveTurns.length; i += CHUNK_SIZE) {
    const slice = substantiveTurns.slice(i, i + CHUNK_SIZE);
    if (slice.length >= 2) {
      chunks.push({ turns: slice, file, project });
    }
  }
  return chunks;
}

// --- LLM Extraction ---

const EXTRACT_PROMPT = `You are analyzing a conversation excerpt to extract work experiences worth remembering.

For each experience, output a JSON object on its own line with these fields:
- title: 中文标题（max 50 chars），仅技术专有名词保留英文。格式：[技术栈/模块] 现象与解决方案。例："[npm] Windows全局安装GitHub包失败的tgz方案"、"[Azure AD] 跨租户Graph API需admin consent"
- content: one clear sentence describing the lesson, practice, or solution (max 200 chars)
- category: one of "good_practice", "problem", "correction", "knowledge"
- tags: array of 2-5 relevant topic tags (lowercase)
- scope: one of "universal", "domain", "project", "company", "personal" — see strict rules below

Scope classification (STRICT):
- "universal": ONLY generic software engineering principles with NO specific framework/language/tool. Examples: Git commit规范, PR review最佳实践, 通用调试思路, 代码重构原则. If it mentions ANY specific tool (React, Python, Azure, npm, Playwright...), it is NOT universal.
- "domain": Experiences about specific PUBLIC technologies, frameworks, or tools that anyone can use. Examples: Azure AD auth, React hooks, Python packaging, npm config, Playwright tricks, Microsoft Graph API.
- "project": Experiences specific to OUR internal projects, repos, or business logic. Examples: Super-Agent-OS architecture, CTA bot design, OpenClaw conventions, skillseed development decisions.
- "company": Internal team conventions, company-specific processes, toolchain choices, org-specific URLs/configs.
- "personal": User preferences, habits, or personal traits.

Rules:
- Only extract NON-TRIVIAL, reusable insights that would help someone in the future
- Extract LESSONS and PRINCIPLES, not API documentation or code descriptions
- BAD: "Function X returns Y events" (this is API docs, not experience)
- GOOD: "Streaming APIs should expose typed events so consumers can filter by type" (this is a reusable lesson)
- Skip general knowledge anyone would know
- Skip test data, placeholder text, or debug artifacts (e.g. "Count test xxx", "test alpha")
- Skip descriptions of how specific code/APIs work — that belongs in code comments
- Focus on: mistakes made, corrections, workarounds, team conventions, debugging lessons, architectural decisions and WHY they were made
- Output ONLY JSON lines, no other text. If nothing worth extracting, output nothing.

Conversation:
`;

function extractWithLlm(chunk: ConversationChunk, brainCli: string): PendingExperience[] {
  const conversationText = chunk.turns
    .filter(t => !isGarbage(t.text)) // pre-filter garbage
    .map(t => `[${t.type}]: ${t.text.slice(0, 1000)}`) // cap per-turn length
    .join("\n\n");

  const prompt = EXTRACT_PROMPT + conversationText;
  const results: PendingExperience[] = [];

  try {
    let output: string;
    // Write prompt to temp file, pipe to CLI
    const tmpFile = path.join(os.tmpdir(), `skillseed-harvest-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, "utf-8");
    try {
      if (brainCli === "claude") {
        output = execFileSync("claude", ["-p", "--bare"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      } else {
        output = execFileSync(brainCli, ["-p"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    // Parse JSON lines from output
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.content && obj.category) {
          // Post-filter: skip garbage that slipped through
          if (isGarbage(obj.content) || isGarbage(obj.title || "") || (obj.content.length < 15 && !obj.tags?.length)) continue;
          // Programmatic: strip wrapping quotes from title
          if (obj.title) obj.title = obj.title.replace(/^["']|["']$/g, "").trim();
          // Programmatic: downgrade universal scope if tags contain specific tech
          if ((obj.scope || "universal") === "universal" && obj.tags?.some((t: string) => UNIVERSAL_BLOCKLIST.has(t.toLowerCase()))) {
            obj.scope = "domain";
          }
          results.push({
            title: obj.title || undefined,
            content: obj.content,
            category: obj.category,
            tags: obj.tags || [],
            scope: obj.scope || "universal",
            source_file: chunk.file,
          });
        }
      } catch { /* skip malformed JSON */ }
    }
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
      console.error(`timeout (chunk too large, skipping)`);
    } else {
      console.error(`failed: ${msg.slice(0, 80)}`);
    }
  }

  return results;
}

// --- Semantic Dedup ---

function tokenize(text: string): Set<string> {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const segments = Array.from(segmenter.segment(text.toLowerCase()));
  return new Set(
    segments
      .filter(s => s.isWordLike || /^[a-z0-9]+$/.test(s.segment))
      .map(s => s.segment)
      .filter(w => w.length > 1 || /[\u4e00-\u9fff]/.test(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isDuplicateExperience(newContent: string, newTags: string[]): { duplicate: boolean; similarExp?: ReturnType<typeof listAllExperiences>[0] } {
  const existing = listAllExperiences();
  const newTokens = tokenize(newContent);
  const newTagSet = new Set(newTags);

  for (const e of existing) {
    // Tag overlap check
    const existingTagSet = new Set(e.meta.tags || []);
    let tagOverlap = 0;
    for (const t of newTagSet) if (existingTagSet.has(t)) tagOverlap++;
    const tagSim = newTagSet.size === 0 ? 0 : tagOverlap / Math.max(newTagSet.size, existingTagSet.size);

    // Text similarity
    const existingTokens = tokenize(e.content);
    const textSim = jaccardSimilarity(newTokens, existingTokens);

    // Combined: high text similarity + tag overlap = duplicate
    if (textSim > 0.6 || (textSim > 0.4 && tagSim > 0.5)) {
      return { duplicate: true, similarExp: e };
    }
  }
  return { duplicate: false };
}

// --- Merge Prompt (used by both writePending real-time merge and batch dedup) ---

const MERGE_PROMPT = `Below are duplicate/similar experiences about the same topic. Merge them into ONE consolidated experience that captures ALL unique details.

Output a single JSON object with:
- title: 中文标题（max 50 chars），仅技术专有名词保留英文，格式：[技术栈] 现象与方案
- content: merged content preserving all unique details (max 300 chars)
- scope: best scope for this (universal/domain/project/company/personal)
- tags: merged unique tags

Output ONLY the JSON object, no other text.

Experiences to merge:
`;

// --- Pending Storage ---

function getPendingDir(): string {
  return path.join(getSkillseedDir(), "pending");
}

function writePending(exp: PendingExperience, brainCli: string = "claude"): string | null {
  // Semantic dedup: merge into existing if too similar
  const { duplicate, similarExp } = isDuplicateExperience(exp.content, exp.tags);
  if (duplicate && similarExp) {
    // LLM merge: combine new context into the existing experience
    const mergeInput = [
      `1. [${similarExp.meta.scope}] [tags: ${(similarExp.meta.tags || []).join(",")}] ${similarExp.content}`,
      `2. [${exp.scope}] [tags: ${exp.tags.join(",")}] ${exp.content}`,
    ].join("\n");
    const prompt = MERGE_PROMPT + mergeInput;

    try {
      let output: string;
      if (brainCli === "claude") {
        output = execFileSync("claude", ["-p", "--bare"], {
          encoding: "utf-8", timeout: 60_000, input: prompt,
          stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
        }).trim();
      } else {
        output = execFileSync(brainCli, ["-p"], {
          encoding: "utf-8", timeout: 60_000, input: prompt,
          stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
        }).trim();
      }

      let mergedObj: { title?: string; content?: string; scope?: string; tags?: string[] } | null = null;
      const cleaned = output.replace(/```(?:json)?\s*/g, "").trim();
      try { mergedObj = JSON.parse(cleaned); } catch {
        for (const line of cleaned.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try { mergedObj = JSON.parse(trimmed); break; } catch { /* skip */ }
        }
      }

      if (mergedObj?.content) {
        const raw = fs.readFileSync(similarExp.filePath, "utf-8");
        const parsed = matter(raw);
        if (mergedObj.title) parsed.data.title = mergedObj.title.replace(/^["']|["']$/g, "").trim().slice(0, 50);
        parsed.data.scope = mergedObj.scope || similarExp.meta.scope;
        parsed.data.tags = mergedObj.tags || similarExp.meta.tags;
        parsed.data.updated = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(similarExp.filePath, matter.stringify(mergedObj.content, parsed.data), "utf-8");
        moveExperienceScope(similarExp.filePath, parsed.data as ExperienceFrontmatter);
        return `merged:${similarExp.id}`;
      }
    } catch { /* merge failed, fall through to write as new */ }
  }

  const dir = getPendingDir();
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const slug = exp.content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exp";
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `${date}-${slug}-${rand}.md`;
  const filePath = path.join(dir, filename);

  const frontmatter = [
    "---",
    ...(exp.title ? [`title: "${exp.title}"`] : []),
    `category: ${exp.category}`,
    `tags: [${exp.tags.map(t => `"${t}"`).join(", ")}]`,
    `scope: ${exp.scope}`,
    `source_file: ${exp.source_file}`,
    `harvested: ${new Date().toISOString()}`,
    "---",
    "",
    exp.content,
    "",
  ].join("\n");

  fs.writeFileSync(filePath, frontmatter, "utf-8");
  return filename;
}

function listPending(): Array<{ file: string; content: string; meta: Record<string, string> }> {
  const dir = getPendingDir();
  if (!fs.existsSync(dir)) return [];

  const results: Array<{ file: string; content: string; meta: Record<string, string> }> = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    const raw = fs.readFileSync(filePath, "utf-8");

    // Simple frontmatter parsing
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;

    const meta: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) meta[line.slice(0, idx)] = line.slice(idx + 2);
    }

    results.push({ file: entry, content: fmMatch[2].trim(), meta });
  }
  return results;
}

// --- Incremental Tracking ---

function getHarvestState(): Record<string, string> {
  const statePath = path.join(getSkillseedDir(), "harvest-state.json");
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    return {};
  }
}

function saveHarvestState(state: Record<string, string>): void {
  const statePath = path.join(getSkillseedDir(), "harvest-state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// --- Dedup ---

function isDuplicate(content: string, existing: string[]): boolean {
  const normalized = content.toLowerCase().trim();
  return existing.some(e => {
    const n = e.toLowerCase().trim();
    return n === normalized || n.includes(normalized) || normalized.includes(n);
  });
}

// --- Public API ---

export function discoverHistoryFiles(): Array<{ file: string; project: string; size: number; mtime: string }> {
  const claudeProjects = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeProjects)) return [];

  const results: Array<{ file: string; project: string; size: number; mtime: string }> = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(full);
        results.push({
          file: full,
          project: projectNameFromPath(full),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }
  walk(claudeProjects);
  return results.sort((a, b) => b.size - a.size);
}

export interface HarvestOptions {
  brainCli?: string;
  minScore?: number;
  maxFiles?: number;
  dryRun?: boolean;
}

export function harvest(opts: HarvestOptions = {}): { scanned: number; extracted: number; pending: number } {
  const brainCli = opts.brainCli || "claude";
  const minScore = opts.minScore ?? 20;
  const maxFiles = opts.maxFiles ?? 0; // 0 = no limit

  const allFiles = discoverHistoryFiles();
  const files = maxFiles > 0 ? allFiles.slice(0, maxFiles) : allFiles;
  const state = getHarvestState();
  const existingContent = listAllExperiences().map(e => e.content);

  let scanned = 0;
  let extracted = 0;

  console.log(`\n🌾 Harvesting from ${files.length} conversation files...\n`);

  for (const f of files) {
    // Skip already harvested (same mtime)
    if (state[f.file] === f.mtime) {
      continue;
    }

    scanned++;
    const project = f.project;
    process.stdout.write(`   Scanning ${project}/${path.basename(f.file).slice(0, 8)}... `);

    const turns = parseJsonlFile(f.file);
    const chunks = chunkConversation(turns, f.file, project);
    const highScoreChunks = chunks.filter(c => scoreChunk(c) >= minScore);

    if (highScoreChunks.length === 0) {
      console.log("skip (no high-value content)");
      state[f.file] = f.mtime;
      continue;
    }

    console.log(`${highScoreChunks.length} chunk(s) to analyze`);

    for (let ci = 0; ci < highScoreChunks.length; ci++) {
      const chunk = highScoreChunks[ci];
      process.stdout.write(`     [${ci + 1}/${highScoreChunks.length}] extracting... `);
      const experiences = extractWithLlm(chunk, brainCli);
      let chunkNew = 0;
      for (const exp of experiences) {
        if (isDuplicate(exp.content, existingContent)) {
          continue;
        }
        if (opts.dryRun) {
          console.log(`   [dry-run] Would extract: ${exp.content.slice(0, 80)}`);
        } else {
          const written = writePending(exp, brainCli);
          if (!written) continue; // semantic dedup skipped
          if (written.startsWith("merged:")) {
            console.log(`     ↗ merged into existing: ${written.slice(7).slice(0, 60)}`);
          }
          existingContent.push(exp.content);
        }
        extracted++;
        chunkNew++;
      }
      if (!opts.dryRun) console.log(`${chunkNew} experience(s)`);
    }

    state[f.file] = f.mtime;
    if (!opts.dryRun) saveHarvestState(state); // save after each file — Ctrl+C safe
  }

  const pendingCount = listPending().length;
  console.log(`\n   Scanned: ${scanned} files`);
  console.log(`   Extracted: ${extracted} new experience(s)`);
  console.log(`   Pending review: ${pendingCount}\n`);

  if (pendingCount > 0) {
    console.log(`   Run 'skillseed harvest --review' to approve/reject.\n`);
  }

  return { scanned, extracted, pending: pendingCount };
}

export async function reviewPending(): Promise<void> {
  const pending = listPending();
  if (pending.length === 0) {
    console.log("\n✅ No pending experiences to review.\n");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log(`\n📋 ${pending.length} pending experience(s) to review:\n`);

  let approved = 0;
  let rejected = 0;

  for (const p of pending) {
    console.log(`─────────────────────────────────`);
    console.log(`  ${p.content}`);
    console.log(`  category: ${p.meta.category}  tags: ${p.meta.tags}  scope: ${p.meta.scope}`);

    const answer = await ask("  [y]es / [n]o / [s]kip / [q]uit? ");
    const cmd = answer.trim().toLowerCase();

    const pendingPath = path.join(getPendingDir(), p.file);

    if (cmd === "y" || cmd === "yes") {
      // Approve: write as real experience
      const date = new Date().toISOString().slice(0, 10);
      let tags: string[] = [];
      try {
        tags = JSON.parse(p.meta.tags || "[]");
      } catch {
        tags = p.meta.tags?.replace(/[\[\]"]/g, "").split(",").map((t: string) => t.trim()).filter(Boolean) || [];
      }

      const meta: ExperienceFrontmatter = {
        scope: (p.meta.scope as ExperienceFrontmatter["scope"]) || "universal",
        sensitivity: "internal",
        category: (p.meta.category as ExperienceFrontmatter["category"]) || "knowledge",
        tags,
        ...(p.meta.title && { title: p.meta.title }),
        confidence: 0.7, // harvested = slightly lower confidence
        source: "observation",
        source_cli: "harvest",
        created: date,
        updated: date,
        used: 0,
      };
      writeExperience(meta, p.content);
      fs.unlinkSync(pendingPath);
      approved++;
      console.log("  ✅ Approved\n");
    } else if (cmd === "n" || cmd === "no") {
      fs.unlinkSync(pendingPath);
      rejected++;
      console.log("  ❌ Rejected\n");
    } else if (cmd === "q" || cmd === "quit") {
      break;
    } else {
      console.log("  ⏭️  Skipped\n");
    }
  }

  rl.close();
  console.log(`\n   Approved: ${approved}, Rejected: ${rejected}, Remaining: ${listPending().length}\n`);
}

export function approveAll(): number {
  const pending = listPending();
  let count = 0;
  const date = new Date().toISOString().slice(0, 10);

  for (const p of pending) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(p.meta.tags || "[]");
    } catch {
      tags = p.meta.tags?.replace(/[\[\]"]/g, "").split(",").map((t: string) => t.trim()).filter(Boolean) || [];
    }

    const meta: ExperienceFrontmatter = {
      scope: (p.meta.scope as ExperienceFrontmatter["scope"]) || "universal",
      sensitivity: "internal",
      category: (p.meta.category as ExperienceFrontmatter["category"]) || "knowledge",
      tags,
      ...(p.meta.title && { title: p.meta.title }),
      confidence: 0.7,
      source: "observation",
      source_cli: "harvest",
      created: date,
      updated: date,
      used: 0,
    };
    writeExperience(meta, p.content);
    fs.unlinkSync(path.join(getPendingDir(), p.file));
    count++;
  }

  console.log(`\n✅ Approved all ${count} pending experience(s).\n`);
  return count;
}

// --- Auto Review (LLM second-pass quality filter) ---

const REVIEW_PROMPT = `You are reviewing harvested work experiences for quality. For each experience, decide:
- "approve": Useful lesson, debugging insight, correction, architectural decision, team convention
- "reject": API documentation, code description, too generic/obvious, duplicate of another experience listed
- "uncertain": Not sure — needs human review

Output one JSON object per line: {"id": N, "verdict": "approve"|"reject"|"uncertain", "reason": "brief reason"}

Existing experiences (for dedup):
`;

export function autoReview(opts: { brainCli?: string; dryRun?: boolean } = {}): {
  approved: number; rejected: number; uncertain: number;
} {
  const brainCli = opts.brainCli || "claude";
  const pending = listPending();

  if (pending.length === 0) {
    console.log("No pending experiences to review.");
    return { approved: 0, rejected: 0, uncertain: 0 };
  }

  console.log(`\n🔍 Auto-reviewing ${pending.length} pending experience(s)...\n`);

  // Get existing experiences for dedup (only tags overlap)
  const existing = listAllExperiences();
  let approved = 0, rejected = 0, uncertain = 0;

  const BATCH = 15;
  const pendingDir = getPendingDir();

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(pending.length / BATCH);
    console.log(`[${batchNum}/${totalBatches}] Reviewing ${batch.length} experiences...`);

    // Find related existing experiences (same tags) for dedup
    const batchTags = new Set(batch.flatMap(p => {
      try { return JSON.parse(p.meta.tags || "[]"); }
      catch { return p.meta.tags?.replace(/[\[\]"]/g, "").split(",").map((t: string) => t.trim()).filter(Boolean) || []; }
    }));
    const relatedExisting = existing
      .filter(e => e.meta.tags.some(t => batchTags.has(t)))
      .slice(0, 20)
      .map(e => e.content.slice(0, 100));

    const existingSection = relatedExisting.length > 0
      ? relatedExisting.map((c, idx) => `E${idx + 1}. ${c}`).join("\n")
      : "(none)";

    const pendingSection = batch.map((p, idx) =>
      `${idx + 1}. ${p.content.slice(0, 150)}`
    ).join("\n");

    const prompt = REVIEW_PROMPT + existingSection + "\n\nPending experiences to review:\n" + pendingSection;

    try {
      let output: string;
      if (brainCli === "claude") {
        output = execFileSync("claude", ["-p", "--bare"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      } else {
        output = execFileSync(brainCli, ["-p"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      }

      const verdicts = new Map<number, { verdict: string; reason: string }>();
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.id && obj.verdict) {
            verdicts.set(Number(obj.id), { verdict: obj.verdict, reason: obj.reason || "" });
          }
        } catch { /* skip */ }
      }

      const date = new Date().toISOString().slice(0, 10);
      for (let idx = 0; idx < batch.length; idx++) {
        const p = batch[idx];
        const v = verdicts.get(idx + 1);
        const verdict = v?.verdict || "uncertain";
        const reason = v?.reason || "no LLM response";

        if (verdict === "approve" && !opts.dryRun) {
          // Write to experience store
          let tags: string[];
          try { tags = JSON.parse(p.meta.tags || "[]"); }
          catch { tags = p.meta.tags?.replace(/[\[\]"]/g, "").split(",").map((t: string) => t.trim()).filter(Boolean) || []; }

          const meta: ExperienceFrontmatter = {
            scope: (p.meta.scope as ExperienceFrontmatter["scope"]) || "universal",
            sensitivity: "internal",
            category: (p.meta.category as ExperienceFrontmatter["category"]) || "knowledge",
            tags,
            ...(p.meta.title && { title: p.meta.title }),
            confidence: 0.7,
            source: "observation",
            source_cli: "harvest",
            created: date,
            updated: date,
            used: 0,
          };
          writeExperience(meta, p.content);
          fs.unlinkSync(path.join(pendingDir, p.file));
          approved++;
        } else if (verdict === "reject" && !opts.dryRun) {
          fs.unlinkSync(path.join(pendingDir, p.file));
          rejected++;
        } else if (verdict === "uncertain") {
          uncertain++;
        } else if (opts.dryRun) {
          if (verdict === "approve") approved++;
          else if (verdict === "reject") rejected++;
          else uncertain++;
        }

        const icon = verdict === "approve" ? "✅" : verdict === "reject" ? "❌" : "❓";
        console.log(`  ${icon} ${verdict}: ${p.content.slice(0, 60)}... ${reason ? `(${reason})` : ""}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
      uncertain += batch.length;
    }
  }

  console.log(`\nResults: ✅ ${approved} approved, ❌ ${rejected} rejected, ❓ ${uncertain} uncertain`);
  if (opts.dryRun) {
    console.log("🔍 Dry run — no changes made. Run without --dry-run to apply.\n");
  } else if (uncertain > 0) {
    console.log(`Run 'skillseed harvest --review' to handle ${uncertain} uncertain experience(s).\n`);
  }

  return { approved, rejected, uncertain };
}

const TITLE_PROMPT = `Generate a short title (max 50 chars) for each experience below. Output one JSON object per line with "num" (the line number) and "title" fields.

Title rules: 中文为主，仅技术专有名词保留英文。格式：[技术栈/模块] 现象与方案。

Example output:
{"num": 1, "title": "[Graph API] 复用Bot凭据获取Token"}
{"num": 2, "title": "[Playwright] overlay弹窗阻塞点击的处理"}
{"num": 3, "title": "[Git] commit message规范与模板配置"}

Experiences:
`;

export function backfillTitles(opts: { dryRun?: boolean; brainCli?: string } = {}): { total: number; updated: number } {
  const brainCli = opts.brainCli || "claude";
  const all = listAllExperiences();
  const needTitle = all.filter(e => !e.meta.title);

  if (needTitle.length === 0) {
    console.log("All experiences already have titles.");
    return { total: all.length, updated: 0 };
  }

  console.log(`Found ${needTitle.length}/${all.length} experiences without titles.\n`);

  let updated = 0;
  const BATCH = 15;

  for (let i = 0; i < needTitle.length; i += BATCH) {
    const batch = needTitle.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(needTitle.length / BATCH);
    console.log(`[${batchNum}/${totalBatches}] Generating titles for ${batch.length} experiences...`);

    const expLines = batch.map((e, idx) =>
      `${idx + 1}. ${e.content.slice(0, 150)}`
    ).join("\n");

    const prompt = TITLE_PROMPT + expLines;

    try {
      let output: string;
      if (brainCli === "claude") {
        output = execFileSync("claude", ["-p", "--bare"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      } else {
        output = execFileSync(brainCli, ["-p"], {
          encoding: "utf-8",
          timeout: 180_000,
          input: prompt,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        }).trim();
      }

      const titles = new Map<number, string>();
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const obj = JSON.parse(trimmed);
          const num = obj.num ?? obj.id;
          if (num !== undefined && obj.title) {
            titles.set(Number(num), obj.title.slice(0, 50));
          }
        } catch { /* skip */ }
      }

      for (let idx = 0; idx < batch.length; idx++) {
        const title = titles.get(idx + 1);
        if (!title) continue;

        const exp = batch[idx];
        if (opts.dryRun) {
          console.log(`  ${exp.id}: "${title}"`);
        } else {
          const raw = fs.readFileSync(exp.filePath, "utf-8");
          const parsed = matter(raw);
          parsed.data.title = title;
          fs.writeFileSync(exp.filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
        }
        updated++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
    }
  }

  if (opts.dryRun) {
    console.log(`\n🔍 Dry run: would update ${updated} titles. Run without --dry-run to apply.`);
  } else {
    console.log(`\n✅ Updated ${updated} titles.`);
  }
  return { total: all.length, updated };
}

export function exportExperiences(outPath: string): void {
  const all = listAllExperiences();
  if (all.length === 0) {
    console.log("No experiences to export.");
    return;
  }

  const groups: Record<string, typeof all> = {};
  for (const e of all) {
    const scope = e.meta.scope || "unknown";
    (groups[scope] ??= []).push(e);
  }

  const lines: string[] = [
    "# Skillseed Experiences Export",
    "",
    `Total: ${all.length} experiences`,
    "",
  ];

  for (const scope of Object.keys(groups).sort()) {
    const exps = groups[scope];
    lines.push(`## ${scope} (${exps.length})`, "");
    for (const e of exps) {
      const title = e.meta.title || e.content.split("\n")[0].slice(0, 80);
      const tags = (e.meta.tags || []).join(", ");
      const cat = e.meta.category || "";
      lines.push(
        `### ${title}`,
        "",
        `- **Category:** ${cat}${tags ? ` | **Tags:** ${tags}` : ""}`,
        `- **Created:** ${e.meta.created || ""} | **Sensitivity:** ${e.meta.sensitivity || ""}`,
        "",
        e.content,
        "",
        "---",
        "",
      );
    }
  }

  const resolved = path.resolve(outPath);
  fs.writeFileSync(resolved, lines.join("\n"), "utf-8");
  const sizeKB = (fs.statSync(resolved).size / 1024).toFixed(1);
  console.log(`✅ Exported ${all.length} experiences to ${resolved} (${sizeKB} KB)`);
}

export function sanitizeAll(opts: { dryRun?: boolean } = {}): { scanned: number; updated: number } {
  const all = listAllExperiences();
  let updated = 0;

  for (const e of all) {
    const cleaned = sanitizeContent(e.content);
    if (cleaned !== e.content) {
      updated++;
      if (opts.dryRun) {
        console.log(`  🔍 ${e.id}`);
        // Show diff: find changed parts
        const lines = e.content.split("\n");
        const cleanedLines = cleaned.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] !== cleanedLines[i]) {
            console.log(`     - ${lines[i].slice(0, 100)}`);
            console.log(`     + ${cleanedLines[i].slice(0, 100)}`);
          }
        }
      } else {
        const raw = fs.readFileSync(e.filePath, "utf-8");
        const parsed = matter(raw);
        fs.writeFileSync(e.filePath, matter.stringify(cleaned, parsed.data), "utf-8");
        console.log(`  ✅ ${e.id}`);
      }
    }
  }

  if (opts.dryRun) {
    console.log(`\n🔍 Dry run: would sanitize ${updated} / ${all.length} experiences.`);
  } else {
    console.log(`\n✅ Sanitized ${updated} / ${all.length} experiences.`);
  }
  return { scanned: all.length, updated };
}

const RECLASSIFY_PROMPT = `Reclassify the scope of each experience below. Output one JSON object per line with "num" and "scope" fields.

Scope rules (STRICT):
- "universal": ONLY generic engineering principles with NO specific tool/framework/language. Example: "Git commit规范", "代码review原则"
- "domain": About specific PUBLIC technologies anyone can use. Example: "Azure AD", "React hooks", "npm", "Playwright", "Python"
- "project": About OUR internal projects/repos. Example: "Super-Agent-OS", "CTA bot", "OpenClaw", "skillseed"
- "company": Internal team/org processes, company-specific configs
- "personal": User preferences or personal traits

If the current scope is already correct, still output it. Output ALL items.

Experiences:
`;

export function reclassify(opts: { dryRun?: boolean; brainCli?: string } = {}): { total: number; updated: number } {
  const brainCli = opts.brainCli || "claude";
  const all = listAllExperiences();
  const BATCH = 15;
  let updated = 0;

  console.log(`Reclassifying ${all.length} experiences...\n`);

  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(all.length / BATCH);
    console.log(`[${batchNum}/${totalBatches}] Reclassifying ${batch.length} experiences...`);

    const expLines = batch.map((e, idx) =>
      `${idx + 1}. [current: ${e.meta.scope}] ${e.content.slice(0, 150)}`
    ).join("\n");

    const prompt = RECLASSIFY_PROMPT + expLines;

    try {
      let output: string;
      if (brainCli === "claude") {
        output = execFileSync("claude", ["-p", "--bare"], {
          encoding: "utf-8", timeout: 120_000, input: prompt,
          stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
        }).trim();
      } else {
        output = execFileSync(brainCli, ["-p"], {
          encoding: "utf-8", timeout: 120_000, input: prompt,
          stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
        }).trim();
      }

      const scopes = new Map<number, string>();
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const obj = JSON.parse(trimmed);
          const num = obj.num ?? obj.id;
          if (num !== undefined && obj.scope) {
            scopes.set(Number(num), obj.scope);
          }
        } catch { /* skip */ }
      }

      for (let idx = 0; idx < batch.length; idx++) {
        const newScope = scopes.get(idx + 1);
        if (!newScope || newScope === batch[idx].meta.scope) continue;

        updated++;
        if (opts.dryRun) {
          console.log(`  ${batch[idx].id}: ${batch[idx].meta.scope} → ${newScope}`);
        } else {
          const raw = fs.readFileSync(batch[idx].filePath, "utf-8");
          const parsed = matter(raw);
          parsed.data.scope = newScope;
          fs.writeFileSync(batch[idx].filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
          // Move file to correct scope directory
          moveExperienceScope(batch[idx].filePath, parsed.data as ExperienceFrontmatter);
          console.log(`  ✅ ${batch[idx].id}: ${batch[idx].meta.scope} → ${newScope}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
    }
  }

  if (opts.dryRun) {
    console.log(`\n🔍 Dry run: would reclassify ${updated} / ${all.length} experiences.`);
  } else {
    console.log(`\n✅ Reclassified ${updated} / ${all.length} experiences.`);
  }
  return { total: all.length, updated };
}

// --- Dedup existing experiences ---

// Phase 0: Fix misclassified universal experiences before dedup
function fixScopeBeforeDedup(all: ReturnType<typeof listAllExperiences>): number {
  let fixed = 0;
  for (const exp of all) {
    if (exp.meta.scope !== "universal") continue;
    const tags = (exp.meta.tags || []).map(t => t.toLowerCase());
    if (tags.some(t => UNIVERSAL_BLOCKLIST.has(t))) {
      updateExperienceMeta(exp.filePath, { scope: "domain" });
      moveExperienceScope(exp.filePath, { ...exp.meta, scope: "domain" } as ExperienceFrontmatter);
      fixed++;
    }
  }
  return fixed;
}

// Phase 1: Jaccard-based fast clustering (unchanged logic)
function findDupClusters(all: ReturnType<typeof listAllExperiences>): Array<number[]> {
  const n = all.length;
  const tokens = all.map(e => tokenize(e.content));
  const tagSets = all.map(e => new Set(e.meta.tags || []));
  const visited = new Set<number>();
  const clusters: Array<number[]> = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    const cluster = [i];
    visited.add(i);
    for (let j = i + 1; j < n; j++) {
      if (visited.has(j)) continue;
      // Check similarity against any member in the cluster
      for (const k of cluster) {
        const textSim = jaccardSimilarity(tokens[k], tokens[j]);
        // Tag overlap
        let tagOverlap = 0;
        for (const t of tagSets[k]) if (tagSets[j].has(t)) tagOverlap++;
        const tagSim = Math.min(tagSets[k].size, tagSets[j].size) === 0 ? 0 : tagOverlap / Math.min(tagSets[k].size, tagSets[j].size);

        if (textSim > 0.3 || (textSim > 0.2 && tagSim >= 0.6)) {
          cluster.push(j);
          visited.add(j);
          break;
        }
      }
    }
    if (cluster.length > 1) clusters.push(cluster);
  }
  return clusters;
}

// --- Shared: LLM call helper ---

function callLlm(prompt: string, brainCli: string, timeout = 60_000): string {
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

function parseLlmJson(output: string): unknown {
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

type Experience = ReturnType<typeof listAllExperiences>[0];

// --- Shared: merge a cluster of experiences via LLM ---

function mergeCluster(exps: Experience[], brainCli: string, dryRun?: boolean): { merged: boolean; deleted: number; title?: string } {
  for (const e of exps) {
    console.log(`  - ${(e.meta.title || e.content).slice(0, 80)}`);
  }

  if (dryRun) return { merged: true, deleted: exps.length - 1 };

  const expText = exps.map((e, i) =>
    `${i + 1}. [${e.meta.scope}] [tags: ${e.meta.tags.join(",")}] ${e.content}`
  ).join("\n");

  try {
    const output = callLlm(MERGE_PROMPT + expText, brainCli);
    const mergedObj = parseLlmJson(output) as { title?: string; content?: string; scope?: string; tags?: string[] } | null;

    if (!mergedObj?.content) {
      console.log("  ⚠️ LLM merge failed, skipping cluster");
      return { merged: false, deleted: 0 };
    }

    const keeper = exps[0];
    const raw = fs.readFileSync(keeper.filePath, "utf-8");
    const parsed = matter(raw);
    parsed.data.title = (mergedObj.title || "").replace(/^["']|["']$/g, "").trim().slice(0, 50);
    parsed.data.scope = mergedObj.scope || keeper.meta.scope;
    parsed.data.tags = mergedObj.tags || keeper.meta.tags;
    fs.writeFileSync(keeper.filePath, matter.stringify(mergedObj.content, parsed.data), "utf-8");
    moveExperienceScope(keeper.filePath, parsed.data as ExperienceFrontmatter);

    for (let k = 1; k < exps.length; k++) {
      try { fs.unlinkSync(exps[k].filePath); } catch { /* already gone */ }
    }

    console.log(`  ✅ Merged → "${parsed.data.title}" (deleted ${exps.length - 1} duplicates)`);
    return { merged: true, deleted: exps.length - 1, title: parsed.data.title as string };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
    return { merged: false, deleted: 0 };
  }
}

// --- Phase 2: LLM Semantic Clustering ---

const CLUSTER_PROMPT = `你是经验去重专家。以下是同一领域的多条经验记录，请识别其中**语义上重复或高度相关**的条目。

判断标准：
- 描述同一个技术问题/解决方案的不同表述 → 重复
- 描述同一个最佳实践的不同角度 → 重复
- 描述同一个工具的不同功能/场景 → 不重复
- 一条是另一条的子集 → 重复（合并到更完整的那条）

## 工作步骤

1. 逐条阅读每个经验，用一句话概括其核心知识点
2. 对比所有概括，找出描述同一知识点的条目
3. 输出结果

## 输出格式（严格 JSON）

{
  "reasoning": [
    "条目1和条目4都在说：异常处理不应该静默吞错",
    "条目2和条目5和条目7都在说：npm从GitHub安装的tgz方案"
  ],
  "clusters": [[1,4], [2,5,7]]
}

- reasoning: 每组合并的理由（一句话说明共同知识点）
- clusters: 应合并的编号分组，每组至少2个编号
- 如果全部不重复，输出 {"reasoning": [], "clusters": []}
- 只输出 JSON，不要其他文字

条目列表：
`;

function buildTagGroups(all: Experience[]): Experience[][] {
  // Build tag → index inverted index (excluding stopwords)
  const tagIndex = new Map<string, number[]>();
  for (let i = 0; i < all.length; i++) {
    for (const tag of all[i].meta.tags || []) {
      const key = tag.toLowerCase();
      if (TAG_STOPWORDS.has(key)) continue;
      if (!tagIndex.has(key)) tagIndex.set(key, []);
      tagIndex.get(key)!.push(i);
    }
  }

  // Union-Find
  const parent = all.map((_, i) => i);
  function find(x: number): number { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  for (const indices of tagIndex.values()) {
    for (let i = 1; i < indices.length; i++) {
      union(indices[0], indices[i]);
    }
  }

  // Collect connected components
  const components = new Map<number, number[]>();
  for (let i = 0; i < all.length; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(i);
  }

  // Split large components by scope; filter size < 3
  const groups: Experience[][] = [];
  for (const indices of components.values()) {
    if (indices.length < 3) continue;
    if (indices.length <= 15) {
      groups.push(indices.map(i => all[i]));
    } else {
      const byScope = new Map<string, Experience[]>();
      for (const i of indices) {
        const scope = all[i].meta.scope;
        if (!byScope.has(scope)) byScope.set(scope, []);
        byScope.get(scope)!.push(all[i]);
      }
      for (const subGroup of byScope.values()) {
        if (subGroup.length >= 3) groups.push(subGroup);
      }
    }
  }
  return groups;
}

function llmCluster(exps: Experience[], brainCli: string): { reasoning: string[]; clusters: number[][] } {
  const expText = exps.map((e, i) =>
    `${i + 1}. [${e.meta.scope}] [tags: ${(e.meta.tags || []).join(",")}] ${(e.meta.title || e.content).slice(0, 120)}`
  ).join("\n");

  const output = callLlm(CLUSTER_PROMPT + expText, brainCli, 90_000);
  const parsed = parseLlmJson(output) as { reasoning?: string[]; clusters?: number[][] } | null;

  if (!parsed?.clusters || !Array.isArray(parsed.clusters)) {
    return { reasoning: [], clusters: [] };
  }

  // Validate: filter out invalid indices
  const valid = parsed.clusters
    .filter(c => Array.isArray(c) && c.length >= 2)
    .map(c => c.filter(n => typeof n === "number" && n >= 1 && n <= exps.length));

  return {
    reasoning: parsed.reasoning || [],
    clusters: valid.filter(c => c.length >= 2),
  };
}

function semanticDedup(
  all: Experience[],
  brainCli: string,
  opts: { dryRun?: boolean }
): { clusters: number; merged: number; deleted: number } {
  const groups = buildTagGroups(all);
  console.log(`\n🧠 Phase 2: Semantic clustering (${groups.length} tag-groups, ${groups.reduce((s, g) => s + g.length, 0)} experiences)`);

  let totalClusters = 0;
  let totalMerged = 0;
  let totalDeleted = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const sampleTags = [...new Set(group.flatMap(e => e.meta.tags || []))].slice(0, 5).join(",");
    process.stdout.write(`  [${gi + 1}/${groups.length}] ${group.length} items (${sampleTags})... `);

    try {
      const { reasoning, clusters } = llmCluster(group, brainCli);
      if (clusters.length === 0) {
        console.log("no duplicates");
        continue;
      }

      console.log(`${clusters.length} cluster(s) found`);
      for (let ci = 0; ci < clusters.length; ci++) {
        const indices = clusters[ci];
        if (reasoning[ci]) console.log(`    💡 ${reasoning[ci]}`);
        const clusterExps = indices.map(n => group[n - 1]).filter(Boolean);
        if (clusterExps.length < 2) continue;

        console.log(`    Cluster (${clusterExps.length} items):`);
        const result = mergeCluster(clusterExps, brainCli, opts.dryRun);
        totalClusters++;
        if (result.merged) {
          totalMerged++;
          totalDeleted += result.deleted;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`failed: ${msg.slice(0, 60)}`);
    }
  }

  return { clusters: totalClusters, merged: totalMerged, deleted: totalDeleted };
}

// --- Main dedup entry ---

export function dedup(opts: { dryRun?: boolean; brainCli?: string; jaccard?: boolean; semantic?: boolean } = {}): { clusters: number; merged: number; deleted: number } {
  const brainCli = opts.brainCli || "claude";
  const runJaccard = !opts.semantic; // skip jaccard only if --semantic explicitly set
  const runSemantic = !opts.jaccard; // skip semantic only if --jaccard explicitly set

  let totalClusters = 0;
  let totalMerged = 0;
  let totalDeleted = 0;

  // Phase 0: Fix misclassified scopes
  const all = listAllExperiences();
  const scopeFixed = fixScopeBeforeDedup(all);
  if (scopeFixed > 0) {
    console.log(`📎 Phase 0: ${scopeFixed} universal → domain (scope corrected)`);
  }

  // Phase 1: Jaccard fast clustering
  if (runJaccard) {
    const freshAll = listAllExperiences();
    const clusters = findDupClusters(freshAll);
    console.log(`\n⚡ Phase 1: Jaccard — ${clusters.length} duplicate clusters in ${freshAll.length} experiences`);

    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      const exps = cluster.map(i => freshAll[i]);
      console.log(`\n  [${ci + 1}/${clusters.length}] Cluster (${cluster.length} items):`);
      const result = mergeCluster(exps, brainCli, opts.dryRun);
      totalClusters++;
      if (result.merged) {
        totalMerged++;
        totalDeleted += result.deleted;
      }
    }
  }

  // Phase 2: LLM semantic clustering
  if (runSemantic) {
    const freshAll = listAllExperiences();
    const result = semanticDedup(freshAll, brainCli, { dryRun: opts.dryRun });
    totalClusters += result.clusters;
    totalMerged += result.merged;
    totalDeleted += result.deleted;
  }

  // Summary
  if (opts.dryRun) {
    console.log(`\n🔍 Dry run: would merge ${totalMerged} clusters, delete ${totalDeleted} duplicates.`);
  } else {
    const remaining = listAllExperiences().length;
    console.log(`\n✅ Total: ${totalMerged} clusters merged, ${totalDeleted} deleted. ${remaining} experiences remaining.`);
  }
  return { clusters: totalClusters, merged: totalMerged, deleted: totalDeleted };
}
