/**
 * Review — interactive, auto-review, approve-all for pending experiences.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { writeExperience, listAllExperiences, type ExperienceFrontmatter } from "../store/file-store.js";
import { callLlm } from "./llm.js";
import { buildReviewPrompt } from "./prompts.js";
import { getPendingDir, listPending } from "./pipeline.js";

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
        ...(p.meta.project && { project: p.meta.project }),
        confidence: 0.7,
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
      ...(p.meta.project && { project: p.meta.project }),
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

  const existing = listAllExperiences();
  let approved = 0, rejected = 0, uncertain = 0;

  const BATCH = 15;
  const pendingDir = getPendingDir();

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(pending.length / BATCH);
    console.log(`[${batchNum}/${totalBatches}] Reviewing ${batch.length} experiences...`);

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

    try {
      const output = callLlm(buildReviewPrompt(existingSection, pendingSection), brainCli, 180_000);

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
          let tags: string[];
          try { tags = JSON.parse(p.meta.tags || "[]"); }
          catch { tags = p.meta.tags?.replace(/[\[\]"]/g, "").split(",").map((t: string) => t.trim()).filter(Boolean) || []; }

          const meta: ExperienceFrontmatter = {
            scope: (p.meta.scope as ExperienceFrontmatter["scope"]) || "universal",
            sensitivity: "internal",
            category: (p.meta.category as ExperienceFrontmatter["category"]) || "knowledge",
            tags,
            ...(p.meta.title && { title: p.meta.title }),
            ...(p.meta.project && { project: p.meta.project }),
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
