/**
 * Setup module — auto-configure AI CLIs during `skillseed init`.
 * Detects CLIs, injects MCP config, and creates CLAUDE.md prompts.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import { getSkillseedDir, getExperiencesDir, getSkillsDir } from "../store/file-store.js";

interface DetectedCli {
  name: string;
  version: string;
  path: string;
}

/** Detect which AI CLIs are installed */
export function detectClis(): DetectedCli[] {
  const found: DetectedCli[] = [];
  const clis = [
    { name: "claude", cmd: "claude", versionArg: "--version" },
    { name: "gemini", cmd: "gemini", versionArg: "--version" },
    { name: "copilot", cmd: "gh", versionArg: "--version" },
  ];

  for (const cli of clis) {
    try {
      const out = execFileSync(cli.cmd, [cli.versionArg], { timeout: 5000, encoding: "utf-8" }).trim();
      const version = out.split("\n")[0];
      found.push({ name: cli.name, version, path: cli.cmd });
    } catch {
      // Not installed
    }
  }
  return found;
}

/** Initialize ~/.skillseed/ directory structure */
export function initSkillseedDir(importStarters: boolean): void {
  const dir = getSkillseedDir();
  const expDir = getExperiencesDir();
  const skillsDir = getSkillsDir();

  fs.mkdirSync(path.join(expDir, "universal"), { recursive: true });
  fs.mkdirSync(path.join(expDir, "personal"), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, ".cache"), { recursive: true });

  // .gitignore
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, ".cache/\n", "utf-8");
  }

  // .gitattributes (cross-platform line endings)
  const gitattrsPath = path.join(dir, ".gitattributes");
  if (!fs.existsSync(gitattrsPath)) {
    fs.writeFileSync(gitattrsPath, "* text=auto eol=lf\n", "utf-8");
  }

  // config.json
  const configPath = path.join(dir, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      brain_cli: "none",
      device_type: "work",
      transport: "stdio",
      port: 9527,
    }, null, 2) + "\n", "utf-8");
  }

  // Init git repo
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      execFileSync("git", ["init"], { cwd: dir, timeout: 5000 });
    }
  } catch {
    // git not available — not fatal
  }

  // Import starters
  if (importStarters) {
    copyStarters(dir);
  }
}

/** Copy starter experiences to ~/.skillseed/experiences/universal/ */
function copyStarters(skillseedDir: string): void {
  const startersDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "starters", "universal");
  const destDir = path.join(skillseedDir, "experiences", "universal");

  if (!fs.existsSync(startersDir)) return;

  // Read existing content to avoid duplicates
  const existingContent = new Set<string>();
  if (fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const { content } = matter(fs.readFileSync(path.join(destDir, f), "utf-8"));
        existingContent.add(content.trim());
      } catch { /* skip */ }
    }
  }

  for (const file of fs.readdirSync(startersDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(path.join(startersDir, file), "utf-8");
      const { content } = matter(raw);
      if (existingContent.has(content.trim())) continue; // already exists
      const destFile = path.join(destDir, file);
      if (!fs.existsSync(destFile)) {
        fs.copyFileSync(path.join(startersDir, file), destFile);
      }
    } catch { /* skip */ }
  }
}

/** Configure Claude CLI MCP settings */
export function configureClaude(transport: "stdio" | "http", port: number): boolean {
  const claudeConfigPath = path.join(os.homedir(), ".claude.json");

  try {
    let config: Record<string, any> = {};
    if (fs.existsSync(claudeConfigPath)) {
      config = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
    }

    if (!config.mcpServers) config.mcpServers = {};

    if (transport === "stdio") {
      config.mcpServers.skillseed = {
        type: "stdio",
        command: "skillseed",
        args: ["serve"],
      };
    } else {
      config.mcpServers.skillseed = {
        type: "http",
        url: `http://localhost:${port}/mcp`,
      };
    }

    fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Inject Skillseed instructions into CLAUDE.md */
export function injectClaudeMd(): boolean {
  const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");
  const marker = "<!-- skillseed-start -->";
  const endMarker = "<!-- skillseed-end -->";

  const instructions = `${marker}
## Skillseed — Work Experience Memory

You have access to the user's work experience library via Skillseed MCP tools.

**When to use:**
- \`seed_recall\`: Before starting any task, search for relevant past experiences
- \`seed_log\`: When the user discovers something useful, makes a mistake, or you learn something about their workflow
- \`seed_preference_get\`: At the start of conversations to personalize your responses
- \`seed_preference_set\`: When the user expresses consistent preferences

**Guidelines:**
- Always check for relevant experiences before giving advice
- Log lessons learned, corrections, and best practices automatically
- Be concise when logging — one clear experience per entry
- Include relevant tags for better retrieval
${endMarker}`;

  try {
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });

    let content = "";
    if (fs.existsSync(claudeMdPath)) {
      content = fs.readFileSync(claudeMdPath, "utf-8");
      // Remove old injection
      const startIdx = content.indexOf(marker);
      const endIdx = content.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1) {
        content = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length);
      }
    }

    content = content.trimEnd() + "\n\n" + instructions + "\n";
    fs.writeFileSync(claudeMdPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Configure VSCode global MCP settings (works for Copilot + Claude extension) */
export function configureVSCode(transport: "stdio" | "http", port: number): boolean {
  const settingsPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Code", "User", "settings.json"
  );

  try {
    if (!fs.existsSync(settingsPath)) return false;

    let settings: Record<string, any> = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

    if (!settings["mcp"]) settings["mcp"] = {};
    if (!settings["mcp"]["servers"]) settings["mcp"]["servers"] = {};

    if (transport === "stdio") {
      settings["mcp"]["servers"]["skillseed"] = {
        type: "stdio",
        command: "skillseed",
        args: ["serve"],
      };
    } else {
      settings["mcp"]["servers"]["skillseed"] = {
        type: "http",
        url: `http://localhost:${port}/mcp`,
      };
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Configure GitHub Copilot CLI MCP settings (~/.copilot/mcp-config.json) */
export function configureCopilotCli(transport: "stdio" | "http", port: number): boolean {
  const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    let config: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }

    if (!config.mcpServers) config.mcpServers = {};

    if (transport === "stdio") {
      config.mcpServers.skillseed = {
        type: "stdio",
        command: "skillseed",
        args: ["serve"],
      };
    } else {
      config.mcpServers.skillseed = {
        type: "http",
        url: `http://localhost:${port}/mcp`,
      };
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Configure Codex CLI MCP settings (~/.codex/config.toml) */
export function configureCodex(transport: "stdio" | "http", port: number): boolean {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");

  try {
    if (!fs.existsSync(configPath)) return false;

    let content = fs.readFileSync(configPath, "utf-8");
    if (content.includes("[mcp_servers.skillseed]")) return true; // already configured

    if (transport === "stdio") {
      content += `\n[mcp_servers.skillseed]\ntype = "stdio"\ncommand = "skillseed"\nargs = ["serve"]\n`;
    } else {
      content += `\n[mcp_servers.skillseed]\ntype = "http"\nurl = "http://localhost:${port}/mcp"\n`;
    }

    fs.writeFileSync(configPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Configure Gemini CLI MCP settings */
export function configureGemini(transport: "stdio" | "http", port: number): boolean {
  const geminiDir = path.join(os.homedir(), ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");

  try {
    fs.mkdirSync(geminiDir, { recursive: true });

    let settings: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }

    if (!settings.mcpServers) settings.mcpServers = {};

    if (transport === "stdio") {
      settings.mcpServers.skillseed = {
        type: "stdio",
        command: "skillseed",
        args: ["serve"],
      };
    } else {
      settings.mcpServers.skillseed = {
        type: "http",
        url: `http://localhost:${port}/mcp`,
      };
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Update config.json with brain CLI choice */
export function setBrainCli(cli: "claude" | "gemini" | "none"): void {
  const configPath = path.join(getSkillseedDir(), "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  config.brain_cli = cli;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Update config.json with device type */
export function setDeviceType(type: "work" | "personal" | "shared"): void {
  const configPath = path.join(getSkillseedDir(), "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  config.device_type = type;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Update config.json with transport */
export function setTransport(transport: "stdio" | "http", port?: number): void {
  const configPath = path.join(getSkillseedDir(), "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  config.transport = transport;
  if (port) config.port = port;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
