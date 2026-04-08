import type { ToolViewComponent, ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

type MarkdownSection = {
    key: string
    label: string
    text: string
}

const YOHO_MEMORY_MARKDOWN_PATHS: Array<{ path: string[]; label: string }> = [
    { path: ['answer'], label: 'Answer' },
    { path: ['message'], label: 'Message' },
    { path: ['summary'], label: 'Summary' },
    { path: ['content'], label: 'Content' },
    { path: ['checks'], label: 'Checks' },
    { path: ['current_step', 'content'], label: 'Current Step' }
]

function parseToolUseError(message: string): { isToolUseError: boolean; errorMessage: string | null } {
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s
    const match = message.match(regex)

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: typeof match[1] === 'string' ? match[1].trim() : ''
        }
    }

    return { isToolUseError: false, errorMessage: null }
}

function extractTextFromContentBlock(block: unknown): string | null {
    if (typeof block === 'string') return block
    if (!isObject(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (typeof block.text === 'string') return block.text
    return null
}

const RESULT_TEXT_KEYS = [
    'content',
    'text',
    'output',
    'error',
    'message',
    'aggregated_output',
    'combined_output',
    'output_text',
    'stdout',
    'stderr'
] as const

function extractTextFromArray(result: unknown[]): string | null {
    const parts = result
        .map(extractTextFromContentBlock)
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join('\n') : null
}

function extractTextCandidate(value: unknown, depth: number): string | null {
    if (typeof value === 'string') {
        const toolUseError = parseToolUseError(value)
        return toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : value
    }

    if (Array.isArray(value)) {
        return extractTextFromArray(value)
    }

    if (isObject(value)) {
        return extractTextFromResult(value, depth + 1)
    }

    return null
}

export function extractTextFromResult(result: unknown, depth: number = 0): string | null {
    if (depth > 3) return null
    if (result === null || result === undefined) return null
    if (typeof result === 'string') return extractTextCandidate(result, depth)

    if (Array.isArray(result)) {
        return extractTextFromArray(result)
    }

    if (!isObject(result)) return null

    for (const key of RESULT_TEXT_KEYS) {
        const text = extractTextCandidate(result[key], depth)
        if (text) {
            return text
        }
    }

    const nestedOutput = isObject(result.output) ? result.output : null
    if (nestedOutput) {
        const nestedText = extractTextFromResult(nestedOutput, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedError = isObject(result.error) ? result.error : null
    if (nestedError) {
        const nestedText = extractTextFromResult(nestedError, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedResult = isObject(result.result) ? result.result : null
    if (nestedResult) {
        const nestedText = extractTextFromResult(nestedResult, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedData = isObject(result.data) ? result.data : null
    if (nestedData) {
        const nestedText = extractTextFromResult(nestedData, depth + 1)
        if (nestedText) return nestedText
    }

    return null
}

function looksLikeHtml(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div') || trimmed.startsWith('<span')
}

function looksLikeJson(text: string): boolean {
    const trimmed = text.trim()
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function tryParseJson(text: string): unknown | null {
    if (!looksLikeJson(text)) {
        return null
    }

    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

function renderText(text: string, opts: { mode: 'markdown' | 'code' | 'auto'; language?: string } = { mode: 'auto' }) {
    if (opts.mode === 'code') {
        return <CodeBlock code={text} language={opts.language ?? 'text'} />
    }

    if (opts.mode === 'markdown') {
        return <MarkdownRenderer content={text} />
    }

    if (looksLikeHtml(text) || looksLikeJson(text)) {
        return <CodeBlock code={text} language={looksLikeJson(text) ? 'json' : 'html'} />
    }

    return <MarkdownRenderer content={text} />
}

function placeholderForState(state: ToolViewProps['block']['tool']['state']): string {
    if (state === 'pending') return 'Waiting for permission…'
    if (state === 'running') return 'Running…'
    return '(no output)'
}

function RawJsonDevOnly(props: { value: unknown }) {
    if (!import.meta.env.DEV) return null
    if (props.value === null || props.value === undefined) return null

    return (
        <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
                Raw JSON
            </summary>
            <div className="mt-2">
                <CodeBlock code={safeStringify(props.value)} language="json" />
            </div>
        </details>
    )
}

function extractStdoutStderr(result: unknown): { stdout: string | null; stderr: string | null } | null {
    if (!isObject(result)) return null

    const stdout = typeof result.stdout === 'string' ? result.stdout : null
    const stderr = typeof result.stderr === 'string' ? result.stderr : null
    if (stdout !== null || stderr !== null) {
        return { stdout, stderr }
    }

    const nested = isObject(result.output) ? result.output : null
    if (nested) {
        const nestedStdout = typeof nested.stdout === 'string' ? nested.stdout : null
        const nestedStderr = typeof nested.stderr === 'string' ? nested.stderr : null
        if (nestedStdout !== null || nestedStderr !== null) {
            return { stdout: nestedStdout, stderr: nestedStderr }
        }
    }

    return null
}

function extractExitInfo(result: unknown): { exitCode: number | null } | null {
    if (!isObject(result)) {
        return null
    }

    const exitCode = typeof result.exit_code === 'number'
        ? result.exit_code
        : typeof result.exitCode === 'number'
            ? result.exitCode
            : null

    if (exitCode !== null) {
        return { exitCode }
    }

    const nested = isObject(result.output) ? result.output : null
    if (!nested) {
        return null
    }

    const nestedExitCode = typeof nested.exit_code === 'number'
        ? nested.exit_code
        : typeof nested.exitCode === 'number'
            ? nested.exitCode
            : null

    return nestedExitCode !== null ? { exitCode: nestedExitCode } : null
}

function extractReadFileContent(result: unknown): { filePath: string | null; content: string } | null {
    if (!isObject(result)) return null
    const file = isObject(result.file) ? result.file : null
    if (!file) return null

    const content = typeof file.content === 'string' ? file.content : null
    if (content === null) return null

    const filePath = typeof file.filePath === 'string'
        ? file.filePath
        : typeof file.file_path === 'string'
            ? file.file_path
            : null

    return { filePath, content }
}

function isYohoMemoryToolName(toolName: string): boolean {
    return toolName === 'yoho_memory__recall'
        || toolName === 'yoho_memory__remember'
        || toolName === 'yoho_memory__get_playbook'
        || toolName === 'mcp__yoho_memory__recall'
        || toolName === 'mcp__yoho_memory__remember'
        || toolName === 'mcp__yoho_memory__get_playbook'
}

function cloneJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(cloneJsonValue)
    }

    if (!isObject(value)) {
        return value
    }

    const clone: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
        clone[key] = cloneJsonValue(nested)
    }
    return clone
}

function readStringAtPath(value: unknown, path: string[]): string | null {
    let current: unknown = value
    for (const key of path) {
        if (!isObject(current)) {
            return null
        }
        current = current[key]
    }
    return typeof current === 'string' ? current : null
}

function deletePath(value: unknown, path: string[]): void {
    if (!isObject(value) || path.length === 0) {
        return
    }

    const [head, ...rest] = path
    if (rest.length === 0) {
        delete value[head]
        return
    }

    deletePath(value[head], rest)
}

function compactJsonValue(value: unknown): unknown | null {
    if (Array.isArray(value)) {
        const next = value
            .map(compactJsonValue)
            .filter((item): item is Exclude<typeof item, null> => item !== null)
        return next.length > 0 ? next : null
    }

    if (isObject(value)) {
        const nextEntries = Object.entries(value)
            .map(([key, nested]) => [key, compactJsonValue(nested)] as const)
            .filter((entry): entry is readonly [string, Exclude<(typeof entry)[1], null>] => entry[1] !== null)
        return nextEntries.length > 0 ? Object.fromEntries(nextEntries) : null
    }

    return value === undefined ? null : value
}

function extractStructuredJsonPayload(result: unknown): unknown | null {
    if (typeof result === 'string') {
        return tryParseJson(result)
    }

    const text = extractTextFromResult(result)
    if (text) {
        const parsed = tryParseJson(text)
        if (parsed !== null) {
            return parsed
        }
    }

    if (Array.isArray(result) || isObject(result)) {
        return result
    }

    return null
}

export function extractYohoMemoryDisplayData(result: unknown): { markdownSections: MarkdownSection[]; jsonValue: unknown | null } {
    const payload = extractStructuredJsonPayload(result)
    if (payload === null) {
        return { markdownSections: [], jsonValue: null }
    }

    if (!Array.isArray(payload) && !isObject(payload)) {
        return { markdownSections: [], jsonValue: payload }
    }

    const working = cloneJsonValue(payload)
    const seenMarkdown = new Set<string>()
    const markdownSections: MarkdownSection[] = []

    for (const spec of YOHO_MEMORY_MARKDOWN_PATHS) {
        const text = readStringAtPath(working, spec.path)?.trim()
        if (!text || seenMarkdown.has(text)) {
            continue
        }

        seenMarkdown.add(text)
        markdownSections.push({
            key: spec.path.join('.'),
            label: spec.label,
            text
        })
        deletePath(working, spec.path)
    }

    return {
        markdownSections,
        jsonValue: compactJsonValue(working)
    }
}

function extractLineList(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

function isProbablyMarkdownList(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1. ')
}

const AskUserQuestionResultView: ToolViewComponent = (props: ToolViewProps) => {
    const answers = props.block.tool.permission?.answers ?? null

    // If answers exist, AskUserQuestionView already shows them with highlighting
    // Return null to avoid duplicate display
    if (answers && Object.keys(answers).length > 0) {
        return null
    }

    // Fallback for tools without structured answers
    return <MarkdownResultView {...props} />
}

const BashResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const exitInfo = extractExitInfo(result)
    const exitCodeBanner = exitInfo && exitInfo.exitCode !== null && exitInfo.exitCode !== 0
        ? (
            <div className="text-sm font-medium text-red-600">
                Exit code {exitInfo.exitCode}
            </div>
        )
        : null

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        const display = toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
        return (
            <>
                <div className="flex flex-col gap-2">
                    {exitCodeBanner}
                    <CodeBlock code={display} language="text" />
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const stdio = extractStdoutStderr(result)
    if (stdio) {
        return (
            <>
                <div className="flex flex-col gap-2">
                    {exitCodeBanner}
                    {stdio.stdout ? <CodeBlock code={stdio.stdout} language="text" /> : null}
                    {stdio.stderr ? <CodeBlock code={stdio.stderr} language="text" /> : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                <div className="flex flex-col gap-2">
                    {exitCodeBanner}
                    {renderText(text, { mode: 'code', language: 'text' })}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (exitCodeBanner) {
        return (
            <>
                {exitCodeBanner}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MarkdownResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const LineListResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (!text) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (isProbablyMarkdownList(text)) {
        return (
            <>
                <MarkdownRenderer content={text} />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const lines = extractLineList(text)
    if (lines.length === 0) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="flex flex-col gap-1">
                {lines.map((line) => (
                    <div key={line} className="text-sm font-mono text-[var(--app-fg)] break-all">
                        {line}
                    </div>
                ))}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const ReadResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const file = extractReadFileContent(result)
    if (file) {
        const path = file.filePath ? resolveDisplayPath(file.filePath, props.metadata) : null
        return (
            <>
                {path ? (
                    <div className="mb-2 text-xs text-[var(--app-hint)] font-mono break-all">
                        {basename(path)}
                    </div>
                ) : null}
                <CodeBlock code={file.content} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MutationResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result } = props.block.tool

    if (result === undefined || result === null) {
        if (state === 'completed') {
            return <div className="text-sm text-[var(--app-hint)]">Done</div>
        }
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    const text = extractTextFromResult(result)
    if (typeof text === 'string' && text.trim().length > 0) {
        const className = state === 'error' ? 'text-red-600' : 'text-[var(--app-fg)]'
        return (
            <>
                <div className={`text-sm ${className}`}>
                    {renderText(text, { mode: state === 'error' ? 'code' : 'auto' })}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">
                {state === 'completed' ? 'Done' : '(no output)'}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexPatchResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexReasoningResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexDiffResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'diff' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">Done</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

type TodoItem = {
    id?: string
    content?: string
    status?: 'pending' | 'in_progress' | 'completed'
    priority?: 'high' | 'medium' | 'low'
}

function extractTodos(input: unknown, result: unknown): TodoItem[] {
    const todosFromInput = isObject(input) && Array.isArray(input.todos)
        ? input.todos.filter(isObject)
        : []
    if (todosFromInput.length > 0) {
        return todosFromInput.map((t) => ({
            id: typeof t.id === 'string' ? t.id : undefined,
            content: typeof t.content === 'string' ? t.content : undefined,
            status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
            priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
        }))
    }

    const newTodos = isObject(result) && Array.isArray(result.newTodos)
        ? result.newTodos.filter(isObject)
        : []
    return newTodos.map((t) => ({
        id: typeof t.id === 'string' ? t.id : undefined,
        content: typeof t.content === 'string' ? t.content : undefined,
        status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
        priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
    }))
}

function todoTone(todo: TodoItem): string {
    if (todo.status === 'completed') return 'text-emerald-600 line-through'
    if (todo.status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function todoIcon(todo: TodoItem): string {
    if (todo.status === 'completed') return '☑'
    return '☐'
}

const TodoWriteResultView: ToolViewComponent = (props: ToolViewProps) => {
    const todos = extractTodos(props.block.tool.input, props.block.tool.result)
    if (todos.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <div className="flex flex-col gap-1">
            {todos.map((todo, idx) => {
                const text = todo.content?.trim() ? todo.content.trim() : '(empty)'
                return (
                    <div key={todo.id ?? String(idx)} className={`text-sm ${todoTone(todo)}`}>
                        {todoIcon(todo)} {text}
                    </div>
                )
            })}
        </div>
    )
}

const YohoMemoryResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const display = extractYohoMemoryDisplayData(result)
    if (display.markdownSections.length > 0 || display.jsonValue !== null) {
        return (
            <>
                <div className="flex flex-col gap-3">
                    {display.markdownSections.map((section) => (
                        <div key={section.key}>
                            <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                                {section.label}
                            </div>
                            <MarkdownRenderer content={section.text} />
                        </div>
                    ))}
                    {display.jsonValue !== null ? (
                        <div>
                            <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                                Structured Data
                            </div>
                            <CodeBlock code={safeStringify(display.jsonValue)} language="json" />
                        </div>
                    ) : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                {typeof result === 'object' ? <RawJsonDevOnly value={result} /> : null}
            </>
        )
    }

    return <CodeBlock code={safeStringify(result)} language="json" />
}

const GenericResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                {typeof result === 'object' ? <RawJsonDevOnly value={result} /> : null}
            </>
        )
    }

    if (typeof result === 'string') {
        return renderText(result, { mode: 'auto' })
    }

    return <CodeBlock code={safeStringify(result)} language="json" />
}

export const toolResultViewRegistry: Record<string, ToolViewComponent> = {
    Task: MarkdownResultView,
    Bash: BashResultView,
    CodexBash: BashResultView,
    Glob: LineListResultView,
    Grep: LineListResultView,
    LS: LineListResultView,
    Read: ReadResultView,
    Edit: MutationResultView,
    MultiEdit: MutationResultView,
    Write: MutationResultView,
    WebFetch: MarkdownResultView,
    WebSearch: MarkdownResultView,
    NotebookRead: ReadResultView,
    NotebookEdit: MutationResultView,
    TodoWrite: TodoWriteResultView,
    CodexReasoning: CodexReasoningResultView,
    CodexPatch: CodexPatchResultView,
    CodexDiff: CodexDiffResultView,
    AskUserQuestion: AskUserQuestionResultView,
    ExitPlanMode: MarkdownResultView,
    ask_user_question: AskUserQuestionResultView,
    exit_plan_mode: MarkdownResultView
}

export function getToolResultViewComponent(toolName: string): ToolViewComponent {
    if (isYohoMemoryToolName(toolName)) {
        return YohoMemoryResultView
    }
    if (toolName.startsWith('mcp__')) {
        return GenericResultView
    }
    return toolResultViewRegistry[toolName] ?? GenericResultView
}
