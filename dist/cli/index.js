#!/usr/bin/env node
/**
 * Skillseed CLI — init, serve, start, status
 */
import fs from "node:fs";
import path from "node:path";
import { serveStdio, serveHttp } from "../server/mcp.js";
import { detectClis, initSkillseedDir, configureClaude, configureGemini, injectClaudeMd, setBrainCli, setDeviceType, setTransport, } from "./setup.js";
import { sync, setupSync, getSyncStatus, audit } from "./sync.js";
import { getSkillseedDir, listAllExperiences } from "../store/file-store.js";
const VERSION = "0.1.0";
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