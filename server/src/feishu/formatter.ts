/**
 * Feishu message formatter.
 * Converts Brain agent output to Feishu message formats.
 *
 * Short plain-text replies → msg_type "text"
 * Longer / markdown-rich replies → msg_type "post" (rich text with inline @mentions)
 */

const MAX_POST_LENGTH = 10000
const SHORT_TEXT_THRESHOLD = 200

type PostTag =
    | { tag: 'text'; text: string; style?: string[] }
    | { tag: 'a'; text: string; href: string; style?: string[] }
    | { tag: 'at'; user_id: string }
    | { tag: 'code_block'; language: string; text: string }
    | { tag: 'hr' }

type PostParagraph = PostTag[]

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

// ========== Markdown → Post rich text conversion ==========

/**
 * Parse inline markdown formatting within a single line into PostTag elements.
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`, [text](url)
 */
function parseInlineMarkdown(line: string): PostTag[] {
    const tags: PostTag[] = []

    // Regex to match inline elements:
    // 1. [text](url) - links
    // 2. **text** - bold
    // 3. *text* - italic (but not **)
    // 4. ~~text~~ - strikethrough
    // 5. `text` - inline code
    const INLINE_RE = /\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<!\*)\*([^*]+?)\*(?!\*)|\~\~(.+?)\~\~|`([^`]+)`/g

    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_RE.exec(line)) !== null) {
        // Add plain text before the match
        if (match.index > lastIndex) {
            tags.push({ tag: 'text', text: line.slice(lastIndex, match.index) })
        }

        if (match[1] !== undefined && match[2] !== undefined) {
            // Link: [text](url)
            tags.push({ tag: 'a', text: match[1], href: match[2] })
        } else if (match[3] !== undefined) {
            // Bold: **text**
            tags.push({ tag: 'text', text: match[3], style: ['bold'] })
        } else if (match[4] !== undefined) {
            // Italic: *text*
            tags.push({ tag: 'text', text: match[4], style: ['italic'] })
        } else if (match[5] !== undefined) {
            // Strikethrough: ~~text~~
            tags.push({ tag: 'text', text: match[5], style: ['lineThrough'] })
        } else if (match[6] !== undefined) {
            // Inline code: `text` — render as bold (post doesn't have inline code style)
            tags.push({ tag: 'text', text: match[6], style: ['bold'] })
        }

        lastIndex = match.index + match[0].length
    }

    // Add remaining text
    if (lastIndex < line.length) {
        tags.push({ tag: 'text', text: line.slice(lastIndex) })
    }

    // If nothing was parsed, return the whole line as text
    if (tags.length === 0 && line) {
        tags.push({ tag: 'text', text: line })
    }

    return tags
}

/**
 * Convert markdown text to Feishu post rich text paragraphs.
 * Handles: headings, bold/italic/strikethrough, links, code blocks, lists, hr, tables.
 */
function markdownToPostParagraphs(text: string): PostParagraph[] {
    const paragraphs: PostParagraph[] = []
    const lines = text.split('\n')
    let i = 0

    while (i < lines.length) {
        const line = lines[i]

        // Code block: ```...```
        if (line.trimStart().startsWith('```')) {
            const language = line.trimStart().slice(3).trim()
            const codeLines: string[] = []
            i++
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i])
                i++
            }
            i++ // skip closing ```
            paragraphs.push([{ tag: 'code_block', language, text: codeLines.join('\n') }])
            continue
        }

        // Horizontal rule: --- or *** or ___
        if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
            paragraphs.push([{ tag: 'hr' }])
            i++
            continue
        }

        // Heading: # ... → bold text
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
        if (headingMatch) {
            paragraphs.push([{ tag: 'text', text: headingMatch[2], style: ['bold'] }])
            i++
            continue
        }

        // Markdown table: lines starting with |
        if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
            const tableLines: string[] = []
            while (i < lines.length && lines[i].trimStart().startsWith('|') && lines[i].trimEnd().endsWith('|')) {
                tableLines.push(lines[i])
                i++
            }
            // Convert table to code block for alignment
            const tableText = convertTableToAligned(tableLines)
            if (tableText) {
                paragraphs.push([{ tag: 'code_block', language: '', text: tableText }])
            }
            continue
        }

        // Unordered list: - item or * item or + item
        const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)$/)
        if (ulMatch) {
            const indent = Math.floor(ulMatch[1].length / 2)
            const prefix = '  '.repeat(indent) + '• '
            paragraphs.push(parseInlineMarkdown(prefix + ulMatch[3]))
            i++
            continue
        }

        // Ordered list: 1. item
        const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/)
        if (olMatch) {
            const indent = Math.floor(olMatch[1].length / 2)
            const prefix = '  '.repeat(indent) + olMatch[2] + '. '
            paragraphs.push(parseInlineMarkdown(prefix + olMatch[3]))
            i++
            continue
        }

        // Empty line → empty paragraph (spacing)
        if (!line.trim()) {
            // Skip consecutive empty lines, just add one empty paragraph
            if (paragraphs.length > 0) {
                paragraphs.push([{ tag: 'text', text: '' }])
            }
            i++
            continue
        }

        // Regular text → parse inline markdown
        paragraphs.push(parseInlineMarkdown(line))
        i++
    }

    return paragraphs
}

/**
 * Convert markdown table lines to aligned plain text (for code block display).
 */
function convertTableToAligned(tableLines: string[]): string | null {
    // Filter out separator rows (|---|---|)
    const dataRows = tableLines.filter(r => !/^\s*\|[\s:-]+\|\s*$/.test(r))
    if (dataRows.length === 0) return null

    // Parse cells
    const parsed = dataRows.map(row =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
    )

    // Calculate max width per column
    const colCount = Math.max(...parsed.map(r => r.length))
    const colWidths: number[] = Array(colCount).fill(0)
    for (const row of parsed) {
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
            if (w > colWidths[ci]) colWidths[ci] = w
        }
    }

    // Build aligned rows
    const outLines: string[] = []
    for (const [ri, row] of parsed.entries()) {
        const cells = []
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
            cells.push(cell + ' '.repeat(Math.max(0, colWidths[ci] - w)))
        }
        outLines.push(cells.join('  '))
        // Add separator after header row
        if (ri === 0 && parsed.length > 1) {
            outLines.push(colWidths.map(w => '-'.repeat(w)).join('  '))
        }
    }

    return outLines.join('\n')
}

/**
 * Build a Feishu message payload ready for the API.
 *
 * - Short plain text (<=200 chars, no markdown) → text message
 * - Longer or markdown-rich text → post rich text (supports inline @mentions)
 *
 * @param text - The markdown text to convert
 * @param atIds - Optional array of open_ids to @mention at the end of the message
 */
export function buildFeishuMessage(text: string, atIds?: string[]): { msgType: string; content: string } {
    const hasAt = atIds && atIds.length > 0

    // Short plain text without markdown → simple text message
    if (text.length <= SHORT_TEXT_THRESHOLD && !hasMarkdownFormatting(text) && !hasAt) {
        return {
            msgType: 'text',
            content: JSON.stringify({ text }),
        }
    }

    // Truncate if too long
    if (text.length > MAX_POST_LENGTH) {
        text = text.slice(0, MAX_POST_LENGTH) + '\n\n...(内容过长已截断)'
    }

    // Convert markdown to post paragraphs
    const paragraphs = markdownToPostParagraphs(text)

    // Append @mentions as a final paragraph
    if (hasAt) {
        const atTags: PostTag[] = atIds!.map(id => ({ tag: 'at' as const, user_id: id }))
        paragraphs.push(atTags)
    }

    const post = {
        zh_cn: {
            content: paragraphs,
        },
    }

    return {
        msgType: 'post',
        content: JSON.stringify(post),
    }
}
