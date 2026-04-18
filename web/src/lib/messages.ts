import type { InfiniteData } from '@tanstack/react-query'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export function makeClientSideId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random()}`
}

function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function getStableOrderIndex(messages: readonly DecryptedMessage[]): Map<string, number> {
    const order = new Map<string, number>()
    messages.forEach((message, index) => {
        if (!order.has(message.id)) {
            order.set(message.id, index)
        }
    })
    return order
}

function getLocalId(msg: DecryptedMessage): string | null {
    return typeof msg.localId === 'string' && msg.localId.length > 0 ? msg.localId : null
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage, orderById: Map<string, number>): number {
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null
    if (aSeq !== null || bSeq !== null) {
        if (aSeq === null) return 1
        if (bSeq === null) return -1
        if (aSeq !== bSeq) {
            return aSeq - bSeq
        }
    }

    const aLocalId = getLocalId(a)
    const bLocalId = getLocalId(b)
    if (aLocalId !== null && bLocalId !== null && aLocalId !== bLocalId) {
        return aLocalId.localeCompare(bLocalId)
    }

    return (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0)
}

function sortMessages(messages: DecryptedMessage[]): DecryptedMessage[] {
    if (messages.length <= 1) {
        return messages
    }
    const orderById = getStableOrderIndex(messages)
    return [...messages].sort((a, b) => compareMessages(a, b, orderById))
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return sortMessages([...incoming])
    }
    if (incoming.length === 0) {
        return sortMessages([...existing])
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const incomingLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId) {
            incomingLocalIds.add(msg.localId)
        }
    }

    // If we received a stored message with a localId, drop any optimistic bubble with the same localId.
    if (incomingLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingLocalIds.has(msg.localId)) {
                return true
            }
            return !msg.status
        })
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => m.localId && m.status)
    const nonOptimisticMessages = merged.filter((m) => !m.localId || !m.status)
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                !m.status &&
                isUserMessage(m) &&
                Math.abs(m.createdAt - optimistic.createdAt) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    return sortMessages(result)
}

export function upsertMessagesInCache(
    data: InfiniteData<MessagesResponse> | undefined,
    incoming: DecryptedMessage[],
): InfiniteData<MessagesResponse> {
    const mergedIncoming = mergeMessages([], incoming)

    if (!data || data.pages.length === 0) {
        return {
            pages: [
                {
                    messages: mergedIncoming,
                    page: {
                        limit: 200,
                        beforeSeq: null,
                        nextBeforeSeq: null,
                        hasMore: false,
                    },
                },
            ],
            pageParams: [null],
        }
    }

    const pages = data.pages.slice()
    const first = pages[0]
    pages[0] = {
        ...first,
        messages: mergeMessages(first.messages, mergedIncoming),
    }

    return {
        ...data,
        pages,
    }
}
