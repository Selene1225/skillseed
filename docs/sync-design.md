# Skillseed Sync — Design Document

## Goal

Let users sync experiences across devices with zero git knowledge.
Everything is guided — user just follows prompts and presses Enter.

---

## User Scenarios

| Scenario | Description | What happens |
|----------|-------------|--------------|
| A | First device, first time | Create private GitHub repo, push |
| B | Second device, vault exists | Auto-detect repo, pull |
| C | Both devices have local data | Merge, then push |
| D | Daily use | Auto-sync in background |

---

## Flow: `skillseed init` (Step 6 — Sync)

### Scenario A — First device

```
6. Sync experiences across devices? (recommended)
   This keeps your experiences in a private GitHub repository.
   [Y/n]: Y

   Checking GitHub CLI...
   ✅ Logged in as Selene1225

   ? Create a new private repo, or use an existing one?
   > [1] Create new (recommended)
     [2] Use existing repo URL
     [3] Skip for now

   Creating private repo: Selene1225/skillseed-vault ...
   ✅ https://github.com/Selene1225/skillseed-vault (private)
   ✅ 4 experiences pushed

   💡 On your other machines, just run: skillseed init
```

### Scenario B — Second device (vault exists)

```
6. Sync experiences across devices?
   [Y/n]: Y

   Checking GitHub CLI...
   ✅ Logged in as Selene1225

   🔍 Found your experience vault: Selene1225/skillseed-vault
   ? Use this repo? [Y/n]: Y

   ⬇ Pulling 12 experiences from cloud...
   ✅ Sync configured!
```

### Scenario C — Both sides have data

```
   ⬇ Pulling 8 experiences from cloud...
   🔀 Merging with 3 local experiences...
   ✅ Merged! Total: 11 experiences (0 conflicts)
   ⬆ Pushing merged data...
   ✅ Done!
```

### No `gh` CLI fallback

```
   Checking GitHub CLI...
   ❌ gh CLI not found

   You can still sync manually:
   ? Enter your Git repo URL (or press Enter to skip):
   > https://github.com/myname/my-vault.git
   ✅ Remote configured
```

---

## Flow: `skillseed sync` (Manual)

```
> skillseed sync

⬇ Pulling... 2 new experiences from cloud
⬆ Pushing... 5 new local experiences
✅ Synced (total: 23 experiences)
```

---

## Auto-sync Timing

| When | Action | Blocking? |
|------|--------|-----------|
| `serve` starts | `git pull` | No (background) |
| After each `seed_log` | `git add` only (stage, no commit) | No (ms-level) |
| `serve` graceful shutdown | `git add + commit + push` | Yes (best-effort) |
| Every 30 minutes during `serve` | `git commit + push` (batch) | No (background) |
| `skillseed sync` | `pull + commit + push` | Yes (user-initiated) |

### Rationale (changed from v1)

- **`seed_log` only does `git add`** — one commit per experience is too noisy. A day might produce dozens of experiences; batching into periodic commits keeps history clean.
- **Graceful shutdown hook** — `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` trigger a final commit+push before exit, preventing data loss from the last 0-30 minutes.
- **30-min push also commits** — batches all staged changes into one commit like `"sync: 7 new experiences"`.

---

## Auto-discovery of Existing Vault

When a second device runs `skillseed init`, we search the user's GitHub for a vault repo.

### Discovery method: `.skillseed-marker` file

Instead of hardcoding the repo name `skillseed-vault`, we place a `.skillseed-marker` file in the repo root:

```json
{ "type": "skillseed-vault", "version": "0.1.0", "created": "2026-04-24" }
```

Discovery logic:

```typescript
// 1. First try the conventional name
const conventional = execSync('gh repo list --json name,url --jq \'.[] | select(.name == "skillseed-vault")\'');

// 2. If not found, search all repos for the marker file
// (only if user renamed the repo)
const repos = execSync('gh repo list --json name,url --limit 50');
for (const repo of repos) {
  const marker = execSync(`gh api repos/${repo.fullName}/contents/.skillseed-marker --jq .content 2>/dev/null`);
  if (marker) return repo;
}
```

This way, even if the user renames the repo, we can still find it.

---

## Conflict Resolution

Experiences are mostly append-only (new files), so conflicts are rare.

### When conflicts happen

Only scenario: two machines modify the same experience file (e.g., `use_count` updated on both).

### Strategy

**Use `git pull` (merge), not `git pull --rebase`.**

Rationale: for append-only experience files, merge is safer than rebase. Rebase can cause more issues when both sides modified the same file.

**Numeric fields: take the higher value. Content conflicts: keep both versions.**

```
⚠ Conflict: git-commit-style.md
  Local:  use_count=5, confidence=0.9
  Remote: use_count=3, confidence=0.8
  → Resolved: use_count=5, confidence=0.9 (kept higher values)
```

### Implementation

1. Use `git pull` (merge strategy)
2. If conflict occurs, parse YAML frontmatter from both versions
3. For numeric fields (`use_count`, `confidence`, `used`): take `Math.max()`
4. For date fields (`updated`, `last_used_at`): take the more recent one
5. For content (body text): if different, create a `.conflict` copy and notify user

---

## Sensitive File Filtering

### Problem

Files with `sensitivity: confidential` or `sensitivity: private` must NOT be synced.
But filenames are dynamic (`{date}-{slug}-{rand4}.md`), so we can't pre-populate `.gitignore`.

### Solution: sync filter (pre-commit check)

Instead of `.gitignore`, use a **sync filter** that runs before every commit:

```typescript
export async function filterSensitiveFiles(dataDir: string): Promise<void> {
  // 1. Scan all staged .md files
  // 2. Parse frontmatter for each
  // 3. If sensitivity >= confidential, run `git reset HEAD <file>`
  // 4. Add to .gitignore dynamically
  // 5. Log: "⚠ Skipped 2 confidential experiences (not synced)"
}
```

This runs automatically before every `git commit` in the sync flow (not as a git hook — we control the commit ourselves).

Additionally, `seed_log` writes a `.local-only` marker in the frontmatter for confidential files:

```yaml
---
sensitivity: confidential
sync: false  # <-- added automatically
---
```

The sync filter checks `sync: false` OR `sensitivity >= confidential` as a double check.

---

## Offline & Auth Handling

### Offline behavior

All background sync operations (pull/push) silently fail when offline. No errors shown to user.

But: `skillseed status` shows sync health:

```
> skillseed status

🌱 Skillseed v0.1.0
   Experiences: 23 (universal: 8, company: 12, personal: 3)
   Transport: stdio
   Sync: ✅ up-to-date (last synced: 5 minutes ago)
```

```
> skillseed status

   Sync: ⚠ last synced 2 days ago — run 'skillseed sync' to update
```

```
> skillseed status

   Sync: ❌ auth expired — run 'gh auth login' to fix
```

### Auth expiration detection

Before each background push, check `gh auth status` exit code:
- Exit 0 → auth OK, proceed
- Exit 1 → auth expired, set internal flag `syncDisabled = true`
- On next `skillseed status` or `skillseed sync`, show auth error with fix command
- Don't silently fail for days — surface the issue within one `status` check

---

## Implementation

### New file: `src/cli/sync.ts`

Handles all sync logic:

```typescript
export async function setupSync(dataDir: string): Promise<void>
  // Called from skillseed init step 6
  // 1. Check gh CLI
  // 2. Search for existing vault (conventional name + marker file)
  // 3. Create or connect repo
  // 4. Place .skillseed-marker in repo
  // 5. Pull/merge if needed
  // 6. Push local data

export async function sync(dataDir: string): Promise<void>
  // Called from skillseed sync
  // 1. git pull (merge)
  // 2. Resolve conflicts if any
  // 3. filterSensitiveFiles()
  // 4. git add . && git commit -m "sync: N experiences"
  // 5. git push

export async function stageChanges(dataDir: string): Promise<void>
  // Called after seed_log
  // 1. git add <new-file>
  // (stage only, no commit, no push)

export async function batchCommitAndPush(dataDir: string): Promise<void>
  // Called every 30 min from serve + on graceful shutdown
  // 1. Check gh auth status
  // 2. git pull (merge)
  // 3. Resolve conflicts if any
  // 4. filterSensitiveFiles()
  // 5. git add . && git commit -m "sync: N new experiences"
  // 6. git push (silent fail if offline)

export async function filterSensitiveFiles(dataDir: string): Promise<void>
  // Unstage any confidential/private files before commit
```

### Changes to existing files

| File | Change |
|------|--------|
| `src/cli/index.ts` | Add `sync` command |
| `src/cli/setup.ts` | Add step 6 (call `setupSync`) |
| `src/server/mcp.ts` | Start 30-min timer + graceful shutdown hook |
| `src/service/experience.ts` | Call `stageChanges` after writing experience file |

### CLI commands

```
skillseed sync              # pull + commit + push
skillseed sync --setup URL  # configure remote manually
skillseed sync --status     # show sync state (ahead/behind/up-to-date)
skillseed sync --audit      # dry-run: show what would be pushed (no actual push)
```

---

## Priority

| Priority | Feature | Effort |
|----------|---------|--------|
| P0 | `skillseed init` sync setup (create/connect repo) | 1 day |
| P0 | `skillseed sync` manual command | 0.5 day |
| P0 | Sensitive file filtering | 0.5 day |
| P1 | Auto `git pull` on `serve` start | 0.5 day |
| P1 | Auto `git add` after `seed_log` | 0.5 day |
| P1 | Graceful shutdown commit+push | 0.5 day |
| P2 | 30-min background batch commit+push | 0.5 day |
| P2 | Conflict auto-resolution | 1 day |
| P2 | Offline/auth health in `status` | 0.5 day |

---

## Privacy & Security

- Repo is **private** by default — only the user can see it
- `skillseed init` explicitly tells the user: "This creates a **private** repository"
- Experiences with `sensitivity: confidential` or `private` are **never synced** (filtered before commit via frontmatter check + `sync: false` marker)
- User can run `skillseed sync --audit` to preview what would be pushed before pushing
- `.skillseed-marker` file identifies the vault repo for auto-discovery
