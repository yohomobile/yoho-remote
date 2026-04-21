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

function getChangeEntry(filePath: string | null, change: unknown): CodexPatchEntry {
    if (!isObject(change)) {
        return {
            filePath,
            language: 'text',
            text: null
        }
    }

    const unifiedDiff = getStringAny(change, ['unified_diff', 'diff'])
    if (unifiedDiff) {
        return {
            filePath,
            language: 'diff',
            text: unifiedDiff
        }
    }

    const content = getString(change, 'content')
    return {
        filePath,
        language: 'text',
        text: content
    }
}

function getEntriesFromInputChanges(input: unknown): CodexPatchEntry[] {
    if (!isObject(input) || !isObject(input.changes)) {
        return []
    }

    const entries = Object.entries(input.changes).map(([filePath, change]) => getChangeEntry(filePath, change))
    return entries.length > 0 ? entries : []
}

function getEntriesFromResultChanges(result: unknown): CodexPatchEntry[] {
    if (!isObject(result) || !Array.isArray(result.changes)) {
        return []
    }

    const entries = result.changes.flatMap((change): CodexPatchEntry[] => {
        if (!isObject(change)) {
            return []
        }
        const filePath = getStringAny(change, ['path', 'file_path'])
        return [getChangeEntry(filePath, change)]
    })

    return entries.length > 0 ? entries : []
}

function mergePatchEntries(inputEntries: CodexPatchEntry[], resultEntries: CodexPatchEntry[]): CodexPatchEntry[] {
    if (inputEntries.length === 0) return resultEntries
    if (resultEntries.length === 0) return inputEntries

    const overlayByPath = new Map<string, CodexPatchEntry>()
    for (const entry of resultEntries) {
        if (entry.filePath) {
            overlayByPath.set(entry.filePath, entry)
        }
    }

    const merged = inputEntries.map((entry) => {
        if (!entry.filePath) {
            return entry
        }
        const overlay = overlayByPath.get(entry.filePath)
        if (!overlay) {
            return entry
        }
        return {
            filePath: overlay.filePath ?? entry.filePath,
            language: overlay.text ? overlay.language : entry.language,
            text: overlay.text ?? entry.text
        }
    })

    const knownPaths = new Set(merged.map((entry) => entry.filePath).filter((value): value is string => typeof value === 'string'))
    for (const entry of resultEntries) {
        if (!entry.filePath || knownPaths.has(entry.filePath)) {
            continue
        }
        merged.push(entry)
    }

    return merged
}

export function getCodexPatchEntries(input: unknown, result: unknown): CodexPatchEntry[] {
    const mergedEntries = mergePatchEntries(
        getEntriesFromInputChanges(input),
        getEntriesFromResultChanges(result)
    )
    if (mergedEntries.length > 0) {
        return mergedEntries
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

function getCodexDiffText(source: unknown): string | null {
    return getStringAny(source, ['unified_diff', 'diff'])
}

export function getCodexDiffUnified(input: unknown, result: unknown = null): string | null {
    return getCodexDiffText(input) ?? getCodexDiffText(result)
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
