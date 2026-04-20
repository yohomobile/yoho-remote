# 08 · 命名与架构主轴纠偏(Errata)

> **状态**:修正性文档。本文处理 **命名与分类维度** 的纠偏;更进一步的 **Hosted vs External 分野**(M4/H2 是外部 peer,**永远不开 remote session**,走 capability 接口)由 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 作权威定义;所有 runtime / capability 动作的 policy + approval 约束由 [`10-approval-and-policy.md`](./10-approval-and-policy.md) 作权威定义。三篇并读,**10 ≈ 09 > 08 > 00–07**。
>
> **触发原因**:用户澄清 —— K1 / M4 / H2 不是同一层对象,也不应作为架构主轴;并进一步澄清 M4 / H2 是 **外部 agent 系统**,remote **永远不为其开 session**(不存在默认不开 / 例外可开这种口径);同时明确 policy + approval 是架构级能力,不是某 runtime 的私有功能。

## 8.1 背景:之前错在哪

00–07 的设计里我写了两个错误前提:

1. 把 K1 定义为 "Brain 里的稳定 AI 人格" —— **错**。K1 是飞书 bot 的接入名,不是人格。
2. 把 K1 / M4 / H4 并列成 "三个候选 runtime" —— **错**。它们不在同一层:
   - K1 是某个 IM 渠道上的 bot 身份;
   - M4 是 OpenClaw 接入 remote 的集成名;
   - H2(之前误写为 H4)是 Hermes 接入 remote 的集成名。
3. Hermes 集成的代号是 **H2**,不是 H4。全套文档中所有 `H4` 应读作 `H2`。

结论:**K1/M4/H2 不构成架构主轴**,下面 8.3–8.5 给出正确的轴线与分类。

## 8.2 五类术语的定义(先把层分开)

| 类别 | 定义 | 生命周期 | 典型配置粒度 |
| --- | --- | --- | --- |
| **channel**(渠道) | 外部 IM 平台或等价物,承担消息收发。例:飞书、钉钉、Slack、WhatsApp | 平台侧,长期稳定 | per channel app |
| **runtime**(运行时) | 真正执行 AI 推理、产出回复的后端系统。例:Brain-local(spawn Claude Code / Codex)、OpenClaw、Hermes | 由实现/部署决定 | per runtime 类型 |
| **bot-surface**(Bot 表面) | 用户在某个 channel 上看得见的 bot 身份(名字、头像、app_id)。一个 bot-surface 属于一个 channel,但可能映射到多个底层组合。例:"K1"在飞书是一个 bot-surface | per deployment | per (channel, app) |
| **persona / profile**(人格/画像) | 注入给 runtime 的 system-prompt 片段 + 记忆上下文,决定"这个 bot 像谁"。例:K1-persona、vijnapti-profile | per profile 定义 | per persona doc / yoho-memory profile |
| **integration-bundle**(集成包) | 把上述几类绑在一起、可独立部署的最小单位。含:(channel app + runtime 选择 + 默认 persona + namespace + 凭证引用)。例:"K1 在某 namespace 的飞书部署" | per 部署实例 | 通常 1 bundle = 1 row in `brain_config.extra.channels[]` |

**关键区分**:
- **channel** 讲的是外部平台(Feishu、DingTalk)——物理/平台侧常量。
- **runtime** 讲的是 AI 后端(Brain-local、OpenClaw、Hermes)——由我们选择怎么实现。
- **bot-surface** 讲的是用户看到的那个"机器人账号"——channel 内的命名实体。
- **persona** 讲的是 bot 说话的风格和知识——可复用、可换。
- **integration-bundle** 把前四者粘起来落到 namespace 上——部署粒度。

一个 bundle 的例子(K1 当前形态):
```
channel         = feishu
channel_app     = <飞书 K1 应用的 app_id>
bot_surface     = K1(飞书端展示名)
default_runtime = brain-local
default_persona = k1-persona(yoho-memory 里的 self-system 定义)
namespace       = yoho-mobile
credentials     = vault://feishu/yoho-mobile
```

## 8.3 K1 / M4 / H2 / 飞书 / 钉钉 的正确分类

| 名字 | 归类 | 说明 | 是 runtime 吗 | 是 channel 吗 |
| --- | --- | --- | --- | --- |
| **飞书** | **channel** | Lark/Feishu 平台本体 | ✗ | ✓ |
| **钉钉** | **channel** | DingTalk 平台本体(未接) | ✗ | ✓ |
| **K1** | **hosted bot-surface** + **hosted integration-bundle**(当前只有一份) | remote 托管的飞书 bot;bundle = (飞书 + brain-local hosted runtime + k1-persona + <某 namespace>)。未来可能有"K1 在钉钉" / "K2"等新 hosted bundle。走 remote 完整 hosted path(见 04 章) | ✗(K1 是 bot,背后的 hosted runtime 是 brain-local) | ✗(K1 在 channel 之内,不是 channel 自身) |
| **M4** | **external runtime peer** / **capability client**(见 09 章) | OpenClaw 是独立的外部 agent 系统,有自己的调度器、skills、IM bot。M4 是这个外部系统在 remote 侧的**调用方身份标识**(app token / client id)。**不是** remote 的 runtime 实现,也**不**通过 `RuntimeAdapter` 接入 | ✗(不是 remote 的 runtime;是 remote **之外** 的 runtime peer) | ✗ |
| **H2** | **external runtime peer** / **capability client**(见 09 章) | Hermes 是独立的外部 Python agent。H2 是其在 remote 侧的调用方身份标识。与 M4 同层 —— 都是 remote 的外部同事,不是 remote 的内部 runtime | ✗(同 M4) | ✗ |

> **读法**:K1 问的是 "用户看到谁";M4 / H2 问的是 "remote 调谁"。两者不在同一句话里。

## 8.4 K1 / M4 / H2 不应作为架构主轴

### 为什么不应该

1. **层次不齐**:K1 是 channel 内的 bot 身份;M4 / H2 是 runtime 侧的适配接入。把它们并列意味着"前台用户账号"和"后端推理集成"被搁在同一张图上,会让 bridge 和路由层代码误以为它们需要同构处理。
2. **组合爆炸被隐藏**:真实维度是 (channel × runtime × persona × namespace)。用 K1/M4/H2 做主轴时,增加钉钉、增加"K1 在钉钉"、增加"M4 + K1-persona"这种正交组合就没法表达。
3. **未来扩展错方向**:如果主轴是 K1/M4/H2,以后加钉钉时人们会纠结"钉钉是不是第四个 K1 级的对象",而真相是"钉钉是 channel,跟 K1 不可比"。

### 风险证据

在 00 / 03 / 04 章里已经看到后果:
- 03 章 3.1 把 K1 说成 "Brain 里的稳定 AI 人格" —— 这是 persona 的定义,不是 K1 的定义。
- 03 章 3.3 `RuntimeAdapter.runtimeType = 'brain' | 'openclaw' | 'hermes'` 没问题(这是 runtime 轴),但 3.1 表格把 K1 和 M4/H2 并成"三选一"就把 bot-surface 和 runtime 混了。
- 07 章把 "K1/M4/H2 灰度接入" 当作里程碑主题 —— 正确拆法应该是 "Channel 接入里程碑(M6 钉钉)" + "Runtime 接入里程碑(M7 OpenClaw、M8 Hermes)" + "Bot-surface 部署里程碑(K1 继续跑 + 未来新 surface)"。

## 8.5 推荐的主轴(并由 09 章作 Hosted / External 二分细化)

### 主轴定义(两维 + 三叠加 + hosted/external 分野)

```
                  Hosted Runtime axis →
                  brain-local      (未来可能新增 hosted)
Channel axis ↓    ───────────      ──────────────────
feishu            K1 (current)     ...
dingtalk          [new K-bundle?]  ...
slack (未来)       ...

Overlays:
  • bot-surface:    每个 (channel, channel_app) 下的一个用户可见 bot 账号
  • persona:         套在 hosted runtime 调用上的 system-prompt + 记忆片段
  • hosted bundle:   hosted 部署单位 = (channel + channel_app + hosted runtime + persona + namespace + 凭证)

External peer systems (不在上面这张图里):
  • M4 = OpenClaw peer  ← 调 remote capability 接口(API / MCP / 配置 / 记忆 / 审计)
  • H2 = Hermes peer    ← 同 M4
  详见 09 章。
```

### 具体主张

1. **第一主轴:Channel**。新增 IM 就新增一个 channel adapter(01 章已覆盖)。channel 自身不绑 runtime,也不绑 persona。
2. **第二主轴:Hosted Runtime**。新增 AI 后端**若由 remote 内部托管**,就新增一个 `RuntimeAdapter`(03 章已覆盖)。当下仅 `brain-local`。
3. **M4 / H2 不在第二主轴**。它们是外部 peer,走 capability 接口(09 章)。把它们塞回 runtime 主轴是 00–07 的历史错误。
4. **Bot-surface 是 channel 内的命名实体**,决定用户看到哪个 bot 名字 / 头像 / app_id。
5. **Persona 是 hosted runtime 调用时叠加的 prompt/记忆片段**,由 remote 注入。M4 / H2 自己管各自的 persona,remote 不过问。
6. **Hosted Integration-bundle 是部署单位**,只涵盖 hosted 路径(K1 等)。M4 / H2 不是 hosted bundle,是外部 capability client。

### 用这条主轴回答三个典型问题

- **接钉钉**:在 channel 轴新增 `dingtalk` hosted 路径。独立于 K1 / M4 / H2。可以在钉钉上部署新 bot-surface(可复用 `k1-persona`,也可全新)。
- **"接 M4"的正确解读**:不是在 runtime 轴新增 `openclaw`,而是**在 `capabilities/` 目录下暴露 M4 需要的 API / MCP / memory / audit 接口,签发 app token,约定限流与审计**(见 09.3 与 09.8)。remote 不 dispatch 消息给 M4。
- **"接 H2"的正确解读**:同上,H2 作为 capability client 接入;默认 feature flag off,仅实验 namespace 可见该 capability 开放。

## 8.6 对 00–07 章的具体修正清单

本节是硬修正点。实施者必须优先以本节为准;00–07 章原文保留但按以下方式重读:

### 必须改语义的地方

| 位置 | 原文大意 | 正确读法 |
| --- | --- | --- |
| 00 章 术语表 "K1" | "Brain 里的稳定 AI 人格" | **改**:"K1 是飞书当前部署的 bot-surface / integration-bundle 名。其中注入的 persona 通常叫 `k1-persona`(住在 yoho-memory)。" |
| 00 章 术语表 "H4" | 全部 H4 | **改**:"H2"。Hermes 的集成代号是 H2。 |
| 00 章 `Agent Runtime` 行 | "Brain-local、M4、H4" | 读作:"Hosted runtime 当前只有 `brain-local`。OpenClaw(M4)、Hermes(H2)不是 hosted runtime,而是外部 peer,通过 capability 接口协作,详见 09 章。" |
| 02 章 2.6 "与 K1 自我系统的衔接" | "K1 = Brain-local runtime 的 persona" | **改**:标题应为 "与 Brain-local runtime 的 selfSystem 衔接"。K1 是 bundle 名,不是 persona 名;该章讲的是 selfSystem / k1-persona 注入。 |
| 03 章 3.1 角色定位表,"K1"那一行 | K1 被与 M4 / H4 并列成 "角色"列 | **改**:整张表应拆两张 —— 一张 "runtime 轴"(brain-local / openclaw / hermes),一张 "bundle / bot-surface"(K1 当前 bundle 配置)。K1 不属于 runtime 轴。 |
| 03 章 3.3 `RuntimeAdapter.runtimeType` | 值为 `'brain' | 'openclaw' | 'hermes'` | **改**:只保留 hosted 值,短期就是 `'brain'`。`openclaw` / `hermes` 不进枚举(见 09.7)。 |
| 03 章 3.4 路由策略前缀 `/m4`、`/h4` | 作为 runtime 切换前缀 | **改**:永久禁列 —— M4 / H2 是外部 peer,不受 remote 路由调度;**没有任何 flag 可以把它们切到 hosted 流**(见 09.1.1 硬约束、09.8)。前缀若出现应被 router 直接拒绝。 |
| 03 章 3.5 / 3.6 表格 | "brain / openclaw / hermes" 接入工作量评估 | **改**:只评估 hosted runtime 接入(brain)。OpenClaw / Hermes 的"接入工作量"转写为 09.8 的 capability API + 客户端 SDK + 审计限流。H4 → H2。 |
| 04 章 4.x 与 06 章 6.x 里出现 "M4 / H4" 的地方 | — | H4 → H2;M4 保持(它本身就是 integration-id)。确认不把 M4 / H2 写成 `runtimeType`,只作为 integration 标签出现。 |
| 07 章 M1–M9 里的 "K1 / M4 / H4 灰度接入" | 作为一条灰度主题 | **改**:- M5 主线是 `RuntimeAdapter` 抽取(hosted 路径,当前仅 brain-local)。- M6 是**渠道**扩展(钉钉 hosted 路径)。- **M7 (OpenClaw) / M8 (Hermes) 已被 09 章重定义**:不是 runtime adapter 接入,而是 **capability API 暴露 + 外部客户端 SDK + 审计/限流**。- K1 bundle 贯穿所有里程碑,不作为独立里程碑。 |

### 名称替换规则(全文级)

| 原 | 改 | 范围 |
| --- | --- | --- |
| `H4` | `H2` | 全部 docs/architecture/agent-mesh/*.md |
| `/h4` | `/h2` | 03 章前缀路由 |
| `k1 persona` / `k1 runtime` 指向时的措辞 | `k1-persona`(当作一个 persona 标识符)或 `brain-local runtime` | 00 / 02 / 03 章 |
| "K1 是 persona" 类陈述 | "K1 是当前飞书的 bundle,注入的 persona 通常叫 `k1-persona`" | 任何断言 K1 = persona 的段落 |

### 不必改的地方(确认过没问题)

- `RuntimeAdapter` 契约 / `RuntimeEvent` 事件模型(03 章 3.3)。
- `im_chat_sessions` / `platform_identities` / `im_chat_members` 表结构(01 / 02 章)。
- 4 态 `ChatStateMachine`、3 层幂等键、abort 两段式(05 章)。
- 07 章的 M1–M4 里程碑(身份、chat sessions、state machine、actor/outbox)—— 与 K1/M4/H2 命名无关。

## 8.7 实施层影响

### 代码命名

- **hosted runtime 类型字段**(DB / code / metric label)短期只有 `brain` 一个值。不要把 `openclaw | hermes` 塞进 `runtimeType` 枚举 —— 它们走 capability 路径,不共用 hosted 的 enum(见 09.7)。
- **Hosted bundle 标签**(部署、审计、告警):`k1` 是当前唯一 hosted bundle 的实例名。例:`brain_config.extra.channels[].bundleName = 'k1-feishu-yoho-mobile'`;`im_inbound_log.bundle = 'k1'`。
- **External peer 标签**(capability 调用、审计):`m4`、`h2` 作为 `externalConsumers[].id` / `external_capability_audit.external_system`,与 hosted bundle 分属不同命名空间。
- **指标 label**:hosted 用 `{runtime=brain, bundle=k1}`;external 用 `{externalSystem=m4, endpoint=memory.read}`。不要混。

### 配置命名

- `brain_config.extra.channels[]` 里不该有顶层字段叫 `k1 / m4 / h2`。应该是 `platform + channelId + runtimeType + personaRef + bundleName`。
- **`agentMesh.runtimeAdapter.openclaw.*` / `agentMesh.runtimeAdapter.hermes.*` 已永久禁列**(见 09.8、09.1.1);external peer 的配置只走 `agentMesh.externalConsumers.*`(capability client 身份)与 `agentMesh.capabilities.*`(capability 暴露开关),不要用 `agentMesh.m4.*` 顶层字段。
- 所有 hosted runtime 的 tool 执行与所有 capability 调用在 outbound / 写 / 高权读取前必须经过 `PolicyGate`,命中高风险规则走 `ApprovalService` 签发的 ticket,参见 10 章。

### 文档更新顺序(后续行动)

1. (本 PR)写本纠偏文档 + README/03 章顶部 banner,**不改 00–07 原文**。
2. (下一 PR)批量把 `H4` → `H2`、`/h4` → `/h2`。
3. (再下一 PR)修 03 章 3.1 表格、改 02.6 标题、00 章术语表 "K1" / "H4" 条目。
4. 00–07 原文修完后,本文档降格为"历史记录",保留在 `docs/analysis/` 做复盘用。

## 8.8 结论(给实施者一句话)

**K1 不是 runtime,M4 / H2 不是 persona;真正的主轴是 "channel × hosted runtime" 二维,bot-surface、persona、integration-bundle 是叠加层,external peer 走 capability 接口。M4 / H2 永远不在 remote 开 session,所有 hosted / capability 动作都过 PolicyGate + 必要时 Approval(见 09 / 10 章)。把 K1/M4/H2 当作部署实例名而不是架构层,你就不会再被它们绑住。**
