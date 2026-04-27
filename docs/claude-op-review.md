# Claude Opus Review — Plan 意见汇总

Date: 2026-04-27 (初版)
Updated: 2026-04-27 (第三轮)

---

## Phase 2 意见

### 1. correction 加权需要定义权重

Plan 里只写了 "recall 排序：category: correction 经验加权"，没有具体数值。

建议：correction 经验 `score *= 1.5`。纠正过的错误比普通经验更有价值，1.5x 够了不会过度偏向。

在 `file-store.ts` 的 `search()` 函数里，`score > 0` 之后加一行：
```typescript
if (exp.meta.category === "correction") score *= 1.5;
```

### 2. 本地 query expansion（同义词）建议砍掉

当前经验量很小（目标 50+），同义词表维护成本高、收益低。tags 匹配 + 关键词匹配已经够用。

建议：删掉这条任务，等经验量到 200+ 再考虑。

### 3. 平台指令文件调研应该前置

"验证 Copilot/Codex/Gemini 是否读指令文件" 标了"调研，不实现"，但它决定了 `injectInstructions` 通用函数是否值得写。

建议：先做调研，再决定实现。如果某平台根本不读那个文件，就不需要注入函数。

已知信息：
- Claude CLI：`~/.claude/CLAUDE.md` **确认会读**
- Copilot CLI：`~/.github/copilot-instructions.md` 待验证
- Codex CLI：`~/.codex/instructions.md` 待验证
- Gemini CLI：`~/.gemini/GEMINI.md` 待验证

### 4. Copilot 检测逻辑有误

`setup.ts:25` 用 `gh --version` 检测 copilot，但 `gh` 是 GitHub CLI，不代表有 Copilot CLI。应该检测 `gh copilot --version`，或者干脆不管检测——只要需要注入就注入。

### 5. CLAUDE.md 注入内容已更新（确认）

当前 `setup.ts:160-182` 的内容已经与设计文档对齐，包含 "Do NOT call" 负面指导。确认 OK。

### 6. tools.ts description 已更新（确认）

Layer 1 的 tool description 已加入触发条件和负面指导，长度适中。确认 OK。

---

## Phase 3 意见

### 7. 3a（手动 Skill）方向正确，优先级对

从经验提炼 checklist/模板是核心价值。`seed_skill_create` + `seed_skill_get` + recall 返回 skills 层就够了。

### 8. 3b（Skill 发现 + 外部 registry）放太早

"分析经验 tags → 搜索外部 registry → 安装到所有平台" 需要外部 registry 存在并有内容，目前不现实。

建议：3b 移到 Phase 5+，或合并到 Mars 的 `skill-discovery-installer`，不在 Skillseed 做。

### 9. M3 检查点与 3a 不匹配

当前 M3 检查点写的是 "discover 能推荐出至少 1 个有用的外部工具"，但如果 3b 推迟了，这条就不成立。

建议改为："3 个手动 skill 被 AI 在实际任务中使用了"。

---

## Plan 文档本身的问题

### 10. seed_context 残留

Plan 第 246-249 行还有 `seed_context` 的描述，但已决定不做。应删掉或标注 ~~已取消~~。

### 11. Phase 4 sync 已实现但未标记

`skillseed sync` 在 v0.2.0 已完成（Phase 1），但 Phase 4 第 667 行仍标为待做。应标 ✅。

### 12. Phase 2 任务清单更新建议

```
- [x] 创建 docs/prompt-injection-design.md
- [x] 更新 tools.ts 4 个 tool description — v0.3.3
- [x] 更新 CLAUDE.md 注入内容 — v0.3.3
- [x] recall MIN_SCORE=10 — v0.3.3
- [ ] recall 排序：correction 加权 (score *= 1.5)
- [ ] 提取通用 injectInstructions(filePath) — 等调研结果
- [ ] 调研：Copilot/Codex/Gemini 是否读指令文件（前置）
- [x] ~~本地 query expansion~~ — 砍掉，经验量太少
- [ ] 验证：多平台实际使用效果
```

---

## 第二轮 Review（Plan 更新后）

> 基于 2026-04-27 最新 plan.md，确认已采纳的建议 + 新增内容意见。

### 已采纳确认

- ✅ correction 加权 score *= 1.5 — 标 ✅，v0.3.4
- ✅ query expansion 砍掉
- ✅ 3b 移到 Phase 5+
- ✅ M3 检查点改为 "3 个 skill 被 AI 使用"
- ✅ seed_context 标已取消
- ✅ sync 标 v0.2.0 已实现

### 13. Recall title 方案：seed_log 不要用 LLM 生成 title

新增的 title 字段设计方向对。但 seed_log 时生成 title 不应该用 LLM — seed_log 要快，规则截取 content 前 50 字符就够。LLM 留给 harvest backfill。

> ✅ 采纳。seed_log 规则截取，harvest 用 LLM。

### 14. backfill 342 条值得做，但要加 --dry-run

342 条不多，一次性批量处理。但 LLM 生成的 title 质量不可控，必须加 `--dry-run` 先预览再写入。

> ✅ 采纳。backfill + --dry-run。

### 15. score ≥ 80 阈值缺乏依据

80 是凭感觉还是有数据？建议先跑一轮实际 query 看 score 分布再定阈值。可以先 `skillseed recall --debug` 输出 score 分布。

> ✅ 采纳。跑了 4 个 query，top1=78~101，后面 53~78。80 大致把高相关和中等分开。先用，后续看数据调。

### 16. detail 参数和高分自动全文功能重叠

"seed_recall 支持 detail 参数"（AI 传 ID 取全文）和 "score ≥ 80 自动返回全文" 目标重叠。建议统一：**高分自动全文 + 低分给 title+ID，AI 可追查**。砍掉 detail 参数，少一个参数 = 少一个 AI 决策点。

> ⚠️ 部分采纳。保留 detail 参数但不在 tool description 中提及——AI 自然不会用，但留着作为逃生口（将来经验变长时可能需要）。

### 17. stop words 标 ✅ 但未确认实现

plan 标了 ✅ 但之前代码 review 没看到 stop words 逻辑。如果没实现就别标 ✅。

> ✅ 已确认实现。file-store.ts 第 49-63 行有完整 STOP_WORDS set + search 过滤逻辑。

### 18. Phase 5 Harvest 状态与实际不符

plan 里 Phase 5 harvest 全标 `[ ]`，但 342 条经验是 harvest 来的，说明 harvest 已经能跑了。应该更新对应任务状态。

> ✅ 采纳。Phase 5 已更新为 "核心已完成"，标记所有已实现的子任务。

### 19. plan.md 太长（874 行），建议拆分

"第一部分 CoT 推演"、"第六部分借鉴关系"、"第七部分隐私安全" 内容稳定，维护频率低。建议拆到 `docs/` 独立文档，plan.md 只保留数据模型 + 实施计划，控制在 400 行以内。

> ✅ 同意，后续做。不影响当前开发。

### 20. 平台调研仍未推进

Copilot/Codex/Gemini 指令文件调研从第一轮就提了，仍挂着。建议二选一：
1. 快速验证（装 Gemini CLI 试一下）
2. 决定只做 Claude（已验证），其他平台等用户反馈

> ✅ 采纳方案 2。只做 Claude，其他等用户反馈。砍掉通用 injectInstructions 函数。

---

## 第三轮 Review（Harvest 自动审核 + Plan 整体）

> 基于 2026-04-27 最新 plan.md（含 Harvest 自动审核设计、Phase 5 状态更新）。

### 21. LLM 二轮审核：批量处理 + 局部去重

方向对，95% 通过率说明第一轮提取质量不错，第二轮主要过滤 5% 垃圾。两个注意点：

- **批量审核**：不要一条一条调 LLM，应一次传 10-20 条批量判断，省 token 省时间。
- **去重范围**：审核 prompt 传"已有经验摘要"做去重，但 342 条全量摘要太长。建议只传同 tags 的经验做局部去重。

> ✅ 采纳。批量 10-20 条一次审核，去重只传同 tags 经验。

### 22. "自动通过"直接入库有风险

高置信自动入库 = 用户不知道入了什么。建议第一次跑自动审核时强制 `--dry-run`，让用户看一轮 LLM 判断质量。确认靠谱了再开自动入库。

> ✅ 采纳。首次自动审核强制 --dry-run，用户确认质量后才开自动入库。

### 23. 里程碑总览和实际进度不匹配

```
M1: 能装能用    →  Phase 1 ✅ (基本完成)
M2: 日常可用    →  Phase 2-3 (进行中)
M3: 完整闭环    →  Phase 4-6 — 但 Phase 5 harvest 已完成！
```

Harvest 提前完成了，但里程碑总览（486-495 行）还写"M3 = Harvest + 自动Skill"。实际上 M2 之前 harvest 就跑了。建议更新里程碑描述，体现实际进度。

> ✅ 采纳。更新里程碑描述。

### 24. seed_correct 还在 MCP Tools 设计里

第三部分（232-236 行）还列着 `seed_correct` tool，但设计决策已写"不做独立 tool"。应标 ~~已取消~~ 或删掉。

> ✅ 采纳。标记已取消。

### 25. 借鉴关系表有过时项

第六部分（784 行）写 `ContextBuilder → seed_context tool`，但 seed_context 已取消。应更新为 `→ seed_recall + seed_preference_get`。

> ✅ 采纳。更新借鉴关系表。
