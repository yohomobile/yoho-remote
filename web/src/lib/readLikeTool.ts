type ReadLikeTool = {
    name: string
    input: unknown
}

const SIMPLE_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'sed', 'less', 'more', 'bat', 'awk'])
const GREP_LIKE_COMMANDS = new Set(['grep', 'rg'])
const COMMAND_BREAK_TOKENS = new Set(['|', '||', '&&', ';'])
const GREP_SHORT_FLAGS_WITH_VALUE = new Set(['e', 'f', 'g', 'm', 'A', 'B', 'C'])
const GREP_LONG_FLAGS_WITH_VALUE = new Set([
    '--after-context',
    '--before-context',
    '--color',
    '--colors',
    '--context',
    '--encoding',
    '--engine',
    '--file',
    '--glob',
    '--iglob',
    '--max-count',
    '--max-depth',
    '--max-filesize',
    '--path-separator',
    '--pre',
    '--pre-glob',
    '--regexp',
    '--replace',
    '--sort',
    '--sortr',
    '--type',
    '--type-add',
    '--type-clear',
    '--type-not'
])

const SED_ADDRESS_RE = /^(?:\$|\d+)(?:,(?:\$|\d+))?[acdilpqswy=]?$/i
const SED_ADDRESS_GROUP_RE = /^(?:\$|\d+)(?:,(?:\$|\d+))?[acdilpqswy=]?(?:;(?:\$|\d+)(?:,(?:\$|\d+))?[acdilpqswy=]?)*$/i

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    if (!isObject(input)) return null
    for (const key of keys) {
        const value = input[key]
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim()
        }
    }
    return null
}

function getCommandString(input: unknown): string | null {
    if (!isObject(input)) return null

    const directCommand = input.command
    if (typeof directCommand === 'string' && directCommand.trim().length > 0) {
        return directCommand.trim()
    }

    if (Array.isArray(directCommand)) {
        const parts = directCommand.filter((part): part is string => typeof part === 'string' && part.length > 0)
        if (parts.length > 0) {
            return parts.join(' ')
        }
    }

    const cmd = input.cmd
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
        return cmd.trim()
    }

    return null
}

function unwrapShellCommand(command: string): string {
    let inner = command.trim()
    const shellWrapped = inner.match(/-[lc]c\s+"([\s\S]+)"$/) ?? inner.match(/-[lc]c\s+'([\s\S]+)'$/)
    if (shellWrapped?.[1]) {
        inner = shellWrapped[1].trim()
    }

    const chained = inner.split(/\s+&&\s+/)
    return (chained[chained.length - 1] ?? inner).trim()
}

function tokenizeShellCommand(command: string): string[] {
    const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    return matches
        .map((token) => token.replace(/^['"]|['"]$/g, ''))
        .filter((token) => token.length > 0)
}

export function isSedAddress(value: string): boolean {
    const trimmed = value.trim()
    if (!trimmed) {
        return false
    }
    return SED_ADDRESS_RE.test(trimmed) || SED_ADDRESS_GROUP_RE.test(trimmed)
}

function looksLikeFilePath(value: string): boolean {
    const trimmed = value.trim()
    if (!trimmed || trimmed === '--' || trimmed === '.' || trimmed === '..') {
        return false
    }
    if (trimmed.endsWith('/')) {
        return false
    }
    if (/[*?[\]{}()|]/.test(trimmed)) {
        return false
    }

    const normalized = trimmed.replace(/\\/g, '/')
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
    if (!basename) {
        return false
    }

    return basename.includes('.') || basename.startsWith('.')
}

function extractReadPathFromParsedCommand(input: unknown): string | null {
    if (!isObject(input) || !Array.isArray(input.parsed_cmd)) {
        return null
    }

    for (const entry of input.parsed_cmd) {
        if (!isObject(entry)) continue
        if (entry.type === 'read' && typeof entry.name === 'string') {
            const name = entry.name.trim()
            if (name.length > 0 && !isSedAddress(name)) {
                return name
            }
        }
    }

    return null
}

function getCommandSegment(command: string): { tokens: string[], commandIndex: number } | null {
    const tokens = tokenizeShellCommand(unwrapShellCommand(command))
    if (tokens.length === 0) return null

    let commandIndex = 0
    while (commandIndex < tokens.length) {
        const token = tokens[commandIndex]!
        if (token === 'env' || token.includes('=')) {
            commandIndex += 1
            continue
        }
        break
    }

    const end = tokens.findIndex((token, index) => index > commandIndex && COMMAND_BREAK_TOKENS.has(token))
    const segment = end === -1 ? tokens : tokens.slice(0, end)
    if (!segment[commandIndex]) return null

    return {
        tokens: segment,
        commandIndex
    }
}

function extractSimpleReadPath(tokens: string[], commandIndex: number): string | null {
    const commandName = tokens[commandIndex]

    for (let index = tokens.length - 1; index > commandIndex; index -= 1) {
        const candidate = tokens[index]!
        if (candidate === '--') continue
        if (candidate.startsWith('-')) continue
        if (candidate === commandName) continue
        if (isSedAddress(candidate)) continue
        if (SIMPLE_READ_COMMANDS.has(candidate) || GREP_LIKE_COMMANDS.has(candidate)) continue
        return candidate
    }

    return null
}

function extractGrepLikePath(tokens: string[], commandIndex: number): string | null {
    const nonFlagTokens: string[] = []
    let skipNext = false

    for (let index = commandIndex + 1; index < tokens.length; index += 1) {
        const token = tokens[index]!

        if (skipNext) {
            skipNext = false
            continue
        }

        if (token === '--') {
            continue
        }

        if (token.startsWith('--')) {
            if (!token.includes('=') && GREP_LONG_FLAGS_WITH_VALUE.has(token)) {
                skipNext = true
            }
            continue
        }

        if (token.startsWith('-') && token !== '-') {
            const shortFlags = token.slice(1)
            if (shortFlags.length === 1 && GREP_SHORT_FLAGS_WITH_VALUE.has(shortFlags)) {
                skipNext = true
            }
            continue
        }

        nonFlagTokens.push(token)
    }

    if (nonFlagTokens.length < 2) {
        return null
    }

    const pathCandidates = nonFlagTokens.slice(1).filter(looksLikeFilePath)
    if (pathCandidates.length !== 1) {
        return null
    }

    return pathCandidates[0] ?? null
}

function extractGitReadPath(tokens: string[], commandIndex: number): string | null {
    const subcommand = tokens[commandIndex + 1]
    if (subcommand !== 'show' && subcommand !== 'diff') {
        return null
    }

    const separatorIndex = tokens.indexOf('--', commandIndex + 1)
    if (separatorIndex === -1) {
        return null
    }

    const pathCandidates = tokens
        .slice(separatorIndex + 1)
        .filter((token) => token !== '--')
        .filter(looksLikeFilePath)

    if (pathCandidates.length !== 1) {
        return null
    }

    return pathCandidates[0] ?? null
}

function extractReadPathFromCommand(command: string): string | null {
    const segment = getCommandSegment(command)
    if (!segment) return null

    const { tokens, commandIndex } = segment
    const commandName = tokens[commandIndex]

    if (!commandName) {
        return null
    }

    if (SIMPLE_READ_COMMANDS.has(commandName)) {
        return extractSimpleReadPath(tokens, commandIndex)
    }

    if (GREP_LIKE_COMMANDS.has(commandName)) {
        return extractGrepLikePath(tokens, commandIndex)
    }

    if (commandName === 'git') {
        return extractGitReadPath(tokens, commandIndex)
    }

    return null
}

export function extractReadLikeToolPath(tool: ReadLikeTool): string | null {
    if (tool.name === 'Read') {
        return getInputStringAny(tool.input, ['file_path', 'path', 'file'])
    }

    if (tool.name === 'NotebookRead') {
        return getInputStringAny(tool.input, ['notebook_path', 'path', 'file'])
    }

    if (tool.name === 'Grep') {
        const path = getInputStringAny(tool.input, ['path'])
        return path && looksLikeFilePath(path) ? path : null
    }

    if (tool.name === 'Bash' || tool.name === 'CodexBash') {
        const parsedPath = extractReadPathFromParsedCommand(tool.input)
        if (parsedPath) {
            return parsedPath
        }

        const command = getCommandString(tool.input)
        return command ? extractReadPathFromCommand(command) : null
    }

    return null
}
