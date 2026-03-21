import { useState, useEffect, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import {
    MarkdownTextPrimitive,
    unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
    useIsMarkdownCodeBlock,
    type CodeHeaderProps,
} from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { SyntaxHighlighter } from '@/components/assistant-ui/shiki-highlighter'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useHappyChatContextSafe } from '@/components/AssistantChat/context'
import { ImageViewer as ImageViewerComponent } from '@/components/ImageViewer'

export const MARKDOWN_PLUGINS = [remarkGfm]

// Box drawing characters used in tree structures
const TREE_CHAR_REGEX = /[─│├└┬┴┼┌┐┘]/

// Detect if text contains tree structure patterns (lines with tree drawing characters)
function hasTreeStructure(text: string): boolean {
    return TREE_CHAR_REGEX.test(text)
}

// Check if code blocks are balanced (even number of ``` markers)
function isCodeBlockBalanced(text: string): boolean {
    const markers = text.match(/```/g)
    if (!markers) return true
    return markers.length % 2 === 0
}

// Preprocess markdown to handle incomplete code blocks and protect tree structures
// This fixes issues when streaming splits code blocks across multiple messages
// Convert server-uploads paths to /api/server-uploads/ URLs
function toServerUploadsUrl(path: string): string {
    if (path.startsWith('server-uploads/')) {
        return `/api/${path}`
    }
    const suIdx = path.indexOf('server-uploads/')
    if (suIdx >= 0) {
        return `/api/${path.slice(suIdx)}`
    }
    return path
}

// Image extensions for classifying feishu-file references
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'])

export function preprocessMarkdown(text: string): string {
    // Convert [Image: path] and [feishu-file: path] to markdown image/link syntax
    if (/\[(Image|feishu-file):\s*[^\]]+\]/.test(text)) {
        text = text.replace(/\[(Image|feishu-file):\s*([^\]]+)\]/g, (_match, tag, path) => {
            const trimmed = path.trim()
            const ext = trimmed.split('.').pop()?.toLowerCase() ?? ''
            const url = toServerUploadsUrl(trimmed)
            if (tag === 'Image' || IMAGE_EXTS.has(ext)) {
                return `![image](${url})`
            }
            const filename = trimmed.split('/').pop() ?? trimmed
            return `[${filename}](${url})`
        })
    }

    // If text has tree structure characters and code blocks are not balanced,
    // close the unclosed code block
    if (hasTreeStructure(text) && !isCodeBlockBalanced(text)) {
        return text + '\n```'
    }

    // If text has tree structure but is not inside any code block,
    // and the lines look like tree output, wrap them in a code block
    if (hasTreeStructure(text) && !text.includes('```')) {
        const lines = text.split('\n')
        const result: string[] = []
        let inTreeSection = false
        let treeLines: string[] = []

        for (const line of lines) {
            // Check if line is part of tree structure (has tree chars or is indented continuation)
            const isTreeLine = TREE_CHAR_REGEX.test(line) ||
                (inTreeSection && /^[\s│]+/.test(line) && line.trim().length > 0)

            if (isTreeLine) {
                if (!inTreeSection) {
                    inTreeSection = true
                    result.push('```')
                }
                treeLines.push(line)
            } else {
                if (inTreeSection) {
                    result.push(...treeLines)
                    result.push('```')
                    treeLines = []
                    inTreeSection = false
                }
                result.push(line)
            }
        }

        // Close any remaining tree section
        if (inTreeSection && treeLines.length > 0) {
            result.push(...treeLines)
            result.push('```')
        }

        return result.join('\n')
    }

    // Escape lines that look like Markdown link definitions but aren't URLs
    // e.g. "[Name | id]: some text" would be swallowed by the parser as a link def
    if (/^\[.+\]:\s/.test(text) || text.includes('\n[')) {
        const lines = text.split('\n')
        let changed = false
        const escaped = lines.map(line => {
            // Match link definition syntax: [label]: followed by non-URL text
            if (/^\[([^\]]+)\]:\s/.test(line) && !/^\[[^\]]+\]:\s*https?:\/\//.test(line)) {
                changed = true
                return '\\' + line
            }
            return line
        })
        if (changed) return escaped.join('\n')
    }

    return text
}

// 检测是否是绝对路径 (支持 @ + ~ 等常见路径字符，且至少包含一个非数字字符)
const ABSOLUTE_PATH_REGEX = /^(\/[\w.@+~-]*[a-zA-Z_][\w.@+~-]*\/)+[\w.@+~-]*$/
// 检测是否是相对路径（以 ./ 或 字母/下划线开头，包含 /，可以有或没有文件扩展名）
const RELATIVE_PATH_REGEX = /^(?:\.\/|(?:[\w@][\w.@+~-]*\/))[\w.@+~-]*[a-zA-Z_][\w.@+~-]*(\.[a-zA-Z0-9]+)?$/
// 用于在文本中查找路径的正则（全局匹配）- 绝对路径以 / 开头（非路径字符后面），相对路径以 ./ 或 @ 开头
const PATH_GLOBAL_REGEX = /(?<![/\w])(\/[\w.@+~-]*[a-zA-Z_][\w.@+~-]*\/)+[\w.@+~-]*|(?:\.\/|(?:[\w@][\w.@+~-]*\/))[\w.@+~-]*[a-zA-Z_][\w.@+~-]*(\.[a-zA-Z0-9]+)?/g

function isAbsolutePath(text: string): boolean {
    return ABSOLUTE_PATH_REGEX.test(text.trim())
}

function isRelativePath(text: string): boolean {
    return RELATIVE_PATH_REGEX.test(text.trim())
}

// 判断是否是文件夹（以 / 结尾或没有扩展名）
function isFolderPath(path: string): boolean {
    return path.endsWith('/') || !/\.[a-zA-Z0-9]+$/.test(path)
}

function isPath(text: string): boolean {
    const trimmed = text.trim()
    return isAbsolutePath(trimmed) || isRelativePath(trimmed)
}

// 将文本中的路径转换为链接
function processTextWithPaths(text: string): ReactNode[] {
    const parts: ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    // 重置正则的 lastIndex
    PATH_GLOBAL_REGEX.lastIndex = 0

    while ((match = PATH_GLOBAL_REGEX.exec(text)) !== null) {
        // 绝对路径在 group[1]，相对路径直接在 match[0]
        const path = match[1] ?? match[0]
        const startIndex = match.index

        // 添加路径之前的文本
        if (startIndex > lastIndex) {
            parts.push(text.slice(lastIndex, startIndex))
        }

        // 判断是绝对路径还是相对路径
        if (path.startsWith('/')) {
            // 绝对路径直接渲染为链接
            parts.push(<FilePathLink key={startIndex} path={path} />)
        } else {
            // 相对路径也显示为链接，点击时再验证
            parts.push(<RelativeFilePathLink key={startIndex} path={path} />)
        }

        lastIndex = startIndex + path.length
    }

    // 添加剩余的文本
    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex))
    }

    return parts
}

// 递归处理 children，将文本中的路径转换为链接
function processChildren(children: ReactNode): ReactNode {
    if (typeof children === 'string') {
        const parts = processTextWithPaths(children)
        return parts.length === 1 ? parts[0] : <>{parts}</>
    }

    if (Array.isArray(children)) {
        // 先把连续的字符串合并，避免路径被分割到多个文本节点
        const merged: ReactNode[] = []
        let currentStrings: string[] = []

        for (const child of children) {
            if (typeof child === 'string') {
                currentStrings.push(child)
            } else {
                // 遇到非字符串节点，先处理累积的字符串
                if (currentStrings.length > 0) {
                    const combinedText = currentStrings.join('')
                    const parts = processTextWithPaths(combinedText)
                    merged.push(...parts)
                    currentStrings = []
                }
                merged.push(child)
            }
        }

        // 处理剩余的字符串
        if (currentStrings.length > 0) {
            const combinedText = currentStrings.join('')
            const parts = processTextWithPaths(combinedText)
            merged.push(...parts)
        }

        return merged.length === 1 ? merged[0] : <>{merged}</>
    }

    return children
}

// 文件路径链接组件 - 点击时复制文件到服务器并在新窗口打开
function FilePathLink({ path }: { path: string }) {
    const context = useHappyChatContextSafe()
    const [loading, setLoading] = useState(false)

    const filename = path.split('/').pop() || path

    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault()
        if (loading || !context?.api || !context?.sessionId) return

        setLoading(true)
        try {
            const result = await context.api.copyFile(context.sessionId, path)
            if (result.success && result.path) {
                // 确保 token 是新鲜的（如果快过期则刷新）
                const token = await context.api.ensureFreshToken()
                const url = `${window.location.origin}/api/${result.path}${token ? `?token=${encodeURIComponent(token)}` : ''}`
                console.log('[FilePathLink] opening URL:', url)
                // 使用隐藏的 <a> 标签触发下载，绕过 PWA 拦截
                const link = document.createElement('a')
                link.href = url
                link.download = result.filename || path.split('/').pop() || 'file'
                link.style.display = 'none'
                document.body.appendChild(link)
                link.click()
                document.body.removeChild(link)
            } else {
                alert(`Failed to load file: ${result.error || 'Unknown error'}`)
            }
        } catch (err) {
            console.error('[FilePathLink] error:', err)
            alert('Failed to load file')
        } finally {
            setLoading(false)
        }
    }

    return (
        <a
            href="#"
            onClick={handleClick}
            className={`text-[var(--app-link)] underline hover:opacity-80 ${loading ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
            title={`Open ${filename}`}
        >
            {loading ? `${path} (loading...)` : path}
        </a>
    )
}

// 相对路径文件存在性缓存 (sessionId -> path -> { exists, absolutePath })
const relativePathCache = new Map<string, Map<string, { exists: boolean; absolutePath?: string } | 'pending'>>()

// 获取或创建 session 的缓存
function getSessionCache(sessionId: string): Map<string, { exists: boolean; absolutePath?: string } | 'pending'> {
    let cache = relativePathCache.get(sessionId)
    if (!cache) {
        cache = new Map()
        relativePathCache.set(sessionId, cache)
    }
    return cache
}

// 待检查的路径队列 (sessionId -> Set<path>)
const pendingChecks = new Map<string, Set<string>>()
// 等待检查完成的回调 (sessionId -> path -> callbacks)
const checkCallbacks = new Map<string, Map<string, Array<() => void>>>()

// 批量检查文件存在性
async function batchCheckFiles(api: { checkFiles: (sessionId: string, paths: string[]) => Promise<Record<string, { exists: boolean; absolutePath?: string }>> }, sessionId: string) {
    const pending = pendingChecks.get(sessionId)
    if (!pending || pending.size === 0) return

    const paths = Array.from(pending)
    pending.clear()

    try {
        const results = await api.checkFiles(sessionId, paths)
        const cache = getSessionCache(sessionId)

        for (const path of paths) {
            const result = results[path] || { exists: false }
            cache.set(path, result)

            // 触发等待的回调
            const callbacks = checkCallbacks.get(sessionId)?.get(path)
            if (callbacks) {
                callbacks.forEach(cb => cb())
                checkCallbacks.get(sessionId)?.delete(path)
            }
        }
    } catch (err) {
        console.error('[batchCheckFiles] error:', err)
        const cache = getSessionCache(sessionId)
        for (const path of paths) {
            cache.set(path, { exists: false })
            const callbacks = checkCallbacks.get(sessionId)?.get(path)
            if (callbacks) {
                callbacks.forEach(cb => cb())
                checkCallbacks.get(sessionId)?.delete(path)
            }
        }
    }
}

// 调度批量检查（防抖）
let batchCheckTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBatchCheck(api: { checkFiles: (sessionId: string, paths: string[]) => Promise<Record<string, { exists: boolean; absolutePath?: string }>> }, sessionId: string) {
    if (batchCheckTimer) {
        clearTimeout(batchCheckTimer)
    }
    batchCheckTimer = setTimeout(() => {
        batchCheckTimer = null
        void batchCheckFiles(api, sessionId)
    }, 50) // 50ms 防抖
}

// 相对路径链接组件 - 懒加载检查文件是否存在
function RelativeFilePathLink({ path }: { path: string }) {
    const context = useHappyChatContextSafe()
    const [status, setStatus] = useState<'checking' | 'exists' | 'not-exists'>('checking')
    const [absolutePath, setAbsolutePath] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const filename = path.split('/').pop() || path
    const isFolder = isFolderPath(path)

    useEffect(() => {
        if (isFolder) return
        if (!context?.api || !context?.sessionId) {
            setStatus('not-exists')
            return
        }

        const sessionId = context.sessionId
        const cache = getSessionCache(sessionId)
        const cached = cache.get(path)

        if (cached && cached !== 'pending') {
            // 已缓存
            if (cached.exists && cached.absolutePath) {
                setAbsolutePath(cached.absolutePath)
                setStatus('exists')
            } else {
                setStatus('not-exists')
            }
            return
        }

        if (cached === 'pending') {
            // 正在检查中，等待回调
            let callbacks = checkCallbacks.get(sessionId)
            if (!callbacks) {
                callbacks = new Map()
                checkCallbacks.set(sessionId, callbacks)
            }
            let pathCallbacks = callbacks.get(path)
            if (!pathCallbacks) {
                pathCallbacks = []
                callbacks.set(path, pathCallbacks)
            }
            pathCallbacks.push(() => {
                const result = cache.get(path)
                if (result && result !== 'pending') {
                    if (result.exists && result.absolutePath) {
                        setAbsolutePath(result.absolutePath)
                        setStatus('exists')
                    } else {
                        setStatus('not-exists')
                    }
                }
            })
            return
        }

        // 加入待检查队列
        cache.set(path, 'pending')
        let pending = pendingChecks.get(sessionId)
        if (!pending) {
            pending = new Set()
            pendingChecks.set(sessionId, pending)
        }
        pending.add(path)

        // 注册回调
        let callbacks = checkCallbacks.get(sessionId)
        if (!callbacks) {
            callbacks = new Map()
            checkCallbacks.set(sessionId, callbacks)
        }
        let pathCallbacks = callbacks.get(path)
        if (!pathCallbacks) {
            pathCallbacks = []
            callbacks.set(path, pathCallbacks)
        }
        pathCallbacks.push(() => {
            const result = cache.get(path)
            if (result && result !== 'pending') {
                if (result.exists && result.absolutePath) {
                    setAbsolutePath(result.absolutePath)
                    setStatus('exists')
                } else {
                    setStatus('not-exists')
                }
            }
        })

        // 调度批量检查
        scheduleBatchCheck(context.api, sessionId)
    }, [context?.api, context?.sessionId, path, isFolder])

    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault()
        if (loading || !context?.api || !context?.sessionId || !absolutePath) return

        setLoading(true)
        try {
            const result = await context.api.copyFile(context.sessionId, absolutePath)
            if (result.success && result.path) {
                const token = await context.api.ensureFreshToken()
                const url = `${window.location.origin}/api/${result.path}${token ? `?token=${encodeURIComponent(token)}` : ''}`
                const link = document.createElement('a')
                link.href = url
                link.download = result.filename || filename
                link.style.display = 'none'
                document.body.appendChild(link)
                link.click()
                document.body.removeChild(link)
            } else {
                alert(`Failed to load file: ${result.error || 'Unknown error'}`)
            }
        } catch (err) {
            console.error('[RelativeFilePathLink] error:', err)
            alert('Failed to load file')
        } finally {
            setLoading(false)
        }
    }

    // 文件夹路径或检查中/不存在时，显示为普通文本
    if (isFolder || status !== 'exists') {
        return <>{path}</>
    }

    return (
        <a
            href="#"
            onClick={handleClick}
            className={`text-[var(--app-link)] underline hover:opacity-80 ${loading ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
            title={`Open ${filename}`}
        >
            {loading ? `${path} (loading...)` : path}
        </a>
    )
}

function CodeHeader(props: CodeHeaderProps) {
    const { copied, copy } = useCopyToClipboard()
    const language = props.language && props.language !== 'unknown' ? props.language : ''

    return (
        <div className="aui-md-codeheader flex items-center justify-between rounded-t-md bg-[var(--app-code-bg)] px-2 py-1">
            <div className="min-w-0 flex-1 pr-2 text-xs font-mono text-[var(--app-hint)]">
                {language}
            </div>
            <button
                type="button"
                onClick={() => copy(props.code)}
                className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                title="Copy"
            >
                {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            </button>
        </div>
    )
}

function Pre(props: ComponentPropsWithoutRef<'pre'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden">
            <pre
                {...rest}
                className={cn(
                    'aui-md-pre m-0 w-max min-w-full rounded-b-md rounded-t-none bg-[var(--app-code-bg)] p-2 text-xs',
                    className
                )}
            />
        </div>
    )
}

function Code(props: ComponentPropsWithoutRef<'code'>) {
    const isCodeBlock = useIsMarkdownCodeBlock()

    if (isCodeBlock) {
        return (
            <code
                {...props}
                className={cn('aui-md-codeblockcode font-mono', props.className)}
            />
        )
    }

    // 检查是否是路径的行内代码
    const content = typeof props.children === 'string' ? props.children : null
    const trimmedContent = content?.trim()

    // 绝对路径
    if (trimmedContent && isAbsolutePath(trimmedContent)) {
        return (
            <code
                className={cn(
                    'aui-md-code break-words rounded bg-[var(--app-inline-code-bg)] px-[0.3em] py-[0.1em] font-mono text-[0.9em]',
                    props.className
                )}
            >
                <FilePathLink path={trimmedContent} />
            </code>
        )
    }

    // 相对路径
    if (trimmedContent && isRelativePath(trimmedContent)) {
        return (
            <code
                className={cn(
                    'aui-md-code break-words rounded bg-[var(--app-inline-code-bg)] px-[0.3em] py-[0.1em] font-mono text-[0.9em]',
                    props.className
                )}
            >
                <RelativeFilePathLink path={trimmedContent} />
            </code>
        )
    }

    return (
        <code
            {...props}
            className={cn(
                'aui-md-code break-words rounded bg-[var(--app-inline-code-bg)] px-[0.3em] py-[0.1em] font-mono text-[0.9em]',
                props.className
            )}
        />
    )
}

function A(props: ComponentPropsWithoutRef<'a'>) {
    // 所有链接都在新标签页打开
    return (
        <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className={cn('aui-md-a text-[var(--app-link)] underline', props.className)}
        />
    )
}

function Paragraph(props: ComponentPropsWithoutRef<'p'>) {
    const { children, ...rest } = props
    return (
        <p {...rest} className={cn('aui-md-p leading-relaxed', props.className)}>
            {processChildren(children)}
        </p>
    )
}

function Blockquote(props: ComponentPropsWithoutRef<'blockquote'>) {
    return (
        <blockquote
            {...props}
            className={cn(
                'aui-md-blockquote border-l-4 border-[var(--app-hint)] pl-3 opacity-85',
                props.className
            )}
        />
    )
}

function UnorderedList(props: ComponentPropsWithoutRef<'ul'>) {
    return <ul {...props} className={cn('aui-md-ul list-disc pl-6', props.className)} />
}

function OrderedList(props: ComponentPropsWithoutRef<'ol'>) {
    return <ol {...props} className={cn('aui-md-ol list-decimal pl-6', props.className)} />
}

function ListItem(props: ComponentPropsWithoutRef<'li'>) {
    const { children, ...rest } = props
    return (
        <li {...rest} className={cn('aui-md-li', props.className)}>
            {processChildren(children)}
        </li>
    )
}

function Hr(props: ComponentPropsWithoutRef<'hr'>) {
    return <hr {...props} className={cn('aui-md-hr border-[var(--app-divider)]', props.className)} />
}

function Table(props: ComponentPropsWithoutRef<'table'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-table-wrapper max-w-full overflow-x-auto">
            <table {...rest} className={cn('aui-md-table w-full border-collapse', className)} />
        </div>
    )
}

function Thead(props: ComponentPropsWithoutRef<'thead'>) {
    return <thead {...props} className={cn('aui-md-thead', props.className)} />
}

function Tbody(props: ComponentPropsWithoutRef<'tbody'>) {
    return <tbody {...props} className={cn('aui-md-tbody', props.className)} />
}

function Tr(props: ComponentPropsWithoutRef<'tr'>) {
    return <tr {...props} className={cn('aui-md-tr', props.className)} />
}

function Th(props: ComponentPropsWithoutRef<'th'>) {
    return (
        <th
            {...props}
            className={cn(
                'aui-md-th border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-left font-semibold',
                props.className
            )}
        />
    )
}

function Td(props: ComponentPropsWithoutRef<'td'>) {
    return <td {...props} className={cn('aui-md-td border border-[var(--app-border)] px-2 py-1', props.className)} />
}

function H1(props: ComponentPropsWithoutRef<'h1'>) {
    return <h1 {...props} className={cn('aui-md-h1 mt-3 text-base font-semibold', props.className)} />
}

function H2(props: ComponentPropsWithoutRef<'h2'>) {
    return <h2 {...props} className={cn('aui-md-h2 mt-3 text-sm font-semibold', props.className)} />
}

function H3(props: ComponentPropsWithoutRef<'h3'>) {
    return <h3 {...props} className={cn('aui-md-h3 mt-2 text-sm font-semibold', props.className)} />
}

function H4(props: ComponentPropsWithoutRef<'h4'>) {
    return <h4 {...props} className={cn('aui-md-h4 mt-2 text-sm font-semibold', props.className)} />
}

function H5(props: ComponentPropsWithoutRef<'h5'>) {
    return <h5 {...props} className={cn('aui-md-h5 mt-2 text-sm font-semibold', props.className)} />
}

function H6(props: ComponentPropsWithoutRef<'h6'>) {
    return <h6 {...props} className={cn('aui-md-h6 mt-2 text-sm font-semibold', props.className)} />
}

function Strong(props: ComponentPropsWithoutRef<'strong'>) {
    return <strong {...props} className={cn('aui-md-strong font-semibold', props.className)} />
}

function Em(props: ComponentPropsWithoutRef<'em'>) {
    return <em {...props} className={cn('aui-md-em italic', props.className)} />
}

function Image(props: ComponentPropsWithoutRef<'img'>) {
    // Use ImageViewer for server-uploads images (adds token auth + click-to-zoom)
    if (props.src?.includes('server-uploads/')) {
        return <ImageViewerComponent src={props.src} alt={props.alt} />
    }
    return <img {...props} className={cn('aui-md-img max-w-full rounded', props.className)} />
}

// Code 组件不能被 memoize，因为 FilePathLink 需要使用 context hook
export const defaultComponents = memoizeMarkdownComponents({
    SyntaxHighlighter,
    CodeHeader,
    pre: Pre,
    h1: H1,
    h2: H2,
    h3: H3,
    h4: H4,
    h5: H5,
    h6: H6,
    a: A,
    p: Paragraph,
    strong: Strong,
    em: Em,
    blockquote: Blockquote,
    ul: UnorderedList,
    ol: OrderedList,
    li: ListItem,
    hr: Hr,
    table: Table,
    thead: Thead,
    tbody: Tbody,
    tr: Tr,
    th: Th,
    td: Td,
    img: Image,
} as const)

// 合并 memoized 和非 memoized 组件
const allComponents = {
    ...defaultComponents,
    code: Code, // Code 不能 memoize，因为内部使用了 context hook
}

export function MarkdownText() {
    return (
        <MarkdownTextPrimitive
            remarkPlugins={MARKDOWN_PLUGINS}
            components={allComponents}
            preprocess={preprocessMarkdown}
            className={cn('aui-md min-w-0 max-w-full break-words text-sm')}
        />
    )
}
