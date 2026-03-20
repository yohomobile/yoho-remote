/**
 * Feishu message formatter.
 * Converts Brain agent output to Feishu message formats.
 *
 * Short plain-text replies → msg_type "text"
 * Longer / markdown-rich replies → msg_type "interactive" (card with markdown element)
 */

const MAX_CARD_LENGTH = 4000
const SHORT_TEXT_THRESHOLD = 200

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

        // Simple text format
        if (typeof data?.type === 'string' && data.type === 'message' && typeof data.message === 'string') {
            return data.message
        }

        // Codex format
        const contentType = (innerContent as Record<string, unknown>).type as string
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
 * (e.g. "[子 session 任务完成]") that should NOT be forwarded to Feishu.
 */
export function isInternalBrainMessage(text: string): boolean {
    // Brain callback messages
    if (text.startsWith('[子 session 任务完成]')) return true
    // Tool use results
    if (text.startsWith('[tool_result]')) return true
    return false
}

/**
 * Detect whether text contains markdown formatting.
 */
function hasMarkdownFormatting(text: string): boolean {
    // Headers, bold, italic, code blocks, lists, links, tables
    return /^#{1,6}\s|(\*\*|__).+(\*\*|__)|```|^\s*[-*+]\s|^\s*\d+\.\s|\[.+\]\(.+\)|^\|.+\|/m.test(text)
}

/**
 * Build a Feishu message payload ready for the API.
 *
 * - Short plain text (<=200 chars, no markdown) → text message
 * - Otherwise → interactive card with markdown element
 */
export function buildFeishuMessage(text: string): { msgType: string; content: string } {
    const isShort = text.length <= SHORT_TEXT_THRESHOLD
    const hasMd = hasMarkdownFormatting(text)

    if (isShort && !hasMd) {
        return {
            msgType: 'text',
            content: JSON.stringify({ text }),
        }
    }

    // Truncate for card if too long
    let cardText = text
    if (cardText.length > MAX_CARD_LENGTH) {
        cardText = cardText.slice(0, MAX_CARD_LENGTH) + '\n\n...(内容过长已截断)'
    }

    const card = {
        config: { wide_screen_mode: true },
        elements: [
            {
                tag: 'markdown',
                content: cardText,
            },
        ],
    }

    return {
        msgType: 'interactive',
        content: JSON.stringify(card),
    }
}
