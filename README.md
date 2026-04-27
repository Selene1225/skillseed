# 🌱 Skillseed

> Give your AI a work memory.

Skillseed is a local MCP server that captures, structures, and serves your accumulated work experiences to any AI tool — Claude, Gemini, Copilot, Codex, Mars — so they all get smarter about *your* way of working.

## Install

```bash
gh release download v0.4.1 -R Selene1225/skillseed -p "*.tgz" --clobber
npm i -g ./skillseed-0.4.1.tgz
seed init
```

`init` auto-detects your AI CLIs (Claude, Gemini, Copilot, Codex), configures MCP for all platforms including VSCode, and optionally sets up cross-device sync via a private GitHub repo.

## How it works

After install, your AI automatically:
- **Remembers** lessons, mistakes, and best practices (`seed_log`)
- **Recalls** relevant experience before tasks (`seed_recall`)
- **Knows your preferences** — language, style, hours (`seed_preference_get/set`)

You don't change how you work. Skillseed runs in the background.

## Commands

Both `seed` and `skillseed` work as command names.

```bash
seed init                  # One-time setup (detects CLIs, configures MCP, sync)
seed status                # Check connection, stats, sync health
seed list                  # Browse your experiences
seed sync                  # Pull + push experiences across devices
seed sync --audit          # Preview what would be pushed (dry-run)
seed harvest               # Extract experiences from CLI conversation history
seed harvest --scan        # Show available history files
seed harvest --dry-run     # Preview extraction without writing
seed harvest --review      # Approve/reject pending experiences (y/n)
seed harvest --approve-all # Approve all pending
seed start                 # HTTP server on port 9527 (multi-client)
```

## Manual MCP config

If `seed init` didn't auto-configure, add manually:

### Claude CLI (`~/.claude.json`)
```json
{ "mcpServers": { "skillseed": { "type": "stdio", "command": "skillseed", "args": ["serve"] } } }
```

### Gemini CLI (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "skillseed": { "type": "stdio", "command": "skillseed", "args": ["serve"] } } }
```

### Copilot CLI (`~/.copilot/mcp-config.json`)
```json
{ "mcpServers": { "skillseed": { "type": "stdio", "command": "skillseed", "args": ["serve"] } } }
```

### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.skillseed]
type = "stdio"
command = "skillseed"
args = ["serve"]
```

### VSCode — Copilot & Claude extension (User `settings.json`)
```json
{ "mcp": { "servers": { "skillseed": { "type": "stdio", "command": "skillseed", "args": ["serve"] } } } }
```

### HTTP mode (multi-client)
```bash
seed start    # http://localhost:9527/mcp
```

## Your data

Plain Markdown + YAML frontmatter in `~/.skillseed/`. Human-readable, git-synced, yours forever.

```
~/.skillseed/
├── experiences/
│   ├── universal/          # Portable knowledge
│   ├── company--microsoft/ # Company-specific
│   ├── team--azure-sdk/    # Team-specific
│   └── personal/           # Your preferences
├── pending/                # Harvested experiences awaiting review
├── config.json
├── harvest-state.json      # Tracks which files have been harvested
└── .skillseed-marker       # Vault identifier (for sync discovery)
```

Sync keeps experiences in a **private** GitHub repo. Confidential/private experiences are never synced.

Uninstall Skillseed? Your data stays in `~/.skillseed/`.

## License

MIT
