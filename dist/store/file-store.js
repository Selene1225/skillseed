/**
 * Markdown file store with frontmatter — primary storage for experiences and preferences.
 * Git-friendly: each experience = one .md file with YAML frontmatter.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
// --- Secret sanitization ---
// Patterns that match real secrets; replacements use {{placeholder}} tokens.
// Users can extend via ~/.skillseed/sanitize.json
const BUILTIN_SANITIZE_RULES = [
    // GUIDs that look like tenant/client/app IDs (in context of auth keywords)
    { pattern: /(?<=(?:tenant|client|app)[\s_-]*(?:id)?[\s:=]*)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, placeholder: "{{tenant_or_app_id}}" },
    // API keys / tokens / secrets (key=value patterns)
    { pattern: /(?<=(?:api[_-]?key|secret|token|password|pwd|access[_-]?key)[\s:="']*)[A-Za-z0-9+\/_.~-]{20,}/gi, placeholder: "{{secret_value}}" },
    // Bearer tokens
    { pattern: /(?<=Bearer\s+)[A-Za-z0-9._~+\/=-]{20,}/gi, placeholder: "{{bearer_token}}" },
    // Connection strings
    { pattern: /(?<=(?:connection[_-]?string|conn[_-]?str)[\s:="']*)[^\s"']{30,}/gi, placeholder: "{{connection_string}}" },
];
let _sanitizeRules = null;
function getSanitizeRules() {
    if (_sanitizeRules)
        return _sanitizeRules;
    _sanitizeRules = [...BUILTIN_SANITIZE_RULES];
    // Load user-defined rules from ~/.skillseed/sanitize.json
    const customPath = path.join(getSkillseedDir(), "sanitize.json");
    if (fs.existsSync(customPath)) {
        try {
            const custom = JSON.parse(fs.readFileSync(customPath, "utf-8"));
            for (const r of custom) {
                _sanitizeRules.push({ pattern: new RegExp(r.pattern, r.flags || "g"), placeholder: r.placeholder });
            }
        }
        catch { /* ignore bad config */ }
    }
    return _sanitizeRules;
}
export function sanitizeContent(text) {
    let result = text;
    for (const rule of getSanitizeRules()) {
        result = result.replace(rule.pattern, rule.placeholder);
    }
    return result;
}
const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "am", "it", "its",
    "this", "that", "these", "those", "i", "you", "he", "she", "we", "they",
    "me", "him", "her", "us", "them", "my", "your", "his", "our", "their",
    "what", "which", "who", "whom", "how", "when", "where", "why",
    "and", "but", "or", "nor", "not", "no", "so", "if", "then", "else",
    "for", "of", "to", "in", "on", "at", "by", "with", "from", "into",
    "about", "as", "up", "out", "off", "over", "after", "before",
    "all", "each", "every", "both", "few", "more", "most", "some", "any",
    "just", "only", "very", "too", "also", "than", "now", "here", "there",
    "的", "了", "在", "是", "和", "有", "我", "你", "他", "她", "它", "们",
    "这", "那", "不", "也", "都", "就", "会", "要", "把", "被", "让", "给",
]);
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
    // Sanitize secrets before writing
    const sanitized = sanitizeContent(content.trim());
    if (isDuplicate(dir, sanitized)) {
        const existing = findByContent(dir, sanitized);
        return existing;
    }
    const date = new Date().toISOString().slice(0, 10);
    const slug = generateSlug(sanitized);
    const rand = randomSuffix();
    const filename = `${date}-${slug}-${rand}.md`;
    const filePath = path.join(dir, filename);
    const fileContent = matter.stringify(sanitized + "\n", meta);
    fs.writeFileSync(filePath, fileContent, "utf-8");
    const id = path.relative(getExperiencesDir(), filePath).replace(/\\/g, "/");
    return { id, meta, content: sanitized, filePath };
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
            const words = q.split(/\s+/).filter(Boolean).filter(w => w.length > 2 && !STOP_WORDS.has(w));
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
    const title = exp.meta.title || exp.content.split("\n")[0].slice(0, 120);
    return `${scopeTag}${tags} ${title}`;
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