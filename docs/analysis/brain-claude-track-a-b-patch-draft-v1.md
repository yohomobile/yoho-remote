# Brain Claude Track A/B 交叉比对 Patch 草稿 V1

## 结论

- 已纳入 patch 草稿：`5` 条
- 未纳入：`53` 条
- 本次没有写 live 数据，当前存在两个文件：
  - 可执行 dry-run manifest：
    [brain-manual-repair-patch-draft.track-a-b.dryrun.v1.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-patch-draft.track-a-b.dryrun.v1.json:1)
  - 上一轮严格交集审计后保留的不可 apply 封套：
    [brain-manual-repair-patch-draft.track-a-b.v1.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-patch-draft.track-a-b.v1.json:1)

## 纳入规则

只纳入同时满足以下条件的记录：

- Track A 命中同一 `sessionId`
- Track B 命中同一 `sessionId`
- Track A=`high`
- Track B=`high`（`score=0.9`）
- 两边在以下字段上没有关键分歧：
  - `machineSelection.mode`
  - `machineSelection.machineId`
  - `childModels.claude`

完整 canonical `brainPreferences` 采用 Track B 的 `recommendedBrainPreferences`。

注意：

- Track A 对这 5 条仍然保留 `childModels.codex.*` 的 unresolved，不是显式反对。
- 因此这份文件是“第一版高置信度 dry-run 草稿”，不是直接 apply 的最终清单。

## 已纳入的 5 条

1. `7704b71a-7272-4b81-aa9a-1888d597021a`
   - Track A=`high`
   - Track B=`high`
   - group=`with-child-evidence`
   - 摘要：`CRS 导航栏高度/圆角优化 + 部署`
2. `5b056c5c-775d-4f0e-9551-e9ee5d0c3b2a`
   - Track A=`high`
   - Track B=`high`
   - group=`with-child-evidence`
   - 摘要：`飞书群: Yoho 技术 · 04/01 00:21`
3. `94aa00bb-85af-4ec4-b3f6-9500a60a0416`
   - Track A=`high`
   - Track B=`high`
   - group=`with-child-evidence`
   - 摘要：`飞书群: Yoho 技术 · 04/02 08:30`
4. `edf6f8db-1406-4b62-b0ee-d449ecf38b8c`
   - Track A=`high`
   - Track B=`high`
   - group=`with-child-evidence`
   - 摘要：`飞书群: Yoho 技术 · 04/04 07:17`
5. `f8ecaf60-3bfc-4076-909d-df4e08fc1e2a`
   - Track A=`high`
   - Track B=`high`
   - group=`with-child-evidence`
   - 摘要：`飞书群: Yoho 技术 · 04/05 13:11`

## 未纳入 53 条摘要

本轮未发现“Track A / Track B 在 machineSelection 或 Claude child allowlist 上直接冲突”的样本。

未纳入的主因只有一个：

- Track A 置信度不足 `high`

细分如下：

- `52` 条为 `Track A=medium`
- `1` 条为 `Track A=low`

按 Track B 分组展开：

- `5` 条：`medium / 中低 / legacy-no-runtime`
- `1` 条：`medium / 中高 / legacy-no-runtime`
- `34` 条：`medium / 中高 / no-child-pre-codex`
- `12` 条：`medium / 高 / with-child-evidence`
- `1` 条：`low / 中 / post-codex-cutoff-singleton`

## 分歧解释

这批剩余记录的“分歧”更准确地说是“准入不足”而不是“字段冲突”：

- Track B 已能给出完整 canonical `brainPreferences`
- 但 Track A 没有把这些记录提升到 `high`
- 因此按当前门槛，不进入第一版 patch 草稿

## 下一轮建议

优先复核这两类：

1. `12` 条 `Track A=medium / Track B=高 / with-child-evidence`
   - 这批最接近进入下一版 patch
2. `34` 条 `Track A=medium / Track B=中高 / no-child-pre-codex`
   - 这批量最大，但缺少直接 child 证据，适合统一补规则后再推进
