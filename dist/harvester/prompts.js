/**
 * All LLM prompt templates as pure builder functions.
 * No side effects — easy to test and reuse.
 */
export function buildExtractPrompt(conversationText) {
    return EXTRACT_PROMPT + conversationText;
}
export function buildMergePrompt(experienceLines) {
    return MERGE_PROMPT + experienceLines;
}
export function buildReviewPrompt(existingSection, pendingSection) {
    return REVIEW_PROMPT + existingSection + "\n\nPending experiences to review:\n" + pendingSection;
}
export function buildTitlePrompt(experienceLines) {
    return TITLE_PROMPT + experienceLines;
}
export function buildReclassifyPrompt(experienceLines) {
    return RECLASSIFY_PROMPT + experienceLines;
}
export function buildClusterPrompt(experienceLines) {
    return CLUSTER_PROMPT + experienceLines;
}
// --- Raw prompt constants ---
const EXTRACT_PROMPT = `You are analyzing a conversation excerpt to extract work experiences worth remembering.

For each experience, output a JSON object on its own line with these fields:
- title: 中文标题（max 50 chars），仅技术专有名词保留英文。格式：[技术栈/模块] 现象与解决方案。例："[npm] Windows全局安装GitHub包失败的tgz方案"、"[Azure AD] 跨租户Graph API需admin consent"
- content: one clear sentence describing the lesson, practice, or solution (max 200 chars)
- category: one of "good_practice", "problem", "correction", "knowledge"
- tags: array of 2-5 relevant topic tags (lowercase)
- scope: one of "universal", "domain", "project", "company", "personal" — see strict rules below

Scope classification (STRICT):
- "universal": ONLY generic software engineering principles with NO specific framework/language/tool. Examples: Git commit规范, PR review最佳实践, 通用调试思路, 代码重构原则. If it mentions ANY specific tool (React, Python, Azure, npm, Playwright...), it is NOT universal.
- "domain": Experiences about specific PUBLIC technologies, frameworks, or tools that anyone can use. Examples: Azure AD auth, React hooks, Python packaging, npm config, Playwright tricks, Microsoft Graph API.
- "project": Experiences specific to OUR internal projects, repos, or business logic. Examples: Super-Agent-OS architecture, CTA bot design, OpenClaw conventions, skillseed development decisions.
- "company": Internal team conventions, company-specific processes, toolchain choices, org-specific URLs/configs.
- "personal": User preferences, habits, or personal traits.

Rules:
- Only extract NON-TRIVIAL, reusable insights that would help someone in the future
- Extract LESSONS and PRINCIPLES, not API documentation or code descriptions
- BAD: "Function X returns Y events" (this is API docs, not experience)
- GOOD: "Streaming APIs should expose typed events so consumers can filter by type" (this is a reusable lesson)
- Skip general knowledge anyone would know
- Skip test data, placeholder text, or debug artifacts (e.g. "Count test xxx", "test alpha")
- Skip descriptions of how specific code/APIs work — that belongs in code comments
- Focus on: mistakes made, corrections, workarounds, team conventions, debugging lessons, architectural decisions and WHY they were made
- Output ONLY JSON lines, no other text. If nothing worth extracting, output nothing.

Conversation:
`;
const MERGE_PROMPT = `Below are duplicate/similar experiences about the same topic. Merge them into ONE consolidated experience that captures ALL unique details.

Output a single JSON object with:
- title: 中文标题（max 50 chars），仅技术专有名词保留英文，格式：[技术栈] 现象与方案
- content: merged content preserving all unique details (max 300 chars)
- scope: best scope for this (universal/domain/project/company/personal)
- tags: merged unique tags

Output ONLY the JSON object, no other text.

Experiences to merge:
`;
const REVIEW_PROMPT = `You are reviewing harvested work experiences for quality. For each experience, decide:
- "approve": Useful lesson, debugging insight, correction, architectural decision, team convention
- "reject": API documentation, code description, too generic/obvious, duplicate of another experience listed
- "uncertain": Not sure — needs human review

Output one JSON object per line: {"id": N, "verdict": "approve"|"reject"|"uncertain", "reason": "brief reason"}

Existing experiences (for dedup):
`;
const TITLE_PROMPT = `Generate a short title (max 50 chars) for each experience below. Output one JSON object per line with "num" (the line number) and "title" fields.

Title rules: 中文为主，仅技术专有名词保留英文。格式：[技术栈/模块] 现象与方案。

Example output:
{"num": 1, "title": "[Graph API] 复用Bot凭据获取Token"}
{"num": 2, "title": "[Playwright] overlay弹窗阻塞点击的处理"}
{"num": 3, "title": "[Git] commit message规范与模板配置"}

Experiences:
`;
const RECLASSIFY_PROMPT = `Reclassify the scope of each experience below. Output one JSON object per line with "num" and "scope" fields.

Scope rules (STRICT):
- "universal": ONLY generic engineering principles with NO specific tool/framework/language. Example: "Git commit规范", "代码review原则"
- "domain": About specific PUBLIC technologies anyone can use. Example: "Azure AD", "React hooks", "npm", "Playwright", "Python"
- "project": About OUR internal projects/repos. Example: "Super-Agent-OS", "CTA bot", "OpenClaw", "skillseed"
- "company": Internal team/org processes, company-specific configs
- "personal": User preferences or personal traits

If the current scope is already correct, still output it. Output ALL items.

Experiences:
`;
const CLUSTER_PROMPT = `你是经验去重专家。下面列出的经验可能存在语义重复（用词不同但描述同一知识点）。

## 任务
1. 逐条阅读每个经验，用一句话概括其核心知识点
2. 对比所有概括，找出描述同一知识点的条目
3. 输出结果

## 输出格式（严格 JSON）
{
  "reasoning": [
    "条目1和条目4都在说：异常处理不应该静默吞错",
    "条目2和条目5和条目7都在说：npm从GitHub安装的tgz方案"
  ],
  "clusters": [[1,4], [2,5,7]]
}

- reasoning: 每组合并的理由（一句话说明共同知识点）
- clusters: 应合并的编号分组，每组至少2个编号
- 如果全部不重复，输出 {"reasoning": [], "clusters": []}
- 只输出 JSON，不要其他文字

条目列表：
`;
//# sourceMappingURL=prompts.js.map