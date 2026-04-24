# 🌱 Skillseed

> Give your AI CLI a work memory.

Skillseed is a local MCP server that captures, structures, and serves your accumulated work experiences to any AI tool — Claude, Gemini, Copilot, Mars, Cortana — so they all get smarter about *your* way of working.

## Install (30 seconds)

```bash
npm install -g skillseed
skillseed init
```

That's it. `init` auto-detects your AI CLIs and configures everything.

## How it works

After install, your AI CLI automatically:
- **Remembers** lessons, mistakes, and best practices (`seed_log`)
- **Recalls** relevant experience before tasks (`seed_recall`)
- **Knows your preferences** — language, style, hours (`seed_preference_get/set`)

You don't change how you work. Skillseed runs in the background.

## CLI Commands

```bash
skillseed init      # One-time setup (detects CLIs, configures MCP)
skillseed status    # Check connection & stats
skillseed list      # Browse your experiences
```

## Manual MCP config (if init didn't auto-configure)

### Claude CLI
Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "skillseed": {
      "type": "stdio",
      "command": "npx",
      "args": ["skillseed", "serve"]
    }
  }
}
```

### Gemini CLI
Add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "skillseed": {
      "type": "stdio",
      "command": "npx",
      "args": ["skillseed", "serve"]
    }
  }
}
```

### HTTP mode (multi-client)
```bash
skillseed start    # Starts HTTP server on port 9527
```
Then point CLIs to `http://localhost:9527/mcp`.

## Your data

All experiences are stored in `~/.skillseed/` as plain Markdown files with YAML frontmatter — human-readable, git-trackable, yours forever.

```
~/.skillseed/
├── experiences/
│   ├── universal/          # Portable knowledge
│   ├── company--microsoft/ # Company-specific
│   ├── team--azure-sdk/    # Team-specific
│   └── personal/           # Your preferences
└── config.json
```

Uninstall Skillseed? Your data stays intact.

## License

MIT
