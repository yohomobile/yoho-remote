import type { IStore } from '../../store'

type ContextSummaryLevel = 1 | 2 | 3

export type SessionContextSummary = {
    id: string
    level: ContextSummaryLevel
    summary: string
    topic: string | null
    seqStart: number | null
    seqEnd: number | null
    createdAt: number
}

export type SessionContextBundle = {
    version: 1
    orgId: string
    sessionId: string
    generatedAtMs: number
    summaries: {
        recentL1: SessionContextSummary[]
        latestL2: SessionContextSummary[]
        latestL3: SessionContextSummary | null
    }
    toolPolicy: {
        recallDefault: 'fallback'
        rememberDefault: 'explicit_or_gap_only'
        skillListDefault: 'injected_manifest_or_on_demand'
    }
}

type ContextBundleStore = IStore & {
    getSessionContextSummaries?: (input: {
        orgId: string
        sessionId: string
        recentL1Limit: number
        latestL2Limit: number
    }) => Promise<SessionContextBundle['summaries']>
}

const MAX_SUMMARY_CHARS = 420

function trimSummary(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= MAX_SUMMARY_CHARS) {
        return normalized
    }
    return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

function renderSummaryLine(summary: SessionContextSummary): string {
    const topic = summary.topic ? ` topic=${summary.topic}` : ''
    const seq = summary.seqStart != null
        ? ` seq=${summary.seqStart}${summary.seqEnd != null && summary.seqEnd !== summary.seqStart ? `-${summary.seqEnd}` : ''}`
        : ''
    return `- L${summary.level}${seq}${topic} id=${summary.id}: ${trimSummary(summary.summary)}`
}

export async function buildSessionContextBundle(
    store: IStore,
    input: {
        orgId: string | null | undefined
        sessionId: string
        projectRoot?: string | null
    }
): Promise<SessionContextBundle | null> {
    const orgId = input.orgId?.trim()
    if (!orgId) {
        return null
    }

    const loader = (store as ContextBundleStore).getSessionContextSummaries
    if (!loader) {
        return {
            version: 1,
            orgId,
            sessionId: input.sessionId,
            generatedAtMs: Date.now(),
            summaries: {
                recentL1: [],
                latestL2: [],
                latestL3: null,
            },
            toolPolicy: {
                recallDefault: 'fallback',
                rememberDefault: 'explicit_or_gap_only',
                skillListDefault: 'injected_manifest_or_on_demand',
            },
        }
    }

    const summaries = await loader({
        orgId,
        sessionId: input.sessionId,
        recentL1Limit: 5,
        latestL2Limit: 3,
    })

    return {
        version: 1,
        orgId,
        sessionId: input.sessionId,
        generatedAtMs: Date.now(),
        summaries,
        toolPolicy: {
            recallDefault: 'fallback',
            rememberDefault: 'explicit_or_gap_only',
            skillListDefault: 'injected_manifest_or_on_demand',
        },
    }
}

export function renderSessionContextBundlePrompt(bundle: SessionContextBundle | null): string {
    if (!bundle) {
        return ''
    }

    const lines: string[] = [
        '',
        '## Yoho ContextBundle（自动上下文，优先使用）',
        `- orgId: ${bundle.orgId}`,
        `- sessionId: ${bundle.sessionId}`,
        '- 这是 server 基于 L1/L2/L3 worker 自动注入的轻量上下文。默认先使用这些信息；只有信息不足、需要证据链、跨 session/项目追溯、或用户明确要求查历史时，才调用 recall。',
        '- remember 默认由 L1/L2/L3 worker 异步沉淀；只有用户明确要求保存、或当前事实不会被后台捕获但必须立即落库时，才调用 remember。',
        '- skill_list 默认不必每轮调用；当没有注入 manifest、候选不明确、路径变化或用户明确要求使用/创建 skill 时，再按需调用 skill_list/search/get。',
    ]

    if (bundle.summaries.latestL3) {
        lines.push('', '### Session 摘要（L3）', renderSummaryLine(bundle.summaries.latestL3))
    }
    if (bundle.summaries.latestL2.length > 0) {
        lines.push('', '### 近期片段摘要（L2）', ...bundle.summaries.latestL2.map(renderSummaryLine))
    }
    if (bundle.summaries.recentL1.length > 0) {
        lines.push('', '### 最近轮次摘要（L1）', ...bundle.summaries.recentL1.map(renderSummaryLine))
    }
    if (!bundle.summaries.latestL3 && bundle.summaries.latestL2.length === 0 && bundle.summaries.recentL1.length === 0) {
        lines.push('', '- 当前 session 暂无可注入的 L1/L2/L3 摘要；如用户问历史或上下文不足，可主动 recall。')
    }

    return lines.join('\n')
}
