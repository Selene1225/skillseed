#!/usr/bin/env node
/**
 * Skillseed CLI — init, serve, start, status
 */
import fs from "node:fs";
import path from "node:path";
import { serveStdio, serveHttp } from "../server/mcp.js";
import { detectClis, initSkillseedDir, configureClaude, configureGemini, configureVSCode, configureCopilotCli, configureCodex, injectClaudeMd, setBrainCli, setDeviceType, setTransport, } from "./setup.js";
import { sync, setupSync, getSyncStatus, audit } from "./sync.js";
import { harvest, reviewPending, approveAll, autoReview, discoverHistoryFiles, backfillTitles, exportExperiences, sanitizeAll, reclassify, dedup } from "./harvest.js";
import { getSkillseedDir, listAllExperiences } from "../store/file-store.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const VERSION = require("../../package.json").version;
async function main() {
    const command = process.argv[2];
    switch (command) {
        case "init":
            await runInit();
            break;
        case "serve":
            await serveStdio();
            break;
        case "start":
            await runStart();
            break;
        case "status":
            runStatus();
            break;
        case "list":
            runList();
            break;
        case "sync":
            await runSync();
            break;
        case "harvest":
            await runHarvest();
            break;
        case "--version":
        case "-v":
            console.log(`skillseed v${VERSION}`);
            break;
        case "--help":
        case "-h":
        case undefined:
            printHelp();
            break;
        default:
            console.log(`Unknown command: ${command}`);
            printHelp();
            process.exit(1);
    }
}
function printHelp() {
    console.log(`
🌱 Skillseed v${VERSION} — Personal Work Experience Engine

Commands:
  init      Set up Skillseed (detect CLIs, configure MCP, create ~/.skillseed/)
  serve     Start MCP server in stdio mode (for CLI auto-launch)
  start     Start MCP server in HTTP mode (multi-client)
  status    Show current status
  list      List stored experiences
  sync      Sync experiences (pull + commit + push)
              --setup URL   Configure remote manually
              --status      Show sync state
              --audit       Dry-run: show what would be pushed
  harvest   Extract experiences from CLI conversation history
              --review      Interactively approve/reject pending experiences
              --auto-review LLM auto-review pending (add --dry-run to preview)
              --approve-all Approve all pending experiences
              --dry-run     Preview without writing
              --scan        Show available history files
              --backfill-titles  Generate titles for existing experiences (add --dry-run to preview)
              --export[=FILE]    Export all experiences to markdown (default: skillseed-export.md)
              --sanitize         Replace secrets with {{placeholders}} (add --dry-run to preview)
              --reclassify       Re-classify scope of all experiences via LLM (add --dry-run to preview)
              --dedup            Find and merge duplicate experiences (add --dry-run to preview)
                                   --jaccard: lexical only  --semantic: LLM only

Options:
  -v, --version   Show version
  -h, --help      Show this help
`);
}
async function runInit() {
    console.log("\n👋 Welcome to Skillseed!\n");
    // 1. Detect CLIs
    console.log("1. Detecting AI CLIs...");
    const clis = detectClis();
    for (const cli of clis) {
        console.log(`   ✅ ${cli.name} — ${cli.version}`);
    }
    if (clis.length === 0) {
        console.log("   ⚠️  No AI CLIs found. You can still use Skillseed manually.");
    }
    // 2. Initialize directory
    console.log("\n2. Initializing ~/.skillseed/...");
    initSkillseedDir(true);
    console.log("   ✅ Directory created with starter experiences");
    // 3. Select brain CLI (non-interactive for now — pick first available)
    const brainOptions = clis.filter(c => c.name === "claude" || c.name === "gemini");
    const brain = brainOptions.length > 0 ? brainOptions[0].name : "none";
    setBrainCli(brain);
    console.log(`\n3. Brain CLI: ${brain === "none" ? "none (rule-based only)" : brain}`);
    // 4. Device type (default: work)
    setDeviceType("work");
    console.log("4. Device type: work (full access)");
    // 5. Configure CLIs
    console.log("\n5. Configuring CLIs...");
    const transport = "stdio";
    const port = 9527;
    setTransport(transport, port);
    const hasClaude = clis.some(c => c.name === "claude");
    const hasGemini = clis.some(c => c.name === "gemini");
    if (hasClaude) {
        const ok = configureClaude(transport, port);
        console.log(ok ? "   ✅ Claude: MCP server configured" : "   ⚠️  Claude: config failed");
        const mdOk = injectClaudeMd();
        console.log(mdOk ? "   ✅ Claude: CLAUDE.md instructions injected" : "   ⚠️  Claude: CLAUDE.md injection failed");
    }
    if (hasGemini) {
        const ok = configureGemini(transport, port);
        console.log(ok ? "   ✅ Gemini: MCP server configured" : "   ⚠️  Gemini: config failed");
    }
    // VSCode global config (Copilot + Claude extension)
    const vscodeOk = configureVSCode(transport, port);
    console.log(vscodeOk ? "   ✅ VSCode: MCP server configured (Copilot + Claude)" : "   ⚠️  VSCode: settings.json not found, skip");
    // GitHub Copilot CLI
    const copilotOk = configureCopilotCli(transport, port);
    console.log(copilotOk ? "   ✅ Copilot CLI: MCP server configured" : "   ⚠️  Copilot CLI: config not found, skip");
    // Codex CLI
    const codexOk = configureCodex(transport, port);
    console.log(codexOk ? "   ✅ Codex: MCP server configured" : "   ⚠️  Codex: config not found, skip");
    // 6. Sync setup
    await setupSync();
    console.log(`
🌱 Skillseed is ready!
   Data: ${getSkillseedDir()}
   Transport: ${transport}${transport === "http" ? ` (port ${port})` : ""}
   
   Just use your CLI normally — Skillseed works in the background.
   Run 'skillseed status' to check anytime.
`);
}
async function runStart() {
    const port = getPort();
    await serveHttp(port);
}
function getPort() {
    const configPath = path.join(getSkillseedDir(), "config.json");
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return config.port ?? 9527;
    }
    catch {
        return 9527;
    }
}
function runStatus() {
    const dir = getSkillseedDir();
    const configPath = path.join(dir, "config.json");
    console.log(`\n🌱 Skillseed Status\n`);
    if (!fs.existsSync(dir)) {
        console.log("   Not initialized. Run 'skillseed init' first.\n");
        return;
    }
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        console.log(`   Data dir:   ${dir}`);
        console.log(`   Brain CLI:  ${config.brain_cli ?? "none"}`);
        console.log(`   Transport:  ${config.transport ?? "stdio"}`);
        console.log(`   Device:     ${config.device_type ?? "work"}`);
    }
    catch {
        console.log(`   Data dir: ${dir}`);
        console.log(`   Config: not found`);
    }
    const experiences = listAllExperiences();
    console.log(`   Experiences: ${experiences.length}`);
    const syncState = getSyncStatus();
    const icon = syncState.state === "ok" ? "✅" : syncState.state === "auth_error" ? "❌" : "⚠";
    console.log(`   Sync: ${icon} ${syncState.detail}`);
    console.log();
}
function runList() {
    const experiences = listAllExperiences();
    if (experiences.length === 0) {
        console.log("\nNo experiences yet. Use seed_log via your AI CLI or run 'skillseed init'.\n");
        return;
    }
    console.log(`\n📚 ${experiences.length} experience(s):\n`);
    for (const exp of experiences) {
        const firstLine = exp.content.split("\n")[0].slice(0, 80);
        console.log(`  [${exp.meta.scope}] ${firstLine}`);
        console.log(`    tags: ${exp.meta.tags.join(", ")} | confidence: ${exp.meta.confidence} | ${exp.meta.created}`);
        console.log();
    }
}
async function runHarvest() {
    const arg = process.argv[3];
    const configPath = path.join(getSkillseedDir(), "config.json");
    let brainCli = "claude";
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        brainCli = config.brain_cli || "claude";
    }
    catch { /* use default */ }
    if (arg === "--review") {
        await reviewPending();
    }
    else if (arg === "--approve-all") {
        approveAll();
    }
    else if (arg === "--auto-review") {
        const dryRun = process.argv[4] === "--dry-run";
        autoReview({ brainCli, dryRun });
    }
    else if (arg === "--backfill-titles") {
        const dryRun = process.argv[4] === "--dry-run";
        backfillTitles({ brainCli, dryRun });
    }
    else if (arg?.startsWith("--export")) {
        // --export or --export=path
        const eqIdx = arg.indexOf("=");
        const outPath = eqIdx > 0 ? arg.slice(eqIdx + 1) : "skillseed-export.md";
        exportExperiences(outPath);
    }
    else if (arg === "--sanitize") {
        const dryRun = process.argv[4] === "--dry-run";
        sanitizeAll({ dryRun });
    }
    else if (arg === "--reclassify") {
        const dryRun = process.argv[4] === "--dry-run";
        reclassify({ brainCli, dryRun });
    }
    else if (arg === "--dedup") {
        const rest = process.argv.slice(4);
        const dryRun = rest.includes("--dry-run");
        const jaccard = rest.includes("--jaccard");
        const semantic = rest.includes("--semantic");
        dedup({ brainCli, dryRun, jaccard, semantic });
    }
    else if (arg === "--scan") {
        const files = discoverHistoryFiles();
        console.log(`\n📂 ${files.length} conversation history files:\n`);
        for (const f of files.slice(0, 20)) {
            console.log(`  ${f.project}/${path.basename(f.file).slice(0, 8)}...  ${(f.size / 1024).toFixed(0)} KB`);
        }
        if (files.length > 20)
            console.log(`  ... and ${files.length - 20} more`);
        console.log();
    }
    else {
        const result = harvest({ brainCli, dryRun: arg === "--dry-run" });
        // Auto-review pending if not dry run and there are pending experiences
        if (!arg && result.pending > 0) {
            console.log("🔍 Running auto-review on pending experiences...\n");
            autoReview({ brainCli, dryRun: true }); // first time always dry-run
        }
    }
}
async function runSync() {
    const arg = process.argv[3];
    if (arg === "--status") {
        const s = getSyncStatus();
        const icon = s.state === "ok" ? "✅" : s.state === "auth_error" ? "❌" : "⚠";
        console.log(`Sync: ${icon} ${s.detail}`);
    }
    else if (arg === "--audit") {
        audit();
    }
    else if (arg === "--setup") {
        await setupSync();
    }
    else {
        await sync();
    }
}
main().catch(console.error);
//# sourceMappingURL=index.js.map