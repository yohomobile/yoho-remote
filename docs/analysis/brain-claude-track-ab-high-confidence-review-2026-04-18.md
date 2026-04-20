# Track A/B 高置信度 Patch 草稿审计

生成时间：2026-04-18

## 结论

- 严格按“两轨一致”审核后，本轮 **approved patch items = 0**。
- 原始高置信候选交集共有 5 条，但它们只能证明：
  - `machineSelection.mode=auto`
  - `machineSelection.machineId=<当前 machineId>`
  - `childModels.claude.allowed=["sonnet"]`
  - `childModels.claude.defaultModel="sonnet"`
- 它们**不能**证明完整 canonical `brainPreferences` 中的 `childModels.codex.allowed/defaultModel`。
- 由于当前 `set-brainPreferences` manifest schema 要求写入完整 canonical object，而 Track A 对 codex 两个字段明确保留为 `unresolved`，所以把 Track B 的 `codex={allowed:[],defaultModel:"gpt-5.4"}` 直接写进 patch，不属于“严格交集”，而是把 Track B 的额外结论补进去了。

## 输入材料

- Track A: [brain-claude-batch-a-suggestions.default.json](/home/workspaces/repos/yoho-remote/data/brain-claude-batch-a-suggestions.default.json:1)
- Track B: [brain-claude-track-b-2026-04-18.json](/home/workspaces/repos/yoho-remote/docs/analysis/brain-claude-track-b-2026-04-18.json:1)
- 原始批次清单: [brain-manual-repair-batch-01.brain-claude.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-batch-01.brain-claude.json:1)
- 当前 manifest schema / apply guardrail: [brainSessionManualRepair.ts](/home/workspaces/repos/yoho-remote/server/src/brain/brainSessionManualRepair.ts:1)

## 发现

### 1. 形式上可过 schema，不等于语义上是严格交集

- 我用 Track A 的 5 条 `high` 与 Track B 的建议对象拼了一个假设 manifest。
- 结果：
  - `parseBrainSessionManualRepairManifest` 可通过
  - `buildBrainSessionManualRepairPlan` 可得到 `plannedWrites=5`
- 但这只是证明“如果采用 Track B 的完整对象，当前 schema 接受它”，**不证明这 5 条完整对象是两轨共同确认的**。

### 2. 真正严格交集只覆盖了 partial fields

- Track A 高置信 5 条都把以下字段列为未决：
  - `childModels.codex.allowed`
  - `childModels.codex.defaultModel`
  - `codex token source / local capability 无稳定线索`
- Track B 对同 5 条给出的完整对象里，codex 是：

```json
{
  "allowed": [],
  "defaultModel": "gpt-5.4"
}
```

- 因此这版 patch 草稿如果把 codex 空 allowlist 写进去，实质上是用 Track B 填补了 Track A 未决字段，不是严格两轨一致。

### 3. active / 陈旧性 当前不是主阻塞

- 对这 5 条交集 session 的现状只读复核结果：
  - 当前都 `active=false`
  - 当前都仍然缺失 `metadata.brainPreferences`
  - 当前 `updatedAt` 与 Track A 草稿生成时一致
- 也就是说，**现在没有观察到 active 漂移或数据陈旧**。
- 但这只能说明“如果语义成立，它们当前可安全进入 dry-run/apply 计划”；不能替代“两轨严格一致”的要求。

## 收紧结果

- 原始高置信交集候选：5 条
- 审核后批准进入 patch manifest：0 条
- 收紧原因：Track A 对 codex 字段没有正向确认，当前 schema 又不支持 partial brainPreferences patch

被收紧的 5 条：

- `7704b71a-7272-4b81-aa9a-1888d597021a`
- `5b056c5c-775d-4f0e-9551-e9ee5d0c3b2a`
- `94aa00bb-85af-4ec4-b3f6-9500a60a0416`
- `edf6f8db-1406-4b62-b0ee-d449ecf38b8c`
- `f8ecaf60-3bfc-4076-909d-df4e08fc1e2a`

## 未纳入项保留状态

- 本轮没有任何 session 被错误提升为“可直接 patch”。
- 全部 58 条仍保留在人工处理池中。
- 其中：
  - 5 条：原始高置信交集，但因 codex 字段未形成严格双轨共识，被退回人工确认
  - 12 条：仅 Track B 高置信，未得到 Track A 的高置信背书
  - 41 条：至少一轨不是高置信，本来就不应进入高置信 patch 草稿

Track B 高但不在 Track A 高交集中的 12 条：

- `916165ae-fb01-4359-8468-d9fda0eaa3c6`
- `1be1fbb2-33a9-4ac9-9239-d3129a73df03`
- `2843fd42-a0e9-418c-be13-75921260fc02`
- `c83d66d0-bf5d-47f1-819f-a4e4b3c7ee10`
- `372d3ff0-8563-4d9a-9ab5-03da850a82da`
- `cbfb6599-d424-4291-a0cd-3f3d6815de50`
- `2d5c6fbd-a6a0-45f7-a6e5-8f0d9d26cc29`
- `da348251-c8ba-492a-9abf-5ec7eccff807`
- `5361fa5d-7079-46c8-b720-c76b9c386865`
- `cb352e49-90bd-469a-ae21-bc7de664587f`
- `572f27a5-e7ea-4c78-94be-3fb19ff2cc11`
- `9af4d046-cb18-44a7-8ab6-051cb596cc6d`

## 建议的下一步

- 如果后续仍想产出“可直接 apply 的高置信 patch manifest”，需要先解决二选一：
  - 让 Track A 对 codex 字段给出正向结论
  - 或把 manifest/apply 能力扩展为 partial brainPreferences patch，只写两轨共同确认的字段

