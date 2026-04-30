/**
 * Harvest tools — backfillTitles, exportExperiences, sanitizeAll, reclassify.
 * Batch operations on existing experiences.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { listAllExperiences, sanitizeContent, moveExperienceScope } from "../store/file-store.js";
import { callLlm } from "./llm.js";
import { buildTitlePrompt, buildReclassifyPrompt } from "./prompts.js";
export function backfillTitles(opts = {}) {
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
        const expLines = batch.map((e, idx) => `${idx + 1}. ${e.content.slice(0, 150)}`).join("\n");
        try {
            const output = callLlm(buildTitlePrompt(expLines), brainCli, 180_000);
            const titles = new Map();
            for (const line of output.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("{"))
                    continue;
                try {
                    const obj = JSON.parse(trimmed);
                    const num = obj.num ?? obj.id;
                    if (num !== undefined && obj.title) {
                        titles.set(Number(num), obj.title.slice(0, 50));
                    }
                }
                catch { /* skip */ }
            }
            for (let idx = 0; idx < batch.length; idx++) {
                const title = titles.get(idx + 1);
                if (!title)
                    continue;
                const exp = batch[idx];
                if (opts.dryRun) {
                    console.log(`  ${exp.id}: "${title}"`);
                }
                else {
                    const raw = fs.readFileSync(exp.filePath, "utf-8");
                    const parsed = matter(raw);
                    parsed.data.title = title;
                    fs.writeFileSync(exp.filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
                }
                updated++;
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
        }
    }
    if (opts.dryRun) {
        console.log(`\n🔍 Dry run: would update ${updated} titles. Run without --dry-run to apply.`);
    }
    else {
        console.log(`\n✅ Updated ${updated} titles.`);
    }
    return { total: all.length, updated };
}
export function exportExperiences(outPath) {
    const all = listAllExperiences();
    if (all.length === 0) {
        console.log("No experiences to export.");
        return;
    }
    const groups = {};
    for (const e of all) {
        const scope = e.meta.scope || "unknown";
        (groups[scope] ??= []).push(e);
    }
    const lines = [
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
            lines.push(`### ${title}`, "", `- **Category:** ${cat}${tags ? ` | **Tags:** ${tags}` : ""}`, `- **Created:** ${e.meta.created || ""} | **Sensitivity:** ${e.meta.sensitivity || ""}`, "", e.content, "", "---", "");
        }
    }
    const resolved = path.resolve(outPath);
    fs.writeFileSync(resolved, lines.join("\n"), "utf-8");
    const sizeKB = (fs.statSync(resolved).size / 1024).toFixed(1);
    console.log(`✅ Exported ${all.length} experiences to ${resolved} (${sizeKB} KB)`);
}
export function sanitizeAll(opts = {}) {
    const all = listAllExperiences();
    let updated = 0;
    for (const e of all) {
        const cleaned = sanitizeContent(e.content);
        if (cleaned !== e.content) {
            updated++;
            if (opts.dryRun) {
                console.log(`  🔍 ${e.id}`);
                const lines = e.content.split("\n");
                const cleanedLines = cleaned.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i] !== cleanedLines[i]) {
                        console.log(`     - ${lines[i].slice(0, 100)}`);
                        console.log(`     + ${cleanedLines[i].slice(0, 100)}`);
                    }
                }
            }
            else {
                const raw = fs.readFileSync(e.filePath, "utf-8");
                const parsed = matter(raw);
                fs.writeFileSync(e.filePath, matter.stringify(cleaned, parsed.data), "utf-8");
                console.log(`  ✅ ${e.id}`);
            }
        }
    }
    if (opts.dryRun) {
        console.log(`\n🔍 Dry run: would sanitize ${updated} / ${all.length} experiences.`);
    }
    else {
        console.log(`\n✅ Sanitized ${updated} / ${all.length} experiences.`);
    }
    return { scanned: all.length, updated };
}
export function reclassify(opts = {}) {
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
        const expLines = batch.map((e, idx) => `${idx + 1}. [current: ${e.meta.scope}] ${e.content.slice(0, 150)}`).join("\n");
        try {
            const output = callLlm(buildReclassifyPrompt(expLines), brainCli, 120_000);
            const scopes = new Map();
            for (const line of output.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("{"))
                    continue;
                try {
                    const obj = JSON.parse(trimmed);
                    const num = obj.num ?? obj.id;
                    if (num !== undefined && obj.scope) {
                        scopes.set(Number(num), obj.scope);
                    }
                }
                catch { /* skip */ }
            }
            for (let idx = 0; idx < batch.length; idx++) {
                const newScope = scopes.get(idx + 1);
                if (!newScope || newScope === batch[idx].meta.scope)
                    continue;
                updated++;
                if (opts.dryRun) {
                    console.log(`  ${batch[idx].id}: ${batch[idx].meta.scope} → ${newScope}`);
                }
                else {
                    const raw = fs.readFileSync(batch[idx].filePath, "utf-8");
                    const parsed = matter(raw);
                    parsed.data.scope = newScope;
                    fs.writeFileSync(batch[idx].filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
                    moveExperienceScope(batch[idx].filePath, parsed.data);
                    console.log(`  ✅ ${batch[idx].id}: ${batch[idx].meta.scope} → ${newScope}`);
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ⚠️ LLM failed: ${msg.slice(0, 80)}`);
        }
    }
    if (opts.dryRun) {
        console.log(`\n🔍 Dry run: would reclassify ${updated} / ${all.length} experiences.`);
    }
    else {
        console.log(`\n✅ Reclassified ${updated} / ${all.length} experiences.`);
    }
    return { total: all.length, updated };
}
//# sourceMappingURL=tools.js.map