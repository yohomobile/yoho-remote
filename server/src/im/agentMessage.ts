/**
 * Agent message parsing utilities.
 * Extracts text and metadata from Brain agent output (SyncEngine messages).
 * Platform-independent — used by BrainBridge to process Brain responses.
 */

/**
 * Extract the Claude message ID and whether the content block contains tool_use.
 * Used to detect "thinking text" that precedes tool calls.
 */
export function extractAgentMessageMeta(content: unknown): { messageId: string; hasToolUse: boolean } | null {
    if (!content || typeof content !== 'object') return null
    const record = content as Record<string, unknown>
    const role = record.role as string | undefined
    if (role !== 'agent' && role !== 'assistant') return null
    const innerContent = record.content as Record<string, unknown> | string | null
    if (!innerContent || typeof innerContent !== 'object') return null
    const data = (innerContent as Record<string, unknown>).data as Record<string, unknown> | undefined
    if (data?.type !== 'assistant' || !data.message) return null
    const message = data.message as Record<string, unknown>
    const messageId = message.id as string | undefined
    if (!messageId) return null
    const blocks = message.content as Array<Record<string, unknown>> | undefined
    const hasToolUse = Array.isArray(blocks) && blocks.some(b => b.type === 'tool_use')
    return { messageId, hasToolUse }
}

/**
 * Extract text from a SyncEngine message content object.
 * Only extracts agent/assistant role messages.
 */
export function extractAgentText(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null
    const record = content as Record<string, unknown>

    const role = record.role as string | undefined
    if (role !== 'agent' && role !== 'assistant') return null

    const innerContent = record.content as Record<string, unknown> | string | null
    if (typeof innerContent === 'string') {
        return innerContent
    }
    if (innerContent && typeof innerContent === 'object') {
        // Skip system event messages (account rotation, errors, status updates)
        const contentType = (innerContent as Record<string, unknown>).type as string | undefined
        if (contentType === 'event') return null

        const data = innerContent.data as Record<string, unknown> | undefined

        // Claude Code agent format: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
        if (data?.type === 'assistant' && data.message) {
            const message = data.message as Record<string, unknown>
            const blocks = message.content as Array<Record<string, unknown>> | undefined
            if (Array.isArray(blocks)) {
                const texts = blocks
                    .filter(b => b.type === 'text' && typeof b.text === 'string')
                    .map(b => b.text as string)
                if (texts.length > 0) return texts.join('\n')
            }
        }

        // Result format: { type: 'output', data: { type: 'result', result: '...' } }
        if (data?.type === 'result' && typeof data.result === 'string') {
            return data.result
        }

        // Simple text format
        if (typeof data?.type === 'string' && data.type === 'message' && typeof data.message === 'string') {
            return data.message
        }

        // Codex format
        if (contentType === 'codex' && data?.type === 'message' && typeof data.message === 'string') {
            return data.message
        }
        if (contentType === 'text') {
            return ((innerContent as Record<string, unknown>).text as string) || null
        }
    }
    return null
}

/**
 * Check if a message is an internal Brain orchestration message
 * (e.g. "[子 session 任务完成]") that should NOT be forwarded to IM.
 */
export function isInternalBrainMessage(text: string): boolean {
    if (text.startsWith('[子 session 任务完成]')) return true
    if (text.startsWith('[tool_result]')) return true
    return false
}
