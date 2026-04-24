import type { AgentEvent, BrainChildCallbackEnvelope } from '@/chat/types'

const BRAIN_CHILD_CALLBACK_HEADER = '[子 session 任务完成]'
const SESSION_PREFIX = 'Session:'
const TITLE_PREFIX = '标题:'
const PREVIOUS_SUMMARY_PREFIX = '上次总结:'

export type BrainChildCallbackEvent = Extract<
    AgentEvent,
    { type: 'brain-child-callback' }
>

function extractPrefixedValue(
    line: string,
    prefix: string
): string | undefined {
    if (!line.startsWith(prefix)) {
        return undefined
    }
    const value = line.slice(prefix.length).trim()
    return value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseBrainChildCallbackEnvelope(
    meta: unknown
): BrainChildCallbackEnvelope | null {
    const metaRecord = asRecord(meta)
    const rawEnvelope = asRecord(metaRecord?.brainChildCallback)
    if (!rawEnvelope) {
        return null
    }

    const stats = asRecord(rawEnvelope.stats)
    const result = asRecord(rawEnvelope.result)
    const sessionId = asString(rawEnvelope.sessionId)
    const mainSessionId = asString(rawEnvelope.mainSessionId)
    const parentSource = asString(rawEnvelope.parentSource)
    const childSource = asString(rawEnvelope.childSource)
    const title = asString(rawEnvelope.title)
    const type = rawEnvelope.type
    const version = rawEnvelope.version
    const messageCount = stats?.messageCount
    const contextBudget = stats?.contextBudget
    const contextRemainingPercent = stats?.contextRemainingPercent
    const inputTokens = stats?.inputTokens
    const outputTokens = stats?.outputTokens
    const contextSize = stats?.contextSize
    const resultText = asString(result?.text)
    const resultSource = result?.source
    const resultSeq = result?.seq

    if (
        type !== 'brain-child-callback' ||
        version !== 1 ||
        !sessionId ||
        !mainSessionId ||
        !title ||
        typeof messageCount !== 'number' ||
        typeof contextBudget !== 'number' ||
        !resultText ||
        (resultSource !== 'result' &&
            resultSource !== 'assistant' &&
            resultSource !== 'message' &&
            resultSource !== 'raw-data' &&
            resultSource !== 'none')
    ) {
        return null
    }

    return {
        type: 'brain-child-callback',
        version: 1,
        sessionId,
        mainSessionId,
        ...(parentSource ? { parentSource } : {}),
        ...(childSource ? { childSource } : {}),
        title,
        previousSummary:
            typeof rawEnvelope.previousSummary === 'string'
                ? rawEnvelope.previousSummary
                : null,
        details: Array.isArray(rawEnvelope.details)
            ? rawEnvelope.details.filter(
                  (item): item is string => typeof item === 'string'
              )
            : [],
        stats: {
            messageCount,
            contextBudget,
            ...(typeof contextRemainingPercent === 'number'
                ? { contextRemainingPercent }
                : {}),
            ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
            ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
            ...(typeof contextSize === 'number' ? { contextSize } : {}),
        },
        result: {
            text: resultText,
            source: resultSource,
            ...(typeof resultSeq === 'number' ? { seq: resultSeq } : {}),
        },
    }
}

export function parseBrainChildCallbackMessage(
    text: string,
    meta?: unknown
): BrainChildCallbackEvent | null {
    const envelope = parseBrainChildCallbackEnvelope(meta)
    if (envelope) {
        return {
            type: 'brain-child-callback',
            sessionId: envelope.sessionId,
            title: envelope.title,
            previousSummary: envelope.previousSummary ?? undefined,
            parentSource: envelope.parentSource,
            childSource: envelope.childSource,
            details: envelope.details,
            report: envelope.result.text,
            envelope,
        }
    }

    const normalized = text.replace(/\r\n?/g, '\n').trimStart()
    if (!normalized.startsWith(BRAIN_CHILD_CALLBACK_HEADER)) {
        return null
    }

    const lines = normalized.split('\n')
    const details: string[] = []
    let sessionId: string | undefined
    let title: string | undefined
    let previousSummary: string | undefined
    let index = 1

    while (index < lines.length) {
        const trimmedLine = lines[index]?.trim() ?? ''
        index += 1

        if (!trimmedLine) {
            break
        }

        sessionId =
            sessionId ?? extractPrefixedValue(trimmedLine, SESSION_PREFIX)
        if (sessionId && trimmedLine.startsWith(SESSION_PREFIX)) {
            continue
        }

        title = title ?? extractPrefixedValue(trimmedLine, TITLE_PREFIX)
        if (title && trimmedLine.startsWith(TITLE_PREFIX)) {
            continue
        }

        previousSummary =
            previousSummary ??
            extractPrefixedValue(trimmedLine, PREVIOUS_SUMMARY_PREFIX)
        if (
            previousSummary &&
            trimmedLine.startsWith(PREVIOUS_SUMMARY_PREFIX)
        ) {
            continue
        }

        details.push(trimmedLine)
    }

    const report = lines.slice(index).join('\n')

    return {
        type: 'brain-child-callback',
        sessionId,
        title,
        previousSummary,
        details,
        report: report.trim().length > 0 ? report : undefined,
    }
}
