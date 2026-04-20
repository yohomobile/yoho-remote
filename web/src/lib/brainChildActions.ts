import { normalizeDecryptedMessage } from '@/chat/normalize'
import { renderEventLabel } from '@/chat/presentation'
import type { NormalizedAgentContent, NormalizedMessage } from '@/chat/types'
import type { DecryptedMessage, Session } from '@/types/api'

export type BrainChildPageActionState = {
    mainSessionId: string | null
    canStop: boolean
    canResume: boolean
}

export function getBrainChildPageInactiveHint(args: {
    resumeError: boolean
    hasMainSessionId: boolean
    hasMessages: boolean
}): string {
    const actionHint = args.hasMainSessionId
        ? '此页不接受直接发消息；可使用上方操作条返回主 Brain、恢复或查看最近片段。'
        : '此页不接受直接发消息；可使用上方操作条恢复或查看最近片段。'

    if (args.resumeError) {
        return `恢复失败。${actionHint}`
    }
    if (!args.hasMessages) {
        return `正在等待子任务启动。${actionHint}`
    }
    return `子任务当前未运行。${actionHint}`
}

export type BrainChildTailPreviewItem = {
    id: string
    createdAt: number
    label: string
    snippet: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null
}

function clipText(text: string, maxLen: number = 180): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLen) {
        return normalized
    }
    return `${normalized.slice(0, maxLen - 1)}…`
}

function normalizeSnippetText(text: string): string {
    const trimmed = text.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        return trimmed
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
            const joined = parsed
                .map((entry) => {
                    const record = asRecord(entry)
                    return asString(record?.text) ?? asString(record?.content)
                })
                .filter((entry): entry is string => Boolean(entry))
                .join('\n')
            if (joined) {
                return joined
            }
        }
        const record = asRecord(parsed)
        const value = asString(record?.text) ?? asString(record?.content)
        if (value) {
            return value
        }
    } catch {
        // Ignore JSON parsing errors and keep the original text.
    }

    return trimmed
}

function extractRawMessageText(content: unknown): string | null {
    if (typeof content === 'string') {
        return clipText(content)
    }

    const record = asRecord(content)
    if (!record) {
        return null
    }

    const directContent = asString(record.content)
    if (directContent) {
        return clipText(directContent)
    }

    const parts = Array.isArray(record.content)
        ? record.content
        : Array.isArray(record.parts)
            ? record.parts
            : null
    if (!parts) {
        return null
    }

    const joined = parts
        .map((part) => {
            const partRecord = asRecord(part)
            if (!partRecord) return null
            return asString(partRecord.text) ?? asString(partRecord.content)
        })
        .filter((part): part is string => Boolean(part))
        .join('\n')

    return joined ? clipText(joined) : null
}

function createPreviewItem(
    id: string,
    createdAt: number,
    label: string,
    snippet: string | null,
): BrainChildTailPreviewItem | null {
    if (!snippet) {
        return null
    }
    return {
        id,
        createdAt,
        label,
        snippet: clipText(normalizeSnippetText(snippet)),
    }
}

function normalizedAgentContentToPreviewItems(
    message: Extract<NormalizedMessage, { role: 'agent' }>,
): BrainChildTailPreviewItem[] {
    const items: BrainChildTailPreviewItem[] = []

    message.content.forEach((content, index) => {
        const item = (() => {
            switch (content.type) {
                case 'text':
                    return createPreviewItem(`${message.id}:text:${index}`, message.createdAt, '输出', content.text)
                case 'tool-call':
                    return createPreviewItem(
                        `${message.id}:tool:${index}`,
                        message.createdAt,
                        `工具 ${content.name}`,
                        content.description ?? JSON.stringify(content.input)
                    )
                case 'tool-result':
                    return createPreviewItem(
                        `${message.id}:tool-result:${index}`,
                        message.createdAt,
                        '工具结果',
                        typeof content.content === 'string' ? content.content : JSON.stringify(content.content)
                    )
                default:
                    return null
            }
        })()

        if (item) {
            items.push(item)
        }
    })

    return items
}

function normalizedMessageToPreviewItems(message: NormalizedMessage): BrainChildTailPreviewItem[] {
    if (message.role === 'user') {
        return createPreviewItem(message.id, message.createdAt, '输入', message.content.text)
            ? [createPreviewItem(message.id, message.createdAt, '输入', message.content.text)!]
            : []
    }

    if (message.role === 'event') {
        const label = renderEventLabel(message.content)
        if (label === 'Unrecognized message format') {
            return []
        }
        return createPreviewItem(message.id, message.createdAt, '事件', label)
            ? [createPreviewItem(message.id, message.createdAt, '事件', label)!]
            : []
    }

    return normalizedAgentContentToPreviewItems(message)
}

export function deriveBrainChildPageActionState(
    session: Pick<Session, 'active' | 'thinking' | 'metadata'>,
): BrainChildPageActionState {
    const mainSessionId = typeof session.metadata?.mainSessionId === 'string' && session.metadata.mainSessionId.trim().length > 0
        ? session.metadata.mainSessionId
        : null

    return {
        mainSessionId,
        canStop: session.active && session.thinking,
        canResume: !session.active,
    }
}

export function extractBrainChildTailPreview(
    messages: DecryptedMessage[],
    limit: number = 6,
): BrainChildTailPreviewItem[] {
    const items: BrainChildTailPreviewItem[] = []

    messages.forEach((message, index) => {
        const normalized = normalizeDecryptedMessage(message)
        const normalizedItems = Array.isArray(normalized)
            ? normalized.flatMap((entry) => normalizedMessageToPreviewItems(entry))
            : normalized
                ? normalizedMessageToPreviewItems(normalized)
                : []

        if (normalizedItems.length > 0) {
            items.push(...normalizedItems)
            return
        }

        const fallback = extractRawMessageText(message.content)
        const item = createPreviewItem(
            message.id || `fallback:${index}`,
            message.createdAt,
            '消息',
            fallback,
        )
        if (item) {
            items.push(item)
        }
    })

    return items.slice(-limit)
}
