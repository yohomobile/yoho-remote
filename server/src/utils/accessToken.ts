export type ParsedAccessToken = {
    baseToken: string
}

export function parseAccessToken(raw: string): ParsedAccessToken | null {
    if (!raw) {
        return null
    }

    const trimmed = raw.trim()
    if (!trimmed) {
        return null
    }

    if (trimmed.includes(':')) {
        return null
    }

    if (trimmed.trim() !== trimmed) {
        return null
    }

    return { baseToken: trimmed }
}
