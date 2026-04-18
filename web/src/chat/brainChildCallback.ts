import type { AgentEvent } from '@/chat/types'

const BRAIN_CHILD_CALLBACK_HEADER = '[子 session 任务完成]'
const SESSION_PREFIX = 'Session:'
const TITLE_PREFIX = '标题:'
const PREVIOUS_SUMMARY_PREFIX = '上次总结:'

export type BrainChildCallbackEvent = Extract<AgentEvent, { type: 'brain-child-callback' }>

function extractPrefixedValue(line: string, prefix: string): string | undefined {
    if (!line.startsWith(prefix)) {
        return undefined
    }
    const value = line.slice(prefix.length).trim()
    return value.length > 0 ? value : undefined
}

export function parseBrainChildCallbackMessage(text: string): BrainChildCallbackEvent | null {
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

        sessionId = sessionId ?? extractPrefixedValue(trimmedLine, SESSION_PREFIX)
        if (sessionId && trimmedLine.startsWith(SESSION_PREFIX)) {
            continue
        }

        title = title ?? extractPrefixedValue(trimmedLine, TITLE_PREFIX)
        if (title && trimmedLine.startsWith(TITLE_PREFIX)) {
            continue
        }

        previousSummary = previousSummary ?? extractPrefixedValue(trimmedLine, PREVIOUS_SUMMARY_PREFIX)
        if (previousSummary && trimmedLine.startsWith(PREVIOUS_SUMMARY_PREFIX)) {
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
        report: report.trim().length > 0 ? report : undefined
    }
}
