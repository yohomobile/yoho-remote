# Yoho Remote：基于原始 1-8 条需求的增强 / 改进 / 质疑矩阵

更新时间：2026-04-18（UTC）

关联研究报告：

- [Agent Identity / Persona Memory / Affective Personalization / Social Agents 调研](./agent-identity-persona-memory-research-2026-04.md)
- [K1 Phase 3: Actor-Aware Brain](./k1-phase3-actor-aware-brain.md)

## 1. 说明

这一版不再使用我上轮抽象出来的 7 个议题，而是**严格对照用户补充的原始 1-8 条**逐条收束。

另外，本轮仍需说明一个执行边界：当前运行时工具列表里没有暴露可直接调用的 skill search 工具，因此本轮按 no-match 路径继续，但保留了这个限制记录。

2026-04-24 补充：本文的 Phase 0-3 是早期研究矩阵分期，其中“Phase 3：建立完整评测闭环”对应新版 [K1 Phase 3: Actor-Aware Brain](./k1-phase3-actor-aware-brain.md) 里的 D. Eval Harness 子能力。产品实施层面的 Phase 3 以 Actor-Aware Brain 文档为准。

## 2. 增强 / 改进 / 质疑矩阵

| # | 原始要求 | 增强 | 必要改进 | 应质疑 / 边界 | 当前架构落点 | 研究依据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | agent 要有自己的身份，如 K1，并基于 yoho-memory 的 skills/memory 形成性格、判断、喜好 | 把“K1”拆成 `core_identity`、`persona_style`、`judgment_policy`、`tool_preferences`、`habit_routines`、`memory_summary` 六层；其中 `core_identity` 只允许人工改 | skills 是能力/流程，不应直接等价于性格；memory 应该影响“偏好与经验”，不应无约束地改写判断边界 | 不要把“有身份”误做成“有真实自我意识”；不允许 memory 自动改写权限、安全边界、组织角色 | 扩 `ai_profiles` 与 `ai_profile_memories`；重构 `buildAIProfilePrompt` 与 `MemoryInjector`，把静态 persona 变成分层注入 | LangGraph Memory、Mem0、CharacterEval、ConsistencyAI |
| 2 | 必须建立在当前架构上，不能虚无 | 直接复用现有 PostgreSQL、`yoho-memory`、`BrainBridge`、`ai_teams`、SSE / Socket.IO、worker/`pg-boss` 路径 | 以“加字段、加 job、加 review queue、加 retrieval policy”为主，不引入新的虚构认知引擎 | 不建议先造独立“人格内核”服务；会把系统拆成无法验证的黑箱 | `server/src/store/postgres.ts`、`server/src/im/BrainBridge.ts`、`server/src/agent/memoryInjector.ts`、`web/src/components/AIProfileSettings.tsx` | LangGraph hot-path vs background memory、Letta sleep-time processing |
| 3 | 有自我就要认识别人，并记录事实、经验、对某人的性格分析 | 新增 `person_fact`、`interaction_episode`、`relationship_state`、`personality_hypothesis` 四类记忆；支持 `person_id` 维度 | 必须把“事实”“经验”“推断”“评价”分表或分 type；每条都带 `source_ref`、`confidence`、`valid_to` | 对“某人的性格分析”只能是低置信推断，默认可过期、可删除、可审计；不能把猜测伪装成事实 | 在 `ai_profile_memories` 旁新增 user/person memory object；`BrainBridge` 的用户画像 recall 改成 typed recall，不再只拼自由文本 | PersonaMem-v2、Collaborative Memory、Affective Computing Survey |
| 4 | 基于对每个人的认知，形成因人而异的对话方式 | 引入 `communication_policy`：直率度、解释深度、节奏、正式度、示例密度、是否先结论后细节 | 先个性化“表达方式”，不要个性化“事实真值”；对不同人只能改变说法，不应改变事实 | 不要滑向讨好型人格或操控型适配；当用户偏好未知时应回退到默认风格 | `BrainBridge` / session append prompt 里增加 communication policy block；web 增加可见的“对话风格偏好”设置 | LongMemEval、ConsistencyAI、Hightouch Golden Record / survivorship rules |
| 5 | 可借佛学唯识处理认知 | 可把唯识当作**认知分层框架**：`raw_signal -> interpreted_object -> self-observation -> seeds/habits -> current activation -> self-model` | 工程上应映射为“观察、推断、习惯、激活态、身份层”的 typed memory，而不是神秘概念直接入库 | 不建议把唯识当作真理判定器或推理引擎；它适合作为 schema 设计语言，不适合作为运行时真值来源 | 可在 memory schema 和 prompt 解释层使用，例如区分“现行状态”和“种子/习气” | LangGraph profile/collection 分层、Affective memory 研究；唯识部分为设计借鉴，不是外部技术规范 |
| 6 | 根据文字和蛛丝马迹感知用户情绪/状态，选择适合交流方式 | 增加短时 `affect_state`，字段包含 `state`、`confidence`、`ttl_ms`、`source`、`channel`、`last_observed_at`；只影响语气/节奏/澄清方式 | 把“观察到的线索”和“推断出的状态”分开记录；情绪模型默认短期有效，自动衰减 | 不能做精神诊断；低置信度必须 abstain；不得长期持久化“负面人格标签” | 在 `BrainBridge` / 用户画像 recall 旁增加 affect extractor；状态只写短时表，不写长期 persona | ES-MemEval、Dynamic Affective Memory、Affective Computing Survey |
| 7 | 支持跨飞书/remote/企业微信等渠道识别同一人，并有管理员确认机制 | 建立 `person_identity_graph`：`person_id` 为 canonical ID，渠道身份作为 linked identifiers；支持 deterministic link、probabilistic candidate、admin review、merge/unmerge audit | 先做确定性合并，再做概率候选；所有自动 merge 都要保留证据链、survivorship rules 和回滚路径 | 不建议用模糊信号直接自动合并真实用户；高风险场景必须 human-in-the-loop | `BrainBridge` 已有 Feishu + Keycloak 线索；可新增 `person_identities`、`identity_links`、`identity_merge_audit` 表，并在 web 提供管理员确认页 | Adobe Identity Graph、Snowplow Identities、Hightouch IDR |
| 8 | 基于网络前沿研究增强、改进或质疑前 7 条 | 采用“分层 identity + scoped memory + relation memory + affect TTL + shared memory + action eval”的研究结论 | 用后台 consolidation、conflict resolution、temporal validity、factual invariance 来给前 7 条加约束 | 研究并不支持“越像人越好”；反而反复提示要防 persona 漂移、事实污染、错误合并和伪共情 | 直接落在 schema、retrieval policy、review queue、eval harness、admin UI 上，而不是停留在 prompt 口号 | Mem0、PersonaMem-v2、LongMemEval、Mem2ActBench、RealMem、EverMemBench、Letta、LangGraph |

## 3. 分期建议

### Phase 0：把“身份”和“记忆”从单段文本拆开

目标：

- agent 身份从一个 `personality` 字段升级为分层 identity
- person/user 记忆从自由文本 recall 升级为 typed memory
- 建立最小的 cross-channel canonical `person_id`

建议范围：

- `ai_profiles` 增加：
  - `core_identity`
  - `persona_style`
  - `judgment_policy`
  - `tool_preferences`
  - `habit_routines`
- 新增 `person_identities` / `identity_links` / `identity_merge_audit`
- `ai_profile_memories` 增加：
  - `scope`
  - `subject_person_id`
  - `source_ref`
  - `confidence`
  - `valid_to`
  - `supersedes`
  - `write_policy`

验收指标：

- `core_identity` 被自动改写的次数为 0
- typed memory 抽样标注中，“事实/推断”分类准确率 >= 95%
- 跨渠道确定性自动合并 precision >= 99.5%
- 所有 merge 都能追溯来源事件和回滚记录

### Phase 1：加入关系记忆、沟通策略、短时 affect

目标：

- agent 能区分“他是谁”“我和他的关系如何”“我该怎么跟他说”
- 情绪/状态只影响交流策略，不污染长期 persona

建议范围：

- 新增 `relationship_state` / `personality_hypothesis` / `communication_policy`
- 新增短时 `affect_state`
- session 启动与消息发送前，分步注入：
  - agent core identity
  - person facts
  - relation state
  - communication policy
  - short-lived affect state

验收指标：

- personalized style 用户主观“更合适”占比 >= 70%
- factual invariance：同一事实在不同 persona / channel 输出一致率 >= 98%
- affect 触发后的“误判为负面标签并持久化”次数 = 0
- 关系推断类记忆中，低置信条目默认有 TTL，过期清理覆盖率 = 100%

### Phase 2：加入后台 consolidation、团队共享记忆与管理员治理

目标：

- 前台热路径不再承担所有记忆写入逻辑
- 多 agent / 多渠道共享记忆有治理和边界

建议范围：

- 新增 consolidation job
- 新增 conflict review queue
- `ai_teams` 增加 shared memory 与 handoff event log
- identity review UI 支持：
  - merge
  - reject
  - unmerge
  - source evidence 查看

验收指标：

- 自动 consolidation 后，被标为 stale 的长期记忆占比稳定下降
- shared memory 并发冲突导致的错误覆盖数趋近 0
- 管理员 review 平均处理时长 <= 5 分钟
- unmerge 后下游 profile 与 memory 能在一个发布周期内回滚完成

### Phase 3：建立完整评测闭环

目标：

- 不靠“感觉更像人”来验收
- 直接验证是否提升协作质量、跨会话一致性和安全边界

说明：此处是研究矩阵里的评测阶段，不代表产品 Phase 3 的完整范围；新版产品 Phase 3 还包括 communicationPlan、team memory、conflict review、session affect 和 observation hypothesis pool。

建议范围：

- 建立 memory eval harness
- 对 identity merge、relation memory、affect routing、communication policy 分别做回归集
- 每次模型/策略升级都跑 factual invariance、wrong-merge、wrong-memory-write、latency、token cost

验收指标：

- wrong persistent memory write rate < 1%
- probabilistic identity 候选 top-1 precision >= 90% 且默认不自动合并
- cross-session persona drift 下降趋势明确
- 人工抽检中“伪共情 / 伪熟悉 / 伪记忆”问题持续下降

## 4. 应避免的伪人格化风险

### 4.1 把“有更多记忆”误当成“有更强自我”

风险：

- 实际只是历史堆积，不是稳定 identity
- 会导致输出更像角色扮演，而不是更可靠

约束：

- core identity 单独建模
- 长期记忆必须可审计、可冲突、可遗忘

### 4.2 把“对人的推断”伪装成“对人的事实”

风险：

- “他脾气差”“她很懒”“此人焦虑”这类推断一旦持久化，很容易形成长期偏见

约束：

- 事实、经验、推断、评价分层
- 推断类默认低置信、可过期、可人工删除

### 4.3 把“情绪识别”做成“精神诊断”

风险：

- 文字线索只能支持交流策略调整，不能支持稳定心理画像

约束：

- affect state 只短期有效
- 低置信度直接 abstain
- 不做长期“心理标签”写入

### 4.4 把“个性化”做成“对不同人说不同事实”

风险：

- persona 和 personalization 可能污染 factual consistency

约束：

- 允许改变语气、结构、解释密度
- 不允许改变事实真值和组织边界

### 4.5 把“跨渠道同人识别”做成“模糊自动合并”

风险：

- 一旦把两个人合并错，后续 memory、权限、关系、语气都会污染

约束：

- 自动 merge 只允许高置信确定性规则
- 概率候选只给管理员看，不直接生效
- 所有 merge 支持 unmerge 和审计

### 4.6 把“佛学唯识”做成“技术真理”

风险：

- 容易把设计隐喻误当成系统真实性证明

约束：

- 唯识只作为 schema 与认知分层的启发
- 真正生效的仍是结构化数据、检索策略、审核机制和评测

## 5. 这轮最重要的研究性结论

最该采用的：

- 身份必须分层，不要再用单个 `personality` 字段承载一切
- 记忆必须 typed、scoped、temporal、auditable
- 个性化主要作用在表达与协作策略，不应作用在事实真值
- 对人的性格分析和情绪识别只能作为可衰减推断，不是永久事实
- 跨渠道 identity graph 应该先 deterministic，再 probabilistic candidate，再 admin confirm

最该警惕的：

- “越像人越高级”是伪目标
- “更会回忆”不等于“更会协作”
- “更有性格”不等于“更可信”

## 6. 参考来源

前沿研究：

- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [PersonaMem-v2: A Benchmark for Personalized Long-Term Memory of LLMs](https://arxiv.org/abs/2512.06688)
- [CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agents](https://arxiv.org/abs/2401.10020)
- [ConsistencyAI: Towards Measuring Cross-Persona Factual Consistency](https://arxiv.org/abs/2510.13852)
- [ES-MemEval: Emotional Support Memory Evaluation for LLM Agents](https://arxiv.org/abs/2602.01885)
- [Dynamic Affective Memory for Empathetic LLMs](https://arxiv.org/abs/2501.14315)
- [A Survey of Affective Computing with Large Language Models](https://arxiv.org/abs/2502.18874)
- [Collaborative Memory for Multi-Agent Systems](https://arxiv.org/abs/2502.19913)
- [Mem2ActBench: Evaluating Memory-Driven Action in LLM Agents](https://arxiv.org/abs/2504.03640)
- [RealMem: Evaluating Real-World Long-Term Memory for LLM Personalization](https://arxiv.org/abs/2509.15037)
- [EverMemBench: Benchmarking Continual Memory for Personalized Agents](https://arxiv.org/abs/2507.18143)

工程与产品实践：

- [LangGraph Memory](https://docs.langchain.com/oss/javascript/langgraph/memory)
- [Letta Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)
- [Letta Shared Memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory/)
- [Adobe Identity Service](https://experienceleague.adobe.com/en/docs/experience-platform/identity/home)
- [Snowplow Identities Concepts](https://docs.snowplow.io/docs/identities/concepts/)
- [Hightouch Identity Resolution Overview](https://hightouch.com/docs/identity-resolution/beta/overview)
