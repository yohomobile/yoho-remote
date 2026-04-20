# Skill 召回率基准测试报告

> 生成时间：2026-04-20 07:45:49  
> Phase 3 pre-flight：BM25 vs Prompt-based 召回率对比

## 数据集概况

| 指标 | 值 |
|------|-----|
| 技能总数 | 14 |
| 评测样本总数 | 42 |
| exact 样本数 | 14 |
| near_synonym 样本数 | 14 |
| fuzzy 样本数 | 14 |
| LLM 评测 | ⏭️ 跳过 (--skip-llm 或无 API Key) |

## 总体指标

| 指标 | BM25 |
|------|------|
| Recall@1 | 73.8% |
| Recall@3 | 92.9% |
| Recall@5 | 97.6% |
| MRR      | 0.834 |

## 按查询类型分组

### exact (n=14)

| 指标 | BM25 |
|------|------|
| Recall@1 | 100.0% |
| Recall@3 | 100.0% |
| Recall@5 | 100.0% |
| MRR      | 1.000 |

### near_synonym (n=14)

| 指标 | BM25 |
|------|------|
| Recall@1 | 71.4% |
| Recall@3 | 100.0% |
| Recall@5 | 100.0% |
| MRR      | 0.833 |

### fuzzy (n=14)

| 指标 | BM25 |
|------|------|
| Recall@1 | 50.0% |
| Recall@3 | 78.6% |
| Recall@5 | 92.9% |
| MRR      | 0.670 |

## BM25 未进入 Top-3 的样本

| ID | 查询 | 预期 | BM25 Rank | BM25 Top-3 |
|----|------|------|-----------|------------|
| q027 | 要做一个能说服老板的提案演示，需要有逻辑的 PPT 框架... | ppt-creator-金字塔原理 | 11 | officecli-制作-ppt, conversation-style-profile, identity-bridge |
| q033 | 用户提到了一些关于他工作方式和偏好的细节，应该怎么记录... | user-profile-extract | 4 | person-modeling, conversation-style-profile, emotion-evidence-extract |
| q039 | 明天要去大会上做研究报告，需要一套专业的幻灯片模板... | 学术演讲-ppt-academic-pptx | 5 | presentation-designer-多agent协作, officecli-制作-ppt, 竞品分析报告 |

## 决策结论

**建议：暂缓 Phase 3 GEPA**
BM25 Recall@3 = 92.9% > 85%，召回质量已较好。Phase 3 的边际收益偏低，
除非 LLM 有显著提升（>10pp），否则资源应先投入 Phase 0/1/2 巩固基础。

## 逐样本结果

| ID | 类型 | 预期 | BM25 Rank |
|----|------|------|----------|
| q001 | exact | conversation-style-profile | #1 |
| q002 | near_synonym | conversation-style-profile | #2 |
| q003 | fuzzy | conversation-style-profile | #1 |
| q004 | exact | emotion-evidence-extract | #1 |
| q005 | near_synonym | emotion-evidence-extract | #1 |
| q006 | fuzzy | emotion-evidence-extract | #1 |
| q007 | exact | identity-bridge | #1 |
| q008 | near_synonym | identity-bridge | #1 |
| q009 | fuzzy | identity-bridge | #2 |
| q010 | exact | meeting-notes | #1 |
| q011 | near_synonym | meeting-notes | #3 |
| q012 | fuzzy | meeting-notes | #3 |
| q013 | exact | officecli-制作-excel-表格 | #1 |
| q014 | near_synonym | officecli-制作-excel-表格 | #1 |
| q015 | fuzzy | officecli-制作-excel-表格 | #1 |
| q016 | exact | officecli-制作-ppt | #1 |
| q017 | near_synonym | officecli-制作-ppt | #1 |
| q018 | fuzzy | officecli-制作-ppt | #2 |
| q019 | exact | officecli-制作-word-文档 | #1 |
| q020 | near_synonym | officecli-制作-word-文档 | #1 |
| q021 | fuzzy | officecli-制作-word-文档 | #1 |
| q022 | exact | person-modeling | #1 |
| q023 | near_synonym | person-modeling | #1 |
| q024 | fuzzy | person-modeling | #1 |
| q025 | exact | ppt-creator-金字塔原理 | #1 |
| q026 | near_synonym | ppt-creator-金字塔原理 | #2 |
| q027 | fuzzy | ppt-creator-金字塔原理 | #11 |
| q028 | exact | presentation-designer-多agent协作 | #1 |
| q029 | near_synonym | presentation-designer-多agent协作 | #1 |
| q030 | fuzzy | presentation-designer-多agent协作 | #2 |
| q031 | exact | user-profile-extract | #1 |
| q032 | near_synonym | user-profile-extract | #3 |
| q033 | fuzzy | user-profile-extract | #4 |
| q034 | exact | yoho-remote-机器残留排查 | #1 |
| q035 | near_synonym | yoho-remote-机器残留排查 | #1 |
| q036 | fuzzy | yoho-remote-机器残留排查 | #1 |
| q037 | exact | 学术演讲-ppt-academic-pptx | #1 |
| q038 | near_synonym | 学术演讲-ppt-academic-pptx | #1 |
| q039 | fuzzy | 学术演讲-ppt-academic-pptx | #5 |
| q040 | exact | 竞品分析报告 | #1 |
| q041 | near_synonym | 竞品分析报告 | #1 |
| q042 | fuzzy | 竞品分析报告 | #1 |