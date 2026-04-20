#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type TrackAClaudeModels = {
    allowed: string[]
    defaultModel: string
}

type TrackASuggestion = {
    sessionId: string
    confidence: 'high' | 'medium' | 'low'
    unresolved: string[]
    session: {
        createdAt: number
        updatedAt: number
        createdBy: string | null
        host: string | null
        version: string | null
        machineId: string | null
        summary: string | null
        runtimeModel: string | null
        childCount: number
    }
    candidate: {
        machineSelection: {
            mode: 'auto' | 'manual' | null
            machineId: string | null
        }
        childModels: {
            claude: TrackAClaudeModels | null
            codex: {
                allowed: string[]
                defaultModel: string
            } | null
        }
    }
    observedChildren: Array<{
        sessionId: string
        flavor: string | null
        modelMode: string | null
        runtimeModel: string | null
        summary: string | null
    }>
}

type TrackAReport = {
    suggestions: TrackASuggestion[]
}

type TrackBItem = {
    sessionId: string
    createdAtIso: string
    lastMessageAtIso: string | null
    machineId: string | null
    group: string
    confidence: {
        score: number
        label: string
    }
    parentRuntime: {
        permissionMode: string | null
        modelMode: string | null
        modelReasoningEffort: string | null
    }
    observedChildren: Array<{
        sessionId: string
        flavor: string | null
        modelMode: string | null
        permissionMode: string | null
        createdAt: number
        lastMessageAt: number | null
    }>
    recommendedBrainPreferences: {
        machineSelection: {
            mode: 'auto' | 'manual'
            machineId: string | null
        }
        childModels: {
            claude: {
                allowed: string[]
                defaultModel: string
            }
            codex: {
                allowed: string[]
                defaultModel: string
            }
        }
    }
}

type TrackBReport = {
    items: TrackBItem[]
}

type BatchItem = {
    sessionId: string
    machineId: string | null
    permissionMode: string | null
    modelMode: string | null
    hasAnyReferenceSource: boolean
    hasTokenSourceId: boolean
    hasBrainTokenSourceIds: boolean
    nativeResumeSessionId: string | null
}

type BatchReport = {
    items: BatchItem[]
}

type ReviewReport = {
    reviewedAt: string
    strictIntersection: {
        overlapSessionIds: string[]
    }
    tightenedDecision: {
        withheldFormerHighIntersection: Array<{
            sessionId: string
            reason: string
        }>
        trackBHighOnlySessionIds: string[]
    }
}

type WorksheetGroup = {
    title: string
    description: string
    unresolvedQuestion: string
    optionKeys: string[]
    sessionIds: string[]
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T
}

function formatValue(value: string | null | undefined): string {
    return value ? `\`${value}\`` : '空'
}

function formatArray(values: string[] | null | undefined): string {
    if (!values || values.length === 0) {
        return '[]'
    }
    return `[${values.map((value) => `\`${value}\``).join(', ')}]`
}

function sameStringArray(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
    if (!left || !right || left.length !== right.length) {
        return false
    }
    return left.every((value, index) => value === right[index])
}

function formatChildren(trackA: TrackASuggestion, trackB: TrackBItem): string {
    if (trackA.observedChildren.length > 0) {
        return trackA.observedChildren.map((child) => {
            const parts = [
                child.flavor ?? 'unknown',
                child.modelMode ?? 'null',
                child.runtimeModel ?? 'null',
                child.summary ?? '无摘要',
            ]
            return parts.join(' / ')
        }).join('<br>')
    }
    if (trackB.observedChildren.length > 0) {
        return trackB.observedChildren.map((child) => {
            const parts = [
                child.flavor ?? 'unknown',
                child.modelMode ?? 'null',
                child.permissionMode ?? 'null',
                new Date(child.createdAt).toISOString(),
            ]
            return parts.join(' / ')
        }).join('<br>')
    }
    return '无'
}

function collectConvergedFields(trackA: TrackASuggestion, trackB: TrackBItem): string[] {
    const converged: string[] = []
    if (
        trackA.candidate.machineSelection.mode
        && trackA.candidate.machineSelection.mode === trackB.recommendedBrainPreferences.machineSelection.mode
    ) {
        converged.push(`machineSelection.mode=${formatValue(trackA.candidate.machineSelection.mode)}`)
    }
    if (
        trackA.candidate.machineSelection.machineId
        && trackA.candidate.machineSelection.machineId === trackB.recommendedBrainPreferences.machineSelection.machineId
    ) {
        converged.push(`machineSelection.machineId=${formatValue(trackA.candidate.machineSelection.machineId)}`)
    }
    if (
        trackA.candidate.childModels.claude
        && sameStringArray(
            trackA.candidate.childModels.claude.allowed,
            trackB.recommendedBrainPreferences.childModels.claude.allowed,
        )
    ) {
        converged.push(`childModels.claude.allowed=${formatArray(trackA.candidate.childModels.claude.allowed)}`)
    }
    if (
        trackA.candidate.childModels.claude
        && trackA.candidate.childModels.claude.defaultModel === trackB.recommendedBrainPreferences.childModels.claude.defaultModel
    ) {
        converged.push(`childModels.claude.defaultModel=${formatValue(trackA.candidate.childModels.claude.defaultModel)}`)
    }
    return converged
}

function renderGroupTable(args: {
    group: WorksheetGroup
    trackAById: Map<string, TrackASuggestion>
    trackBById: Map<string, TrackBItem>
    batchById: Map<string, BatchItem>
}): string {
    const rows = args.group.sessionIds.map((sessionId) => {
        const trackA = args.trackAById.get(sessionId)
        const trackB = args.trackBById.get(sessionId)
        const batch = args.batchById.get(sessionId)
        if (!trackA || !trackB || !batch) {
            throw new Error(`Missing source data for session ${sessionId}`)
        }

        const factLines = [
            `summary=${trackA.session.summary ?? '空'}`,
            `createdAt=${trackB.createdAtIso}`,
            `lastMessageAt=${trackB.lastMessageAtIso ?? '空'}`,
            `version=${trackA.session.version ?? '空'}`,
            `createdBy=${trackA.session.createdBy ?? '空'}`,
            `host=${trackA.session.host ?? '空'}`,
            `machineId=${trackA.session.machineId ?? trackB.machineId ?? batch.machineId ?? '空'}`,
            `runtimeModel=${trackA.session.runtimeModel ?? '空'}`,
            `parentRuntime=${trackB.parentRuntime.permissionMode ?? batch.permissionMode ?? '空'} / ${trackB.parentRuntime.modelMode ?? batch.modelMode ?? '空'}`,
            `childEvidence=${formatChildren(trackA, trackB)}`,
            `referenceSource=${batch.hasAnyReferenceSource ? 'yes' : 'no'}`,
            `tokenSource=${batch.hasTokenSourceId ? 'yes' : 'no'} / brainTokenSourceIds=${batch.hasBrainTokenSourceIds ? 'yes' : 'no'}`,
            `nativeResumeSessionId=${batch.nativeResumeSessionId ?? '空'}`,
        ]

        const convergedLines = collectConvergedFields(trackA, trackB)
        const trackCell = [
            `\`${sessionId}\``,
            `Track A=${trackA.confidence}`,
            `Track B=${trackB.confidence.label} (${trackB.confidence.score})`,
            `childCount=${trackA.session.childCount}`,
        ].join('<br>')

        return `| ${trackCell} | ${factLines.join('<br>')} | ${convergedLines.join('<br>')} | ${args.group.unresolvedQuestion} | ${args.group.optionKeys.join(' / ')} |`
    })

    return [
        `## ${args.group.title}`,
        '',
        args.group.description,
        '',
        '| Session | 事实字段 | 两轨共同已收敛字段 | 唯一未决问题 | 推荐决策选项 |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ].join('\n')
}

async function main(): Promise<void> {
    const root = process.cwd()
    const trackAPath = resolve(root, 'data/brain-claude-batch-a-suggestions.default.json')
    const trackBPath = resolve(root, 'docs/analysis/brain-claude-track-b-2026-04-18.json')
    const batchPath = resolve(root, 'data/brain-manual-repair-batch-01.brain-claude.json')
    const reviewPath = resolve(root, 'docs/analysis/brain-claude-track-ab-high-confidence-review-2026-04-18.json')
    const outputPath = resolve(root, 'docs/analysis/brain-first-batch-manual-confirmation-worksheet-2026-04-18.md')

    const trackA = readJson<TrackAReport>(trackAPath)
    const trackB = readJson<TrackBReport>(trackBPath)
    const batch = readJson<BatchReport>(batchPath)
    const review = readJson<ReviewReport>(reviewPath)

    const trackAById = new Map(trackA.suggestions.map((item) => [item.sessionId, item]))
    const trackBById = new Map(trackB.items.map((item) => [item.sessionId, item]))
    const batchById = new Map(batch.items.map((item) => [item.sessionId, item]))

    const groups: WorksheetGroup[] = [
        {
            title: 'A. 原先 5 条被 Withheld 的双高候选',
            description: '这 5 条是 Track A=`high` 与 Track B=`高` 的交集，但最新 review 明确收紧为 withheld，因为 codex 字段还不属于严格两轨共同结论。',
            unresolvedQuestion: '是否接受 Track B 的 `childModels.codex={allowed:[], defaultModel:\"gpt-5.4\"}` 作为“显式禁用”写入值；Track A 对 codex 仍是 unresolved。',
            optionKeys: ['O1', 'O2', 'O3'],
            sessionIds: review.tightenedDecision.withheldFormerHighIntersection.map((item) => item.sessionId),
        },
        {
            title: 'B. 12 条 Track B 高 / with-child-evidence，但 Track A 为 medium 的候补',
            description: '这 12 条在字段值上没有 A/B 冲突，且都有直接 child 旁证；Track A 之所以没到 `high`，主要是它把单条 child 证据压在 `medium` 档。',
            unresolvedQuestion: '是否接受 `Track A=medium + Track B=高(with-child-evidence)` 进入首批修复，并同步采用 Track B 的 codex 显式禁用结论。',
            optionKeys: ['O1', 'O2', 'O4'],
            sessionIds: review.tightenedDecision.trackBHighOnlySessionIds,
        },
    ]

    const markdown = [
        '# 首批 Brain 修复人工确认工作表',
        '',
        `生成时间：${new Date().toISOString()}`,
        '',
        '## 范围',
        '',
        `- review 日期：${review.reviewedAt}`,
        `- 记录范围：${groups.reduce((sum, group) => sum + group.sessionIds.length, 0)} 条`,
        `- 来源：Track A=\`${trackAPath}\`，Track B=\`${trackBPath}\`，Batch=\`${batchPath}\`，Review=\`${reviewPath}\``,
        '',
        '## 决策选项',
        '',
        '| 选项 | 含义 |',
        '| --- | --- |',
        '| O1 | 保守继续留在人工池，本轮不进入 patch manifest。 |',
        '| O2 | 接受 Track B 的 codex 显式禁用结论，按完整 canonical `brainPreferences` 进入首批修复。 |',
        '| O3 | 只确认已收敛的 `machineSelection + Claude` 字段，等待支持 partial patch 或单独 codex 规则后再落库。 |',
        '| O4 | 仅用于 `Track A=medium / Track B=高` 组：先把这条记录标成“首批候补”，待 reviewer 明确认可 medium/high 组合后再按 O2 执行。 |',
        '',
        '## 共同背景',
        '',
        '- 这 17 条都来自 missing-brainPreferences 的人工处理池，不写 live 数据。',
        '- 两轨对 `machineSelection` 与 `childModels.claude` 的建议值没有直接冲突；review 阶段卡住的是 codex 字段是否应显式写成禁用，以及 medium/high 组合是否足够进入首批。',
        '- 当前 manifest schema 仍要求完整 canonical `brainPreferences`，所以只要选择写入，就必须一并回答 codex 字段。',
        '',
        ...groups.map((group) => renderGroupTable({
            group,
            trackAById,
            trackBById,
            batchById,
        })),
    ].join('\n')

    writeFileSync(outputPath, `${markdown}\n`)
    console.log(`Wrote worksheet to ${outputPath}`)
}

void main()
