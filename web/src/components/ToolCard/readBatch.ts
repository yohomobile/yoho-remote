import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'
import { extractReadLikeToolPath, isSedAddress } from '@/lib/readLikeTool'

export type ReadBatchItem = {
    file: string
    displayPath: string
    name: string
    directory: string | null
    content: string | null
    state: ToolCallBlock['tool']['state']
}

const READ_LIKE_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'sed', 'less', 'more', 'bat', 'awk'])

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

function getInputFiles(input: unknown): string[] {
    if (!isObject(input) || !Array.isArray(input.files)) {
        return []
    }

    return input.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
}

function getTextFromContentBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) return null

    const parts = value
        .map((item) => {
            if (typeof item === 'string') return item
            if (!isObject(item)) return null
            if (typeof item.text === 'string') return item.text
            if (typeof item.content === 'string') return item.content
            return null
        })
        .filter((text): text is string => typeof text === 'string' && text.length > 0)

    return parts.length > 0 ? parts.join('\n') : null
}

function extractResultText(result: unknown): string | null {
    if (typeof result === 'string' && result.length > 0) {
        return result
    }

    if (!isObject(result)) {
        return null
    }

    const file = result.file
    if (isObject(file) && typeof file.content === 'string') {
        return file.content
    }

    for (const key of ['aggregated_output', 'stdout', 'stderr', 'output', 'content', 'text', 'message', 'error']) {
        const value = result[key]
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
        const blockText = getTextFromContentBlocks(value)
        if (blockText) {
            return blockText
        }
        const nestedText = extractResultText(value)
        if (nestedText) {
            return nestedText
        }
    }

    return null
}

function getDisplayParts(file: string, metadata: SessionMetadataSummary | null): Pick<ReadBatchItem, 'displayPath' | 'name' | 'directory'> {
    const displayPath = resolveDisplayPath(file, metadata)
    const name = basename(displayPath)
    const directory = displayPath === name
        ? null
        : displayPath.slice(0, Math.max(0, displayPath.length - name.length)).replace(/[\\/]+$/, '')

    return {
        displayPath,
        name,
        directory: directory && directory.length > 0 ? directory : null
    }
}

export function formatReadBatchItemLabel(item: ReadBatchItem): string {
    if (!item.directory) {
        return item.name
    }
    return `${item.name}: ${item.directory}`
}

export function getReadBatchItems(block: ToolCallBlock, metadata: SessionMetadataSummary | null): ReadBatchItem[] {
    const inputFiles = getInputFiles(block.tool.input)
    const childTools = block.children.filter((child): child is ToolCallBlock => child.kind === 'tool-call')
    const itemCount = Math.max(inputFiles.length, childTools.length)
    const items: ReadBatchItem[] = []

    for (let index = 0; index < itemCount; index += 1) {
        const child = childTools[index]
        const inputFile = inputFiles[index]
        const inputPath = typeof inputFile === 'string' && !isSedAddress(inputFile) ? inputFile : null
        const childPath = child ? extractReadLikeToolPath(child.tool) : null
        const file = childPath ?? inputPath ?? `Read command ${index + 1}`
        const display = getDisplayParts(file, metadata)

        items.push({
            file,
            ...display,
            content: child ? extractResultText(child.tool.result) : null,
            state: child?.tool.state ?? block.tool.state
        })
    }

    return items
}
