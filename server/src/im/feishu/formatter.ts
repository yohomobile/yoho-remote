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
    | { tag: 'md'; text: string }

type PostParagraph = PostTag[]

/**
 * Detect whether text contains markdown formatting.
 */
function hasMarkdownFormatting(text: string): boolean {
    return /^#{1,6}\s|(\*\*|__).+(\*\*|__)|```|`[^`]+`|(?<!\*)\*[^*]+\*(?!\*)|~~.+~~|^\s*[-*+]\s|^\s*\d+\.\s|\[.+\]\(.+\)|!\[.*\]\(.+\)|^\|.+\||^>\s|^\s*[-*+]\s+\[[ xX]\]/m.test(text)
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
    // Elements that post format handles poorly — route to card for native markdown rendering
    if (/^>\s/m.test(text)) return true                     // blockquote
    if (/!\[.*\]\(.+\)/.test(text)) return true             // image
    if (/^(\s*[-*_]\s*){3,}$/m.test(text)) return true      // horizontal rule
    return false
}

// ========== Markdown preprocessing (inspired by lark-cli optimizeMarkdownStyle) ==========

/**
 * Protect code blocks by replacing them with placeholders during transformation.
 * Returns the modified text and a restore function.
 */
function protectCodeBlocks(text: string): { text: string; restore: (t: string) => string } {
    const blocks: string[] = []
    const replaced = text.replace(/```[\s\S]*?```/g, (match) => {
        blocks.push(match)
        return `___CB_${blocks.length - 1}___`
    })
    return {
        text: replaced,
        restore: (t: string) => t.replace(/___CB_(\d+)___/g, (_, i) => blocks[Number(i)] ?? ''),
    }
}

/**
 * Compress 3+ consecutive newlines to 2 (outside code blocks).
 */
function compressNewlines(text: string): string {
    const { text: safe, restore } = protectCodeBlocks(text)
    return restore(safe.replace(/\n{3,}/g, '\n\n'))
}

/**
 * Normalize table spacing — ensure pipes have consistent spacing.
 * Converts `|foo|bar|` to `| foo | bar |` for better rendering.
 */
function normalizeTableSpacing(text: string): string {
    const { text: safe, restore } = protectCodeBlocks(text)
    const normalized = safe.replace(/^(\|.+\|)$/gm, (line) => {
        // Skip separator rows
        if (/^\s*\|[\s:-]+\|\s*$/.test(line)) return line
        return line.replace(/\|([^|]+)/g, (_, cell) => {
            const trimmed = cell.trim()
            return trimmed ? `| ${trimmed} ` : '| '
        })
    })
    return restore(normalized)
}

/**
 * Downgrade headings for card format where H1-H3 render excessively large.
 * When H1-H3 exist: H1→H4, H2→H5, H3→H5, H4-H6→H5
 * This matches lark-cli's optimizeMarkdownStyle behavior.
 */
function downgradeHeadings(text: string): string {
    const { text: safe, restore } = protectCodeBlocks(text)
    // Only downgrade if large headings (H1-H3) are present
    if (!/^#{1,3}\s/m.test(safe)) return text
    const downgraded = safe.replace(/^(#{1,6})\s/gm, (match, hashes: string) => {
        const level = hashes.length
        if (level === 1) return '#### '
        return '##### '
    })
    return restore(downgraded)
}

/**
 * Escape `[` and `]` inside markdown link display text to prevent format injection.
 * e.g. `[[evil]](url)` → `[\[evil\]](url)`
 */
function escapeLinkText(text: string): string {
    const { text: safe, restore } = protectCodeBlocks(text)
    // Match markdown links [text](url) but not images ![alt](url)
    const escaped = safe.replace(/(?<!!)\[([^\]]*\[[^\]]*\][^\]]*)\]\(([^)]+)\)/g, (_, linkText: string, url: string) => {
        const cleaned = linkText.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
        return `[${cleaned}](${url})`
    })
    return restore(escaped)
}

/**
 * Full markdown preprocessing pipeline for Feishu.
 * Applied before passing markdown to both card and post formats.
 */
function optimizeMarkdownForFeishu(text: string, forCard: boolean = false): string {
    let result = compressNewlines(text)
    result = normalizeTableSpacing(result)
    result = escapeLinkText(result)
    if (forCard) {
        result = downgradeHeadings(result)
    }
    return result
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
            // ![alt](url) — image reference; post format can't embed images, show as clean link
            tags.push({ tag: 'a', text: match[1] || '图片', href: match[2] })
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
            // Inline code — preserve backticks for visual distinction since post format lacks code style
            tags.push({ tag: 'text', text: `\`${match[8]}\`` })
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
 * Applies cell truncation (max 40 display-width) and URL shortening to keep
 * tables readable on mobile Feishu screens.
 */
function convertTableToAligned(tableLines: string[]): string | null {
    const dataRows = tableLines.filter(r => !/^\s*\|[\s:-]+\|\s*$/.test(r))
    if (dataRows.length === 0) return null

    let anyTruncated = false
    const parsed = dataRows.map(row =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => {
            const cell = c.trim()
            const truncated = truncateCell(cell)
            if (truncated !== cell) anyTruncated = true
            return truncated
        })
    )

    const colCount = Math.max(...parsed.map(r => r.length))
    const colWidths: number[] = Array(colCount).fill(0)
    for (const row of parsed) {
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = displayWidth(cell)
            if (w > colWidths[ci]) colWidths[ci] = w
        }
    }

    const outLines: string[] = []
    for (const [ri, row] of parsed.entries()) {
        const cells = []
        for (let ci = 0; ci < colCount; ci++) {
            const cell = row[ci] || ''
            const w = displayWidth(cell)
            cells.push(cell + ' '.repeat(Math.max(0, colWidths[ci] - w)))
        }
        outLines.push(cells.join('  '))
        if (ri === 0 && parsed.length > 1) {
            outLines.push(colWidths.map(w => '-'.repeat(w)).join('  '))
        }
    }

    const result = outLines.join('\n')
    return anyTruncated ? result + '\n* 表格已截断' : result
}

/** Calculate display width accounting for CJK and emoji double-width characters. */
function displayWidth(text: string): number {
    return [...text].reduce((sum, ch) => {
        const cp = ch.codePointAt(0) ?? 0
        // CJK unified ideographs, symbols, fullwidth forms
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return sum + 2
        // Emoji and other wide Unicode blocks (U+1F000+)
        if (cp >= 0x1F000) return sum + 2
        return sum + 1
    }, 0)
}

const MAX_CELL_WIDTH = 40

/** Truncate a cell's display content: shorten URLs and cap at MAX_CELL_WIDTH. */
function truncateCell(cell: string): string {
    // Shorten bare URLs: https://example.com/very/long/path → example.com/very/…
    let result = cell.replace(/https?:\/\/([^/\s]+)(\/[^\s)]*)/g, (_, domain: string, path: string) => {
        const short = domain + (path.length > 12 ? path.slice(0, 11) + '…' : path)
        return short
    })
    // Truncate if still too wide
    if (displayWidth(result) > MAX_CELL_WIDTH) {
        let width = 0
        let i = 0
        const chars = [...result]
        while (i < chars.length && width < MAX_CELL_WIDTH - 1) {
            width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(chars[i]) ? 2 : 1
            i++
        }
        result = chars.slice(0, i).join('') + '…'
    }
    return result
}

// ========== Markdown → Card conversion ==========

/**
 * Convert standard markdown to Feishu card lark_md format.
 * Main differences: @mentions use <at id=xxx></at>, task lists use emoji.
 */
function toCardMarkdown(text: string, atIds?: string[]): string {
    let md = text

    // Image URLs are resolved upstream (FeishuAdapter.resolveMarkdownImages uploads them).
    // Any remaining http URLs here are upload failures already converted to links.

    // Convert task lists to emoji (lark_md doesn't have checkbox)
    md = md.replace(/^(\s*)[-*+]\s+\[x\]\s+/gim, '$1☑ ')
    md = md.replace(/^(\s*)[-*+]\s+\[\s*\]\s+/gm, '$1☐ ')

    // Append @mentions in card format
    if (atIds && atIds.length > 0) {
        const atTags = atIds.map(id => `<at user_id="${id}"></at>`).join(' ')
        md += '\n\n' + atTags
    }

    return md
}

/**
 * Extract the first heading from markdown as post title.
 * Only extracts H1-H2 as post titles (H3+ are too minor for a title).
 */
function extractPostTitle(text: string): { title: string | null; body: string } {
    const match = text.match(/^\s*(#{1,2})\s+(.+)$/m)
    if (match && match.index !== undefined) {
        const beforeHeading = text.slice(0, match.index).trim()
        if (!beforeHeading) {
            const title = match[2].replace(/\*\*/g, '').trim()
            const body = text.slice(match.index + match[0].length).replace(/^\n+/, '').trim()
            return { title, body }
        }
    }
    return { title: null, body: text }
}

/**
 * Extract the first heading from markdown as card title, return remaining text.
 */
function extractCardTitle(text: string): { title: string | null; body: string } {
    // Only extract heading as card title if it's the first non-empty line
    const match = text.match(/^\s*(#{1,3})\s+(.+)$/m)
    if (match && match.index !== undefined) {
        const beforeHeading = text.slice(0, match.index).trim()
        if (!beforeHeading) {
            const title = match[2].replace(/\*\*/g, '').trim()
            const body = text.slice(match.index + match[0].length).replace(/^\n+/, '').trim()
            return { title, body }
        }
    }
    return { title: null, body: text }
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
    // Preprocess: compress newlines, normalize tables, downgrade headings, escape links
    const optimized = optimizeMarkdownForFeishu(text, true)
    const { title, body } = extractCardTitle(optimized)
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

    const card: Record<string, unknown> = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        elements,
    }

    // Only add header when there's a real heading extracted from the text
    if (title) {
        card.header = {
            title: { content: title, tag: 'plain_text' },
            template: 'blue',
        }
    }

    // Check total size — fall back to post if card exceeds limit
    // Pass original text (not card-optimized) so post gets its own preprocessing
    const cardJson = JSON.stringify(card)
    const cardBytes = new TextEncoder().encode(cardJson).length
    if (cardBytes > MAX_CARD_BYTES) {
        console.warn(`[formatter] Card ${cardBytes}B > ${MAX_CARD_BYTES}B limit (textLen=${text.length}), falling back to post`)
        return buildPostPayload(text, atIds)
    }

    return {
        msgType: 'interactive',
        content: cardJson,
    }
}

/**
 * Build a Feishu post (rich text) payload.
 * Uses native md tag for markdown content — renders inline code, lists, links natively.
 * Falls back to manual paragraph conversion for plain text (no markdown formatting).
 */
export function buildPostPayload(text: string, atIds?: string[]): { msgType: string; content: string } {
    if (text.length > MAX_POST_LENGTH) {
        text = text.slice(0, MAX_POST_LENGTH) + '\n\n...(内容过长已截断)'
    }

    // Preprocess markdown
    text = optimizeMarkdownForFeishu(text, false)

    // Extract first heading as post title (Feishu renders it as a bold header line)
    const { title: postTitle, body: postBody } = extractPostTitle(text)

    const paragraphs: PostParagraph[] = []
    const bodyText = postBody || text

    if (bodyText) {
        if (hasMarkdownFormatting(bodyText)) {
            // md tag renders markdown natively in post format — handles inline code,
            // bold, italic, links, lists etc. without our manual conversion.
            // Note: md tag must be the sole element in its paragraph.
            paragraphs.push([{ tag: 'md', text: bodyText }])
        } else {
            paragraphs.push(...markdownToPostParagraphs(bodyText))
        }
    }

    if (atIds && atIds.length > 0) {
        paragraphs.push(atIds.map(id => ({ tag: 'at' as const, user_id: id })))
    }

    const post: Record<string, unknown> = {
        zh_cn: {
            ...(postTitle ? { title: postTitle } : {}),
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
/**
 * Build a streaming card payload for Feishu.
 * The Feishu edit API (PATCH /im/v1/messages) only supports editing interactive cards.
 * This function always returns an interactive card so that streaming messages can be
 * created once and then updated in-place.
 */
export function buildStreamingCard(text: string): { msgType: string; content: string } {
    const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: text }],
    }
    return {
        msgType: 'interactive',
        content: JSON.stringify(card),
    }
}

/**
 * Build a Feishu message for edit operations.
 * Feishu edit API (PATCH /im/v1/messages) only supports editing interactive cards —
 * attempting to edit a "text" or "post" message returns error 230001 "NOT a card".
 * Therefore this always returns an interactive card format.
 */
export function buildFeishuMessageForEdit(text: string): { msgType: string; content: string } {
    return buildStreamingCard(text)
}

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
