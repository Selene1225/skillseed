/**
 * Harvest pipeline — scan, chunk, score, extract, write pending.
 * This is the only module with side effects (file I/O, LLM calls).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import { getSkillseedDir, listAllExperiences, moveExperienceScope } from "../store/file-store.js";
import { callLlm, parseLlmJson } from "./llm.js";
import { buildExtractPrompt, buildMergePrompt } from "./prompts.js";
import { isDuplicateExperience, UNIVERSAL_BLOCKLIST } from "./dedup.js";
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
const SKIP_PATTERNS = [
    /^ping$/i,
    /^(?:hi|hello|hey|你好|test)\s*$/i,
    /^(?:yes|no|y|n|ok|好|是|对)\s*$/i,
];
const GARBAGE_PATTERNS = [
    /Count test\b/i,
    /test\s+(?:alpha|beta|gamma|delta)\b/i,
    /test\s+\d{10,}/i,
    /\b(?:foo|bar|baz|lorem ipsum)\b/i,
    /^TODO:?\s*$/i,
    /^placeholder/i,
];
// --- JSONL Parsing ---
export function parseJsonlFile(filePath) {
    const turns = [];
    let content;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return turns;
    }
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const obj = JSON.parse(line);
            if (obj.type !== "user" && obj.type !== "assistant")
                continue;
            let text = "";
            const msg = obj.message;
            if (!msg?.content)
                continue;
            if (typeof msg.content === "string") {
                text = msg.content;
            }
            else if (Array.isArray(msg.content)) {
                text = msg.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n");
            }
            if (!text.trim())
                continue;
            turns.push({
                type: obj.type,
                text: text.trim(),
                timestamp: obj.timestamp || "",
                sessionId: obj.sessionId || "",
            });
        }
        catch {
            // skip malformed lines
        }
    }
    return turns;
}
function projectNameFromPath(filePath) {
    const parts = filePath.split(path.sep);
    const projIdx = parts.indexOf("projects");
    if (projIdx >= 0 && projIdx + 1 < parts.length) {
        const dirName = parts[projIdx + 1];
        const segments = dirName.split("-");
        return segments[segments.length - 1] || dirName;
    }
    return "unknown";
}
// --- Heuristic Filter ---
export function scoreChunk(chunk) {
    let score = 0;
    const fullText = chunk.turns.map(t => t.text).join("\n");
    for (const p of CORRECTION_PATTERNS)
        if (p.test(fullText))
            score += 30;
    for (const p of LESSON_PATTERNS)
        if (p.test(fullText))
            score += 25;
    for (const p of PROCESS_PATTERNS)
        if (p.test(fullText))
            score += 20;
    for (const p of SOLUTION_PATTERNS)
        if (p.test(fullText))
            score += 20;
    const wordCount = fullText.split(/\s+/).length;
    if (wordCount > 200)
        score += 10;
    if (wordCount > 500)
        score += 10;
    return score;
}
function isSkippable(text) {
    return SKIP_PATTERNS.some(p => p.test(text.trim()));
}
function isGarbage(text) {
    return GARBAGE_PATTERNS.some(p => p.test(text.trim()));
}
// --- Chunking ---
export function chunkConversation(turns, file, project) {
    const chunks = [];
    const CHUNK_SIZE = 20;
    const substantiveTurns = turns.filter(t => !isSkippable(t.text));
    if (substantiveTurns.length < 4)
        return chunks;
    for (let i = 0; i < substantiveTurns.length; i += CHUNK_SIZE) {
        const slice = substantiveTurns.slice(i, i + CHUNK_SIZE);
        if (slice.length >= 2) {
            chunks.push({ turns: slice, file, project });
        }
    }
    return chunks;
}
// --- LLM Extraction ---
function extractWithLlm(chunk, brainCli) {
    const conversationText = chunk.turns
        .filter(t => !isGarbage(t.text))
        .map(t => `[${t.type}]: ${t.text.slice(0, 1000)}`)
        .join("\n\n");
    const prompt = buildExtractPrompt(conversationText);
    const results = [];
    try {
        const output = callLlm(prompt, brainCli, 180_000);
        for (const line of output.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{"))
                continue;
            try {
                const obj = JSON.parse(trimmed);
                if (obj.content && obj.category) {
                    if (isGarbage(obj.content) || isGarbage(obj.title || "") || (obj.content.length < 15 && !obj.tags?.length))
                        continue;
                    if (obj.title)
                        obj.title = obj.title.replace(/^["']|["']$/g, "").trim();
                    if ((obj.scope || "universal") === "universal" && obj.tags?.some((t) => UNIVERSAL_BLOCKLIST.has(t.toLowerCase()))) {
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
            }
            catch { /* skip malformed JSON */ }
        }
    }
    catch (err) {
        const msg = err.message || "";
        if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
            console.error(`timeout (chunk too large, skipping)`);
        }
        else {
            console.error(`failed: ${msg.slice(0, 80)}`);
        }
    }
    return results;
}
// --- Pending Storage ---
export function getPendingDir() {
    return path.join(getSkillseedDir(), "pending");
}
export function writePending(exp, brainCli = "claude") {
    const { duplicate, similarExp } = isDuplicateExperience(exp.content, exp.tags);
    if (duplicate && similarExp) {
        const mergeInput = [
            `1. [${similarExp.meta.scope}] [tags: ${(similarExp.meta.tags || []).join(",")}] ${similarExp.content}`,
            `2. [${exp.scope}] [tags: ${exp.tags.join(",")}] ${exp.content}`,
        ].join("\n");
        try {
            const output = callLlm(buildMergePrompt(mergeInput), brainCli);
            const mergedObj = parseLlmJson(output);
            if (mergedObj?.content) {
                const raw = fs.readFileSync(similarExp.filePath, "utf-8");
                const parsed = matter(raw);
                if (mergedObj.title)
                    parsed.data.title = mergedObj.title.replace(/^["']|["']$/g, "").trim().slice(0, 50);
                parsed.data.scope = mergedObj.scope || similarExp.meta.scope;
                parsed.data.tags = mergedObj.tags || similarExp.meta.tags;
                parsed.data.updated = new Date().toISOString().slice(0, 10);
                fs.writeFileSync(similarExp.filePath, matter.stringify(mergedObj.content, parsed.data), "utf-8");
                moveExperienceScope(similarExp.filePath, parsed.data);
                return `merged:${similarExp.id}`;
            }
        }
        catch { /* merge failed, fall through to write as new */ }
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
export function listPending() {
    const dir = getPendingDir();
    if (!fs.existsSync(dir))
        return [];
    const results = [];
    for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".md"))
            continue;
        const filePath = path.join(dir, entry);
        const raw = fs.readFileSync(filePath, "utf-8");
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch)
            continue;
        const meta = {};
        for (const line of fmMatch[1].split("\n")) {
            const idx = line.indexOf(": ");
            if (idx > 0)
                meta[line.slice(0, idx)] = line.slice(idx + 2);
        }
        results.push({ file: entry, content: fmMatch[2].trim(), meta });
    }
    return results;
}
// --- Incremental Tracking ---
function getHarvestState() {
    const statePath = path.join(getSkillseedDir(), "harvest-state.json");
    try {
        return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
    catch {
        return {};
    }
}
function saveHarvestState(state) {
    const statePath = path.join(getSkillseedDir(), "harvest-state.json");
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}
function isDuplicate(content, existing) {
    const normalized = content.toLowerCase().trim();
    return existing.some(e => {
        const n = e.toLowerCase().trim();
        return n === normalized || n.includes(normalized) || normalized.includes(n);
    });
}
// --- File Discovery ---
export function discoverHistoryFiles() {
    const claudeProjects = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeProjects))
        return [];
    const results = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.name.endsWith(".jsonl")) {
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
// --- Main Harvest ---
export function harvest(opts = {}) {
    const brainCli = opts.brainCli || "claude";
    const minScore = opts.minScore ?? 20;
    const maxFiles = opts.maxFiles ?? 0;
    const allFiles = discoverHistoryFiles();
    const files = maxFiles > 0 ? allFiles.slice(0, maxFiles) : allFiles;
    const state = getHarvestState();
    const existingContent = listAllExperiences().map(e => e.content);
    let scanned = 0;
    let extracted = 0;
    console.log(`\n🌾 Harvesting from ${files.length} conversation files...\n`);
    for (const f of files) {
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
                }
                else {
                    const written = writePending(exp, brainCli);
                    if (!written)
                        continue;
                    if (written.startsWith("merged:")) {
                        console.log(`     ↗ merged into existing: ${written.slice(7).slice(0, 60)}`);
                    }
                    existingContent.push(exp.content);
                }
                extracted++;
                chunkNew++;
            }
            if (!opts.dryRun)
                console.log(`${chunkNew} experience(s)`);
        }
        state[f.file] = f.mtime;
        if (!opts.dryRun)
            saveHarvestState(state);
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
//# sourceMappingURL=pipeline.js.map