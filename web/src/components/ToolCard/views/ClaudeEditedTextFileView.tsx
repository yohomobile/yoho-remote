import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getFilePath(input: unknown): string | null {
    if (!isObject(input)) return null
    const filePath = input.file_path
    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath.trim() : null
}

function getSnippet(input: unknown): string | null {
    if (!isObject(input)) return null
    const snippet = input.snippet
    return typeof snippet === 'string' && snippet.trim().length > 0 ? snippet : null
}

function parseLineNumberedSnippetLine(line: string): { lineNumber: number; text: string } | null {
    const match = line.match(/^(\d+)\t([\s\S]*)$/)
    if (!match) {
        return null
    }

    return {
        lineNumber: Number.parseInt(match[1], 10),
        text: match[2]
    }
}

function formatPatchHeader(lineNumbers: number[]): string | null {
    if (lineNumbers.length === 0) {
        return null
    }

    if (lineNumbers.length === 1) {
        return `@@ line ${lineNumbers[0]} @@`
    }

    const isContiguous = lineNumbers.every((lineNumber, index) => index === 0 || lineNumber === lineNumbers[index - 1] + 1)
    if (isContiguous) {
        return `@@ lines ${lineNumbers[0]}-${lineNumbers[lineNumbers.length - 1]} @@`
    }

    return `@@ lines ${lineNumbers.join(', ')} @@`
}

export function buildClaudeEditedTextFilePatch(input: unknown): string | null {
    const snippet = getSnippet(input)
    if (!snippet) {
        return null
    }

    const lines = snippet.split('\n')
    const parsedLines = lines.map(parseLineNumberedSnippetLine)
    const hasLineNumbers = parsedLines.every((line) => line !== null)
    const patchLines: string[] = []

    if (hasLineNumbers) {
        const lineNumbers = parsedLines.map((line) => line!.lineNumber)
        const header = formatPatchHeader(lineNumbers)
        if (header) {
            patchLines.push(header)
        }
        patchLines.push(...parsedLines.map((line) => `+${line!.text}`))
        return patchLines.join('\n')
    }

    patchLines.push(...lines.map((line) => `+${line}`))

    const filePath = getFilePath(input)
    if (filePath) {
        patchLines.unshift(`+++ ${filePath}`)
    }

    return patchLines.join('\n')
}

export function ClaudeEditedTextFileView(props: ToolViewProps) {
    const patch = buildClaudeEditedTextFilePatch(props.block.tool.input)
    if (!patch) {
        return null
    }

    return <CodeBlock code={patch} language="diff" />
}
