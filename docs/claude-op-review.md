# Claude Opus Review — Phase 2 & 3 Plan

Date: 2026-04-27

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
