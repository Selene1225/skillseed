/**
 * Sync module — git-based experience sync across devices via GitHub.
 * Handles: setupSync (init step 6), manual sync, stageChanges, batchCommitAndPush,
 * and sensitive file filtering.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import matter from "gray-matter";
import { getSkillseedDir, getExperiencesDir } from "../store/file-store.js";
import { createInterface } from "node:readline";

const MARKER_FILE = ".skillseed-marker";
const CONVENTIONAL_REPO = "skillseed-vault";
const SENSITIVE_LEVELS = ["confidential", "private"];

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd: cwd ?? getSkillseedDir(),
    timeout: 30_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function ghExec(args: string): string {
  return execSync(`gh ${args}`, { timeout: 30_000, encoding: "utf-8" }).trim();
}

function ghSafe(args: string): string | null {
  try {
    return ghExec(args);
  } catch {
    return null;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getConfig(): Record<string, any> {
  const configPath = path.join(getSkillseedDir(), "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, any>): void {
  const configPath = path.join(getSkillseedDir(), "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Sensitive File Filter ────────────────────────────────────────────

/** Unstage any confidential/private files before commit */
export function filterSensitiveFiles(dataDir: string): number {
  const staged = gitSafe(["diff", "--cached", "--name-only"], dataDir);
  if (!staged) return 0;

  let filtered = 0;
  for (const file of staged.split("\n").filter(Boolean)) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(dataDir, file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const { data } = matter(raw);
      if (
        SENSITIVE_LEVELS.includes(data.sensitivity) ||
        data.sync === false
      ) {
        gitSafe(["reset", "HEAD", file], dataDir);
        filtered++;
      }
    } catch {
      // skip unparseable files
    }
  }
  return filtered;
}

// ── Stage Changes ────────────────────────────────────────────────────

/** Stage a single file (called after seed_log). Fast, non-blocking. */
export function stageChanges(filePath: string): void {
  const dataDir = getSkillseedDir();
  const hasRemote = gitSafe(["remote"], dataDir);
  if (!hasRemote) return; // no sync configured

  try {
    const rel = path.relative(dataDir, filePath);
    gitSafe(["add", rel], dataDir);
  } catch {
    // non-fatal
  }
}

// ── Sync (Manual) ────────────────────────────────────────────────────

/** Full manual sync: pull → filter → commit → push */
export async function sync(dataDir?: string): Promise<void> {
  const dir = dataDir ?? getSkillseedDir();
  const remote = gitSafe(["remote"], dir);
  if (!remote) {
    console.log("❌ Sync not configured. Run 'seed init' to set up sync.");
    return;
  }

  // Check auth
  if (!checkAuth()) {
    console.log("❌ GitHub auth expired. Run 'gh auth login' to fix.");
    return;
  }

  // Ensure branch is 'main'
  ensureMainBranch(dir);
  const branch = gitSafe(["branch", "--show-current"], dir) ?? "main";

  // 1. Pull
  console.log("⬇ Pulling...");
  const pullResult = gitSafe(["pull", "origin", branch, "--no-edit"], dir);
  if (pullResult === null) {
    // Maybe remote is empty (first push)
    const remoteHead = gitSafe(["ls-remote", "--heads", "origin", branch], dir);
    if (!remoteHead || remoteHead.length === 0) {
      console.log("   (remote is empty — will push for the first time)");
    } else {
      console.log("⚠ Pull failed — continuing with local data");
    }
  }

  // 2. Stage all changes
  gitSafe(["add", "."], dir);

  // 3. Filter sensitive files
  const filtered = filterSensitiveFiles(dir);
  if (filtered > 0) {
    console.log(`⚠ Skipped ${filtered} confidential experience(s) (not synced)`);
  }

  // 4. Commit
  const status = gitSafe(["status", "--porcelain"], dir) ?? "";
  if (status.length > 0) {
    const count = status.split("\n").filter(Boolean).length;
    git(["commit", "-m", `sync: ${count} experience(s)`], dir);
  }

  // 5. Push
  console.log("⬆ Pushing...");
  const pushResult = gitSafe(["push", "-u", "origin", branch], dir);
  if (pushResult === null) {
    console.log("⚠ Push failed (offline?)");
  } else {
    const total = countExperiences(dir);
    console.log(`✅ Synced (total: ${total} experiences)`);

    // Record sync time
    const config = getConfig();
    config.last_sync = new Date().toISOString();
    saveConfig(config);
  }
}

// ── Batch Commit & Push (background timer + shutdown) ────────────────

/** Batch commit+push for 30-min timer and graceful shutdown */
export async function batchCommitAndPush(dataDir?: string): Promise<void> {
  const dir = dataDir ?? getSkillseedDir();
  const remote = gitSafe(["remote"], dir);
  if (!remote) return;

  if (!checkAuth()) return; // silent fail for background

  ensureMainBranch(dir);
  const branch = gitSafe(["branch", "--show-current"], dir) ?? "main";

  // Pull first
  gitSafe(["pull", "origin", branch, "--no-edit"], dir);

  // Stage all
  gitSafe(["add", "."], dir);

  // Filter sensitive
  filterSensitiveFiles(dir);

  // Commit if changes
  const status = gitSafe(["status", "--porcelain"], dir) ?? "";
  if (status.length > 0) {
    const count = status.split("\n").filter(Boolean).length;
    gitSafe(["commit", "-m", `sync: ${count} new experience(s)`], dir);
  }

  // Push (silent fail if offline)
  const pushResult = gitSafe(["push", "-u", "origin", branch], dir);
  if (pushResult !== null) {
    const config = getConfig();
    config.last_sync = new Date().toISOString();
    saveConfig(config);
  }
}

// ── Setup Sync (init step 6) ─────────────────────────────────────────

/** Interactive sync setup during skillseed init */
export async function setupSync(): Promise<void> {
  const dataDir = getSkillseedDir();

  const answer = await prompt(
    "\n6. Sync experiences across devices? (recommended)\n" +
    "   This keeps your experiences in a private GitHub repository.\n" +
    "   [Y/n]: "
  );

  if (answer.toLowerCase() === "n") {
    console.log("   Skipped. You can set up sync later with 'skillseed sync --setup'.");
    return;
  }

  // Check gh CLI
  console.log("\n   Checking GitHub CLI...");
  const ghStatus = ghSafe("auth status");
  if (ghStatus === null) {
    // No gh CLI — manual fallback
    console.log("   ❌ gh CLI not found\n");
    console.log("   You can still sync manually:");
    const url = await prompt("   ? Enter your Git repo URL (or press Enter to skip): ");
    if (url) {
      await configureRemote(dataDir, url);
      console.log("   ✅ Remote configured");
    }
    return;
  }

  // Extract username
  const username = extractGhUsername();
  if (username) {
    console.log(`   ✅ Logged in as ${username}`);
  }

  // Search for existing vault
  const existing = await findExistingVault(username);
  if (existing) {
    console.log(`\n   🔍 Found your experience vault: ${existing.fullName}`);
    const use = await prompt("   ? Use this repo? [Y/n]: ");
    if (use.toLowerCase() !== "n") {
      await connectVault(dataDir, existing.url);
      return;
    }
  }

  // Create or use existing
  console.log("\n   ? Create a new private repo, or use an existing one?");
  console.log("   > [1] Create new (recommended)");
  console.log("     [2] Use existing repo URL");
  console.log("     [3] Skip for now");
  const choice = await prompt("   Choice: ");

  if (choice === "1" || choice === "") {
    await createVaultRepo(dataDir, username);
  } else if (choice === "2") {
    const url = await prompt("   ? Enter repo URL: ");
    if (url) {
      await configureRemote(dataDir, url);
      await initialSync(dataDir);
    }
  } else {
    console.log("   Skipped.");
  }
}

// ── Sync Status ──────────────────────────────────────────────────────

export function getSyncStatus(): { state: string; detail: string } {
  const dir = getSkillseedDir();
  const remote = gitSafe(["remote"], dir);
  if (!remote) {
    return { state: "not_configured", detail: "Sync not configured" };
  }

  if (!checkAuth()) {
    return { state: "auth_error", detail: "auth expired — run 'gh auth login' to fix" };
  }

  const config = getConfig();
  const lastSync = config.last_sync;
  if (!lastSync) {
    return { state: "never", detail: "never synced — run 'skillseed sync'" };
  }

  const ago = Date.now() - new Date(lastSync).getTime();
  const hours = Math.floor(ago / 3_600_000);
  const minutes = Math.floor(ago / 60_000);

  if (hours > 48) {
    const days = Math.floor(hours / 24);
    return { state: "stale", detail: `last synced ${days} days ago — run 'skillseed sync' to update` };
  }
  if (minutes < 1) {
    return { state: "ok", detail: "up-to-date (just now)" };
  }
  if (minutes < 60) {
    return { state: "ok", detail: `up-to-date (${minutes} minutes ago)` };
  }
  return { state: "ok", detail: `up-to-date (${hours} hours ago)` };
}

// ── Audit (dry-run) ──────────────────────────────────────────────────

export function audit(): void {
  const dir = getSkillseedDir();
  gitSafe(["add", "."], dir);
  filterSensitiveFiles(dir);
  const status = gitSafe(["status", "--porcelain"], dir) ?? "";
  if (!status) {
    console.log("Nothing to push — everything is up-to-date.");
    return;
  }
  console.log("Files that would be pushed:\n");
  for (const line of status.split("\n").filter(Boolean)) {
    console.log(`  ${line}`);
  }
  // Reset staging (audit only)
  gitSafe(["reset", "HEAD"], dir);
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Rename 'master' to 'main' if needed */
function ensureMainBranch(dataDir: string): void {
  const branch = gitSafe(["branch", "--show-current"], dataDir);
  if (branch === "master") {
    gitSafe(["branch", "-M", "main"], dataDir);
  }
}

function checkAuth(): boolean {
  return ghSafe("auth status") !== null;
}

function extractGhUsername(): string | null {
  try {
    const out = execSync("gh api user --jq .login", { timeout: 10_000, encoding: "utf-8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface VaultInfo {
  fullName: string;
  url: string;
}

async function findExistingVault(username: string | null): Promise<VaultInfo | null> {
  if (!username) return null;

  // 1. Try conventional name
  const conventionalUrl = ghSafe(`repo view ${username}/${CONVENTIONAL_REPO} --json url --jq .url`);
  if (conventionalUrl) {
    return { fullName: `${username}/${CONVENTIONAL_REPO}`, url: conventionalUrl };
  }

  // 2. Search repos for marker file
  const reposJson = ghSafe(`repo list ${username} --json name,url --limit 50`);
  if (!reposJson) return null;

  try {
    const repos = JSON.parse(reposJson) as Array<{ name: string; url: string }>;
    for (const repo of repos) {
      const marker = ghSafe(
        `api repos/${username}/${repo.name}/contents/${MARKER_FILE} --jq .content`
      );
      if (marker) {
        return { fullName: `${username}/${repo.name}`, url: repo.url };
      }
    }
  } catch {
    // parse error
  }

  return null;
}

async function createVaultRepo(dataDir: string, username: string | null): Promise<void> {
  const repoName = CONVENTIONAL_REPO;
  const fullName = username ? `${username}/${repoName}` : repoName;

  console.log(`\n   Creating private repo: ${fullName} ...`);
  const result = ghSafe(`repo create ${repoName} --private --description "Skillseed experience vault" --confirm`);
  if (result === null) {
    // Try without --confirm (newer gh versions)
    const result2 = ghSafe(`repo create ${repoName} --private --description "Skillseed experience vault"`);
    if (result2 === null) {
      console.log("   ❌ Failed to create repo. You can create it manually and run sync --setup.");
      return;
    }
  }

  const repoUrl = ghSafe(`repo view ${fullName} --json url --jq .url`);
  if (!repoUrl) {
    console.log("   ❌ Repo created but couldn't get URL.");
    return;
  }

  console.log(`   ✅ ${repoUrl} (private)`);

  // Place marker file
  const markerPath = path.join(dataDir, MARKER_FILE);
  fs.writeFileSync(markerPath, JSON.stringify({
    type: "skillseed-vault",
    version: "0.1.0",
    created: new Date().toISOString().slice(0, 10),
  }, null, 2) + "\n", "utf-8");

  // Configure remote and push
  await configureRemote(dataDir, repoUrl);
  await initialSync(dataDir);
}

async function configureRemote(dataDir: string, url: string): Promise<void> {
  // Ensure git repo
  if (!fs.existsSync(path.join(dataDir, ".git"))) {
    git(["init"], dataDir);
  }

  // Set remote
  const existingRemote = gitSafe(["remote", "get-url", "origin"], dataDir);
  if (existingRemote) {
    git(["remote", "set-url", "origin", url], dataDir);
  } else {
    git(["remote", "add", "origin", url], dataDir);
  }

  // Save to config
  const config = getConfig();
  config.sync_remote = url;
  saveConfig(config);
}

async function connectVault(dataDir: string, url: string): Promise<void> {
  await configureRemote(dataDir, url);

  // Pull existing data
  console.log("\n   ⬇ Pulling experiences from cloud...");
  gitSafe(["fetch", "origin"], dataDir);

  // Check if remote has commits
  const remoteHead = gitSafe(["rev-parse", "origin/main"], dataDir)
    ?? gitSafe(["rev-parse", "origin/master"], dataDir);

  if (remoteHead) {
    // Check local status
    const localHead = gitSafe(["rev-parse", "HEAD"], dataDir);
    if (localHead) {
      // Both have data — merge
      const localCount = countExperiences(dataDir);
      console.log(`   🔀 Merging with ${localCount} local experiences...`);
      gitSafe(["pull", "origin", "main", "--no-edit"], dataDir)
        ?? gitSafe(["pull", "origin", "master", "--no-edit"], dataDir);
    } else {
      // No local commits — just checkout
      gitSafe(["checkout", "-b", "main", "origin/main"], dataDir)
        ?? gitSafe(["checkout", "-b", "main", "origin/master"], dataDir);
    }
  }

  const total = countExperiences(dataDir);
  console.log(`   ✅ Sync configured! (${total} experiences)`);

  // Push any local-only data
  await initialSync(dataDir);
}

async function initialSync(dataDir: string): Promise<void> {
  // Ensure on main branch
  const branch = gitSafe(["branch", "--show-current"], dataDir);
  if (!branch) {
    gitSafe(["checkout", "-b", "main"], dataDir);
  }

  // Stage, filter, commit, push
  gitSafe(["add", "."], dataDir);
  filterSensitiveFiles(dataDir);

  const status = gitSafe(["status", "--porcelain"], dataDir) ?? "";
  if (status.length > 0) {
    const count = status.split("\n").filter(Boolean).length;
    git(["commit", "-m", `sync: initial ${count} experience(s)`], dataDir);
    const pushResult = gitSafe(["push", "-u", "origin", "main"], dataDir);
    if (pushResult !== null) {
      console.log(`   ✅ ${count} experience(s) pushed`);
    }
  }

  // Record sync time
  const config = getConfig();
  config.last_sync = new Date().toISOString();
  saveConfig(config);

  console.log("\n   💡 On your other machines, just run: skillseed init");
}

function countExperiences(dataDir: string): number {
  const expDir = path.join(dataDir, "experiences");
  if (!fs.existsSync(expDir)) return 0;
  let count = 0;
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith(".md")) count++;
    }
  }
  walk(expDir);
  return count;
}
