# Harvest Pipeline 设计

## 概述

Harvest 是 Skillseed 的经验提取引擎，从 AI CLI 对话历史中自动发现、提取、清洗、去重经验。

**核心文件**：`src/cli/harvest.ts`（1,474 行，Skillseed 最大的单文件）

## 完整 Pipeline 流程

```
     CLI 对话历史（~/.claude/projects/**/*.jsonl）
                    ↓
            ┌───────────────┐
            │  1. 发现文件    │  discoverHistoryFiles()
            │  增量追踪      │  harvest-state.json
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  2. 前置过滤    │  GARBAGE_PATTERNS (6 regex)
            │  丢弃垃圾数据  │  SKIP_PATTERNS (3 regex)
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  3. 分块       │  chunkConversation()
            │  20 turns/chunk│  启发式评分筛选高价值 chunk
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  4. LLM 提取   │  extractWithLlm()
            │  EXTRACT_PROMPT │  Claude/Gemini CLI 一次调用
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  5. 后置过滤    │  isGarbage(title+content)
            │  + Scope 强制  │  UNIVERSAL_BLOCKLIST 降级
            │  + Title 清洗  │  strip wrapping quotes
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  6. 实时去重    │  isDuplicateExperience()
            │  Jaccard 词法  │  Intl.Segmenter 中文分词
            │  重复 → LLM 合并│  MERGE_PROMPT
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  7. 写入 Pending│  writePending()
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  8. 审核       │  --auto-review (LLM)
            │  三档分流      │  --review (手动)
            │               │  --approve-all (全部通过)
            └───────┬───────┘
                    ↓
            ┌───────────────┐
            │  9. 入库       │  writeExperience()
            │  自动脱敏      │  sanitizeContent()
            └───────────────┘
```

## 阶段详解

### 1. 文件发现与增量追踪

```typescript
discoverHistoryFiles()
// 扫描 ~/.claude/projects/**/*.jsonl
// 返回: { file, project, size, mtime }

// harvest-state.json 记录每个文件的 mtime
// 只处理 mtime 变化的文件（增量）
// 每处理完一个文件就保存状态（Ctrl+C safe）
```

### 2. 前置过滤（Pre-Filter）

两层过滤，在 LLM 调用前丢弃垃圾数据：

**GARBAGE_PATTERNS**（正则，无 `^` 锚点，可匹配文本中间）：
```
Count test\b          # 测试残留
test\s+(alpha|beta)   # 测试标记
test\s+\d{10,}        # 测试+时间戳
(foo|bar|baz|lorem)   # 占位符
TODO:\s*$             # 空 TODO
placeholder           # 占位符
```

**SKIP_PATTERNS**（跳过无意义对话）：
```
^ping$
^(hi|hello|hey|你好|test)\s*$
^(yes|no|y|n|ok|好|是|对)\s*$
```

### 3. 分块与启发式评分

```typescript
chunkConversation(turns, file, project)
// 每 20 个 turn 一个 chunk
// 评分规则：
//   CORRECTION_PATTERNS (+3)  "不对|应该是|错了|fix"
//   LESSON_PATTERNS (+2)      "原来|学到|trick|root cause"
//   SOLUTION_PATTERNS (+2)    "solved|搞定了"
//   PROCESS_PATTERNS (+1)     "流程|步骤|pipeline"
// 只处理 score ≥ 2 的 chunk（过滤闲聊）
```

### 4. LLM 提取

**EXTRACT_PROMPT** 核心要求：

```
从对话中提取可复用的工作经验。每行输出一个 JSON：
{
  "title": "中文标题，专有名词保留英文",
  "content": "一句话经验 (max 200 chars)",
  "category": "good_practice|problem|correction|knowledge",
  "tags": ["tag1", "tag2"],
  "scope": "universal|domain|project|company|personal"
}
```

**Scope 分类严格定义**（在 prompt 中）：
- `universal`：必须与具体框架/语言/工具无关
- `domain`：特定公共技术栈（React, Python, Azure）
- `project`：内部项目/业务逻辑
- `personal`：个人偏好

### 5. 后置过滤 + Scope 强制

```typescript
// 5a. 垃圾过滤（检查 title 和 content）
if (isGarbage(obj.content) || isGarbage(obj.title)) continue;

// 5b. 最短内容检查
if (obj.content.length < 15 && !obj.tags?.length) continue;

// 5c. Title 清洗
obj.title = obj.title.replace(/^["']|["']$/g, "").trim();

// 5d. Scope 代码级兜底
const UNIVERSAL_BLOCKLIST = new Set([
  "python", "azure", "npm", "playwright", "teams", ...
  // 40+ 技术术语
]);
if (scope === "universal" && tags.some(t => BLOCKLIST.has(t))) {
  scope = "domain";  // 强制降级
}
```

### 6. 实时去重（写入时）

**分词器**：`Intl.Segmenter('zh-CN', { granularity: 'word' })`

```typescript
// v0.5.2 修复：旧版 split(/\s+/) 无法处理中文
// "npm发布需要2FA" → ["npm", "发布", "需要", "2fa"]（正确）
// 而不是 ["npm发布需要2fa"]（一个巨大 token）

isDuplicateExperience(newContent, newTags)
// 阈值: textSim > 0.6 || (textSim > 0.4 && tagSim > 0.5)
// 发现重复 → 调 MERGE_PROMPT 合并（不是丢弃！）
```

### 7-9. 审核与入库

**三档分流**（auto-review）：
- ✅ 高置信 → 自动入库
- ❓ 边界 → pending 等用户 review
- ❌ 明显垃圾 → 丢弃

**入库自动脱敏**：`writeExperience()` 调用 `sanitizeContent()` 替换敏感数据。

## 批量去重（harvest --dedup）

三阶段设计：

```
Phase 0: Scope 前置修正
──────────────────────
  UNIVERSAL_BLOCKLIST 扫描所有 universal 经验
  带技术栈 tag 的 → 降级为 domain
  实测: 33 条修正

Phase 1: Jaccard 词法聚类
──────────────────────────
  tokenize (Intl.Segmenter) + jaccardSimilarity
  阈值: textSim > 0.3 || (textSim > 0.2 && tagSim >= 0.6)
  每个 cluster → MERGE_PROMPT → 合并
  成本: 0 LLM 调用（纯本地）

Phase 2: LLM 语义聚类
──────────────────────
  Union-Find 按 tag 交集构建连通分量
  TAG_STOPWORDS 排除高频废词（bug, fix, error...）
  大分量(>15) 按 scope 拆分
  每组 → CLUSTER_PROMPT (Chain-of-Thought)
  → 输出 {reasoning, clusters}
  每个 cluster → MERGE_PROMPT → 合并
  成本: ~30 cluster + ~15 merge = ~45 LLM 调用
```

### 为什么不用 Embedding？

- 零新依赖（不需要 API key 或本地模型）
- LLM 直接判断语义比 cosine similarity 更准
- 已有 claude/gemini CLI，直接复用

### CLUSTER_PROMPT（Chain-of-Thought）

```
你是经验去重专家。

工作步骤：
1. 逐条概括核心知识点
2. 对比找出同一知识点的条目
3. 输出结果

输出格式：
{
  "reasoning": ["条目1和条目4都在说：异常处理不应静默吞错"],
  "clusters": [[1,4], [2,5,7]]
}
```

**CoT 的价值**：
- 防止索引幻觉（LLM 先概括再编号）
- reasoning 可用于 dry-run 人工审核
- 输出校验：filter 无效索引

### MERGE_PROMPT

```
将多条重复经验合并为一条：
- title: 中文标题（max 50 chars），格式：[技术栈] 现象与方案
- content: 合并所有细节（max 300 chars）
- scope: 最佳 scope
- tags: 合并去重
```

## 所有 Prompt 一览

| Prompt | 用途 | 调用位置 |
|--------|------|---------|
| EXTRACT_PROMPT | 从对话提取经验 | `extractWithLlm()` |
| MERGE_PROMPT | 合并重复经验 | `writePending()`, `dedup()` |
| CLUSTER_PROMPT | LLM 语义聚类 | `llmCluster()` |
| REVIEW_PROMPT | 自动审核 | `autoReview()` |
| TITLE_PROMPT | 批量生成标题 | `backfillTitles()` |
| RECLASSIFY_PROMPT | 重新分类 scope | `reclassify()` |

## 质量保障演进

| 版本 | 问题 | 修复 |
|------|------|------|
| v0.5.0 | scope 分类混乱 | EXTRACT_PROMPT 严格定义 + RECLASSIFY |
| v0.5.0 | 测试残留入库 | GARBAGE_PATTERNS + post-filter |
| v0.5.2 | 中文分词失败 | Intl.Segmenter 替代 split() |
| v0.5.2 | 重复经验被丢弃 | writePending → LLM merge |
| v0.5.2 | 过滤器漏网 | 去掉 `^` 锚点 + 检查 title |
| v0.5.2 | scope 无代码兜底 | UNIVERSAL_BLOCKLIST |
| v0.5.3 | 语义重复漏掉 | Union-Find + LLM clustering |

## 数据指标

| 指标 | 值 |
|------|-----|
| 总会话文件 | 683 |
| 提取经验 | ~300+ |
| Pipeline 代码 | 1,474 行 |
| LLM prompt | 6 个 |
| 内置 regex 规则 | 6 garbage + 3 skip + 6 heuristic |
| UNIVERSAL_BLOCKLIST | 40+ 技术术语 |
| TAG_STOPWORDS | 15 高频废词 |
| Dedup Jaccard 阈值 | textSim>0.3 或 textSim>0.2+tagSim≥0.6 |
| 实时 dedup 阈值 | textSim>0.6 或 textSim>0.4+tagSim>0.5 |
