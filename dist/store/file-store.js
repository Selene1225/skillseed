/**
 * Markdown file store with frontmatter — primary storage for experiences and preferences.
 * Git-friendly: each experience = one .md file with YAML frontmatter.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
export function getSkillseedDir() {
    return path.join(os.homedir(), ".skillseed");
}
export function getExperiencesDir() {
    return path.join(getSkillseedDir(), "experiences");
}
export function getSkillsDir() {
    return path.join(getSkillseedDir(), "skills");
}
function generateSlug(content) {
    // Take first 50 chars, lowercase, replace non-alphanumeric with dashes
    const raw = content.slice(0, 50).toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-|-$/g, "");
    return raw || "experience";
}
function randomSuffix() {
    return Math.random().toString(36).slice(2, 6);
}
function scopeToDir(meta) {
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
export function writeExperience(meta, content) {
    const dir = path.join(getExperiencesDir(), scopeToDir(meta));
    fs.mkdirSync(dir, { recursive: true });
    // Dedup: skip if identical content already exists in this scope
    const trimmed = content.trim();
    if (isDuplicate(dir, trimmed)) {
        // Return existing experience instead of creating duplicate
        const existing = findByContent(dir, trimmed);
        return existing;
    }
    const date = new Date().toISOString().slice(0, 10);
    const slug = generateSlug(content);
    const rand = randomSuffix();
    const filename = `${date}-${slug}-${rand}.md`;
    const filePath = path.join(dir, filename);
    const fileContent = matter.stringify(trimmed + "\n", meta);
    fs.writeFileSync(filePath, fileContent, "utf-8");
    const id = path.relative(getExperiencesDir(), filePath).replace(/\\/g, "/");
    return { id, meta, content: trimmed, filePath };
}
function isDuplicate(dir, content) {
    return findByContent(dir, content) !== null;
}
function findByContent(dir, content) {
    if (!fs.existsSync(dir))
        return null;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md"))
            continue;
        const fp = path.join(dir, file);
        const exp = readExperience(fp);
        if (exp && exp.content === content)
            return exp;
    }
    return null;
}
export function readExperience(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data, content } = matter(raw);
        const id = path.relative(getExperiencesDir(), filePath).replace(/\\/g, "/");
        return {
            id,
            meta: data,
            content: content.trim(),
            filePath,
        };
    }
    catch {
        return null;
    }
}
export function updateExperienceMeta(filePath, updates) {
    const exp = readExperience(filePath);
    if (!exp)
        return;
    const merged = { ...exp.meta, ...updates, updated: new Date().toISOString().slice(0, 10) };
    const newMeta = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    const fileContent = matter.stringify(exp.content + "\n", newMeta);
    fs.writeFileSync(filePath, fileContent, "utf-8");
}
export function listAllExperiences() {
    const results = [];
    if (!fs.existsSync(getExperiencesDir()))
        return results;
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.name.endsWith(".md")) {
                const exp = readExperience(full);
                if (exp)
                    results.push(exp);
            }
        }
    }
    walk(getExperiencesDir());
    return results;
}
/** Search experiences — interface designed for future index swap */
export function search(opts) {
    const all = listAllExperiences();
    let scored = [];
    for (const exp of all) {
        let score = 0;
        // Tag matching
        if (opts.tags && opts.tags.length > 0) {
            const matched = opts.tags.filter(t => exp.meta.tags.some(et => et.toLowerCase() === t.toLowerCase()));
            score += matched.length * 20;
        }
        // Keyword matching (query against content + tags)
        if (opts.query) {
            const q = opts.query.toLowerCase();
            const words = q.split(/\s+/).filter(Boolean);
            for (const w of words) {
                if (exp.content.toLowerCase().includes(w))
                    score += 10;
                if (exp.meta.tags.some(t => t.toLowerCase().includes(w)))
                    score += 15;
            }
        }
        // Scope filtering
        if (opts.scope && exp.meta.scope !== opts.scope) {
            continue; // skip non-matching scope
        }
        // Boost by usage and recency (only if already matched by query/tags)
        if (score > 0) {
            if (exp.meta.category === "correction")
                score *= 1.5;
            score += Math.min(exp.meta.used, 10);
            score += exp.meta.confidence * 5;
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
        const budgeted = [];
        for (const r of scored) {
            const estTokens = Math.ceil(r.experience.content.length / 4) + 30; // 30 for metadata
            if (totalTokens + estTokens > opts.maxTokens)
                break;
            totalTokens += estTokens;
            budgeted.push(r);
        }
        return budgeted;
    }
    return scored;
}
/** Format experience as summary line (~30-50 tokens) */
export function formatSummary(exp) {
    const scopeTag = `[${exp.meta.scope}${exp.meta.company ? ":" + exp.meta.company : ""}]`;
    const tags = exp.meta.tags.length > 0 ? ` [${exp.meta.tags.join(",")}]` : "";
    const firstLine = exp.content.split("\n")[0].slice(0, 120);
    return `${scopeTag}${tags} ${firstLine} (confidence:${exp.meta.confidence} | used:${exp.meta.used} | ${exp.meta.created})`;
}
/** Format experience as full detail */
export function formatDetail(exp) {
    return matter.stringify(exp.content + "\n", exp.meta);
}
// Preferences stored as personal-scope experiences with category=preference
export function getPreference(key) {
    const all = listAllExperiences();
    const pref = all.find(e => e.meta.category === "preference" && e.meta.scope === "personal" &&
        e.content.startsWith(`${key}: `));
    return pref ? pref.content.slice(key.length + 2).trim() : null;
}
export function getAllPreferences() {
    const all = listAllExperiences();
    const prefs = {};
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
export function setPreference(key, value) {
    // Check if preference already exists
    const all = listAllExperiences();
    const existing = all.find(e => e.meta.category === "preference" && e.meta.scope === "personal" &&
        e.content.startsWith(`${key}: `));
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
//# sourceMappingURL=file-store.js.map