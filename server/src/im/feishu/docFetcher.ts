/**
 * Feishu Document Fetcher
 *
 * Detects feishu document links in message text and fetches their content
 * via Feishu Open API, so K1 can understand shared documents.
 *
 * Supported types:
 * - docx  (文档)     → markdown content
 * - wiki  (知识库)   → resolve node → docx content
 * - base  (多维表格) → table records
 * - sheet (电子表格) → sheet data
 */

// Max content length to avoid flooding the context
const MAX_DOC_CONTENT_LENGTH = 8000
const MAX_BITABLE_RECORDS = 50

interface FeishuLink {
    type: 'docx' | 'wiki' | 'bitable' | 'sheet'
    token: string
    /** For bitable: table_id extracted from URL query param */
    tableId?: string
    originalUrl: string
}

/**
 * Regex patterns for feishu document links.
 *
 * URL formats:
 *   https://xxx.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUv
 *   https://xxx.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUv
 *   https://xxx.feishu.cn/base/AbCdEfGhIjKlMnOpQrStUv?table=tblXxxx&view=vewYyyy
 *   https://xxx.feishu.cn/sheets/AbCdEfGhIjKlMnOpQrStUv
 *
 * Also supports:
 *   https://xxx.larksuite.com/...  (international variant)
 *   https://xxx.larkoffice.com/... (another variant)
 */
const FEISHU_LINK_RE = /https?:\/\/[a-zA-Z0-9-]+\.(feishu\.cn|larksuite\.com|larkoffice\.com)\/(docx|wiki|base|sheets)\/([a-zA-Z0-9_-]+)(\?[^\s)]*)?/g

/**
 * Extract all feishu document links from text.
 */
export function extractFeishuLinks(text: string): FeishuLink[] {
    const links: FeishuLink[] = []
    const seen = new Set<string>()

    let match: RegExpExecArray | null
    // Reset regex state
    FEISHU_LINK_RE.lastIndex = 0
    while ((match = FEISHU_LINK_RE.exec(text)) !== null) {
        const docType = match[2] as 'docx' | 'wiki' | 'base' | 'sheets'
        const token = match[3]
        const queryStr = match[4] || ''
        const originalUrl = match[0]

        // Deduplicate
        const key = `${docType}:${token}`
        if (seen.has(key)) continue
        seen.add(key)

        const type = docType === 'sheets' ? 'sheet' : docType === 'base' ? 'bitable' : docType

        let tableId: string | undefined
        if (type === 'bitable' && queryStr) {
            const tableMatch = queryStr.match(/[?&]table=([a-zA-Z0-9_]+)/)
            // Only use table param if it's a real table ID (tbl prefix).
            // URLs often have table=blk... which is a block ID, not a table ID.
            if (tableMatch && tableMatch[1].startsWith('tbl')) tableId = tableMatch[1]
        }

        links.push({ type, token, tableId, originalUrl })
    }

    return links
}

/**
 * Fetch content of feishu documents and return enriched text.
 * Appends document content as context blocks after the original message.
 *
 * @param text - Original message text
 * @param getToken - Function to get tenant_access_token
 * @returns Original text with document content appended, or original text if no links/errors
 */
export async function enrichTextWithDocContent(
    text: string,
    getToken: () => Promise<string>,
): Promise<string> {
    const links = extractFeishuLinks(text)
    if (links.length === 0) return text

    const docParts: string[] = []
    const token = await getToken()

    // Fetch all links in parallel (max 3 to avoid rate limiting)
    const fetchers = links.slice(0, 3).map(async (link) => {
        try {
            const content = await fetchDocContent(link, token)
            if (content) {
                const typeLabel = DOC_TYPE_LABELS[link.type]
                docParts.push(`<feishu-doc type="${typeLabel}" url="${link.originalUrl}">\n${content}\n</feishu-doc>`)
            }
        } catch (err) {
            console.error(`[DocFetcher] Failed to fetch ${link.type} ${link.token.slice(0, 12)}:`, err)
        }
    })

    await Promise.all(fetchers)

    if (docParts.length === 0) return text
    return text + '\n\n' + docParts.join('\n\n')
}

const DOC_TYPE_LABELS: Record<string, string> = {
    docx: '文档',
    wiki: '知识库文档',
    bitable: '多维表格',
    sheet: '电子表格',
}

// ========== Individual type fetchers ==========

async function fetchDocContent(link: FeishuLink, token: string): Promise<string | null> {
    switch (link.type) {
        case 'docx':
            return fetchDocxContent(link.token, token)
        case 'wiki':
            return fetchWikiContent(link.token, token)
        case 'bitable':
            return fetchBitableContent(link.token, link.tableId, token)
        case 'sheet':
            return fetchSheetContent(link.token, token)
        default:
            return null
    }
}

/**
 * Fetch docx document content as markdown.
 * API: GET /open-apis/docx/v1/documents/{document_id}/raw_content
 */
async function fetchDocxContent(docToken: string, token: string): Promise<string | null> {
    const resp = await fetch(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/raw_content`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!resp.ok) {
        console.error(`[DocFetcher] docx fetch failed: ${resp.status}`)
        return null
    }
    const data = await resp.json() as { code?: number; data?: { content?: string }; msg?: string }
    if (data.code !== 0) {
        console.error(`[DocFetcher] docx API error: code=${data.code} msg=${data.msg}`)
        return null
    }
    let content = data.data?.content || ''
    if (content.length > MAX_DOC_CONTENT_LENGTH) {
        content = content.slice(0, MAX_DOC_CONTENT_LENGTH) + '\n\n...(文档内容过长已截断)'
    }
    console.log(`[DocFetcher] Fetched docx ${docToken.slice(0, 12)}: ${content.length} chars`)
    return content || null
}

/**
 * Fetch wiki page content.
 * Step 1: GET /open-apis/wiki/v2/spaces/get_node?token={node_token} → get obj_token + obj_type
 * Step 2: Use obj_token to fetch actual content (usually a docx)
 */
async function fetchWikiContent(nodeToken: string, token: string): Promise<string | null> {
    // Step 1: Resolve wiki node to get actual document token
    const nodeResp = await fetch(
        `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${nodeToken}`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!nodeResp.ok) {
        console.error(`[DocFetcher] wiki get_node failed: ${nodeResp.status}`)
        return null
    }
    const nodeData = await nodeResp.json() as {
        code?: number
        data?: { node?: { obj_token?: string; obj_type?: string; title?: string } }
        msg?: string
    }
    if (nodeData.code !== 0) {
        console.error(`[DocFetcher] wiki get_node error: code=${nodeData.code} msg=${nodeData.msg}`)
        return null
    }
    const node = nodeData.data?.node
    if (!node?.obj_token) {
        console.error(`[DocFetcher] wiki node missing obj_token`)
        return null
    }

    const title = node.title || ''
    const objType = node.obj_type || ''
    console.log(`[DocFetcher] Wiki node resolved: type=${objType} title="${title}" obj_token=${node.obj_token.slice(0, 12)}`)

    // Step 2: Fetch content based on type
    let content: string | null = null
    if (objType === 'docx' || objType === 'doc') {
        content = await fetchDocxContent(node.obj_token, token)
    } else if (objType === 'sheet') {
        content = await fetchSheetContent(node.obj_token, token)
    } else if (objType === 'bitable') {
        content = await fetchBitableContent(node.obj_token, undefined, token)
    } else {
        return `[知识库页面: ${title || nodeToken}] (类型: ${objType}，暂不支持获取内容)`
    }

    if (content && title) {
        content = `# ${title}\n\n${content}`
    }
    return content
}

/**
 * Fetch bitable (多维表格) records.
 * If tableId is provided, fetch that specific table. Otherwise list tables first.
 * API: GET /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records
 */
async function fetchBitableContent(appToken: string, tableId: string | undefined, token: string): Promise<string | null> {
    // If no tableId, list tables first and use the first one
    if (!tableId) {
        const tablesResp = await fetch(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables?page_size=10`,
            { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!tablesResp.ok) {
            console.error(`[DocFetcher] bitable list tables failed: ${tablesResp.status}`)
            return null
        }
        const tablesData = await tablesResp.json() as {
            code?: number
            data?: { items?: Array<{ table_id: string; name: string }> }
            msg?: string
        }
        if (tablesData.code !== 0) {
            console.error(`[DocFetcher] bitable list tables error: code=${tablesData.code} msg=${tablesData.msg}`)
            return null
        }
        const tables = tablesData.data?.items
        if (!tables || tables.length === 0) {
            return '[多维表格: 无数据表]'
        }

        // Fetch first table (most common case), list all table names
        const tableNames = tables.map(t => t.name).join('、')
        const firstTable = tables[0]
        tableId = firstTable.table_id

        const records = await fetchBitableRecords(appToken, tableId, token)
        if (!records) return `[多维表格] 数据表：${tableNames}`
        return `[多维表格] 数据表：${tableNames}\n\n## ${firstTable.name}\n\n${records}`
    }

    const records = await fetchBitableRecords(appToken, tableId, token)
    return records
}

async function fetchBitableRecords(appToken: string, tableId: string, token: string): Promise<string | null> {
    const resp = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${MAX_BITABLE_RECORDS}`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!resp.ok) {
        console.error(`[DocFetcher] bitable records failed: ${resp.status}`)
        return null
    }
    const data = await resp.json() as {
        code?: number
        data?: {
            total?: number
            items?: Array<{ fields: Record<string, unknown> }>
        }
        msg?: string
    }
    if (data.code !== 0) {
        console.error(`[DocFetcher] bitable records error: code=${data.code} msg=${data.msg}`)
        return null
    }

    const items = data.data?.items
    if (!items || items.length === 0) return '[空表]'

    const total = data.data?.total || items.length

    // Convert records to readable format
    const lines: string[] = []
    for (const [i, item] of items.entries()) {
        const fieldParts: string[] = []
        for (const [key, value] of Object.entries(item.fields)) {
            fieldParts.push(`${key}: ${formatFieldValue(value)}`)
        }
        lines.push(`[${i + 1}] ${fieldParts.join(' | ')}`)
    }

    let result = lines.join('\n')
    if (total > items.length) {
        result += `\n\n...(共 ${total} 条记录，仅显示前 ${items.length} 条)`
    }

    if (result.length > MAX_DOC_CONTENT_LENGTH) {
        result = result.slice(0, MAX_DOC_CONTENT_LENGTH) + '\n\n...(内容过长已截断)'
    }

    console.log(`[DocFetcher] Fetched bitable ${appToken.slice(0, 12)}/${tableId}: ${items.length}/${total} records`)
    return result
}

/**
 * Format a bitable field value to readable text.
 * Handles various field types: text, number, links, attachments, people, etc.
 */
function formatFieldValue(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)

    // Array values (multi-select, people, links, etc.)
    if (Array.isArray(value)) {
        return value.map(v => {
            if (typeof v === 'string') return v
            if (v && typeof v === 'object') {
                const obj = v as Record<string, unknown>
                // Person/user field: { name, id }
                if (obj.name) return String(obj.name)
                // Link field: { text, link }
                if (obj.text) return String(obj.text)
                // Attachment: { name, url }
                if (obj.name && obj.url) return `[${obj.name}]`
                return JSON.stringify(v)
            }
            return String(v)
        }).join(', ')
    }

    // Object values
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>
        if (obj.text) return String(obj.text)
        if (obj.name) return String(obj.name)
        return JSON.stringify(value)
    }

    return String(value)
}

/**
 * Fetch sheet (电子表格) content.
 * Step 1: List sheets to get sheet IDs
 * Step 2: Fetch first sheet's data
 */
async function fetchSheetContent(spreadsheetToken: string, token: string): Promise<string | null> {
    // Step 1: Get sheet metadata
    const metaResp = await fetch(
        `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!metaResp.ok) {
        console.error(`[DocFetcher] sheet meta failed: ${metaResp.status}`)
        return null
    }
    const metaData = await metaResp.json() as {
        code?: number
        data?: { sheets?: Array<{ sheet_id: string; title: string; row_count?: number; column_count?: number }> }
        msg?: string
    }
    if (metaData.code !== 0) {
        console.error(`[DocFetcher] sheet meta error: code=${metaData.code} msg=${metaData.msg}`)
        return null
    }
    const sheets = metaData.data?.sheets
    if (!sheets || sheets.length === 0) return '[电子表格: 无工作表]'

    const firstSheet = sheets[0]
    const sheetNames = sheets.map(s => s.title).join('、')

    // Step 2: Fetch data of first sheet (limit to 100 rows)
    const maxRows = Math.min(firstSheet.row_count || 100, 100)
    const maxCols = Math.min(firstSheet.column_count || 26, 26) // A-Z
    const endCol = String.fromCharCode(64 + maxCols) // A=1 → 65
    const range = `${firstSheet.sheet_id}!A1:${endCol}${maxRows}`

    const dataResp = await fetch(
        `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!dataResp.ok) {
        console.error(`[DocFetcher] sheet data failed: ${dataResp.status}`)
        return `[电子表格] 工作表：${sheetNames}`
    }
    const sheetData = await dataResp.json() as {
        code?: number
        data?: { valueRange?: { values?: unknown[][] } }
        msg?: string
    }
    if (sheetData.code !== 0) {
        console.error(`[DocFetcher] sheet data error: code=${sheetData.code} msg=${sheetData.msg}`)
        return `[电子表格] 工作表：${sheetNames}`
    }

    const values = sheetData.data?.valueRange?.values
    if (!values || values.length === 0) return `[电子表格: ${firstSheet.title}] 空表`

    // Format as simple text table
    const lines: string[] = []
    for (const row of values) {
        const cells = row.map(cell => {
            if (cell === null || cell === undefined) return ''
            if (typeof cell === 'object') return JSON.stringify(cell)
            return String(cell)
        })
        lines.push(cells.join('\t'))
    }

    let result = `工作表：${sheetNames}\n\n## ${firstSheet.title}\n\n${lines.join('\n')}`
    if (result.length > MAX_DOC_CONTENT_LENGTH) {
        result = result.slice(0, MAX_DOC_CONTENT_LENGTH) + '\n\n...(内容过长已截断)'
    }

    console.log(`[DocFetcher] Fetched sheet ${spreadsheetToken.slice(0, 12)}: ${values.length} rows`)
    return result
}
