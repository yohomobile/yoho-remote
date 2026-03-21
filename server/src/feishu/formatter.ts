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
 * Convert markdown tables to plain-text aligned tables for Feishu card markdown
 * (which doesn't support | table | syntax).
 * Wraps converted tables in a code block so alignment is preserved.
 */
function convertMarkdownTables(text: string): string {
    // Match consecutive lines that look like table rows (starting with |)
    // Including the separator line (|---|---|)
    const TABLE_RE = /(?:^|\n)((?:\|.+\|\s*\n)+)/g

    return text.replace(TABLE_RE, (match, tableBlock: string) => {
        const rows = tableBlock.trim().split('\n').map(r => r.trim())
        // Filter out separator rows (|---|---|)
        const dataRows = rows.filter(r => !/^\|[\s:-]+\|$/.test(r))
        if (dataRows.length === 0) return match

        // Parse cells
        const parsed = dataRows.map(row =>
            row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
        )

        // Calculate max width per column
        const colCount = Math.max(...parsed.map(r => r.length))
        const colWidths: number[] = Array(colCount).fill(0)
        for (const row of parsed) {
            for (let i = 0; i < colCount; i++) {
                const cell = row[i] || ''
                // Approximate width: CJK chars count as 2, others as 1
                const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
                if (w > colWidths[i]) colWidths[i] = w
            }
        }

        // Build aligned rows
        const lines: string[] = []
        for (const [ri, row] of parsed.entries()) {
            const cells = []
            for (let i = 0; i < colCount; i++) {
                const cell = row[i] || ''
                const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
                cells.push(cell + ' '.repeat(Math.max(0, colWidths[i] - w)))
            }
            lines.push(cells.join('  '))
            // Add separator after header row
            if (ri === 0 && parsed.length > 1) {
                lines.push(colWidths.map(w => '-'.repeat(w)).join('  '))
            }
        }

        const prefix = match.startsWith('\n') ? '\n' : ''
        return `${prefix}\`\`\`\n${lines.join('\n')}\n\`\`\`\n`
    })
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
        // These have { type: 'event', data: { type: 'message', message: '...' } }
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
 * - Short plain text (<=200 chars, no markdown) → text message (lighter, no card chrome)
 * - Longer or markdown-rich text → interactive card with markdown element
 */
export function buildFeishuMessage(text: string): { msgType: string; content: string } {
    // Short plain text without markdown → simple text message
    if (text.length <= SHORT_TEXT_THRESHOLD && !hasMarkdownFormatting(text)) {
        return {
            msgType: 'text',
            content: JSON.stringify({ text }),
        }
    }

    // Longer or markdown-rich → interactive card
    let cardText = convertMarkdownTables(text)
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
