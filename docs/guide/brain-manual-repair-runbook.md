# 旧 Brain 数据手工修复 Runbook

适用范围：离线修复 `metadata.source=brain` 或 `metadata.source=brain-child` 的历史 session 数据。

## 安全边界

- 不碰 `active` 会话。脚本规划阶段会跳过，`--apply` 前还会再检查一次。
- 不重启任何服务。这个流程只读库或写库，不包含任何 restart 步骤。
- 默认 `dry-run`。只有显式传 `--apply` 才会写入。
- 先快照，后写入。`--apply` 时会先落一份变更前快照 JSON，再开始写库。
- 每条变更都按当前 schema 校验，并输出 before / after diff。
- 当前 manifest 一条 item 只允许一种动作：
  - `set-brainPreferences`
  - `set-permissionMode`

## 输入文件

模板文件： [brain-manual-repair-manifest.template.json](/home/workspaces/repos/yoho-remote/data/brain-manual-repair-manifest.template.json:1)

不要直接改历史导出的清单文件。先复制模板，再按人工确认结果填写。

## 完整流程

1. 先拿到人工修复清单。
   - 明确每条目标 session 的 `sessionId`
   - 明确要改哪一个字段
   - 明确目标值，或确认可引用的 `copyFromSessionId`
2. 从模板生成 patch manifest。
   - 复制 `data/brain-manual-repair-manifest.template.json`
   - 填入真实 `sessionId`
   - 如果是 `set-brainPreferences`：
     - 二选一：保留 `copyFromSessionId`
     - 或改成显式 `brainPreferences`
     - 不要同时保留两者
   - 如果是 `set-permissionMode`：
     - 填合法目标值
3. 先跑 dry-run。

```bash
bun run repair:brain-sessions -- --manifest=/abs/path/patch.manifest.json
```

4. 检查 dry-run 输出。
   - 确认每条 diff 都符合人工预期
   - 确认没有 `Rejected manifest items`
   - 确认 `Skipped active` 里没有误伤需要处理的会话
5. 再执行 apply。

```bash
bun run repair:brain-sessions -- --manifest=/abs/path/patch.manifest.json --apply
```

6. 记录 apply 结果。
   - 保存脚本输出里的 `Snapshot:` 路径
   - 记录 `Applied / Apply skipped active / Apply skipped drifted / Apply failed`
   - 如果出现 drift 或 active，先重新确认数据，再重新生成 manifest

## 最小使用示例

只做 dry-run：

```bash
bun run repair:brain-sessions -- --manifest=/home/workspaces/repos/yoho-remote/data/brain-manual-repair-manifest.template.json
```

指定快照路径并 apply：

```bash
bun run repair:brain-sessions -- \
  --manifest=/abs/path/patch.manifest.json \
  --snapshot-file=/abs/path/pre-apply.snapshot.json \
  --apply
```

JSON 输出：

```bash
bun run repair:brain-sessions -- \
  --manifest=/abs/path/patch.manifest.json \
  --format=json
```

## manifest 填写提醒

- `namespace` 可选；如果填了，必须和目标 session 的真实 namespace 一致。
- `reason` 建议写人工确认依据，方便留痕。
- `set-brainPreferences` 支持两种方式：
  - `copyFromSessionId`
  - `brainPreferences`
- `set-permissionMode` 必须符合当前 flavor 允许的值，否则会在 dry-run 阶段被拒绝。
