# Memory 管理设计

## 概述

Skillseed 的 memory 是一个**分层、分域、分级**的经验存储系统。不同于对话历史（LLM context window），Skillseed 的 memory 是持久化的、跨工具的、用户拥有的。

## Memory 分层架构

```
┌─────────────────────────────────────┐
│  Layer 3: Skills (Phase 3, 待实现)   │  ← 从经验提炼的可复用规则
│  "Azure AD 应用配置 checklist"        │     高抽象度，直接指导行动
├─────────────────────────────────────┤
│  Layer 2: Preferences                │  ← 用户偏好
│  "用中文回复" / "邮件风格简洁"         │     key-value，立即生效
├─────────────────────────────────────┤
│  Layer 1: Experiences                │  ← 原始经验
│  "Graph API Delegated 权限无需 admin" │     数量多，需搜索+排序
└─────────────────────────────────────┘
```

### 输出优先级

AI recall 时按层级返回，token budget 分配：

1. **Preferences** — 最优先，每次对话开头获取
2. **Skills** — 匹配当前任务的技能规则（Phase 3）
3. **Experiences** — 关键词/tag 搜索，score 排序

## Scope 分域体系

每条经验有一个 scope，决定其适用范围：

```
universal   全平台通用（Git 规范、通用调试原则）
  ↓
domain      特定技术栈（Python、Azure AD、Playwright）
  ↓
company     公司特定（内部流程、工具配置）
  ↓
team        团队特定（代码规范、review 流程）
  ↓
project     项目特定（架构决策、业务逻辑）
  ↓
personal    个人偏好（语言、风格）
```

### Scope 在 recall 中的作用

- 搜索时可指定 scope 过滤
- 未来计划：universal 经验只返回 title（通用原则不需要细节），project 经验返回全文（细节很重要）

### Scope 分类质量保障

**问题**：LLM 倾向于把所有东西标为 universal，导致 universal 被特定技术栈知识污染。

**三层防御**：

1. **Prompt 层**：EXTRACT_PROMPT 中明确定义每个 scope 的边界和反面示例
2. **代码层**：UNIVERSAL_BLOCKLIST（40+ 技术术语），universal + 特定技术 tag → 自动降级为 domain
3. **批量修正**：`harvest --reclassify` 用 LLM 重新分类，`--dedup` Phase 0 做前置修正

## 存储设计

### 为什么用 Markdown + YAML frontmatter？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **SQLite** | 查询快 | 不 human-readable，git diff 无意义 |
| **JSON** | 简单 | 大文件 git merge 困难 |
| **✅ Markdown** | human-readable，git-friendly，每文件独立 | 搜索需遍历 |

**选择理由**：
- 用户数据透明：`cat` 就能看，不依赖任何工具
- Git 同步友好：每条经验一个文件，merge 冲突可手动解决
- 性能够用：300 条经验全量搜索 < 50ms

### 目录 = Scope

文件存储路径反映 scope：

```
experiences/
├── universal/           → scope: universal
├── domain--general/     → scope: domain
├── project--unknown/    → scope: project
├── company--microsoft/  → scope: company, company: microsoft
└── personal/            → scope: personal
```

`moveExperienceScope()` 在 scope 变更时自动移动文件到正确目录。

### 文件命名

```
{date}-{slug}-{rand}.md
2026-04-28-graph-api-delegated-perm-a3f2.md
```

- `date`：创建日期
- `slug`：content 前 40 字符 slugify
- `rand`：4 字符随机后缀，防止 stdio 并发写冲突

## 搜索与 Recall 机制

### 搜索评分算法

```
score = 0

// Tag 精确匹配（权重最高）
for each query_tag matching experience_tag:
  score += 20

// 关键词匹配
for each query_word (去停用词后):
  if word in content: score += 10
  if word in tags: score += 15

// 加权
if category == "correction": score *= 1.5  // 纠错经验更重要
score += min(used, 10)                      // 使用频率
score += confidence * 5                     // 置信度

// 最低阈值
if score < 10: 丢弃
```

### Token Budget 智能分配

同一个 1500 token 预算下：

| Score | 返回内容 | Token 消耗估算 |
|-------|---------|---------------|
| ≥ 80（高分） | `title + 全文 content` | content.length / 3 + 30 |
| < 80（低分） | `[scope] [tags] title` | title.length / 3 + 30 |

**效果**：低分结果只占 ~20 token，同样预算能返回更多条结果。AI 看到 title 觉得有用，可通过 `detail` 参数获取全文。

### 停用词过滤

内置英文 + 中文停用词表（~80 词），防止 "the", "的", "是" 等无意义词产生假阳性。

## 敏感数据管理

### 自动脱敏

`writeExperience()` 写入前自动调用 `sanitizeContent()`：

**内置规则**：
- Azure tenant ID → `{{tenant_id}}`
- API key / token → `{{api_key}}`
- Bearer token → `{{bearer_token}}`
- Connection string → `{{connection_string}}`

**用户自定义规则**：`~/.skillseed/sanitize.json`

```json
[
  { "pattern": "my-secret-project", "replacement": "{{project_name}}" }
]
```

### 批量脱敏

`harvest --sanitize [--dry-run]` 扫描所有经验，应用脱敏规则。

## Sensitivity 分级

| 级别 | 含义 | 同步策略 |
|------|------|---------|
| `public` | 可公开分享 | 同步到 public repo |
| `internal` | 公司内部 | 同步到 private repo |
| `confidential` | 敏感 | 本地存储，不同步 |
| `private` | 个人隐私 | 本地存储，不同步 |

**推断逻辑**（rules.ts）：
- 包含 credential/token/ip-address → confidential
- 包含 corp/internal domain → internal
- 包含公司关键词 → internal
- 默认 → public

## 经验生命周期（Phase 4 设计）

```
创建 → 使用 → 衰减 → 归档/删除
  ↑                      |
  └── 被 recall 命中 ─────┘  (重新激活)
```

- **used 计数**：每次被 recall 命中 +1
- **confidence 衰减**：6 个月未使用 → 降低 confidence
- **staleness 审计**：`seed audit` 标记过期经验
- **offboard**：`seed offboard` 离职时清理公司数据

## 并发安全

- **stdio 模式**：文件名随机后缀防冲突
- **HTTP 模式**：单进程 Node.js，天然串行
- **sync**：git 作为分布式锁，merge 冲突手动解决
- **harvest**：harvest-state.json 每个文件处理后保存，Ctrl+C safe
