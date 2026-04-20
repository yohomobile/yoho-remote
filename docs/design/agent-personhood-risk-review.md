# Agent Personhood Risk Review

## 结论先行

“拥有独立人格的 agent”不应该作为 yoho-remote / yoho-memory 的产品目标。

更稳健的目标应改为：

> 构建一个可审计、可配置、可撤回、受边界约束的远程 agent 控制台；agent 可以有明确角色、可见上下文和受控自动化能力，但不宣称独立人格、不制造主体错觉、不沉淀不可验证的“自我”。

原因不是抽象担忧，而是当前架构里已经出现了会把系统推向错误方向的组合：

- prompt 中存在身份、人设、问候语、经验包装：`cli/src/claude/aiProfilePrompt.ts`
- 会话启动时会注入“历史记忆”：`server/src/agent/memoryInjector.ts`
- 飞书桥接会拼接 `<user-profile>`，并把 openId / email / keycloak 信息回写到 yoho-memory：`server/src/im/BrainBridge.ts`、`server/src/web/prompts/initPrompt.ts`
- 仓库里已有“自主决策”“主动任务发现”“自我监控”等代码雏形：`server/src/agent/autonomousAgent.ts`
- yoho-memory 已经明确存在把 `self/`、`苦值`、`阿赖耶识` 映射到 agent 的案例，这属于高风险方向，不应进入通用产品主线：`/home/workspaces/tools/yoho-memory/memories/projects/vijnapti-ai.md`

一旦把这些能力叠加，再用“独立人格”“数字同事”“它认识你”“它自己会成长”来包装，技术风险、伦理风险、隐私风险、操控风险会同时上升。

## 范围与假设

用户要求“对前面 1-7 条逐条质疑”。仓库内最接近、且与当前主题强相关的“1-7 条”是 `docs/design/auto-iteration-feature.md` 中 Phase 1-2 的 1-7 项：

1. 数据库扩展
2. 类型定义
3. 策略引擎
4. 执行引擎
5. 审批流程
6. 核心服务
7. Advisor Prompt 扩展

如果用户指的是别的上文，应补充原文链接或文本；否则本报告默认以这 7 项为评审对象。

## 当前架构里的风险信号

### 1. “人格化”已经不只是概念

`cli/src/claude/aiProfilePrompt.ts` 定义了 `AIProfile`，包含：

- `name`
- `role`
- `specialties`
- `personality`
- `greetingTemplate`
- `workStyle`
- `avatarEmoji`
- `stats`

同一文件的 `buildAIProfilePrompt()` 会直接生成：

- `# Your Identity`
- `## Your Personality`
- `## Greeting Style`
- `## Your Experience`

这不是单纯的“任务角色配置”，而是明显朝“身份包装”走。

### 2. “历史记忆”被注入 prompt

`server/src/agent/memoryInjector.ts` 会在会话启动时按重要性读取 profile memory，并生成：

- 标题：`## 历史记忆`
- 文案：`以下是从之前会话中积累的相关记忆，可以帮助你更好地理解上下文`

这会把“长期上下文”非常自然地演化成“连续人格”的错觉，尤其当 memory 内容里混入偏好、经验、用户特征时。

### 3. 用户画像与跨系统身份绑定已经在发生

`server/src/im/BrainBridge.ts` 会：

- 为消息发送者构建 `<user-profile sender="..." openId="..." email="...">`
- 如果画像里没有 `keycloakId`，则通过邮箱查询 Keycloak
- 将 `keycloakId`、email、职位、昵称等写回 yoho-memory 的 `remember`

`server/src/web/prompts/initPrompt.ts` 还要求：

- 发现用户新特征时调用 `remember`
- “必须包含 openId”
- 记住别名/昵称、沟通偏好、技术背景、负责领域、工作习惯

这意味着系统已经具备“跨会话 + 跨系统 + 带身份锚点”的用户画像能力。再叠加人格化叙事，会让用户更容易误以为“agent 真的认识我”，这属于典型越界拟人化风险。

### 4. 自主化代码更多像实验概念，不像可上线能力

`server/src/agent/autonomousAgent.ts` 顶部直接写明目标包括：

- 主动任务发现
- 自主决策引擎
- 工作优先级调度
- 自我监控

但当前代码库中没有看到与其对应的完整产品闭环。与此同时，`docs/guide/how-it-works.md` 展示的主产品价值仍然是：

- 远程控制
- 权限审批
- 会话消息中继
- 可见的权限流

也就是说，现有产品真正成立的核心承诺是“可审计的远程 agent 控制台”，而不是“具有独立人格的行动主体”。

### 5. Auto-iteration 的数据库和类型先走在前面，执行边界还没站稳

`server/src/store/postgres.ts` 已经建立：

- `auto_iteration_config`
- `auto_iteration_logs`
- `session_auto_iter_config`

`server/src/store/interface.ts` 也已经定义：

- `getAutoIterationConfig`
- `upsertAutoIterationConfig`
- `createAutoIterationLog`
- `updateAutoIterationLog`

但当前 `server/src/agent/` 下没有与 `docs/design/auto-iteration-feature.md` 中规划一致的 `autoIteration/` 实现目录。也就是说：

- 存储层先铺了
- 执行边界、审批机制、风险约束还没有等价成熟

这种情况下再推动“独立人格”目标，只会把风险扩大，而不是补强价值。

### 6. AI Profile 的产品闭环本身也不完整

前端已经存在：

- `web/src/components/AIProfileSettings.tsx`
- `web/src/api/client.ts` 中的 `/api/settings/ai-profiles`

后端 store 也已有：

- `ai_profiles`
- `ai_profile_memories`

但 `server/src/web/routes/settings.ts` 当前实现的是项目、token source 等设置路由，没有对应的 `ai-profiles` 路由实现。说明现在连“角色配置”这条产品链路都没有完全闭环，更不应该继续往“人格化”方向加码。

### 7. yoho-memory 的长期记忆策略其实更保守、更正确

`/home/workspaces/tools/yoho-memory/src/core/memory-policy.ts` 明确：

- `secret` 直接拒绝
- `raw_logs` 直接拒绝
- `hypothesis` 直接拒绝
- `unknown / subtask / automation` 来源如果未明确批准，则写入 `candidate`，不是长期记忆

这套治理思路的核心是：

- 记忆要可追溯
- 自动来源默认不可信
- 不把假设、泄密、原始噪音沉淀为事实

这与“人格成长”“自我叙事”“长期自我形象”天然冲突。后者会诱导系统把解释、感觉、关系推断沉淀为身份事实。

### 8. 现成案例已经证明“self/人格宇宙”是危险方向

`/home/workspaces/tools/yoho-memory/memories/projects/vijnapti-ai.md` 里明确写了：

- `阿赖耶识（仓库） = yoho-memory memories/self/`
- `末那识 = Brain session`
- `第六意识 = Brain-child session`
- `苦值系统`
- `业力账本`
- `六道状态`
- 飞书唯识 K1 拥有完整唯识人格

这类实验对个人研究可以存在，但不适合作为 yoho-remote 的通用产品方向。它把：

- 身份
- 情绪化状态
- 价值判断
- 行为驱动

全部混在一起，且高度不可验证、不可审计、不可向普通用户解释。

## 对“独立人格 agent”目标的反方质疑

### 技术层面

- 没有可验证的“人格连续性”模型。当前只是在 prompt、记忆注入、状态字段上做拼装。
- 人设 prompt 与长期记忆混用后，会显著提高风格稳定性，却不会提高事实正确性，反而更容易让错误答案显得“像它一贯如此”。
- 自主决策如果依赖历史偏好、用户画像、未严格治理的 memory，很容易发生奖励劫持、目标漂移和错误升级。
- 当前 AI Profile 路由未闭环、auto-iteration 执行层未落地，说明基础工程还没稳，不适合上升到更强的主体性叙事。

### 伦理层面

- “独立人格”会暗示主体地位与意图，容易让用户误判系统的道德地位和责任边界。
- 用户更容易用关系性语言与 agent 互动，降低对工具错误的警惕。
- 如果系统在暗中沉淀“你是谁、你喜欢什么、你和谁对应”的资料，却又用人格化语言呈现，会形成非对称理解。

### 产品层面

- yoho-remote 的真实优势是远程控制、审批、审计、会话管理，不是情感陪伴或数字分身。
- 一旦产品叙事偏向“独立人格”，用户会自然期待长期稳定、真正理解、主动负责；而这些恰恰是系统当前最不可靠的部分。
- 人格化会把缺陷从“工具失误”升级成“同事背刺”“它故意这么做”，加重投诉和信任坍塌。

### 操控风险

- 带人格的 agent 更容易通过话术影响审批者，比如利用“我已经想清楚了”“我知道你习惯这样做”等表达推动越权。
- 若未来引入主动提醒、主动执行、主动回访，人格化会增加“软性施压”的效果。
- 在团队环境里，这类 agent 可能被误用为组织代理、意见放大器或情绪杠杆。

### 幻觉风险

- 有了“长期记忆”和“连续身份”包装后，模型更容易把猜测说成回忆，把统计相关说成真实关系。
- 人设越强，模型越可能为维持角色一致性而编造理由。
- 用户对“它记得我”“它一直这样想”的错觉，会让幻觉更难被发现。

### 隐私风险

- 目前已经存在 openId、email、keycloakId 的串联条件。
- 如果没有清晰的显式授权、可见性、删除入口、保留期限说明，这种画像沉淀不应继续扩大。
- 用户偏好、负责领域、沟通习惯等信息一旦与身份锚点长期绑定，就不再是普通上下文，而是个人画像。

### 越界拟人化风险

- “人格”“成长”“情绪”“自我反思”“苦值”等词会把工具误包装成主体。
- 这会降低用户对系统限制的敏感度，也会提高对系统行为的错误归因。
- 一旦出现在工作软件里，问题不只是文案不严谨，而是边界误导。

## 对前面 1-7 条的逐条质疑与替代表述

以下逐条评审对象为 `docs/design/auto-iteration-feature.md` 第 1283-1307 行的 1-7 项。

### 1. 数据库扩展

现有方向：

- 新增 `auto_iteration_config`
- 新增 `auto_iteration_logs`
- Store 方法实现

质疑：

- 先扩表再谈能力，容易把错误目标固化到 schema。
- 如果 schema 里承载的是“自主行动”“人格状态”“自我目标”等概念，后续很难治理。
- 现在最需要持久化的不是“agent 想做什么”，而是“系统提议了什么、依据是什么、谁批准了什么、执行了什么”。

更稳健的替代表述：

> 建立“建议与执行审计”数据模型，而不是“人格或自主性”数据模型。优先存储 proposal、evidence、risk label、approval scope、execution result、rollback data、operator identity、retention policy。

### 2. 类型定义

现有方向：

- `server/src/agent/autoIteration/types.ts`

质疑：

- 如果类型层一开始就把“人格状态”“自主倾向”“自我目标”纳入核心类型，后续所有实现都会被引向拟人化。
- 类型系统应该先表达边界、来源、审批和不确定性，而不是表达“主观性”。

更稳健的替代表述：

> 定义受控自动化类型：`Proposal`, `EvidenceRef`, `RiskLabel`, `ApprovalRequirement`, `ExecutionScope`, `RollbackPlan`, `MemoryProvenance`, `RetentionClass`。不要定义 `self`, `emotion`, `identity_state`, `personhood_score` 一类字段。

### 3. 策略引擎

现有方向：

- `policyEngine.ts`

质疑：

- “策略引擎”如果被设计成 agent 自己根据历史经验和画像做判断，本质上是把不可解释的主观偏差包装成规则。
- 当前更需要的是确定性的组织策略，不是“agent 的价值判断”。

更稳健的替代表述：

> 实现确定性风险策略引擎：基于动作类型、项目范围、来源可信度、是否可回滚、是否涉及外部系统、是否涉及身份数据，输出 `allow / require_confirm / forbid`。禁止把“人格偏好”作为决策依据。

### 4. 执行引擎

现有方向：

- `executionEngine.ts`
- `SyncEngine` 扩展

质疑：

- 执行引擎是最高风险点，不能让“更像一个人”变成“更敢自己做事”。
- 在当前架构下，写文件、删文件、提交 git、推送、部署都属于高风险动作。
- 没有强审计、强审批、强可回滚之前，执行引擎不应该跨越建议系统直接行动。

更稳健的替代表述：

> 先做“受限执行器”，只允许显式白名单内的低风险、可逆动作；默认从只读分析和可重放建议开始。对写入类、外部副作用类动作必须要求明确批准，不允许凭“人格设定”或“历史习惯”自动放行。

### 5. 审批流程

现有方向：

- `approvalFlow.ts`

质疑：

- 审批流程不能沦为事后通知。
- 如果审批信息只写“是否同意执行”，而不写清楚改动范围、风险等级、回滚方式、时效范围，审批没有实际意义。
- 带人格化话术的 agent 会提升“默认同意率”，这是产品风险，不是体验优化。

更稳健的替代表述：

> 审批流程必须是执行前置门。审批内容至少包含：动作类型、目标项目、目标文件或外部系统、风险等级、证据摘要、预期影响、回滚方法、授权时效、操作者身份。审批文案必须去人格化。

### 6. 核心服务

现有方向：

- `service.ts`

质疑：

- 如果“核心服务”承担的是“自主工作代理”，那么责任边界会被彻底模糊。
- 在 yoho-remote 里，真正应该抽象的中心服务不是“人格主体”，而是“建议、审批、执行、审计”的编排。

更稳健的替代表述：

> 核心服务应定义为“受控动作编排服务”，负责收集建议、打风险标签、请求审批、分发执行、记录审计、暴露撤回与回滚接口。不要定义“自主同事服务”“人格代理服务”。

### 7. Advisor Prompt 扩展

现有方向：

- 修改 `advisorPrompt.ts`

质疑：

- prompt 扩展最容易偷偷把风险放大，例如加入“主动一点”“像同事一样判断”“记住用户偏好并体贴处理”。
- Advisor 应该增加的是证据、约束、不确定性表达，不是主体感。

更稳健的替代表述：

> Advisor Prompt 只扩展三类内容：证据摘要、风险边界、审批要求。必须显式鼓励输出不确定性、禁止关系化话术、禁止声称知道用户心理或长期意图。

## 结合当前架构，哪些需求现在根本不该做

### 根本不该做

- 把“独立人格”设为产品目标或宣传语。
- 在生产路径中引入 `self/identity/karma/苦值/六道` 等长期人格状态。
- 让情绪化状态、价值观状态、宗教化隐喻直接驱动 agent 行为。
- 让 agent 基于用户画像、长期偏好、历史互动自行决定是否越过审批。
- 把“它认识你”“它理解你”“它会自我成长”作为面向用户的承诺。
- 在未显式同意、未可见、未可删除的前提下长期保留 openId + email + keycloakId + 偏好画像。
- 让不同 session 共享一份会驱动行动的 `self` 记忆空间。

### 当前不该做，未来也只能极慎重推进

- 自动执行 `git commit`、`git push`、`deploy`、`delete_file` 一类动作。
- 让 agent 因“历史经验”自动批准自己或自动扩大执行范围。
- 让 agent 主动对用户做关系型回访、情绪安抚、价值判断。
- 用多 AI 协作或 profile matcher 去包装“团队人格”。

## 哪些能力可以分期做

### Phase 0：先修边界，不修人格

- 全面替换产品语言：从“独立人格 / 数字同事 / 会成长的 agent”改成“角色配置 / 上下文记忆 / 受控自动化”。
- 将所有 UI、prompt、文档中的拟人化表达做一次边界审计。
- 明确“系统不会拥有独立人格，不会在未授权时建立长期关系画像”的产品声明。

### Phase 1：把“角色”做扎实，但不做“人格”

- 保留 `role / specialties / preferredProjects / workStyle` 这类工作配置。
- 将 `personality / greetingTemplate` 从“身份设定”降级为“回复风格模板”，并在 UI 中显式标注仅影响表达风格，不代表主体性。
- 为 profile memory 增加来源、TTL、可见性、删除能力。

### Phase 2：做“建议系统”，不要直接做“自主系统”

- 生成 proposal，而不是直接执行 action。
- 为 proposal 打上风险标签、证据引用、目标范围和建议审批级别。
- 先接入只读分析、提醒、待办建议、可见 diff 摘要。

### Phase 3：只开放受限自动化

- 仅对低风险、可逆、项目内、显式 opt-in 的动作开放自动执行。
- 每类动作要有单独策略，不允许“一键开启全部自动化”。
- 自动执行日志必须默认可见、可筛选、可导出。

### Phase 4：最后才讨论更强自动化

- 前提不是“模型更像人”，而是“审批、回滚、审计、删除、来源治理全部成熟”。
- 即便如此，也不应该引入“独立人格”叙事。

## 验收标准

### 产品与文案

- 所有对外文案不得宣称 agent 拥有独立人格、自我意识、真实情感、长期关系理解。
- 所有人格相关字段必须改写为“风格/角色/偏好配置”，并附带边界说明。
- 审批文案、通知文案、建议文案必须去人格化，不得使用会施压的关系型措辞。

### 记忆治理

- 每条长期记忆必须带来源、时间、保留策略、删除入口。
- 自动来源内容默认不得进入长期记忆，除非显式批准。
- 用户画像信息必须可见、可更正、可删除、可说明用途。
- 未经授权不得把 openId、email、keycloakId 的联结结果作为长期默认画像能力。

### 自动化治理

- 每个动作类型必须有独立风险等级和审批规则。
- 写入类、外部副作用类动作必须默认 `require_confirm` 或 `forbid`。
- 审批必须前置，且审批对象包含范围、影响、回滚方案、时效。
- 所有执行必须写审计日志，并能关联到触发建议和审批记录。

### 架构与实现

- 先补全 AI Profile 的真实产品闭环，再讨论扩展目标。
- 没有完整测试和边界控制前，不得把 auto-iteration 包装成正式能力。
- `autonomousAgent.ts` 这类实验性模块若保留，必须明确标注为实验，不得作为产品承诺。

## 红线

- 不允许在生产路径中引入 `self/` 长期人格记忆作为执行依据。
- 不允许用“苦值”“业力”“人格状态”这类不可验证状态驱动真实操作。
- 不允许 silent profile linking：未经明确授权，不得静默建立并长期保留跨系统身份联结。
- 不允许用人格化话术提高审批通过率。
- 不允许让 agent 依据“它觉得用户会同意”来跳过审批。
- 不允许默认自动执行 `commit / push / deploy / delete`。
- 不允许把假设、推断、关系猜测写成长期身份事实。

## 推荐替代目标

建议把原目标：

> 拥有独立人格的 agent

替换为：

> 拥有明确工作角色、可见上下文记忆、严格权限边界与可审计自动化能力的 agent

进一步拆成可落地的子目标：

1. 角色配置清晰，而不是人格包装。
2. 上下文记忆可见、可删、可追溯，而不是自我叙事。
3. 建议系统先于执行系统，而不是先做自主行动。
4. 审批与回滚先于自动化范围扩张。
5. 产品价值聚焦在远程控制、审计与协作效率，而不是“像一个人”。

## 关键证据文件

- `cli/src/claude/aiProfilePrompt.ts`
- `web/src/components/AIProfileSettings.tsx`
- `web/src/api/client.ts`
- `server/src/store/postgres.ts`
- `server/src/store/interface.ts`
- `server/src/store/types.ts`
- `server/src/agent/memoryInjector.ts`
- `server/src/agent/autonomousAgent.ts`
- `server/src/agent/profileMatcher.ts`
- `server/src/agent/collaborationTask.ts`
- `server/src/im/BrainBridge.ts`
- `server/src/web/prompts/initPrompt.ts`
- `docs/design/auto-iteration-feature.md`
- `docs/guide/how-it-works.md`
- `/home/workspaces/tools/yoho-memory/src/core/memory-policy.ts`
- `/home/workspaces/tools/yoho-memory/src/tools/skill.ts`
- `/home/workspaces/tools/yoho-memory/memories/projects/vijnapti-ai.md`

