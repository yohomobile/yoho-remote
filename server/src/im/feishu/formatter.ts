/**
 * Feishu message formatter.
 * Converts Brain agent output to Feishu message formats.
 *
 * Short plain-text replies → msg_type "text"
 * Medium rich replies       → msg_type "post" (rich text with inline @mentions)
 * Long / structured replies → msg_type "interactive" (message card with markdown)
 */

const MAX_POST_LENGTH = 10000
const MAX_CARD_BYTES = 28000  // 30KB limit with safety margin
const SHORT_TEXT_THRESHOLD = 200
const CARD_THRESHOLD = 800

type PostTag =
    | { tag: 'text'; text: string; style?: string[] }
    | { tag: 'a'; text: string; href: string; style?: string[] }
    | { tag: 'at'; user_id: string }
    | { tag: 'img'; image_key: string }
    | { tag: 'code_block'; language: string; text: string }
    | { tag: 'hr' }

type PostParagraph = PostTag[]

/**
 * Detect whether text contains markdown formatting.
 */
function hasMarkdownFormatting(text: string): boolean {
    return /^#{1,6}\s|(\*\*|__).+(\*\*|__)|```|^\s*[-*+]\s|^\s*\d+\.\s|\[.+\]\(.+\)|!\[.*\]\(.+\)|^\|.+\||^>\s|^\s*[-*+]\s+\[[ xX]\]/m.test(text)
}

/**
 * Detect whether text has enough structure to benefit from card format.
 */
function shouldUseCard(text: string): boolean {
    if (text.length >= CARD_THRESHOLD) return true
    const hasCodeBlock = /```[\s\S]+?```/.test(text)
    if (hasCodeBlock) return true
    const headingCount = (text.match(/^#{1,6}\s/gm) || []).length
    if (headingCount >= 2) return true
    const hasTable = /^\|.+\|$/m.test(text)
    if (hasTable) return true
    return false
}

// ========== Markdown → Post rich text conversion ==========

/**
 * Parse inline markdown formatting within a single line into PostTag elements.
 * Handles: ![alt](url), [text](url), **bold**, *italic*, ~~strikethrough~~, `code`
 */
function parseInlineMarkdown(line: string): PostTag[] {
    const tags: PostTag[] = []
    // Order: image ![alt](url), link [text](url), bold, italic, strikethrough, inline code
    const INLINE_RE = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<!\*)\*([^*]+?)\*(?!\*)|\~\~(.+?)\~\~|`([^`]+)`/g

    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_RE.exec(line)) !== null) {
        if (match.index > lastIndex) {
            tags.push({ tag: 'text', text: line.slice(lastIndex, match.index) })
        }

        if (match[1] !== undefined && match[2] !== undefined) {
            // ![alt](url) — image reference
            const alt = match[1] || '图片'
            tags.push({ tag: 'a', text: `[${alt}]`, href: match[2] })
        } else if (match[3] !== undefined && match[4] !== undefined) {
            // [text](url) — link
            tags.push({ tag: 'a', text: match[3], href: match[4] })
        } else if (match[5] !== undefined) {
            tags.push({ tag: 'text', text: match[5], style: ['bold'] })
        } else if (match[6] !== undefined) {
            tags.push({ tag: 'text', text: match[6], style: ['italic'] })
        } else if (match[7] !== undefined) {
            tags.push({ tag: 'text', text: match[7], style: ['lineThrough'] })
        } else if (match[8] !== undefined) {
            // Inline code — no rich style in post format, render as plain text
            tags.push({ tag: 'text', text: match[8] })
        }

        lastIndex = match.index + match[0].length
    }

    if (lastIndex < line.length) {
        tags.push({ tag: 'text', text: line.slice(lastIndex) })
    }

    if (tags.length === 0 && line) {
        tags.push({ tag: 'text', text: line })
    }

    return tags
}

/**
 * Convert markdown text to Feishu post rich text paragraphs.
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
            i++
            paragraphs.push([{ tag: 'code_block', language, text: codeLines.join('\n') }])
            continue
        }

        // Horizontal rule
        if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
            paragraphs.push([{ tag: 'hr' }])
            i++
            continue
        }

        // Blockquote → italic with ┃ prefix
        const bqMatch = line.match(/^(\s*(?:>\s*)+)(.*)$/)
        if (bqMatch) {
            const depth = (bqMatch[1].match(/>/g) || []).length
            const prefix = '┃ '.repeat(depth)
            const inner = bqMatch[2].trim()
            if (inner) {
                const inlineTags = parseInlineMarkdown(inner)
                let prefixed = false
                for (const t of inlineTags) {
                    if (t.tag === 'text') {
                        if (!prefixed) { t.text = prefix + t.text; prefixed = true }
                        t.style = [...(t.style || []), 'italic']
                    }
                }
                if (!prefixed) inlineTags.unshift({ tag: 'text', text: prefix, style: ['italic'] })
                paragraphs.push(inlineTags)
            } else {
                paragraphs.push([{ tag: 'text', text: prefix.trim(), style: ['italic'] }])
            }
            i++
            continue
        }

        // Heading → bold text
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
        if (headingMatch) {
            paragraphs.push([{ tag: 'text', text: headingMatch[2], style: ['bold'] }])
            i++
            continue
        }

        // Markdown table
        if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
            const tableLines: string[] = []
            while (i < lines.length && lines[i].trimStart().startsWith('|') && lines[i].trimEnd().endsWith('|')) {
                tableLines.push(lines[i])
                i++
            }
            const tableText = convertTableToAligned(tableLines)
            if (tableText) {
                paragraphs.push([{ tag: 'code_block', language: '', text: tableText }])
            }
            continue
        }

        // Task list (- [ ] / - [x])
        const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/)
        if (taskMatch) {
            const indent = Math.floor(taskMatch[1].length / 2)
            const checked = taskMatch[2].toLowerCase() === 'x'
            const prefix = '  '.repeat(indent) + (checked ? '☑ ' : '☐ ')
            paragraphs.push(parseInlineMarkdown(prefix + taskMatch[3]))
            i++
            continue
        }

        // Unordered list
        const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)$/)
        if (ulMatch) {
            const indent = Math.floor(ulMatch[1].length / 2)
            const prefix = '  '.repeat(indent) + '• '
            paragraphs.push(parseInlineMarkdown(prefix + ulMatch[3]))
            i++
            continue
        }

        // Ordered list
        const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/)
        if (olMatch) {
            const indent = Math.floor(olMatch[1].length / 2)
            const prefix = '  '.repeat(indent) + olMatch[2] + '. '
            paragraphs.push(parseInlineMarkdown(prefix + olMatch[3]))
            i++
            continue
        }

        // Empty line
        if (!line.trim()) {
            if (paragraphs.length > 0) {
                paragraphs.push([{ tag: 'text', text: '' }])
            }
            i++
            continue
        }

        // Regular text
        paragraphs.push(parseInlineMarkdown(line))
        i++
    }

    return paragraphs
}

/**
 * Convert markdown table lines to aligned plain text (for code block display).
 */
function convertTableToAligned(tableLines: string[]): string | null {
    const dataRows = tableLines.filter(r => !/^\s*\|[\s:-]+\|\s*$/.test(r))
    if (dataRows.length === 0) return null

    const parsed = dataRows.map(row =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
    )

    const colCount = Math.max(...parsed.map(r => r.length))
    const colWidths: number[] = Array(colCount).fill(0)
    for (const row of parsed) {
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
            if (w > colWidths[ci]) colWidths[ci] = w
        }
    }

    const outLines: string[] = []
    for (const [ri, row] of parsed.entries()) {
        const cells = []
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = [...cell].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
            cells.push(cell + ' '.repeat(Math.max(0, colWidths[ci] - w)))
        }
        outLines.push(cells.join('  '))
        if (ri === 0 && parsed.length > 1) {
            outLines.push(colWidths.map(w => '-'.repeat(w)).join('  '))
        }
    }

    return outLines.join('\n')
}

// ========== Markdown → Card conversion ==========

/**
 * Convert standard markdown to Feishu card lark_md format.
 * Main differences: @mentions use <at id=xxx></at>, task lists use emoji.
 */
function toCardMarkdown(text: string, atIds?: string[]): string {
    let md = text

    // Convert task lists to emoji (lark_md doesn't have checkbox)
    md = md.replace(/^(\s*)[-*+]\s+\[x\]\s+/gim, '$1☑ ')
    md = md.replace(/^(\s*)[-*+]\s+\[ \]\s+/gm, '$1☐ ')

    // Append @mentions in card format
    if (atIds && atIds.length > 0) {
        const atTags = atIds.map(id => `<at id=${id}></at>`).join(' ')
        md += '\n\n' + atTags
    }

    return md
}

/**
 * Extract the first heading from markdown as card title, return remaining text.
 */
function extractCardTitle(text: string): { title: string; body: string } {
    const match = text.match(/^(#{1,3})\s+(.+)$/m)
    if (match) {
        const title = match[2].replace(/\*\*/g, '').trim()
        const body = text.slice(0, match.index) + text.slice(match.index! + match[0].length)
        return { title, body: body.replace(/^\n+/, '').trim() }
    }
    return { title: 'K1', body: text }
}

/**
 * Split markdown into chunks that fit within Feishu card element size limits.
 * Splits at paragraph boundaries (double newlines) or heading boundaries.
 */
function splitCardChunks(text: string, maxChunkLen: number): string[] {
    if (text.length <= maxChunkLen) return [text]

    const chunks: string[] = []
    // Split at double newlines or before headings
    const sections = text.split(/\n(?=#{1,6}\s)|\n\n/)
    let current = ''

    for (const section of sections) {
        const piece = section.trim()
        if (!piece) continue

        if (current && (current.length + piece.length + 2) > maxChunkLen) {
            chunks.push(current.trim())
            current = piece
        } else {
            current = current ? current + '\n\n' + piece : piece
        }
    }
    if (current.trim()) chunks.push(current.trim())

    return chunks
}

interface CardElement {
    tag: string
    content?: string
    [key: string]: unknown
}

/**
 * Build a Feishu interactive card payload from markdown text.
 */
function buildCardPayload(text: string, atIds?: string[]): { msgType: string; content: string } {
    const { title, body } = extractCardTitle(text)
    const cardMd = toCardMarkdown(body, atIds)

    // Build card elements — split if needed
    const elements: CardElement[] = []
    const chunks = splitCardChunks(cardMd, 4000)

    for (let ci = 0; ci < chunks.length; ci++) {
        elements.push({ tag: 'markdown', content: chunks[ci] })
        if (ci < chunks.length - 1) {
            elements.push({ tag: 'hr' })
        }
    }

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { content: title, tag: 'plain_text' as const },
            template: 'blue' as const,
        },
        elements,
    }

    // Check total size — fall back to post if card exceeds limit
    const cardJson = JSON.stringify(card)
    if (new TextEncoder().encode(cardJson).length > MAX_CARD_BYTES) {
        return buildPostPayload(text, atIds)
    }

    return {
        msgType: 'interactive',
        content: cardJson,
    }
}

/**
 * Build a Feishu post (rich text) payload.
 */
function buildPostPayload(text: string, atIds?: string[]): { msgType: string; content: string } {
    if (text.length > MAX_POST_LENGTH) {
        text = text.slice(0, MAX_POST_LENGTH) + '\n\n...(内容过长已截断)'
    }

    const paragraphs = markdownToPostParagraphs(text)

    if (atIds && atIds.length > 0) {
        const atTags: PostTag[] = atIds.map(id => ({ tag: 'at' as const, user_id: id }))
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

// ========== Public API ==========

/**
 * Build a Feishu message payload ready for the API.
 *
 * Routing:
 * - Short plain text (<=200 chars, no markdown) → text message
 * - Medium markdown text → post rich text
 * - Long / structured content (>=800 chars, code blocks, tables, multi-heading) → interactive card
 */
export function buildFeishuMessage(text: string, atIds?: string[]): { msgType: string; content: string } {
    const hasAt = atIds && atIds.length > 0

    // Plain text — short, no formatting, no mentions
    if (text.length <= SHORT_TEXT_THRESHOLD && !hasMarkdownFormatting(text) && !hasAt) {
        return {
            msgType: 'text',
            content: JSON.stringify({ text }),
        }
    }

    // Card — long or structurally rich content
    if (shouldUseCard(text)) {
        return buildCardPayload(text, atIds)
    }

    // Post — medium rich text
    return buildPostPayload(text, atIds)
}
