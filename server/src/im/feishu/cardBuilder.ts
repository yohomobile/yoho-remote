/**
 * Feishu interactive card builder.
 *
 * Brain outputs cards via <feishu-card> tags using one of two formats:
 *
 * 1. Raw Feishu card JSON (content starts with '{'):
 *    <feishu-card>
 *    {"schema":"2.0","header":{...},"elements":[...]}
 *    </feishu-card>
 *
 * 2. Simple DSL (everything else):
 *    <feishu-card>
 *    title: 操作结果 | green
 *    ---
 *    ## 任务完成
 *
 *    详细内容支持完整 **markdown** 格式。
 *
 *    <buttons>
 *    确认 | primary | confirm
 *    取消 | danger | cancel
 *    </buttons>
 *
 *    <columns>
 *    <column>
 *    **左列**内容
 *    <column>
 *    **右列**内容
 *    </columns>
 *
 *    ---
 *    注脚信息
 *    </feishu-card>
 *
 * DSL syntax:
 *   - Optional first line: `title: TEXT | COLOR`
 *     Colors: blue green red orange yellow purple grey wathet turquoise indigo violet carmine
 *   - Optional `---` separator after title line
 *   - Body: markdown content, sections separated by `---` lines become hr elements
 *   - `<buttons>...\n</buttons>`: button group, one button per line: `text | type | value`
 *     Button types: primary (blue), danger (red), default (grey)
 *   - `<columns>...<column>...<column>...</columns>`: multi-column layout
 */

const VALID_COLORS = new Set([
    'blue', 'green', 'red', 'orange', 'yellow',
    'purple', 'grey', 'wathet', 'turquoise', 'indigo', 'violet', 'carmine',
])

const VALID_BUTTON_TYPES = new Set(['primary', 'danger', 'default'])

type FeishuElement =
    | { tag: 'markdown'; content: string }
    | { tag: 'hr' }
    | { tag: 'note'; elements: Array<{ tag: 'plain_text'; content: string }> }
    | { tag: 'action'; actions: FeishuButton[] }
    | { tag: 'column_set'; columns: FeishuColumn[]; flex_mode: string; background_style: string }

interface FeishuButton {
    tag: 'button'
    text: { content: string; tag: 'plain_text' }
    type: string
    value?: Record<string, string>
}

interface FeishuColumn {
    tag: 'column'
    width: 'weighted'
    weight: number
    elements: Array<{ tag: 'markdown'; content: string }>
}

interface FeishuCard {
    schema: '2.0'
    config?: { wide_screen_mode: boolean }
    header?: {
        title: { content: string; tag: 'plain_text' }
        template: string
    }
    body: { elements: FeishuElement[] }
}

/**
 * Convert raw card content (from <feishu-card> block) into Feishu card JSON string.
 * Returns null if content is empty or invalid.
 */
export function buildCardJson(content: string): string | null {
    const trimmed = content.trim()
    if (!trimmed) return null

    // Raw JSON path — validate and return as-is
    if (trimmed.startsWith('{')) {
        try {
            JSON.parse(trimmed)
            return trimmed
        } catch {
            console.warn('[cardBuilder] Invalid card JSON, falling back to DSL:', trimmed.slice(0, 80))
        }
    }

    return buildFromDsl(trimmed)
}

function buildFromDsl(input: string): string | null {
    try {
        const lines = input.split('\n')
        let title = ''
        let color = 'blue'
        let bodyStart = 0

        // Optional header line: "title: TEXT | COLOR"
        const titleMatch = lines[0]?.match(/^title:\s*(.+?)(?:\s*\|\s*(\w+))?\s*$/i)
        if (titleMatch) {
            title = titleMatch[1].trim()
            const c = titleMatch[2]?.toLowerCase()
            if (c && VALID_COLORS.has(c)) color = c
            bodyStart = 1
            // Skip optional separator line after title
            if (/^-{3,}$/.test(lines[bodyStart]?.trim() ?? '')) {
                bodyStart++
            }
        }

        const body = lines.slice(bodyStart).join('\n').trim()

        const card: FeishuCard = {
            schema: '2.0',
            config: { wide_screen_mode: true },
            body: { elements: [] },
        }

        if (title) {
            card.header = {
                title: { content: title, tag: 'plain_text' },
                template: color,
            }
        }

        if (body) {
            // Split on section dividers (`---` on its own line) → markdown + hr elements
            // Last section after final `---` becomes a note element (footer style)
            const sections = body.split(/\n-{3,}\n/)
            const lastIdx = sections.length - 1
            // Only treat the last section as a footer if it's clearly short/note-like (≤80 chars)
            const hasFooter = sections.length >= 2 && sections[lastIdx].trim().length < 80

            for (let i = 0; i < sections.length; i++) {
                const section = sections[i].trim()
                if (!section) continue

                if (hasFooter && i === lastIdx) {
                    // Render last short section as note (footer)
                    card.body.elements.push({ tag: 'hr' })
                    card.body.elements.push({
                        tag: 'note',
                        elements: [{ tag: 'plain_text', content: section }],
                    })
                } else {
                    // Parse <buttons> blocks within each section
                    const sectionElements = parseSectionWithButtons(section)
                    card.body.elements.push(...sectionElements)
                    if (i < lastIdx - (hasFooter ? 1 : 0)) {
                        card.body.elements.push({ tag: 'hr' })
                    }
                }
            }
        }

        if (!card.header && card.body.elements.length === 0) return null
        return JSON.stringify(card)
    } catch (err) {
        console.warn('[cardBuilder] DSL parse error:', err)
        return null
    }
}

/**
 * Parse a section of body text that may contain interactive DSL blocks:
 *
 * **Buttons** (`<buttons>...</buttons>`):
 *   <buttons>
 *   按钮文字 | primary | action_value
 *   取消 | default | cancel
 *   </buttons>
 *   Fields per line: `text | type | value`
 *   - type: primary (blue), danger (red), default (grey) — defaults to default
 *   - value: string passed as action value when clicked (optional)
 *
 * **Columns** (`<columns>...<column>...</columns>`):
 *   <columns>
 *   <column>
 *   左列 markdown 内容
 *   <column>
 *   右列 markdown 内容
 *   </columns>
 *
 * Text outside these blocks is emitted as markdown elements.
 */
function parseSectionWithButtons(section: string): FeishuElement[] {
    const elements: FeishuElement[] = []
    // Match both <buttons>...</buttons> and <columns>...</columns> blocks
    const BLOCK_RE = /<(buttons|columns)>([\s\S]*?)<\/\1>/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = BLOCK_RE.exec(section)) !== null) {
        // Text before this block
        const before = section.slice(lastIndex, match.index).trim()
        if (before) elements.push({ tag: 'markdown', content: before })

        const blockType = match[1]
        const blockContent = match[2]

        if (blockType === 'buttons') {
            const buttonLines = blockContent.split('\n').map(l => l.trim()).filter(Boolean)
            const buttons: FeishuButton[] = buttonLines.map(line => {
                const parts = line.split('|').map(p => p.trim())
                const text = parts[0] || '按钮'
                const rawType = parts[1]?.toLowerCase() || 'default'
                const type = VALID_BUTTON_TYPES.has(rawType) ? rawType : 'default'
                const value = parts[2] ? { action: parts[2] } : undefined
                const btn: FeishuButton = {
                    tag: 'button',
                    text: { content: text, tag: 'plain_text' },
                    type,
                }
                if (value) btn.value = value
                return btn
            })
            if (buttons.length > 0) {
                elements.push({ tag: 'action', actions: buttons })
            }
        } else if (blockType === 'columns') {
            // Split on <column> markers
            const columnParts = blockContent.split(/<column>/i).map(c => c.trim()).filter(Boolean)
            if (columnParts.length > 0) {
                const columns: FeishuColumn[] = columnParts.map(content => ({
                    tag: 'column',
                    width: 'weighted',
                    weight: 1,
                    elements: [{ tag: 'markdown', content }],
                }))
                elements.push({
                    tag: 'column_set',
                    columns,
                    flex_mode: 'bisect',
                    background_style: 'default',
                })
            }
        }

        lastIndex = match.index + match[0].length
    }

    // Remaining text after last block
    const after = section.slice(lastIndex).trim()
    if (after) elements.push({ tag: 'markdown', content: after })

    // If no blocks found, just return markdown
    if (elements.length === 0) {
        elements.push({ tag: 'markdown', content: section })
    }

    return elements
}
