# 首批 Brain Patch O2 Dry-Run 结果

## 输入文件

- manifest： [brain-manual-repair-patch.batch-01.o2.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-patch.batch-01.o2.json:1)
- 候补： [brain-manual-repair-candidates.batch-01b.o2.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-candidates.batch-01b.o2.json:1)
- 原始 dry-run 输出： [brain-manual-repair-patch.batch-01.o2.dry-run.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-patch.batch-01.o2.dry-run.json:1)

## Dry-Run 摘要

- `manifestItems=5`
- `plannedWrites=5`
- `skippedActive=0`
- `skippedNoop=0`
- `rejected=0`

结论：

- 5 条全部通过当前 schema 校验
- 5 条当前都不是 `active`
- 本次 dry-run 没有出现需要从 manifest 移除的记录

## Before / After Diff

1. `7704b71a-7272-4b81-aa9a-1888d597021a`
   - 摘要：`CRS 导航栏高度/圆角优化 + 部署`
   - before：
     - `brainPreferences` 缺失
     - `permissionMode=bypassPermissions`
     - `modelMode=opus`
   - after：
     - `machineSelection.mode=auto`
     - `machineSelection.machineId=e16b3653-ad9f-46a7-89fd-48a3d576cccb`
     - `childModels.claude.allowed=["sonnet"]`
     - `childModels.claude.defaultModel="sonnet"`
     - `childModels.codex.allowed=[]`
     - `childModels.codex.defaultModel="gpt-5.4"`
2. `5b056c5c-775d-4f0e-9551-e9ee5d0c3b2a`
   - 摘要：`飞书群: Yoho 技术 · 04/01 00:21`
   - before：
     - `brainPreferences` 缺失
     - `permissionMode=bypassPermissions`
     - `modelMode=default`
   - after：
     - `machineSelection.mode=auto`
     - `machineSelection.machineId=e16b3653-ad9f-46a7-89fd-48a3d576cccb`
     - `childModels.claude.allowed=["sonnet"]`
     - `childModels.claude.defaultModel="sonnet"`
     - `childModels.codex.allowed=[]`
     - `childModels.codex.defaultModel="gpt-5.4"`
3. `94aa00bb-85af-4ec4-b3f6-9500a60a0416`
   - 摘要：`飞书群: Yoho 技术 · 04/02 08:30`
   - before：
     - `brainPreferences` 缺失
     - `permissionMode=bypassPermissions`
     - `modelMode=default`
   - after：
     - `machineSelection.mode=auto`
     - `machineSelection.machineId=e16b3653-ad9f-46a7-89fd-48a3d576cccb`
     - `childModels.claude.allowed=["sonnet"]`
     - `childModels.claude.defaultModel="sonnet"`
     - `childModels.codex.allowed=[]`
     - `childModels.codex.defaultModel="gpt-5.4"`
4. `edf6f8db-1406-4b62-b0ee-d449ecf38b8c`
   - 摘要：`飞书群: Yoho 技术 · 04/04 07:17`
   - before：
     - `brainPreferences` 缺失
     - `permissionMode=bypassPermissions`
     - `modelMode=default`
   - after：
     - `machineSelection.mode=auto`
     - `machineSelection.machineId=e16b3653-ad9f-46a7-89fd-48a3d576cccb`
     - `childModels.claude.allowed=["sonnet"]`
     - `childModels.claude.defaultModel="sonnet"`
     - `childModels.codex.allowed=[]`
     - `childModels.codex.defaultModel="gpt-5.4"`
5. `f8ecaf60-3bfc-4076-909d-df4e08fc1e2a`
   - 摘要：`飞书群: Yoho 技术 · 04/05 13:11`
   - before：
     - `brainPreferences` 缺失
     - `permissionMode=bypassPermissions`
     - `modelMode=sonnet`
   - after：
     - `machineSelection.mode=auto`
     - `machineSelection.machineId=e16b3653-ad9f-46a7-89fd-48a3d576cccb`
     - `childModels.claude.allowed=["sonnet"]`
     - `childModels.claude.defaultModel="sonnet"`
     - `childModels.codex.allowed=[]`
     - `childModels.codex.defaultModel="gpt-5.4"`

## Skip 情况

- `Skipped active`: 无
- `Skipped noop`: 无
- `Rejected`: 无

## Manifest 收缩结果

本次 dry-run 后，首批 manifest 不需要移除任何记录，仍保留全部 `5` 条。
