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
 *    ---
 *    注脚信息
 *    </feishu-card>
 *
 * DSL syntax:
 *   - Optional first line: `title: TEXT | COLOR`
 *     Colors: blue green red orange yellow purple grey wathet turquoise indigo violet carmine
 *   - Optional `---` separator after title line
 *   - Body: markdown content, sections separated by `---` lines become hr elements
 */

const VALID_COLORS = new Set([
    'blue', 'green', 'red', 'orange', 'yellow',
    'purple', 'grey', 'wathet', 'turquoise', 'indigo', 'violet', 'carmine',
])

type FeishuElement =
    | { tag: 'markdown'; content: string }
    | { tag: 'hr' }
    | { tag: 'note'; elements: Array<{ tag: 'plain_text'; content: string }> }

interface FeishuCard {
    schema: '2.0'
    header?: {
        title: { content: string; tag: 'plain_text' }
        template: string
    }
    elements: FeishuElement[]
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
            elements: [],
        }

        if (title) {
            card.header = {
                title: { content: title, tag: 'plain_text' },
                template: color,
            }
        }

        if (body) {
            // Split on section dividers (`---` on its own line) → markdown + hr elements
            const sections = body.split(/\n-{3,}\n/)
            for (let i = 0; i < sections.length; i++) {
                const section = sections[i].trim()
                if (section) {
                    card.elements.push({ tag: 'markdown', content: section })
                }
                if (i < sections.length - 1) {
                    card.elements.push({ tag: 'hr' })
                }
            }
        }

        if (!card.header && card.elements.length === 0) return null
        return JSON.stringify(card)
    } catch (err) {
        console.warn('[cardBuilder] DSL parse error:', err)
        return null
    }
}
