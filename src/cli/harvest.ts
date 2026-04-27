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
import { getSkillseedDir, writeExperience, listAllExperiences, type ExperienceFrontmatter } from "../store/file-store.js";

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
- content: one clear sentence describing the lesson, practice, or solution (max 200 chars)
- category: one of "good_practice", "problem", "correction", "knowledge"
- tags: array of 2-5 relevant topic tags (lowercase)
- scope: one of "universal", "project", "company", "personal"

Rules:
- Only extract NON-TRIVIAL, reusable insights
- Skip general knowledge anyone would know
- Skip tool usage instructions that are in documentation
- Focus on: mistakes made, corrections, workarounds, team conventions, debugging lessons
- Output ONLY JSON lines, no other text. If nothing worth extracting, output nothing.

Conversation:
`;

function extractWithLlm(chunk: ConversationChunk, brainCli: string): PendingExperience[] {
  const conversationText = chunk.turns
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
          results.push({
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

// --- Pending Storage ---

function getPendingDir(): string {
  return path.join(getSkillseedDir(), "pending");
}

function writePending(exp: PendingExperience): string {
  const dir = getPendingDir();
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const slug = exp.content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exp";
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `${date}-${slug}-${rand}.md`;
  const filePath = path.join(dir, filename);

  const frontmatter = [
    "---",
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
          writePending(exp);
          existingContent.push(exp.content); // prevent dups within batch
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
