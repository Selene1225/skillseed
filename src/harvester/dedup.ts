/**
 * Dedup engine — tokenization, Jaccard, Union-Find clustering, LLM semantic dedup.
 * Owns all duplicate detection logic; merges via LLM when duplicates found.
 */

import fs from "node:fs";
import matter from "gray-matter";
import { listAllExperiences, updateExperienceMeta, moveExperienceScope, type ExperienceFrontmatter } from "../store/file-store.js";
import { callLlm, parseLlmJson } from "./llm.js";
import { buildMergePrompt, buildClusterPrompt } from "./prompts.js";

// Re-export Experience type alias for convenience
export type Experience = ReturnType<typeof listAllExperiences>[0];

// Tags that force scope downgrade from universal → domain
export const UNIVERSAL_BLOCKLIST = new Set([
  "python", "azure", "npm", "playwright", "teams", "edge", "github", "windows",
  "sqlite", "react", "asyncio", "fastapi", "typescript", "node", "docker",
  "kubernetes", "redis", "postgresql", "mongodb", "nextjs", "vue", "angular",
  "django", "flask", "express", "graphql", "rest", "grpc", "terraform",
  "powershell", "bash", "linux", "macos", "chrome", "firefox", "safari",
  "webpack", "vite", "eslint", "jest", "vitest", "pytest", "junit",
]);

// High-frequency low-signal tags excluded from Union-Find graph edges
export const TAG_STOPWORDS = new Set([
  "bug", "fix", "error", "issue", "problem", "solution", "workaround",
  "debugging", "troubleshooting", "best-practice", "tip", "note",
  "configuration", "setup", "config",
]);

// --- Tokenization ---

export function tokenize(text: string): Set<string> {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const segments = Array.from(segmenter.segment(text.toLowerCase()));
  return new Set(
    segments
      .filter(s => s.isWordLike || /^[a-z0-9]+$/.test(s.segment))
      .map(s => s.segment)
      .filter(w => w.length > 1 || /[\u4e00-\u9fff]/.test(w))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Real-time dedup (used during harvest write) ---

export function isDuplicateExperience(newContent: string, newTags: string[]): { duplicate: boolean; similarExp?: Experience } {
  const existing = listAllExperiences();
  const newTokens = tokenize(newContent);
  const newTagSet = new Set(newTags);

  for (const e of existing) {
    const existingTagSet = new Set(e.meta.tags || []);
    let tagOverlap = 0;
    for (const t of newTagSet) if (existingTagSet.has(t)) tagOverlap++;
    const tagSim = newTagSet.size === 0 ? 0 : tagOverlap / Math.max(newTagSet.size, existingTagSet.size);

    const existingTokens = tokenize(e.content);
    const textSim = jaccardSimilarity(newTokens, existingTokens);

    if (textSim > 0.6 || (textSim > 0.4 && tagSim > 0.5)) {
      return { duplicate: true, similarExp: e };
    }
  }
  return { duplicate: false };
}

// --- Phase 0: Fix misclassified universal experiences ---

export function fixScopeBeforeDedup(all: Experience[]): number {
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

// --- Phase 1: Jaccard fast clustering ---

export function findDupClusters(all: Experience[]): Array<number[]> {
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
      for (const k of cluster) {
        const textSim = jaccardSimilarity(tokens[k], tokens[j]);
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

// --- Shared: merge a cluster of experiences via LLM ---

export function mergeCluster(exps: Experience[], brainCli: string, dryRun?: boolean): { merged: boolean; deleted: number; title?: string } {
  for (const e of exps) {
    console.log(`  - ${(e.meta.title || e.content).slice(0, 80)}`);
  }

  if (dryRun) return { merged: true, deleted: exps.length - 1 };

  const expText = exps.map((e, i) =>
    `${i + 1}. [${e.meta.scope}] [tags: ${e.meta.tags.join(",")}] ${e.content}`
  ).join("\n");

  try {
    const output = callLlm(buildMergePrompt(expText), brainCli);
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

    console.log(`  ✅ Merged → "${(mergedObj.title || "").slice(0, 50)}"`);
    return { merged: true, deleted: exps.length - 1, title: mergedObj.title };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️ Merge failed: ${msg.slice(0, 60)}`);
    return { merged: false, deleted: 0 };
  }
}

// --- Phase 2: Union-Find tag grouping ---

export function buildTagGroups(all: Experience[]): Experience[][] {
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

// --- Phase 2: LLM semantic clustering ---

function llmCluster(exps: Experience[], brainCli: string): { reasoning: string[]; clusters: number[][] } {
  const expText = exps.map((e, i) =>
    `${i + 1}. [${e.meta.scope}] [tags: ${(e.meta.tags || []).join(",")}] ${(e.meta.title || e.content).slice(0, 120)}`
  ).join("\n");

  const output = callLlm(buildClusterPrompt(expText), brainCli, 90_000);
  const parsed = parseLlmJson(output) as { reasoning?: string[]; clusters?: number[][] } | null;

  if (!parsed?.clusters || !Array.isArray(parsed.clusters)) {
    return { reasoning: [], clusters: [] };
  }

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
  const runJaccard = !opts.semantic;
  const runSemantic = !opts.jaccard;

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
