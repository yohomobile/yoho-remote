function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function stableSerialize(value: unknown, seen: WeakSet<object>): string {
    if (value === null) {
        return 'null'
    }

    switch (typeof value) {
        case 'string':
            return JSON.stringify(value)
        case 'number':
            return Number.isFinite(value) ? String(value) : 'null'
        case 'boolean':
            return value ? 'true' : 'false'
        case 'bigint':
            return JSON.stringify(`${value.toString()}n`)
        case 'undefined':
            return 'undefined'
        case 'symbol':
            return JSON.stringify(value.toString())
        case 'function':
            return JSON.stringify('[Function]')
        default:
            break
    }

    if (value instanceof Date) {
        return JSON.stringify(value.toISOString())
    }
    if (value instanceof RegExp) {
        return JSON.stringify(value.toString())
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item === undefined ? null : item, seen)).join(',')}]`
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            throw new Error('Circular reference detected while hashing value')
        }

        seen.add(value)
        const entries: string[] = []
        for (const key of Object.keys(value).sort()) {
            const item = (value as Record<string, unknown>)[key]
            if (item === undefined) {
                continue
            }
            entries.push(`${JSON.stringify(key)}:${stableSerialize(item, seen)}`)
        }
        seen.delete(value)
        return `{${entries.join(',')}}`
    }

    return JSON.stringify(String(value))
}

export function stableStringify(value: unknown): string {
    return stableSerialize(value, new WeakSet<object>())
}

function hashStringDjb2(text: string): string {
    let hash = 5381
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
    }
    return `djb2:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function hashStableValueSync(value: unknown): string {
    return hashStringDjb2(stableStringify(value))
}

export async function hashStableValue(value: unknown): Promise<string> {
    const text = stableStringify(value)
    const subtle = globalThis.crypto?.subtle
    if (subtle) {
        try {
            const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
            return `sha256:${toHex(new Uint8Array(digest))}`
        } catch {
            // Fall back to a synchronous hash in environments that expose subtle
            // but reject digest calls for the current runtime.
        }
    }

    return hashStringDjb2(text)
}
