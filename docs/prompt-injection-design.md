# Skillseed Prompt Injection — Design Document

## Goal

Tell every AI platform **when** to use Skillseed tools, without wasting tokens on simple tasks.

---

## Two-Layer Strategy

### Layer 1: Tool Descriptions (tools.ts)

**Covers all platforms automatically** — any MCP client reads tool descriptions.

```typescript
// seed_log
"Record a work experience, lesson, or best practice. Call when:
(1) user discovers something useful or makes a mistake,
(2) user corrects you — always log corrections,
(3) a non-obvious solution is found after debugging.
Do NOT log trivial facts or things the user already knows."

// seed_recall
"Search past work experiences. Call when:
(1) writing code, configs, or making technical decisions,
(2) user corrected you — check if similar corrections exist,
(3) repeated failures on same task — search for past solutions.
Do NOT call for simple questions, greetings, or general knowledge."

// seed_preference_get
"Get user preferences. Call once at conversation start ONLY if
the task involves producing output (code, docs, emails).
Do NOT call for simple Q&A."

// seed_preference_set
"Set a user preference. Call when user explicitly states a
consistent preference about how they like things done."
```

### Layer 2: Global Instruction Files (per platform)

Injected by `seed init`. Provides richer context than tool descriptions allow.

| Platform | File | Marker |
|----------|------|--------|
| Claude CLI | `~/.claude/CLAUDE.md` | `<!-- skillseed-start/end -->` |
| Copilot CLI + VSCode | `~/.github/copilot-instructions.md` | `<!-- skillseed-start/end -->` |
| Codex | `~/.codex/instructions.md` | `<!-- skillseed-start/end -->` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `<!-- skillseed-start/end -->` |

All files get the **same content**, injected between markers:

```markdown
<!-- skillseed-start -->
## Skillseed — Work Experience Memory

You have access to the user's work experience library via Skillseed MCP tools.

**When to call seed_recall:**
- Before writing code, configs, or technical documents
- After the user corrects you (check for similar past corrections)
- When stuck or failing repeatedly on a task
- Do NOT call for simple questions or general knowledge

**When to call seed_log:**
- When the user discovers something non-obvious
- When you make a mistake and the user corrects you (always log corrections)
- When a debugging session reveals a useful pattern
- Do NOT log trivial or well-known facts

**When to call seed_preference_get:**
- Once at start of conversation, ONLY if producing output (code, docs, emails)

**When to call seed_preference_set:**
- When the user states a consistent preference ("I always want...", "Never do...")
<!-- skillseed-end -->
```

---

## Implementation

### Changes to `src/server/tools.ts`

Update all 4 tool descriptions with trigger conditions (Layer 1).

### Changes to `src/cli/setup.ts`

Add 3 new injection functions (Layer 2):

```typescript
export function injectCopilotInstructions(): boolean
  // Target: ~/.github/copilot-instructions.md
  // Same marker pattern as CLAUDE.md

export function injectCodexInstructions(): boolean
  // Target: ~/.codex/instructions.md
  // Same marker pattern

export function injectGeminiMd(): boolean
  // Target: ~/.gemini/GEMINI.md
  // Same marker pattern
```

Refactor: extract shared `injectInstructions(filePath)` to avoid duplication.

### Changes to `src/cli/index.ts`

Call all 4 injections in `runInit()`:

```
5. Configuring CLIs...
   ✅ Claude: MCP configured
   ✅ Claude: CLAUDE.md instructions injected
   ✅ Copilot: instructions injected
   ✅ Codex: instructions injected
   ✅ Gemini: instructions injected
   ✅ VSCode: MCP configured
```

---

## Deduplication

All injection functions use the `<!-- skillseed-start/end -->` marker pattern:

1. If markers exist → replace content between them
2. If not → append to end of file
3. If file doesn't exist → create it with just the skillseed block

This means `seed init` is safe to run multiple times — it updates, never duplicates.

---

## Future: Skill-Driven Triggers (Phase 3)

When Skills are implemented, the prompt injection content will be enhanced:

```markdown
**Active Skills (auto-loaded):**
- Azure Pipeline: When writing CI/CD configs, always check past pipeline experiences
- PR Review: When reviewing PRs, recall team coding standards

Call seed_recall with relevant skill tags for targeted context.
```

This is Phase 3 work — not implemented now.
