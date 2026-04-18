import type { DbMessage } from '../types'
import { isRealActivityMessage } from './activity'

const TOOL_SUMMARY_MAX_LENGTH = 120
const FILE_PATH_KEYS = ['file_path', 'path', 'paths']

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function dedupeStrings(values: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of values) {
        const trimmed = value.trim()
        if (trimmed.length === 0 || seen.has(trimmed)) {
            continue
        }
        seen.add(trimmed)
        result.push(trimmed)
    }
    return result
}

function truncate(value: string, maxLength: number = TOOL_SUMMARY_MAX_LENGTH): string {
    if (value.length <= maxLength) {
        return value
    }
    return `${value.slice(0, maxLength - 3)}...`
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function normalizeText(value: string[]): string {
    return value
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join('\n')
}

function pushUserContent(parts: string[], value: unknown): void {
    if (typeof value === 'string') {
        const text = asString(value)
        if (text) {
            parts.push(text)
        }
        return
    }

    const record = asRecord(value)
    if (record?.type === 'text') {
        const text = asString(record.text)
        if (text) {
            parts.push(text)
        }
        return
    }

    if (!Array.isArray(value)) {
        return
    }

    for (const block of value) {
        const blockRecord = asRecord(block)
        if (!blockRecord || typeof blockRecord.type !== 'string') {
            continue
        }
        if (blockRecord.type === 'text') {
            const text = asString(blockRecord.text)
            if (text) {
                parts.push(text)
            }
            continue
        }
        if (blockRecord.type === 'image') {
            parts.push('[Image]')
            continue
        }
        if (blockRecord.type === 'document') {
            parts.push('[Document]')
        }
    }
}

function maybePushFilePaths(input: unknown, files: string[]): void {
    const record = asRecord(input)
    if (!record) {
        return
    }

    for (const key of FILE_PATH_KEYS) {
        const value = record[key]
        if (typeof value === 'string') {
            if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
                files.push(value)
            }
            continue
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('./') || item.startsWith('../'))) {
                    files.push(item)
                }
            }
        }
    }
}

function isSkillGetTool(name: string): boolean {
    const normalized = name.toLowerCase()
    return normalized.includes('skill__get') || normalized.endsWith('skill_get') || normalized.includes('skill/get')
}

function summarizeToolUse(name: string, input: unknown): string {
    const inputRecord = asRecord(input)
    const filePath = asString(inputRecord?.file_path) ?? asString(inputRecord?.path)
    if (filePath) {
        return `${name} ${truncate(filePath)}`
    }

    const command = asString(inputRecord?.command) ?? asString(inputRecord?.cmd)
    if (command) {
        return `${name} ${truncate(command)}`
    }

    const pattern = asString(inputRecord?.pattern) ?? asString(inputRecord?.q)
    if (pattern) {
        return `${name} ${truncate(pattern)}`
    }

    const skillId = asString(inputRecord?.id)
    if (skillId && isSkillGetTool(name)) {
        return `${name} ${truncate(skillId)}`
    }

    if (inputRecord) {
        return `${name} ${truncate(safeStringify(inputRecord))}`
    }

    return name
}

function extractAssistantBlocks(
    value: unknown,
    assistantParts: string[],
    toolUses: string[],
    skillRefs: string[],
    files: string[]
): void {
    if (typeof value === 'string') {
        const text = asString(value)
        if (text) {
            assistantParts.push(text)
        }
        return
    }

    if (!Array.isArray(value)) {
        return
    }

    for (const block of value) {
        const record = asRecord(block)
        if (!record || typeof record.type !== 'string') {
            continue
        }
        if (record.type === 'text') {
            const text = asString(record.text)
            if (text) {
                assistantParts.push(text)
            }
            continue
        }
        if (record.type === 'tool_use' || record.type === 'server_tool_use') {
            const name = asString(record.name) ?? 'Tool'
            const input = record.input
            toolUses.push(summarizeToolUse(name, input))
            maybePushFilePaths(input, files)
            if (isSkillGetTool(name)) {
                const skillId = asString(asRecord(input)?.id)
                if (skillId) {
                    skillRefs.push(skillId)
                }
            }
        }
    }
}

function extractAssistantContent(
    content: unknown,
    assistantParts: string[],
    toolUses: string[],
    skillRefs: string[],
    files: string[]
): void {
    const record = asRecord(content)
    if (!record) {
        return
    }

    if (Array.isArray(content)) {
        extractAssistantBlocks(content, assistantParts, toolUses, skillRefs, files)
        return
    }

    if (record.role === 'assistant') {
        extractAssistantBlocks(record.content, assistantParts, toolUses, skillRefs, files)
        const plainText = asString(record.content)
        if (plainText) {
            assistantParts.push(plainText)
        }
        return
    }

    if (record.role !== 'agent') {
        return
    }

    const inner = asRecord(record.content)
    if (!inner) {
        return
    }

    if (Array.isArray(record.content)) {
        extractAssistantBlocks(record.content, assistantParts, toolUses, skillRefs, files)
        return
    }

    if (inner.type !== 'output') {
        return
    }

    const data = asRecord(inner.data)
    if (!data) {
        return
    }

    if (data.type === 'assistant') {
        const message = asRecord(data.message)
        extractAssistantBlocks(message?.content, assistantParts, toolUses, skillRefs, files)
        if (typeof message?.content === 'string') {
            const text = asString(message.content)
            if (text) {
                assistantParts.push(text)
            }
        }
        return
    }

    if (data.type === 'result') {
        const result = asString(data.result)
        if (result) {
            assistantParts.push(result)
        }
        return
    }

    if (data.type === 'attachment') {
        const attachmentType = asString(asRecord(data.attachment)?.type)
        if (attachmentType) {
            assistantParts.push(`[attachment:${attachmentType}]`)
        }
    }
}

export type ExtractedTurn = {
    userText: string
    assistantText: string
    toolUses: string[]
    skillRefs: string[]
    files: string[]
    realMessageCount: number
}

export function isTurnStartUserMessage(content: unknown): boolean {
    const record = asRecord(content)
    if (!record || record.role !== 'user') {
        return false
    }

    if (typeof record.content === 'string') {
        return asString(record.content) !== null
    }

    const contentRecord = asRecord(record.content)
    if (contentRecord?.type === 'text') {
        return asString(contentRecord.text) !== null
    }

    if (!Array.isArray(record.content)) {
        return false
    }

    return record.content.some((block) => {
        const blockRecord = asRecord(block)
        if (!blockRecord || typeof blockRecord.type !== 'string') {
            return false
        }
        return blockRecord.type === 'text' || blockRecord.type === 'image' || blockRecord.type === 'document'
    })
}

export function isMidStreamToolUse(content: unknown): boolean {
    const record = asRecord(content)
    if (!record) {
        return false
    }

    let blocks: unknown = null

    if (record.role === 'agent') {
        const inner = asRecord(record.content)
        const data = asRecord(inner?.data)
        const message = asRecord(data?.message)
        blocks = message?.content
    } else if (record.role === 'assistant') {
        blocks = record.content
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
        return false
    }

    const last = asRecord(blocks[blocks.length - 1])
    if (!last || typeof last.type !== 'string') {
        return false
    }

    return last.type === 'tool_use' || last.type === 'server_tool_use'
}

export function extractTurnContent(messages: DbMessage[]): ExtractedTurn {
    const userParts: string[] = []
    const assistantParts: string[] = []
    const toolUses: string[] = []
    const skillRefs: string[] = []
    const files: string[] = []
    let realMessageCount = 0

    for (const message of messages) {
        if (!isRealActivityMessage(message.content)) {
            continue
        }

        realMessageCount++
        const record = asRecord(message.content)
        if (!record) {
            continue
        }

        if (record.role === 'user' && isTurnStartUserMessage(message.content)) {
            pushUserContent(userParts, record.content)
            continue
        }

        if (record.role === 'assistant' || record.role === 'agent') {
            extractAssistantContent(message.content, assistantParts, toolUses, skillRefs, files)
        }
    }

    return {
        userText: normalizeText(userParts),
        assistantText: normalizeText(assistantParts),
        toolUses: dedupeStrings(toolUses),
        skillRefs: dedupeStrings(skillRefs),
        files: dedupeStrings(files),
        realMessageCount,
    }
}
