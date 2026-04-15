import type { ReactNode } from 'react'
import { getCodexDiffUnified, getCodexPatchEntries, getCodexPatchPrimaryPath, getUnifiedDiffFilePath } from '@/components/ToolCard/codexArtifacts'
import type { SessionMetadataSummary } from '@/types/api'
import { BulbIcon, ClipboardIcon, EyeIcon, FileDiffIcon, GlobeIcon, PuzzleIcon, QuestionIcon, RocketIcon, SearchIcon, TerminalIcon, WrenchIcon } from '@/components/ToolCard/icons'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

const DEFAULT_ICON_CLASS = 'h-3.5 w-3.5'
// Tool presentation registry for `yoho-remote/web` (aligned with `yoho-remote-app`).

export type ToolPresentation = {
    icon: ReactNode
    title: string
    subtitle: string | null
    minimal: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    if (!isObject(input)) return null
    for (const key of keys) {
        const value = input[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

function countLines(text: string): number {
    return text.split('\n').length
}

function snakeToTitleWithSpaces(value: string): string {
    return value
        .split('_')
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ')
}

function formatMCPTitle(toolName: string): string {
    const withoutPrefix = toolName.replace(/^mcp__/, '')
    const parts = withoutPrefix.split('__')
    if (parts.length >= 2) {
        const serverName = snakeToTitleWithSpaces(parts[0])
        const toolPart = snakeToTitleWithSpaces(parts.slice(1).join('_'))
        return `MCP: ${serverName} ${toolPart}`
    }
    return `MCP: ${snakeToTitleWithSpaces(withoutPrefix)}`
}

function isNamespacedToolName(toolName: string): boolean {
    return toolName.includes('__')
}

/** Extract a semantic display title from a shell command string.
 *  Handles the Codex pattern: /usr/bin/zsh -lc "cd <dir> && <actual cmd>"
 *  Returns titles like "Read README.md", "Search: pattern", "List files".
 */
function extractShellCmdTitle(rawCmd: string): string | null {
    // Unwrap shell wrapper: zsh -lc "..." or bash -c "..."
    let inner = rawCmd.trim()
    const lcMatch = inner.match(/-[lc]c\s+"([\s\S]+)"$/) ?? inner.match(/-[lc]c\s+'([\s\S]+)'$/)
    if (lcMatch) inner = lcMatch[1]

    // Strip leading "cd <dir> && " and "sleep N && " prefixes
    inner = inner.replace(/^cd\s+\S+\s*&&\s*/, '').trim()
    inner = inner.replace(/^sleep\s+\S+\s*&&\s*/, '').trim()

    const firstWord = inner.split(/[\s|;&]/)[0] ?? ''

    // Detect read-file commands: extract filename and return "Read <file>"
    const FILE_EXT_RE = /(?:^|\s)((?:[\w./~-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mts|mjs|json|md|sh|py|go|rs|rb|java|kt|swift|yaml|yml|toml|env|lock|txt|csv|html|css|scss))/

    const readCmds = new Set(['cat', 'head', 'tail', 'nl', 'sed', 'less', 'more', 'bat', 'awk'])
    if (readCmds.has(firstWord)) {
        const fileMatch = inner.match(FILE_EXT_RE)
        if (fileMatch) return fileMatch[1].split('/').pop() ?? fileMatch[1]
        return 'Read file'
    }

    // Detect search commands → just "Search"
    if (new Set(['grep', 'rg', 'ag', 'ack']).has(firstWord)) return 'Search'

    // Detect list/find commands
    if (firstWord === 'ls' || firstWord === 'tree') return 'List files'
    if (firstWord === 'find' || firstWord === 'fd') return 'Find files'

    // Any file with known extension in command
    const fileMatch = inner.match(FILE_EXT_RE)
    if (fileMatch) return fileMatch[1].split('/').pop() ?? fileMatch[1]

    // Map remaining commands to short labels
    const labelMap: Record<string, string> = {
        git: 'Git', npm: 'npm', bun: 'Bun', yarn: 'Yarn', pnpm: 'pnpm',
        python: 'Python', python3: 'Python', node: 'Node',
        mkdir: 'Mkdir', rm: 'Rm', mv: 'Mv', cp: 'Cp',
        curl: 'Curl', wget: 'Wget', jq: 'Jq',
        systemctl: 'Systemctl', journalctl: 'Journalctl', service: 'Service',
        ssh: 'SSH', scp: 'Scp', rsync: 'Rsync',
        docker: 'Docker', kubectl: 'Kubectl',
        make: 'Make', cargo: 'Cargo',
        sleep: 'Sleep', echo: 'Shell', printf: 'Shell',
    }
    if (labelMap[firstWord]) return labelMap[firstWord]

    // Return just the first word capitalized if it looks like a command name
    if (firstWord && /^[\w-]+$/.test(firstWord) && firstWord.length <= 20) {
        return firstWord.charAt(0).toUpperCase() + firstWord.slice(1)
    }

    return null
}

function getGenericToolSubtitle(input: unknown): string | null {
    return getInputStringAny(input, [
        'input',
        'prompt',
        'query',
        'pattern',
        'url',
        'file_path',
        'path',
        'filePath',
        'file',
        'command',
        'cmd'
    ])
}

type ToolOpts = {
    toolName: string
    input: unknown
    result: unknown
    childrenCount: number
    description: string | null
    metadata: SessionMetadataSummary | null
}

export const knownTools: Record<string, {
    icon: (opts: ToolOpts) => ReactNode
    title: (opts: ToolOpts) => string
    subtitle?: (opts: ToolOpts) => string | null
    minimal?: boolean | ((opts: ToolOpts) => boolean)
}> = {
    Task: {
        icon: () => <RocketIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const description = getInputStringAny(opts.input, ['description'])
            return description ?? 'Task'
        },
        subtitle: (opts) => {
            const prompt = getInputStringAny(opts.input, ['prompt'])
            return prompt ? truncate(prompt, 120) : null
        },
        minimal: (opts) => opts.childrenCount === 0
    },
    Agent: {
        icon: () => <RocketIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const description = getInputStringAny(opts.input, ['description'])
            return description ?? 'Agent'
        },
        subtitle: (opts) => {
            const prompt = getInputStringAny(opts.input, ['prompt'])
            return prompt ? truncate(prompt, 120) : null
        },
        minimal: (opts) => opts.childrenCount === 0
    },
    Bash: {
        icon: () => <TerminalIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => opts.description ?? 'Terminal',
        subtitle: (opts) => getInputStringAny(opts.input, ['command', 'cmd']),
        minimal: true
    },
    Glob: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['pattern']) ?? 'Search files',
        minimal: true
    },
    Grep: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const pattern = getInputStringAny(opts.input, ['pattern'])
            return pattern ? `grep(pattern: ${pattern})` : 'Search content'
        },
        minimal: true
    },
    LS: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'List files'
        },
        minimal: true
    },
    CodexBash: {
        icon: (opts) => {
            // parsed_cmd (newer Codex)
            if (isObject(opts.input) && Array.isArray(opts.input.parsed_cmd) && opts.input.parsed_cmd.length > 0) {
                const first = opts.input.parsed_cmd[0]
                const type = isObject(first) ? first.type : null
                if (type === 'read') return <EyeIcon className={DEFAULT_ICON_CLASS} />
                if (type === 'write') return <FileDiffIcon className={DEFAULT_ICON_CLASS} />
                if (type === 'search') return <SearchIcon className={DEFAULT_ICON_CLASS} />
            }
            // Infer icon from command string (Codex 0.118 style)
            const cmdStr = getInputStringAny(opts.input, ['command', 'cmd'])
            if (cmdStr) {
                const title = extractShellCmdTitle(cmdStr)
                if (title?.startsWith('Search')) return <SearchIcon className={DEFAULT_ICON_CLASS} />
                if (title?.startsWith('Read') || title === 'Read file') return <EyeIcon className={DEFAULT_ICON_CLASS} />
                if (title === 'Find files' || title === 'List files' || title?.startsWith('List')) return <SearchIcon className={DEFAULT_ICON_CLASS} />
            }
            return <TerminalIcon className={DEFAULT_ICON_CLASS} />
        },
        title: (opts) => {
            // parsed_cmd (newer Codex): handle all types, not just single Read
            if (isObject(opts.input) && Array.isArray(opts.input.parsed_cmd)) {
                for (const parsed of opts.input.parsed_cmd) {
                    if (!isObject(parsed)) continue
                    if (parsed.type === 'read' && typeof parsed.name === 'string') {
                        return basename(resolveDisplayPath(parsed.name, opts.metadata))
                    }
                    if (parsed.type === 'list_files') {
                        return typeof parsed.path === 'string' && parsed.path ? parsed.path : 'List files'
                    }
                    if (parsed.type === 'search') {
                        return typeof parsed.query === 'string' && parsed.query
                            ? `Search: ${parsed.query.substring(0, 25)}`
                            : 'Search'
                    }
                }
            }
            // Fallback: extract from command string (Codex 0.118 style)
            const cmdStr = getInputStringAny(opts.input, ['command', 'cmd'])
            if (cmdStr) {
                const title = extractShellCmdTitle(cmdStr)
                if (title) return title
            }
            return opts.description ?? 'Terminal'
        },
        subtitle: (opts) => {
            const command = getInputStringAny(opts.input, ['command', 'cmd'])
            if (command) return command
            if (isObject(opts.input) && Array.isArray(opts.input.command)) {
                return opts.input.command.filter((part) => typeof part === 'string').join(' ')
            }
            return null
        },
        minimal: true
    },
    Read: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path', 'file'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Read file'
        },
        minimal: true
    },
    Edit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Edit file'
        },
        minimal: true
    },
    MultiEdit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            if (!file) return 'Edit file'
            const edits = isObject(opts.input) && Array.isArray(opts.input.edits) ? opts.input.edits : null
            const count = edits ? edits.length : 0
            const path = resolveDisplayPath(file, opts.metadata)
            return count > 1 ? `${path} (${count} edits)` : path
        },
        minimal: true
    },
    Write: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Write file'
        },
        subtitle: (opts) => {
            const content = getInputStringAny(opts.input, ['content', 'text'])
            if (!content) return null
            const lines = countLines(content)
            return lines > 1 ? `${lines} lines` : `${content.length} chars`
        },
        minimal: true
    },
    WebFetch: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            if (!url) return 'Web fetch'
            try {
                return new URL(url).hostname
            } catch {
                return url
            }
        },
        subtitle: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            if (!url) return null
            return url
        },
        minimal: true
    },
    WebSearch: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['query']) ?? 'Web search',
        subtitle: (opts) => {
            const query = getInputStringAny(opts.input, ['query'])
            return query ? truncate(query, 80) : null
        },
        minimal: true
    },
    NotebookRead: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['notebook_path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'Read notebook'
        },
        minimal: true
    },
    NotebookEdit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['notebook_path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'Edit notebook'
        },
        subtitle: (opts) => {
            const mode = getInputStringAny(opts.input, ['edit_mode'])
            return mode ? `mode: ${mode}` : null
        },
        minimal: false
    },
    TodoWrite: {
        icon: () => <BulbIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Todo list',
        subtitle: (opts) => {
            const todos = isObject(opts.input) && Array.isArray(opts.input.todos) ? opts.input.todos : null
            if (todos && todos.length > 0) return `${todos.length} items`
            const newTodos = isObject(opts.result) && Array.isArray(opts.result.newTodos) ? opts.result.newTodos : null
            if (newTodos && newTodos.length > 0) return `${newTodos.length} items`
            return null
        },
        minimal: (opts) => {
            const todos = isObject(opts.input) && Array.isArray(opts.input.todos) ? opts.input.todos : null
            if (todos && todos.length > 0) return false
            const newTodos = isObject(opts.result) && Array.isArray(opts.result.newTodos) ? opts.result.newTodos : null
            if (newTodos && newTodos.length > 0) return false
            return true
        }
    },
    CodexReasoning: {
        icon: () => <BulbIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['title']) ?? 'Reasoning',
        minimal: true
    },
    CodexPatch: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Apply changes',
        subtitle: (opts) => {
            const entries = getCodexPatchEntries(opts.input, opts.result)
            if (entries.length === 0) return null

            const firstPath = getCodexPatchPrimaryPath(opts.input, opts.result)
            if (!firstPath) return null

            const display = resolveDisplayPath(firstPath, opts.metadata)
            const name = basename(display)
            return entries.length > 1 ? `${name} (+${entries.length - 1})` : name
        },
        minimal: (opts) => getCodexPatchEntries(opts.input, opts.result).length === 0
    },
    CodexDiff: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Diff',
        subtitle: (opts) => {
            const unified = getCodexDiffUnified(opts.input)
            if (!unified) return null

            const filePath = getUnifiedDiffFilePath(unified)
            if (!filePath) return null

            return filePath.split('/').pop() ?? filePath
        },
        minimal: (opts) => !getCodexDiffUnified(opts.input)
    },
    search: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['query', 'pattern']) ?? 'Search',
        minimal: true
    },
    CodexPlan: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Plan',
        minimal: false
    },
    webReader: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            if (url) {
                try { return new URL(url).hostname } catch { /* ignore */ }
            }
            return 'Web Reader'
        },
        subtitle: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            return url ? truncate(url, 120) : null
        },
        minimal: false
    },
    analyze_image: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Analyze Image',
        subtitle: (opts) => {
            const prompt = getInputStringAny(opts.input, ['prompt'])
            return prompt ? truncate(prompt, 120) : null
        },
        minimal: false
    },
    ExitPlanMode: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Plan proposal',
        minimal: false
    },
    exit_plan_mode: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Plan proposal',
        minimal: false
    },
    AskUserQuestion: {
        icon: () => <QuestionIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const questions = isObject(opts.input) && Array.isArray(opts.input.questions)
                ? opts.input.questions : []
            const count = questions.length
            const first = questions[0] ?? null
            const header = isObject(first) && typeof first.header === 'string'
                ? first.header.trim() : ''

            if (count > 1) {
                return `${count} Questions`
            }
            return header.length > 0 ? header : 'Question'
        },
        subtitle: (opts) => {
            const questions = isObject(opts.input) && Array.isArray(opts.input.questions)
                ? opts.input.questions : []
            const count = questions.length
            const first = questions[0] ?? null
            const question = isObject(first) && typeof first.question === 'string'
                ? first.question.trim() : ''

            if (count > 1 && question.length > 0) {
                return truncate(question, 100) + ` (+${count - 1} more)`
            }
            return question.length > 0 ? truncate(question, 120) : null
        },
        minimal: false
    },
    ask_user_question: {
        icon: () => <QuestionIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const questions = isObject(opts.input) && Array.isArray(opts.input.questions)
                ? opts.input.questions : []
            const count = questions.length
            const first = questions[0] ?? null
            const header = isObject(first) && typeof first.header === 'string'
                ? first.header.trim() : ''

            if (count > 1) {
                return `${count} Questions`
            }
            return header.length > 0 ? header : 'Question'
        },
        subtitle: (opts) => {
            const questions = isObject(opts.input) && Array.isArray(opts.input.questions)
                ? opts.input.questions : []
            const count = questions.length
            const first = questions[0] ?? null
            const question = isObject(first) && typeof first.question === 'string'
                ? first.question.trim() : ''

            if (count > 1 && question.length > 0) {
                return truncate(question, 100) + ` (+${count - 1} more)`
            }
            return question.length > 0 ? truncate(question, 120) : null
        },
        minimal: false
    },
    ToolSearch: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Tool Search',
        subtitle: (opts) => getInputStringAny(opts.input, ['query', 'name']),
        minimal: true
    },
    TaskOutput: {
        icon: () => <TerminalIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Task Output',
        minimal: true
    },
    TaskStop: {
        icon: () => <TerminalIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Task Stop',
        minimal: true
    },
    EnterPlanMode: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Enter Plan Mode',
        minimal: true
    },
    Skill: {
        icon: () => <BulbIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const skill = getInputStringAny(opts.input, ['skill'])
            return skill ? `/${skill}` : 'Skill'
        },
        minimal: true
    },
    Monitor: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['description']) ?? 'Monitor',
        minimal: true
    },
    BrowserAgent: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Browser Agent',
        minimal: false
    }
}

export function getToolPresentation(opts: Omit<ToolOpts, 'metadata'> & { metadata: SessionMetadataSummary | null }): ToolPresentation {
    if (opts.toolName.startsWith('mcp__')) {
        return {
            icon: <PuzzleIcon className={DEFAULT_ICON_CLASS} />,
            title: formatMCPTitle(opts.toolName),
            subtitle: getGenericToolSubtitle(opts.input),
            minimal: true
        }
    }

    if (isNamespacedToolName(opts.toolName)) {
        return {
            icon: <PuzzleIcon className={DEFAULT_ICON_CLASS} />,
            title: formatMCPTitle(opts.toolName),
            subtitle: getGenericToolSubtitle(opts.input),
            minimal: true
        }
    }

    const known = knownTools[opts.toolName] ?? knownTools[opts.toolName.charAt(0).toUpperCase() + opts.toolName.slice(1)]
    if (known) {
        const minimal = typeof known.minimal === 'function' ? known.minimal(opts) : (known.minimal ?? false)
        return {
            icon: known.icon(opts),
            title: known.title(opts),
            subtitle: known.subtitle ? known.subtitle(opts) : null,
            minimal
        }
    }

    const subtitle = getGenericToolSubtitle(opts.input)

    let title = opts.toolName
    if (title.includes('/') && !title.includes(' ')) {
        title = title.split('/').pop() ?? title
    }

    return {
        icon: <WrenchIcon className={DEFAULT_ICON_CLASS} />,
        title,
        subtitle: subtitle ? truncate(subtitle, 80) : null,
        minimal: true
    }
}
