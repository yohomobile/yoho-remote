import { hashStableValueSync } from '@/lib/hash'

const LOCAL_ID_PREFIX_REGEX = /^(.*?)(?::\d+)$/

export function parseLocalIdPrefix(id: string): string {
    const match = id.match(LOCAL_ID_PREFIX_REGEX)
    return match ? match[1] : id
}

export function deriveStableMessageId(message: {
    id: string
    localId?: string | null
    seq?: number | null
}): string {
    if (typeof message.localId === 'string' && message.localId.length > 0) {
        return message.localId
    }

    if (typeof message.seq === 'number' && Number.isFinite(message.seq)) {
        return `seq:${message.seq}:${hashStableValueSync(parseLocalIdPrefix(message.id))}`
    }

    return parseLocalIdPrefix(message.id)
}
