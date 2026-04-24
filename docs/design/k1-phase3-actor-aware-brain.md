# K1 Phase 3: Actor-Aware Brain

更新时间：2026-04-24（UTC）

关联文档：

- [Agent Personhood Risk Review](./agent-personhood-risk-review.md)
- [K1 Product Language And Guardrails](./k1-product-language-and-guardrails.md)
- [Yoho Remote：基于原始 1-8 条需求的增强 / 改进 / 质疑矩阵](./agent-identity-1-8-matrix-2026-04.md)
- [Identity Graph](./identity-graph.md)

## 1. 一句话目标

K1 从“稳定角色 + 通用回复”升级为“能按当前 actor、团队和会话场景调整表达与上下文读取的 Brain”，但所有调整都必须可见、可审、可关、可评。

Phase 3 不把“人格”“关系”“情绪”整体判死刑。真正禁止的是：

- 把推断伪装成事实。
- 把观察假设静默注入生产 prompt。
- 用人格化叙事影响审批或真实执行动作。
- 让用户看不到系统正在依据什么调整行为。

换句话说，能开工的是可审计的适配层，不能开工的是秘密生效的人格化决策。

## 2. 架构位置

```text
识别层（Phase 2 已完成）
  知道当前 actor 是谁：Person / Identity / Attribution
        |
        v
适配层（Phase 3 核心）
  决定对这个 actor、团队、会话如何表达、读取和提示
        |
        v
治理层（贯穿 Phase 3）
  可见 / 可审 / 可关 / 可评
```

Phase 2 已经解决“谁在说话”和“由谁触发”。Phase 3 只回答“知道是谁之后，这些信息能怎样受控地影响 Brain”。

## 3. 分层原则

越硬、越显式、越可复核的信息，越可以进入热路径；越软、越推断、越像画像的信息，越应该进入候选池或审阅面板。

| 层级 | 能力 | 示例 | 是否进生产 prompt | 生效条件 |
| --- | --- | --- | --- | --- |
| 1 | 用户显式偏好 | “先给结论，少铺垫” | 是 | 用户或管理员显式填写，用户可关闭 |
| 2 | 团队共享事实 | “sgprod DB 端口改成 5433” | 是 | 管理员批准进入 team scope |
| 3 | 会话级临时状态 | “本会话在赶 ddl，回复简洁点” | 是，仅当前 session | 当前会话显式信号或用户确认 |
| 4 | 冲突记忆待决 | “端口 5432”和“端口 5433”冲突 | 否 | 管理员处理后才合并 |
| 5 | 系统观察假设 | “最近多次要求更短回复” | 否 | 只进观察面板；用户确认后才能升级为偏好 |
| 6 | 人格 / 关系 / 情绪假设 | “某人是急性子”“某人不信任系统” | 否 | 不直接驱动 prompt；最多作为可删除、可过期、可审阅假设 |
| 7 | Eval harness | golden set 回归与人工评分 | 不适用 | 每次策略或 prompt 变更后可运行 |

## 4. 六个子能力

### A. Communication Plan

目的：让 K1 对不同人使用不同表达方式，但事实、权限和安全边界保持一致。

范围：

- 按 `identityActor.personId` 读取一条 `communicationPlan`。
- 在 Brain init 或消息回复前，把计划作为短前缀注入 system prompt。
- Settings 增加“我的回复偏好”，支持用户自行编辑和一键关闭。
- 日志记录本次注入的 plan id、版本、来源和 actor。

硬边界：

- 只影响表达：结构、长度、解释深度、示例密度、正式度。
- 不参与工具调用判定、权限判定、审批判定。
- 不由 AI 自动推断后直接生效；自动观察只能进候选。
- 同一事实对不同人必须保持 factual invariance。

接入 Phase 2：

- Brain init 与消息 pipeline 直接从 `c.get('identityActor').personId` 读取 plan，复用 auth middleware 已经 resolve 好的 actor 上下文，不再额外查询。
- Feishu / Web / CLI 三端共用同一解析结果，因此 communication plan 的 lookup 与渠道无关。
- Plan 按 `(namespace, orgId, personId)` 存储，与 `persons` 表同一权威边界；person merge 时 plan 跟随到 target person。

建议 PR：

1. Store 增加 `communication_plans` 与审计字段。
2. API / Settings UI 支持查看、编辑、关闭个人回复偏好。
3. Brain init 注入 plan，并在 session log 里记录注入结果。

### B. Team Shared Memory

目的：把“个人记忆”扩展为“团队共享事实板”，让已批准的团队事实跨人可用。

范围：

- `remember` / `recall` 支持 `scope: personal | team`。
- team scope 绑定 `org_id`，personal scope 绑定 `person_id`。
- 团队部署步骤、人员分工、服务配置等进入 team scope。
- 个人回复偏好、私人工作习惯进入 personal scope。

硬边界：

- team 写入必须由管理员批准。
- team candidate 不允许自动晋升。
- 每条 team 记忆必须有 actor、来源、时间、审批记录。
- team 事实冲突时进入 Conflict Review，不在热路径猜测谁对。

yoho-remote 与 yoho-memory 的职责分工：

- yoho-remote 保留 scope 的权威治理：org_id / person_id 绑定、审批状态、actor audit 都落在 yoho-remote PostgreSQL 里，不回写到记忆文本。
- yoho-memory 侧只新增一个 `scope` 参数透传（`personal | team`），在同一 `namespace` 下存两个 sub-collection；默认 recall 仅读 personal，team 需要显式请求。
- 跨 person 的 team 记忆不进入 yoho-memory 的 personal 域，避免污染个人偏好 recall。
- 审批动作永远走 yoho-remote API，yoho-memory 不感知"已审批 vs 未审批"，只区分"personal vs team"两个物理域。

建议 PR：

1. Memory API 增加 scope 参数与权限检查（yoho-remote 侧）。
2. Store 增加 team memory provenance / audit 字段。
3. yoho-memory 透传 scope，新增 team sub-collection 同步能力。
4. Admin UI 增加 team candidate review。
5. Brain recall 分 personal/team 两段注入。

### C. Consolidation And Conflict Review

目的：让后台定期发现冗余、过期、冲突记忆，但不自动替管理员做最终合并。

范围：

- 后台 job 扫描 personal/team 记忆。
- 生成 conflict candidates：A 说 X，B 说 Y。
- `/self-system` 或管理员设置页增加 Conflict Review Panel。
- 管理员选择保留、废弃、合并或标记过期。

硬边界：

- job 只生成候选，不自动合并。
- 被 reject 的条目保留历史，不硬删。
- 合并、废弃、过期操作都写 actor audit。
- team scope 的 conflict 默认优先展示，避免污染多人 recall。

建议 PR：

1. Store 增加 `memory_conflict_candidates` 与 decision audit。
2. 后台 job 生成候选对。
3. Admin UI 复用 Identity Review Panel 的候选确认模式。

### D. Eval Harness

目的：用回归集判断策略变更是让 K1 更好还是更差。

范围：

- 从真实 session 中抽样构建脱敏 golden set。
- 覆盖 communicationPlan、team recall、conflict resolution、affect routing。
- 输出 factual consistency、wrong memory write、伪熟悉、伪共情、token cost、latency。

硬边界：

- 分数不自动阻断部署，只作为 review 信号。
- golden set 必须脱敏，person 名称和身份锚点要打码。
- 人工 judgment 保留最终解释权。

建议 PR：

1. 增加 golden set JSON schema 和脱敏脚本。
2. 增加本地 eval runner。
3. CI 或手动命令输出基线对比报告。

### E. Session Affect

目的：支持短时状态影响当前会话的回复节奏，不污染长期画像。

范围：

- 当前会话中用户明确说“我很急”“别解释太多”“先给命令”时，写入 session-only affect。
- affect 只影响回复长度、澄清频率、解释深度和节奏。
- 会话结束后自动丢弃，除非用户主动转成长期偏好。

硬边界：

- 不做心理诊断。
- 不写长期 persona。
- 低置信度 abstain。
- 只能影响表达方式，不能影响工具调用、权限或事实判断。

建议 PR：

1. Session state 增加 `sessionAffect`。
2. Brain prompt 增加 session-only 注入块。
3. UI 提供“本会话简洁 / 详细 / 默认”的显式切换。

### F. Observation Hypothesis Pool

目的：保留“系统能学习”的价值，但不让观察假设秘密生效。

范围：

- 系统可以生成观察候选，例如“你最近多次要求先结论”。
- 候选进入用户可见面板。
- 用户确认后，才升级为 communicationPlan。
- 用户可删除、忽略、关闭自动观察。

硬边界：

- 默认不进 prompt。
- 默认不进工具判定。
- 不写“人格标签”或“心理标签”作为事实。
- 高敏感观察需要 TTL，过期自动隐藏或降权。

建议 PR：

1. Store 增加 observation candidates。
2. Settings 增加“观察到的偏好建议”面板。
3. 确认后写入 communicationPlan，拒绝后保留 audit。

## 5. 推进顺序

推荐顺序：

1. A. Communication Plan：改动小，用户感知强，能验证整个分层框架。
2. C. Consolidation And Conflict Review：复用 Phase 2 candidate review 模式，风险低。
3. D. Eval Harness 最小版：后续 prompt / memory 变更需要基线。
4. E. Session Affect：只在 session 内生效，影响面可控。
5. B. Team Shared Memory：权限、审计和组织治理更重，放在基础 UI 稳定之后。
6. F. Observation Hypothesis Pool：最敏感，等治理链路完整后再做。

时间分期：

- 本季度必交项：A、C、D。这三项构成"适配生效 + 冲突治理 + 回归保底"的最小闭环，交付后 Phase 3 就具备"可见、可审、可关、可评"的完整骨架。
- 下季度交付项：E、B、F。这三项依赖前三项的治理面板、audit 表和 eval runner，先有基础设施再加上层能力。
- 单子能力预计 2-4 个 PR，六项合计约 16-18 个 PR；每个 PR 独立可 review、可回滚，避免一次性大合并。

## 6. 验收标准

通用验收：

- 用户能看到哪些策略正在影响自己的回复。
- 用户能关闭个人适配，回到默认风格。
- 管理员能追溯 team 记忆、冲突处理、观察升级的 actor。
- 自动来源内容不能绕过 candidate / review 直接进入长期可注入记忆。
- 所有热路径注入都有日志记录，至少包含 strategy id、scope、source、actor 和版本。

A 的验收：

- 同一个事实在不同 communicationPlan 下输出一致率 >= 98%。
- 用户关闭 communicationPlan 后，下一轮会话不再注入。
- 工具调用决策不读取 communicationPlan。

B 的验收：

- team memory 写入必须有 actor audit。
- 未批准 team candidate 不会进入 recall。
- personal 记忆不会被其他 person recall 到。

C 的验收：

- conflict job 不会自动合并。
- reject / keep / supersede 都可追溯。
- 被废弃条目仍可在历史中查看。

D 的验收：

- golden set 已脱敏。
- 每次策略变更能输出与基线的 diff。
- eval 报告包含分数、样本、失败原因和人工复核入口。

E 的验收：

- session affect 过期后不再注入。
- affect 不会写入长期 profile。
- 低置信或歧义输入不生成状态。

F 的验收：

- observation candidate 默认不生效。
- 用户确认后才升级为 communicationPlan。
- 用户可删除或关闭观察候选。

## 7. 非目标

Phase 3 不做这些事：

- 不把“独立人格”作为产品目标。
- 不让人格、情绪、苦值、关系猜测驱动工具调用或审批。
- 不用关系化话术推动用户批准操作。
- 不做自动心理诊断。
- 不把推断出来的性格分析写成长期事实。
- 不把 team memory 作为无需审批的共享真相源。

Phase 3 允许做的是受控适配：用户明确偏好、团队已审事实、会话级临时状态、候选观察、冲突审阅和评测闭环。

