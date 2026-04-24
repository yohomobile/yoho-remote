type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type YohoMemoryClientConfig = {
    baseUrl: string
    token: string
    timeoutMs: number
}

export type RememberRequest = {
    input: string
    source?: 'interactive' | 'subtask' | 'automation'
    approvedForLongTerm?: boolean
    idempotencyKey?: string
}

export type SkillSaveRequest = {
    name: string
    category: string
    content: string
    description?: string
    tags?: string[]
    activationMode?: 'manual' | 'model' | 'disabled'
    paths?: string[]
    antiTriggers?: string[]
    requiredTools?: string[]
    allowedTools?: string[]
    idempotencyKey?: string
}

type L1MemoryInput = {
    sessionId: string
    namespace: string
    userSeq: number
    topic: string | null
    summary: string
    tools: string[]
    entities: string[]
    files: string[]
}

type L2MemoryInput = {
    sessionId: string
    namespace: string
    l2Id: string
    topic: string | null
    summary: string
    tools: string[]
    entities: string[]
    l1Count: number
    l1Ids: string[]
}

type L3MemoryInput = {
    sessionId: string
    namespace: string
    l3Id: string
    topic: string | null
    summary: string
    tools: string[]
    entities: string[]
    sourceLevel: 1 | 2
    sourceCount: number
    sourceIds: string[]
    trivial: boolean
}

type SkillContentInput = {
    sourceLevel: 'L2' | 'L3'
    sessionId: string
    namespace: string
    topic: string
    summary: string
    tools: string[]
    entities: string[]
    sourceIds: string[]
}

type MemoryProposalInput = {
    sourceLevel: 'L1' | 'L2' | 'L3'
    sessionId: string
    namespace: string
    topic: string | null
    text: string
    tools: string[]
    entities: string[]
    files?: string[]
    sourceIds?: string[]
}

const GENERIC_TOPIC_PATTERN = /^(general|misc|other|discussion|chat|一般|杂项|闲聊)/i

function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '')
}

function normalizeList(values: string[]): string[] {
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const value of values) {
        const trimmed = value.trim()
        if (trimmed === '' || seen.has(trimmed)) {
            continue
        }
        seen.add(trimmed)
        normalized.push(trimmed)
    }
    return normalized
}

function formatList(values: string[]): string {
    const normalized = normalizeList(values)
    return normalized.length > 0 ? normalized.join(', ') : 'none'
}

function topicOrFallback(topic: string | null | undefined, fallback: string): string {
    const trimmed = topic?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : fallback
}

function hasSpecificTopic(topic: string | null | undefined): topic is string {
    const trimmed = topic?.trim() ?? ''
    return trimmed.length > 0 && !GENERIC_TOPIC_PATTERN.test(trimmed)
}

export function buildSkillTags(tools: string[], entities: string[]): string[] {
    return normalizeList([...tools, ...entities]).slice(0, 8)
}

export function isValuableForL2Skill(input: {
    topic: string | null | undefined
    tools: string[]
    l1Count: number
}): boolean {
    return input.tools.length > 0 && input.l1Count >= 3 && hasSpecificTopic(input.topic)
}

export function isValuableForL3Skill(input: {
    topic: string | null | undefined
    tools: string[]
    sourceCount: number
}): boolean {
    return input.tools.length > 0 && input.sourceCount <= 3 && hasSpecificTopic(input.topic)
}

export function composeL1MemoryInput(input: L1MemoryInput): string {
    return [
        '[yoho-remote summary L1]',
        `Session: ${input.sessionId}`,
        `Namespace: ${input.namespace}`,
        `User seq: ${input.userSeq}`,
        `Topic: ${topicOrFallback(input.topic, 'untitled turn')}`,
        `Summary: ${input.summary}`,
        `Tools: ${formatList(input.tools)}`,
        `Entities: ${formatList(input.entities)}`,
        `Files: ${formatList(input.files)}`,
    ].join('\n')
}

export function composeL2MemoryInput(input: L2MemoryInput): string {
    return [
        '[yoho-remote summary L2]',
        `Session: ${input.sessionId}`,
        `Namespace: ${input.namespace}`,
        `L2 id: ${input.l2Id}`,
        `Topic: ${topicOrFallback(input.topic, 'untitled segment')}`,
        `Summary: ${input.summary}`,
        `Tools: ${formatList(input.tools)}`,
        `Entities: ${formatList(input.entities)}`,
        `L1 count: ${input.l1Count}`,
        `L1 ids: ${formatList(input.l1Ids)}`,
    ].join('\n')
}

export function composeL3MemoryInput(input: L3MemoryInput): string {
    return [
        '[yoho-remote summary L3]',
        `Session: ${input.sessionId}`,
        `Namespace: ${input.namespace}`,
        `L3 id: ${input.l3Id}`,
        `Topic: ${topicOrFallback(input.topic, input.trivial ? 'short session' : 'untitled session')}`,
        `Summary: ${input.summary}`,
        `Tools: ${formatList(input.tools)}`,
        `Entities: ${formatList(input.entities)}`,
        `Source level: L${input.sourceLevel}`,
        `Source count: ${input.sourceCount}`,
        `Source ids: ${formatList(input.sourceIds)}`,
        `Trivial: ${String(input.trivial)}`,
    ].join('\n')
}

export function composeMemoryProposalInput(input: MemoryProposalInput): string {
    const lines = [
        `[yoho-remote memory proposal ${input.sourceLevel}]`,
        `Session: ${input.sessionId}`,
        `Namespace: ${input.namespace}`,
        `Topic: ${topicOrFallback(input.topic, 'untitled')}`,
        '',
        'Memory:',
        input.text.trim(),
        '',
        'Evidence:',
        `Tools: ${formatList(input.tools)}`,
        `Entities: ${formatList(input.entities)}`,
    ]
    if (input.files && input.files.length > 0) {
        lines.push(`Files: ${formatList(input.files)}`)
    }
    if (input.sourceIds && input.sourceIds.length > 0) {
        lines.push(`Source ids: ${formatList(input.sourceIds)}`)
    }
    return lines.join('\n')
}

export function composeSkillContent(input: SkillContentInput): string {
    return [
        `# ${input.topic}`,
        '',
        `Source: yoho-remote ${input.sourceLevel} summary`,
        `Session: ${input.sessionId}`,
        `Namespace: ${input.namespace}`,
        '',
        '## Summary',
        '',
        input.summary,
        '',
        '## Signals',
        '',
        `- Tools: ${formatList(input.tools)}`,
        `- Entities: ${formatList(input.entities)}`,
        `- Source ids: ${formatList(input.sourceIds)}`,
        '',
        '## Usage Note',
        '',
        'This is a candidate workflow distilled from session summaries. Review before promotion.',
    ].join('\n')
}

export class YohoMemoryClient {
    private readonly baseUrl: string
    private readonly token: string
    private readonly timeoutMs: number
    private readonly fetchImpl: FetchLike

    constructor(config: YohoMemoryClientConfig, fetchImpl: FetchLike = fetch) {
        this.baseUrl = stripTrailingSlash(config.baseUrl)
        this.token = config.token.trim()
        this.timeoutMs = config.timeoutMs
        this.fetchImpl = fetchImpl
    }

    async remember(body: RememberRequest): Promise<void> {
        await this.post('/api/remember', { ...body, __sync__: true }, 'remember')
    }

    async saveSkill(body: SkillSaveRequest): Promise<void> {
        await this.post('/api/skill_save', { ...body, __sync__: true }, 'skill_save')
    }

    private async post(path: string, body: Record<string, unknown>, label: string): Promise<void> {
        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            }
            if (this.token !== '') {
                headers.Authorization = `Bearer ${this.token}`
            }

            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            if (!response.ok) {
                const text = await response.text().catch(() => '')
                const suffix = text.trim() === '' ? '' : `: ${text.trim().slice(0, 500)}`
                throw new Error(`HTTP ${response.status}${suffix}`)
            }
        } catch (error) {
            console.warn(`[yohoMemory] ${label} failed:`, error)
        }
    }
}
