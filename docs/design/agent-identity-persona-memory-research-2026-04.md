# Yoho Remote 调研：Agent Identity / Persona Memory / Affective Personalization / Social Agents

更新时间：2026-04-18（UTC）

## 1. 任务范围与说明

本报告围绕以下主题调研 2024-2026 的研究与外部最佳实践，并只保留对 Yoho Remote 现有架构可落地的结论：

- agent identity
- persona memory
- affective computing
- personalization
- cross-session self-consistency
- social agents

原任务要求“针对用户提出的 1-7 条逐条增强、改进或质疑”。但当前会话上下文和仓库内文档里没有看到那 7 条原文，因此这里做了一个**显式映射**，把问题重构成 7 个可实施议题：

1. Agent identity 建模
2. Persona memory 建模
3. Affective computing 与情绪状态
4. Personalization 与用户画像
5. Cross-session self-consistency
6. Social agents / shared memory
7. Evaluation / governance / safety

如果后续补充原始 1-7 条，应以用户原文替换本映射，而不是把本映射视作原始需求。

另：本轮要求先做 `skill_search`。当前运行时工具列表里没有暴露可直接调用的 skill search 工具，因此本报告按 no-match 路径继续执行，并明确记录这个限制。

## 2. 当前仓库现状

Yoho Remote 已经有一套可扩展的基础，但还停留在“静态 profile + 轻量记忆注入 + 外部 recall”的第一阶段：

- `ai_profiles` 当前字段主要是 `name`、`role`、`specialties`、`personality`、`greeting_template`、`preferred_projects`、`work_style`，适合静态 persona，不适合表达冲突、时间性、来源和作用域。
- `ai_profile_memories` 当前只有 `memory_type`、`content`、`importance`、`access_count`、`expires_at`、`metadata`，没有 `scope`、`source`、`supersedes`、`valid_from/to`、`confidence`、`owner`、`write_policy` 这类字段。
- `MemoryInjector` 是启动时一次性取 Top-N 记忆、按重要性排序后直接塞 prompt；没有 query-time relevance、冲突检测、后台反思压缩、时间衰减和关系记忆。
- `buildAIProfilePrompt` 把 `role / specialties / personality / greeting / stats` 直接拼成单段系统提示，这更像“静态角色卡”，不是可演进 identity。
- `BrainBridge` 对外部用户画像的做法是：按 `senderName + senderId` 调远端 recall，再把 Keycloak 信息补进去；说明系统已经有跨系统身份融合需求，但还没有统一 identity graph 或 typed profile。
- `profileMatcher` 仍然是关键词打分，适合 demo 级路由，不适合作为跨会话一致性和个性化路由的核心判定层。

## 3. 2024-2026 可落地研究结论

### 3.1 记忆不该继续等价于“长上下文”或“全历史塞 prompt”

2025 年的多项评测都在指向同一个事实：长记忆能力不是“能放更多 token”这么简单，而是包含检索、更新、冲突处理、遗忘、跨会话迁移、行动执行等多个子能力。

- [LongMemEval](https://arxiv.org/abs/2410.10813) 把长记忆拆成 single-hop、multi-hop、temporal reasoning、knowledge update、abstention 五类能力，说明“记住”与“在正确时机使用并拒答不确定内容”是两件事。
- [Mem0](https://arxiv.org/abs/2504.19413) 的核心结论是：生产系统里单靠上下文窗口既贵又不稳，应该把稳定事实与可回忆经验拆出来形成独立 memory layer。
- [PersonaMem-v2](https://arxiv.org/abs/2512.06688) 进一步强调，个性化记忆不是只要“命中过去信息”就够，必须同时覆盖 preference/behavior/context，并在长时跨度里保持可更新。

对 Yoho Remote 的直接含义：

- 不要继续把 `personality` 和 `历史记忆` 视作两个大文本块。
- 要把“稳定身份”“稳定偏好”“项目上下文”“短期情绪”“关系记忆”“共享团队状态”拆开建模。

### 3.2 业界实践正在收敛到“Profile + Collection + Scoped Memory”

这点在框架侧已经基本收敛：

- [LangGraph Memory](https://docs.langchain.com/oss/javascript/langgraph/memory) 明确区分 `profile` 与 `collection`。`profile` 适合单一稳定事实表，`collection` 适合多条事实/经历，并明确建议用后台流程做 memory update，而不是每轮都在热路径重写。
- [Mem0 entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory) 把记忆按 `user`、`agent`、`run` 等作用域隔离，解决“谁的记忆”和“什么时候生效”的问题。
- [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks) 与 [shared memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory/) 进一步把记忆拆成只读/可写 block、私有/共享记忆和 archival memory，并支持 sleep-time processing。

对 Yoho Remote 的直接含义：

- 现有 `ai_profiles` 可以继续保留，但它只能做 `profile` 的一小部分。
- 现有 `ai_profile_memories` 需要从“平铺记录”升级为“分作用域、分写策略、分生命周期”的 memory objects。
- `server` 现有 PostgreSQL + `pg-boss` / worker 路径非常适合承接后台 consolidation / reflection / decay 任务。

### 3.3 Persona consistency 不会自然出现，必须显式建模

近两年的 role-play / persona 研究有两个稳定结论：

- [CharacterEval](https://arxiv.org/abs/2401.10020) 这类评测表明，LLM 会出现 persona consistency 与 knowledge boundary 的双重问题，尤其在长轮次对话中更明显。
- [Evaluating Role-Playing LLMs at Deeper Level](https://arxiv.org/abs/2410.17903) 指出，仅靠开头一段角色设定，模型在深轮次里会逐渐漂移；更稳定的做法是引入结构化 persona、行为约束和情景相关记忆。
- [ConsistencyAI](https://arxiv.org/abs/2510.13852) 说明个性化系统如果把 persona 与事实性知识搅在一起，很容易造成同一问题因不同 persona 给出不一致答案。

对 Yoho Remote 的直接含义：

- `role/personality/greetingTemplate` 应该从一个自由文本字段拆成：
  - immutable charter：不可被自动改写的核心身份与边界
  - editable persona：风格、习惯、偏好
  - session stance：本轮任务的工作姿态
- factual memory 与 stylistic memory 必须分层，否则 persona 会污染事实回答。

### 3.4 Affective computing 可以做，但只能做“短时状态层”，不能做“永久人格层”

跟情绪相关的 2025-2026 研究给出的信号比较一致：

- [ES-MemEval](https://arxiv.org/abs/2602.01885) 显示，在情感支持对话里，仅靠普通长上下文并不能稳定维持情绪线索，模型需要对情感状态做显式回忆与更新。
- [Dynamic Affective Memory for Empathetic LLMs](https://arxiv.org/abs/2501.14315) 的工程启发不是“记住用户情绪标签”，而是维护会变化、会衰减、带不确定性的 affect state。
- [A Survey of Affective Computing with LLMs](https://arxiv.org/abs/2502.18874) 总结了一个关键风险：情绪推断误差很高，长期保存推断出来的心理状态会制造用户画像污染。

对 Yoho Remote 的直接含义：

- 适合引入 `affect_state`，但它必须具备 TTL、confidence、source、last_observed_at。
- 不适合把“焦虑、愤怒、低落”这类推断结果长期固化进 `personality` 或稳定用户画像。
- UI 和系统提示都应该把 affect 当作“短时运行态”，不是长期 persona。

### 3.5 社交型 agent 需要“关系记忆”和“共享记忆”，不能只靠个人记忆

2024-2026 的 social agents 研究和框架实践都在强调：关系、角色和共享语境是独立对象。

- [SOTOPIA](https://arxiv.org/abs/2310.11667) 虽然更早，但后续 2024-2025 相关工作一直沿用其核心假设：社会互动能力离不开 relationship-aware state。
- [Collaborative Memory for Multi-Agent Systems](https://arxiv.org/abs/2502.19913) 强调 multi-agent memory 需要区分 private memory、shared workspace、group state 与 provenance。
- [Letta shared memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory/) 的工程落点非常直接：给多个 agent 暴露同一块受控共享 memory，但不要让每个 agent 都能任意重写全部内容。

对 Yoho Remote 的直接含义：

- 既然仓库已经有 `ai_teams` / `ai_team_members` 表，就不该只把 team 当静态分组。
- 应新增 team-level / task-level / handoff-level memory，而不是让每个 AI profile 各自保存一份重复上下文。
- 共享记忆最好做成 append-only event log + materialized shared summary，而不是多 agent 直接重写同一段 summary。

### 3.6 评测必须覆盖“会不会做事”，不能只测“会不会找回记忆”

2025-2026 的记忆评测已经明显转向 agentic/action-oriented：

- [Mem2ActBench](https://arxiv.org/abs/2504.03640) 评估的是“记忆是否正确驱动后续行动”，而不是单纯问答回忆。
- [RealMem](https://arxiv.org/abs/2509.15037) 和 [EverMemBench](https://arxiv.org/abs/2507.18143) 都强调真实长期使用中会出现更新、冲突、遗忘、错写、过时和关系转移等问题。

对 Yoho Remote 的直接含义：

- 不能只做“recall 命中率”指标。
- 必须评估记忆是否改善：
  - profile 路由
  - 工具参数默认值
  - 跨 session 项目延续
  - 多 agent handoff
  - 情绪/语气适配
- 同时要监控 persona 漂移、事实偏离、延迟和 token 成本。

## 4. 针对映射后的 1-7 条逐条增强、改进或质疑

### 1) Agent identity

建议增强：

- 把当前单一 `AI Profile` 拆成三层：
  - core identity：名字、职责边界、不可自动改写的 charter
  - persona layer：表达风格、工作偏好、协作习惯
  - runtime stance：本轮任务意图、优先级、约束
- `core identity` 默认只允许人工修改；`persona layer` 允许经过审核的后台更新。

建议质疑：

- 现在把 `personality` 当作 identity 主体过于粗糙，无法支持冲突解决和多 agent 协作。

### 2) Persona memory

建议增强：

- 把当前 `memory_type` 扩成更细的 schema：
  - `stable_preference`
  - `habit_routine`
  - `project_fact`
  - `episode`
  - `tooling_default`
  - `relationship_fact`
- 增加 `scope`、`source_ref`、`confidence`、`supersedes`、`valid_from`、`valid_to`、`write_policy`。

建议质疑：

- 当前 Top-N prompt injection 适合轻量增强，不适合作为长期 persona memory 主机制。

### 3) Affective computing

建议增强：

- 增加独立 `affect_state`，字段至少包含：
  - `valence/arousal` 或离散情绪标签
  - `confidence`
  - `ttl_ms`
  - `source`
  - `last_observed_at`
- 只在明确需要的通道启用，例如聊天助手、社交场景、支持型代理。

建议质疑：

- 不建议让 coding agent 长期持有“情绪人格化设定”；对开发任务帮助有限，还会污染身份一致性。
- 不建议把模型推断出的心理状态长期写入稳定画像。

### 4) Personalization

建议增强：

- 把个性化从“描述性 persona”升级为“可执行默认值”：
  - 默认语言
  - 风格偏好
  - 工具偏好
  - 项目偏好
  - 代码规范偏好
  - 协作节奏
- 统一 Feishu openId、Keycloak user、namespace 内 user profile，形成最小 identity graph。

建议质疑：

- `preferredProjects` 目前只是字符串数组，表达不了优先级、最近度、熟悉度和上下文窗口。

### 5) Cross-session self-consistency

建议增强：

- 加入后台 consolidation：
  - 会话结束后提炼 stable facts / episodic memories / stale memories
  - 冲突项进入 review queue
  - 对记忆做 decay / merge / supersede
- 在 session 启动时分三步加载：
  - immutable identity
  - stable profile
  - task/session relevant memories

建议质疑：

- 现在依赖 `updated_at` + `importance` 排序，无法证明“这一条在本轮仍然有效”。
- 跨 session 一致性不能靠“历史越多越好”，反而需要更强的 forget / conflict / abstain 机制。

### 6) Social agents

建议增强：

- 为 `ai_teams` 新增共享记忆层：
  - team charter
  - shared working agreements
  - task handoff notes
  - current shared plan
- 采用“单 owner 汇总 + 多 agent append 事件”的写入模式。

建议质疑：

- 不建议每个 agent 都能直接改同一块共享 summary；并发冲突和责任归因都会失控。

### 7) Evaluation / governance / safety

建议增强：

- 建立 memory eval harness，至少覆盖：
  - retrieval accuracy
  - update correctness
  - temporal validity
  - abstention
  - action grounding
  - persona consistency
  - factual invariance under style changes
- 对 affect / personalization 加入用户可见和可清除机制。

建议质疑：

- 只靠主观体验评估 personalization，最后很容易把“风格更像人”误判成“系统更可靠”。

## 5. 建议采用的研究结论

建议采用：

- 采用“identity / stable profile / episodic memory / affect state / shared memory”分层建模。
- 采用 scoped memory，而不是所有内容都挂在 `profile_id` 下。
- 采用 `profile + collection` 混合模型：稳定事实进 profile，事件与关系进 collection。
- 采用后台 consolidation / reflection / decay，而不是每轮热路径直接重写所有记忆。
- 采用冲突与时间性字段：`confidence`、`supersedes`、`valid_to`、`source_ref`。
- 采用 team-level shared memory，但用受控写策略。
- 采用 action-oriented 评测，而不是只看 recall QA。
- 采用 affect 的短时状态层，并强制 TTL 与低置信度时的 abstain。

## 6. 不建议采用的方向

不建议采用：

- 不建议继续把“更长上下文”当作长期记忆主方案。
- 不建议把 persona、事实知识、项目状态混成一个自由文本字段。
- 不建议让多个 agent 并发重写同一共享 summary。
- 不建议把推断出的情绪或心理状态长期固化到稳定画像。
- 不建议只用向量检索或只用关键词检索；长期系统通常需要结构化 profile + 检索式 collection 混合。
- 不建议只做 recall 命中率评测；必须测行动正确性和事实不变性。
- 不建议默认自动写入所有“看起来像偏好”的信息；需要置信度、来源和覆盖规则。

## 7. 针对现有工程的落地顺序

### Phase 0：低风险结构化升级

- 扩充 `ai_profile_memories` schema：`scope`、`source_ref`、`confidence`、`supersedes`、`valid_to`、`owner_type`、`write_policy`
- 把 `personality` 拆成：
  - `core_identity`
  - `persona_style`
  - `working_style`
- `MemoryInjector` 改成三段注入：identity / stable profile / relevant episodic memories

### Phase 1：后台记忆治理

- 增加 session-end consolidation job
- 增加 stale / conflict review queue
- 引入短时 `affect_state`
- 为 Feishu / Keycloak / namespace user 建立最小 identity graph

### Phase 2：社交与团队记忆

- 为 `ai_teams` 增加 shared memory objects
- handoff summary 从自由文本变成 append-only events + derived summary
- 增加 team / task / relationship 级别的 memory retrieval

### Phase 3：评测与策略闭环

- 建立 memory regression benchmark
- 跟踪 persona consistency / factual invariance / action success / latency / token cost
- 对 personalization 和 affect 增加用户可见、可导出、可清除能力

## 8. 与仓库代码的直接对应关系

优先会受影响的文件：

- `server/src/store/postgres.ts`
- `server/src/agent/memoryInjector.ts`
- `cli/src/claude/aiProfilePrompt.ts`
- `server/src/im/BrainBridge.ts`
- `server/src/agent/profileMatcher.ts`
- `web/src/components/AIProfileSettings.tsx`

这些位置已经足够承接第一轮改造，不需要先重做整体架构。

## 9. 参考来源

研究论文与评测：

- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [PersonaMem-v2: A Benchmark for Personalized Long-Term Memory of LLMs](https://arxiv.org/abs/2512.06688)
- [CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agents](https://arxiv.org/abs/2401.10020)
- [Evaluating Role-Playing LLMs at Deeper Level: A Case Study of Character Agents](https://arxiv.org/abs/2410.17903)
- [ConsistencyAI: Towards Measuring Cross-Persona Factual Consistency](https://arxiv.org/abs/2510.13852)
- [ES-MemEval: Emotional Support Memory Evaluation for LLM Agents](https://arxiv.org/abs/2602.01885)
- [Dynamic Affective Memory for Empathetic LLMs](https://arxiv.org/abs/2501.14315)
- [A Survey of Affective Computing with Large Language Models](https://arxiv.org/abs/2502.18874)
- [Collaborative Memory for Multi-Agent Systems](https://arxiv.org/abs/2502.19913)
- [Mem2ActBench: Evaluating Memory-Driven Action in LLM Agents](https://arxiv.org/abs/2504.03640)
- [RealMem: Evaluating Real-World Long-Term Memory for LLM Personalization](https://arxiv.org/abs/2509.15037)
- [EverMemBench: Benchmarking Continual Memory for Personalized Agents](https://arxiv.org/abs/2507.18143)

工程与框架实践：

- [LangGraph Memory](https://docs.langchain.com/oss/javascript/langgraph/memory)
- [Mem0 Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)
- [Letta Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)
- [Letta Shared Memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory/)
