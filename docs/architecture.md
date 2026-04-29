# Skillseed 架构总览

> Personal Work Experience Engine — 给所有 AI 工具加上经验记忆

## 核心理念

AI CLI 用完即走，不帮你积累经验。Skillseed 是一个本地 MCP server，捕获、结构化、积累你散落在各工具里的工作经验，让所有 AI 都能用。

**一句话定位**：Mars 管「谁来干活」，Cortana 管「在哪交互」，Skillseed 管「带着什么经验去干」。

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│            AI CLI / Agent 层（已有，不重造）            │
│                                                     │
│  Claude CLI    Gemini CLI    Copilot    Mars Agent   │
│     ↕              ↕           ↕           ↕        │
│              MCP Protocol (stdio/HTTP)              │
│     ↕              ↕           ↕           ↕        │
├─────────────────────────────────────────────────────┤
│                                                     │
│                  Skillseed MCP Server               │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐           │
│  │ seed_log│  │seed_recall│ │seed_pref │  ← Tools  │
│  └────┬────┘  └────┬─────┘ └────┬─────┘           │
│       ↓            ↓            ↓                   │
│  ┌─────────────────────────────────────┐           │
│  │         Service Layer               │           │
│  │  experience.ts  recall.ts  pref.ts  │           │
│  └─────────────┬───────────────────────┘           │
│                ↓                                    │
│  ┌──────────────────────┐  ┌──────────────┐        │
│  │    Brain Layer        │  │  Rule Engine │        │
│  │  invoker.ts (async)   │  │  rules.ts    │        │
│  │  LLM refine scope/tag│  │  regex/heur. │        │
│  └──────────────────────┘  └──────────────┘        │
│                ↓                                    │
│  ┌──────────────────────────────────────┐          │
│  │         Store Layer                   │          │
│  │  file-store.ts                        │          │
│  │  ~/.skillseed/experiences/**/*.md     │          │
│  │  Markdown + YAML frontmatter          │          │
│  └──────────────────────────────────────┘          │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────────────────────────┐          │
│  │         CLI Layer                     │          │
│  │  seed init / serve / start / status   │          │
│  │  seed harvest (提取 pipeline)          │          │
│  │  seed sync / clear / list             │          │
│  └──────────────────────────────────────┘          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## 代码结构

```
src/                          ~3,500 行 TypeScript
├── index.ts                  入口 (5 行)
├── server/
│   ├── mcp.ts                MCP server 初始化 (stdio + HTTP)
│   └── tools.ts              4 个 MCP tool 定义 (108 行)
├── service/
│   ├── experience.ts         seed_log 业务逻辑 (120 行)
│   ├── recall.ts             seed_recall 搜索 + token budget (72 行)
│   └── preference.ts         seed_preference get/set (17 行)
├── brain/
│   ├── rules.ts              规则引擎：scope/sensitivity 推断 (160 行)
│   └── invoker.ts            Brain CLI 异步调用 (87 行)
├── store/
│   └── file-store.ts         文件存储 + 搜索 + sanitize (373 行)
└── cli/
    ├── index.ts              CLI 路由 (358 行)
    ├── setup.ts              seed init 初始化 (400 行)
    ├── harvest.ts            提取 pipeline 核心 (1,474 行)
    └── sync.ts               git sync 封装 (555 行)
```

## 数据模型

### Experience（经验）

每条经验 = 一个 Markdown 文件，YAML frontmatter 存元数据：

```yaml
---
scope: domain            # universal|domain|company|team|project|personal
sensitivity: internal    # public|internal|confidential|private
category: correction     # good_practice|problem|correction|knowledge|preference
tags: [azure, graph-api, delegated-permissions]
title: "[Graph API] Delegated权限无需admin授权"
confidence: 0.8
source: conversation
source_cli: claude
created: "2026-04-20"
updated: "2026-04-28"
used: 3
---

Graph API 的 User.Read 用 Delegated permission 即可，不需要 Application 权限。
Delegated 权限的授权是用户级别的，不需要 admin consent。
```

### 目录结构

```
~/.skillseed/
├── config.json                    # 配置：brain_cli, transport
├── harvest-state.json             # harvest 增量状态
├── sanitize.json                  # 自定义敏感数据规则
├── experiences/
│   ├── universal/                 # 通用软件工程原则
│   ├── domain--general/           # 特定技术栈经验
│   ├── project--unknown/          # 项目特定经验
│   ├── company--unknown/          # 公司特定经验
│   └── personal/                  # 个人偏好
├── pending/                       # 待审核经验
└── skills/                        # (Phase 3) 技能文件
```

## MCP Tools（4 个）

| Tool | 触发时机 | 说明 |
|------|---------|------|
| `seed_log` | 用户被纠正、发现非显而易见的方案、描述项目约定 | 写入经验 |
| `seed_recall` | 写代码/配置前、被纠正后查历史、反复失败时 | 搜索经验，token budget 控制 |
| `seed_preference_get` | 开始生产输出时（代码/文档/邮件） | 获取用户偏好 |
| `seed_preference_set` | 用户说「记住/remember」+ 偏好类内容 | 设置偏好 |

### 路由机制

tool description 中嵌入正/负触发词，Claude/Gemini 根据 description 自动选择 tool：

- `seed_recall` description 含 "NEVER call when user says 记住/remember"
- `seed_preference_set` description 含 "Call when user says 记住/remember"
- 经验证，**tool description 权重高于 CLAUDE.md 指令文件**

## 双 Transport

| 模式 | 命令 | 场景 |
|------|------|------|
| stdio | `seed serve` | CLI 自动拉起，单客户端 |
| HTTP | `seed start` | 多客户端同时连接（Mars + CLI） |

## CLI 命令

| 命令 | 说明 |
|------|------|
| `seed init` | 检测 CLI、配置 MCP、创建 ~/.skillseed/ |
| `seed serve` / `start` | 启动 MCP server |
| `seed status` | 显示状态（经验数、sync 状态） |
| `seed list` | 列出所有经验 |
| `seed clear` | 清空经验 + harvest 状态 |
| `seed sync` | git pull + push 同步 |
| `seed harvest` | 从 CLI 历史提取经验（见 harvest-pipeline.md） |
| `seed harvest --dedup` | 两阶段去重（Jaccard + LLM 语义） |
| `seed harvest --export` | 导出为 Markdown |
| `seed harvest --sanitize` | 脱敏敏感数据 |
| `seed harvest --reclassify` | LLM 重新分类 scope |

## 技术栈

- **Runtime**: Node.js 20+, TypeScript 5.x
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **存储**: Markdown + YAML frontmatter (gray-matter)
- **搜索**: 关键词 + tag 匹配 + 分数排序（本地，无外部依赖）
- **LLM 调用**: execFileSync 调本地 CLI（claude/gemini），零 API key
- **同步**: git（用户自己的 private repo）
- **测试**: Vitest, 31 tests
- **发布**: npm pack → GitHub Release → `npm install -g`

## 版本历史

| 版本 | 里程碑 |
|------|--------|
| v0.1-v0.3 | MVP: MCP server + 4 tools + init + sync |
| v0.4.0-v0.4.2 | Harvest: CLI 历史提取 342 条经验 |
| v0.4.5-v0.4.8 | 质量：backfill titles, sanitize, CLAUDE.md routing |
| v0.5.0-v0.5.2 | Pipeline 大改：reclassify, dedup, 4 bug fix |
| v0.5.3 | 两阶段语义去重（Union-Find + LLM clustering） |
| v0.5.5 | Phase 2 完成：smart token budget |

## Phase 路线图

| Phase | 状态 | 说明 |
|-------|------|------|
| **1. MVP** | ✅ 完成 | 能装能用，MCP 双 transport |
| **2. Recall 优化** | ✅ 完成 | title 系统、score-based 返回、token budget |
| **5. Harvest** | ✅ 完成 | 提取+审核+去重+清洗+reclassify |
| **3. Skill 系统** | 🔜 下一步 | 从经验提炼可复用规则 |
| **4. 经验生命周期** | 待开始 | staleness, audit, offboard |
| **6. 自动 Skill 生成** | 待开始 | 经验模式检测 → 自动提炼 |
| **7. 扩展** | 远期 | 内存索引、SQLite、向量搜索 |
