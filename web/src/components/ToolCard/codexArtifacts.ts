function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getString(value: unknown, key: string): string | null {
    if (!isObject(value)) return null
    const candidate = value[key]
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

function getStringAny(value: unknown, keys: string[]): string | null {
    for (const key of keys) {
        const candidate = getString(value, key)
        if (candidate) return candidate
    }
    return null
}

export type CodexPatchEntry = {
    filePath: string | null
    language: 'diff' | 'text'
    text: string | null
}

export function getCodexPatchEntries(input: unknown, result: unknown): CodexPatchEntry[] {
    if (isObject(input) && isObject(input.changes)) {
        const entries = Object.entries(input.changes).map(([filePath, change]) => {
            if (!isObject(change)) {
                return {
                    filePath,
                    language: 'text' as const,
                    text: null
                }
            }

            const unifiedDiff = getString(change, 'unified_diff')
            if (unifiedDiff) {
                return {
                    filePath,
                    language: 'diff' as const,
                    text: unifiedDiff
                }
            }

            const content = getString(change, 'content')
            return {
                filePath,
                language: 'text' as const,
                text: content
            }
        })

        if (entries.length > 0) {
            return entries
        }
    }

    const resultDiff = getString(result, 'diff')
    if (resultDiff) {
        return [{
            filePath: getStringAny(result, ['file_path', 'path']) ?? getStringAny(input, ['file_path', 'path']),
            language: 'diff',
            text: resultDiff
        }]
    }

    const filePath = getStringAny(input, ['file_path', 'path']) ?? getStringAny(result, ['file_path', 'path'])
    if (!filePath) {
        return []
    }

    return [{
        filePath,
        language: 'text',
        text: null
    }]
}

export function getCodexPatchPrimaryPath(input: unknown, result: unknown): string | null {
    return getCodexPatchEntries(input, result)[0]?.filePath ?? null
}

export function getCodexDiffUnified(input: unknown): string | null {
    return getString(input, 'unified_diff')
}

export function getUnifiedDiffFilePath(unifiedDiff: string): string | null {
    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            return line.replace(/^\+\+\+ (b\/)?/, '')
        }
    }

    return null
}

export function truncatePreview(text: string, maxLines: number = 40, maxChars: number = 2500): string {
    const lines = text.split('\n')
    const limitedLines = lines.slice(0, maxLines).join('\n')
    const truncatedByLines = lines.length > maxLines
    const limitedText = limitedLines.length > maxChars
        ? `${limitedLines.slice(0, maxChars)}\n...`
        : limitedLines

    if (truncatedByLines && !limitedText.endsWith('\n...')) {
        return `${limitedText}\n...`
    }

    return limitedText
}
