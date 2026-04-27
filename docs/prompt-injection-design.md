# Skillseed Prompt Injection — Design Document

## Goal

Tell every AI platform **when** to use Skillseed tools, without wasting tokens on simple tasks.

---

## Design Decisions

- **多平台指令注入：只做 Claude CLI**（已验证），其他平台（Copilot/Codex/Gemini）等用户反馈再做
- ~~通用 `injectInstructions()` 函数~~ — 不做，只有一个平台不需要抽象
- **Skillseed 与 AI 内置记忆是互补关系** — 不对立、不替代。Claude 记忆管当前工具会话，Skillseed 管跨工具持久化，两者都用

---

## Two-Layer Strategy

### Layer 1: Tool Descriptions (tools.ts)

**Covers all platforms automatically** — any MCP client reads tool descriptions.

每个 tool 的 description 包含正面触发条件 + 负面指导（"Do NOT call for..."），避免 AI 对简单问题/打招呼也调 tool。

```typescript
// seed_log
"Record a work experience or lesson learned. Call when:
(1) user corrects you,
(2) a non-obvious solution is found after debugging,
(3) user describes project-specific processes, conventions, or architecture decisions,
(4) user explicitly asks to remember something.
Do NOT call for trivial facts or well-known information."

// seed_recall
"Search past work experiences. Call when:
(1) writing code or configs and need project-specific context,
(2) user corrected you — check for similar past corrections,
(3) stuck or failing repeatedly.
Do NOT call for simple questions, greetings, or general knowledge."

// seed_preference_get
"Get user preferences. Call once at start ONLY if producing output (code, docs, emails).
Do NOT call for simple Q&A or greetings."

// seed_preference_set
"Set a user preference. Use when the user expresses a consistent preference
about how they like things done."
```

### Layer 2: CLAUDE.md Instruction File

Injected by `seed init` into `~/.claude/CLAUDE.md`，用 `<!-- skillseed-start/end -->` marker 包裹。

核心设计要点：

1. **与内置记忆协作**：明确告诉 AI "Skillseed persists across ALL AI tools"，让 AI 在用自己记忆的同时**也**调 seed tool
2. **seed_preference_set 排第一位**：这是用户最直觉的需求（"记住 X"），排在最前确保 AI 优先看到
3. **列出触发关键词**："remember"、"记住"、"记得" — 减少 AI 判断歧义
4. **强制要求**："ALWAYS call this tool in addition to your own memory. Do NOT just say 'ok' without saving."

当前注入内容（v0.4.3）：

```markdown
<!-- skillseed-start -->
## Skillseed — Work Experience Memory

You have access to the user's work experience library via Skillseed MCP tools.
Skillseed persists experiences across ALL AI tools (Claude, Copilot, Gemini, etc).
When the user wants something remembered, ALSO save it to Skillseed so other tools can access it too.

**When to call seed_preference_set:**
- When the user says "remember", "记住", "记得", or asks you to always/never do something
- When the user states a language, style, or behavior preference
- ALWAYS call this tool in addition to your own memory. Do NOT just say "ok" without saving.

**When to call seed_log:**
- When the user corrects you (category: correction)
- When a debugging session reveals a non-obvious solution
- When the user describes project-specific processes, conventions, or architecture decisions
- Do NOT log trivial or well-known facts

**When to call seed_recall:**
- Before writing code, configs, or technical documents
- After the user corrects you (check for similar past corrections)
- When stuck or failing repeatedly on a task
- Do NOT call for simple questions, greetings, or general knowledge

**When to call seed_preference_get:**
- Once at start of conversation, ONLY if producing output (code, docs, emails)
<!-- skillseed-end -->
```

---

## Recall Quality Optimizations

### Stop Words 过滤

`file-store.ts` 中维护 STOP_WORDS set（~100 英文 + ~25 中文常见词），搜索时过滤：
- 过滤 stop words
- 过滤长度 ≤ 2 的词
- 防止 "hello how are you" 这类 trivial query 返回假阳性

### Score-Based Response

| Score | 返回内容 | 说明 |
|-------|---------|------|
| ≥ 80 | 全文 content | 高匹配，直接给 AI 用 |
| 10-79 | 摘要（120 字符截断）+ experience ID | 中等匹配，AI 可用 detail 参数追查 |
| < 10 | 过滤掉 | 不相关 |

- `detail` 参数保留但不在 tool description 中提及，AI 自然不会主动用，作为逃生口
- 80 阈值基于实际 score 分布（top1=78~101，后面 53~78），先用后调

### Correction 加权

`category: correction` 的经验 `score *= 1.5`，纠正过的错误比普通经验更有价值。

### Summary 精简

去掉了 `confidence/used/created` metadata，每条省 ~30 字符 token。

---

## Deduplication

CLAUDE.md injection 使用 `<!-- skillseed-start/end -->` marker：

1. Markers 存在 → 替换中间内容
2. 不存在 → 追加到文件末尾
3. 文件不存在 → 创建文件

`seed init` 可安全重复运行，更新不重复。

---

## Future: Title System (Phase 2 进行中)

当前摘要 = content 截断 120 字符，不够精炼。计划为每条经验生成 `title`（30-50 字符）：

- harvest 时 LLM 同时生成 title
- seed_log 时规则截取 content 前 50 字符
- recall 返回：高分 title+全文，低分 title only
- 同样 token budget 下能展示更多结果

## Future: Skill-Driven Triggers (Phase 3)

When Skills are implemented, the prompt injection content will be enhanced:

```markdown
**Active Skills (auto-loaded):**
- Azure Pipeline: When writing CI/CD configs, always check past pipeline experiences
- PR Review: When reviewing PRs, recall team coding standards

Call seed_recall with relevant skill tags for targeted context.
```
