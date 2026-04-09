/**
 * File content extraction for IM adapters.
 * Extracts readable text from uploaded files so Brain can understand their contents.
 *
 * Supported:
 * - Plain text files (.txt, .md, .json, .py, .js, .ts, .yaml, .xml, .csv, .log, etc.)
 * - CSV → markdown table
 * - PDF → text extraction
 * - DOCX → markdown conversion
 * - XLSX/XLS → markdown tables per sheet
 */

import { extname } from 'node:path'

const MAX_TEXT_SIZE = 50_000     // 50KB text limit per file
const MAX_CSV_ROWS = 200
const MAX_XLSX_ROWS = 200
const MAX_PDF_PAGES = 30

// Extensions that can be read directly as UTF-8
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rst',
    '.json', '.jsonl', '.ndjson',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
    '.xml', '.html', '.htm', '.svg',
    '.csv', '.tsv',
    '.log', '.diff', '.patch',
    // Programming languages
    '.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    '.java', '.kt', '.kts', '.scala', '.groovy',
    '.c', '.h', '.cpp', '.cc', '.hpp', '.cxx',
    '.cs', '.fs',
    '.go', '.rs', '.zig',
    '.rb', '.php', '.pl', '.pm', '.lua',
    '.swift', '.m', '.mm',
    '.r', '.R', '.jl',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.sql', '.graphql', '.gql',
    '.proto', '.thrift',
    '.tf', '.hcl',
    '.dockerfile',
    // Config / data
    '.properties', '.gradle', '.cmake',
    '.gitignore', '.dockerignore', '.editorconfig',
    '.eslintrc', '.prettierrc', '.babelrc',
])

// Language hint map for code fences
const LANG_MAP: Record<string, string> = {
    '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
    '.jsx': 'jsx', '.tsx': 'tsx', '.mjs': 'javascript', '.cjs': 'javascript',
    '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.fs': 'fsharp',
    '.go': 'go', '.rs': 'rust', '.zig': 'zig',
    '.rb': 'ruby', '.php': 'php', '.lua': 'lua',
    '.swift': 'swift', '.r': 'r', '.R': 'r', '.jl': 'julia',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.ps1': 'powershell',
    '.sql': 'sql', '.graphql': 'graphql',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.xml': 'xml', '.html': 'html', '.htm': 'html', '.svg': 'svg',
    '.md': 'markdown', '.proto': 'protobuf', '.tf': 'hcl',
    '.dockerfile': 'dockerfile', '.csv': 'csv', '.tsv': 'tsv',
}

/**
 * Try to extract readable text content from a file buffer.
 * Returns formatted text for Brain consumption, or null if extraction not supported/failed.
 */
export async function extractFileContent(fileName: string, buffer: Buffer): Promise<string | null> {
    const ext = extname(fileName).toLowerCase()

    // CSV → markdown table (before generic text, for better formatting)
    if (ext === '.csv' || ext === '.tsv') {
        return extractCsv(fileName, buffer, ext === '.tsv' ? '\t' : ',')
    }

    // Plain text files → read as UTF-8 with code fence
    if (isTextFile(fileName)) {
        return extractPlainText(fileName, buffer, ext)
    }

    // PDF → text extraction
    if (ext === '.pdf') {
        return extractPdf(fileName, buffer)
    }

    // DOCX → markdown
    if (ext === '.docx') {
        return extractDocx(fileName, buffer)
    }

    // XLSX/XLS → markdown tables
    if (ext === '.xlsx' || ext === '.xls') {
        return extractXlsx(fileName, buffer)
    }

    return null
}

/**
 * Check if a file can be read as plain text.
 */
function isTextFile(fileName: string): boolean {
    const ext = extname(fileName).toLowerCase()
    if (TEXT_EXTENSIONS.has(ext)) return true
    // Files without extension or with common text names
    const base = fileName.toLowerCase()
    return ['makefile', 'rakefile', 'gemfile', 'procfile', 'vagrantfile'].includes(base)
        || base.startsWith('readme') || base.startsWith('license') || base.startsWith('changelog')
}

// ========== Plain text ==========

function extractPlainText(fileName: string, buffer: Buffer, ext: string): string | null {
    try {
        const text = buffer.toString('utf-8')

        // Quick binary check — if too many non-printable chars, bail
        const nonPrintable = [...text.slice(0, 1000)].filter(ch => {
            const code = ch.charCodeAt(0)
            return code < 9 || (code > 13 && code < 32 && code !== 27)
        }).length
        if (nonPrintable > 50) return null

        if (text.length > MAX_TEXT_SIZE) {
            const truncated = text.slice(0, MAX_TEXT_SIZE)
            const lang = LANG_MAP[ext] || ''
            return `[${fileName}] (截取前 ${MAX_TEXT_SIZE} 字符)\n\`\`\`${lang}\n${truncated}\n\`\`\``
        }

        const lang = LANG_MAP[ext] || ''
        // For markdown files, don't wrap in code fence — send as-is
        if (ext === '.md' || ext === '.markdown' || ext === '.rst') {
            return `[${fileName}]\n\n${text}`
        }
        return `[${fileName}]\n\`\`\`${lang}\n${text}\n\`\`\``
    } catch {
        return null
    }
}

// ========== CSV/TSV ==========

function extractCsv(fileName: string, buffer: Buffer, delimiter: string): string | null {
    try {
        const text = buffer.toString('utf-8')
        const lines = text.split('\n').filter(l => l.trim())
        if (lines.length === 0) return null

        const rows = lines.slice(0, MAX_CSV_ROWS + 1).map(line => parseCsvLine(line, delimiter))
        const colCount = Math.max(...rows.map(r => r.length))

        // Build markdown table
        const mdLines: string[] = []
        for (let ri = 0; ri < rows.length && ri <= MAX_CSV_ROWS; ri++) {
            const cells = []
            for (let ci = 0; ci < colCount; ci++) {
                cells.push((rows[ri][ci] || '').replace(/\|/g, '\\|'))
            }
            mdLines.push(`| ${cells.join(' | ')} |`)
            if (ri === 0) {
                mdLines.push(`| ${cells.map(() => '---').join(' | ')} |`)
            }
        }

        const truncNote = lines.length > MAX_CSV_ROWS
            ? `\n\n...(共 ${lines.length} 行，显示前 ${MAX_CSV_ROWS} 行)`
            : ''

        return `[${fileName}] (${lines.length} 行)\n\n${mdLines.join('\n')}${truncNote}`
    } catch {
        // Fallback to plain text
        return extractPlainText(fileName, buffer, '.csv')
    }
}

function parseCsvLine(line: string, delimiter: string): string[] {
    const cells: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"'
                    i++
                } else {
                    inQuotes = false
                }
            } else {
                current += ch
            }
        } else if (ch === '"') {
            inQuotes = true
        } else if (ch === delimiter) {
            cells.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    cells.push(current.trim())
    return cells
}

// ========== PDF ==========

async function extractPdf(fileName: string, buffer: Buffer): Promise<string | null> {
    try {
        const pdfParseModule = await import('pdf-parse')
        const pdfParse = (pdfParseModule as any).default || pdfParseModule
        const data = await pdfParse(buffer, { max: MAX_PDF_PAGES })
        const text = data.text?.trim()
        if (!text) return `[${fileName}] (PDF, ${data.numpages} 页，无可提取文本)`

        const pageInfo = `${data.numpages} 页`
        const truncated = text.length > MAX_TEXT_SIZE
            ? text.slice(0, MAX_TEXT_SIZE) + '\n\n...(内容过长已截断)'
            : text

        return `[${fileName}] (PDF, ${pageInfo})\n\n${truncated}`
    } catch (err) {
        console.warn(`[fileExtractor] PDF extraction failed for ${fileName}:`, err)
        return null
    }
}

// ========== DOCX ==========

async function extractDocx(fileName: string, buffer: Buffer): Promise<string | null> {
    try {
        const mammothModule = await import('mammoth')
        const mammoth = (mammothModule as any).default || mammothModule
        const result = await mammoth.extractRawText({ buffer })
        const text = result.value?.trim()
        if (!text) return `[${fileName}] (DOCX, 无可提取内容)`

        const truncated = text.length > MAX_TEXT_SIZE
            ? text.slice(0, MAX_TEXT_SIZE) + '\n\n...(内容过长已截断)'
            : text

        return `[${fileName}] (DOCX)\n\n${truncated}`
    } catch (err) {
        console.warn(`[fileExtractor] DOCX extraction failed for ${fileName}:`, err)
        return null
    }
}

// ========== XLSX/XLS ==========

async function extractXlsx(fileName: string, buffer: Buffer): Promise<string | null> {
    try {
        const XLSX = await import('xlsx')
        const workbook = XLSX.read(buffer, { type: 'buffer' })
        if (!workbook.SheetNames.length) return `[${fileName}] (Excel, 无工作表)`

        const parts: string[] = []
        for (const sheetName of workbook.SheetNames.slice(0, 5)) {
            const sheet = workbook.Sheets[sheetName]
            if (!sheet) continue

            const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' })
            if (rows.length === 0) continue

            const displayRows = rows.slice(0, MAX_XLSX_ROWS + 1)
            const colCount = Math.max(...displayRows.map(r => (r as string[]).length))
            if (colCount === 0) continue

            const mdLines: string[] = []
            for (let ri = 0; ri < displayRows.length; ri++) {
                const row = displayRows[ri] as string[]
                const cells = []
                for (let ci = 0; ci < colCount; ci++) {
                    cells.push(String(row[ci] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '))
                }
                mdLines.push(`| ${cells.join(' | ')} |`)
                if (ri === 0) {
                    mdLines.push(`| ${cells.map(() => '---').join(' | ')} |`)
                }
            }

            const truncNote = rows.length > MAX_XLSX_ROWS
                ? `\n...(共 ${rows.length} 行，显示前 ${MAX_XLSX_ROWS} 行)`
                : ''

            const sheetLabel = workbook.SheetNames.length > 1 ? `Sheet: ${sheetName}` : ''
            parts.push(`${sheetLabel ? `**${sheetLabel}** (${rows.length} 行)\n\n` : ''}${mdLines.join('\n')}${truncNote}`)
        }

        if (parts.length === 0) return `[${fileName}] (Excel, 无数据)`

        const sheetsNote = workbook.SheetNames.length > 5
            ? `\n\n...(共 ${workbook.SheetNames.length} 个工作表，显示前 5 个)`
            : ''

        return `[${fileName}] (Excel)\n\n${parts.join('\n\n---\n\n')}${sheetsNote}`
    } catch (err) {
        console.warn(`[fileExtractor] XLSX extraction failed for ${fileName}:`, err)
        return null
    }
}
