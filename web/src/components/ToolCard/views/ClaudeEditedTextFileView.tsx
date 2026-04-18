import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getSnippet(input: unknown): string | null {
    if (!isObject(input)) return null
    const snippet = input.snippet
    return typeof snippet === 'string' && snippet.trim().length > 0 ? snippet : null
}

export function ClaudeEditedTextFileView(props: ToolViewProps) {
    const snippet = getSnippet(props.block.tool.input)
    if (!snippet) {
        return null
    }

    return <CodeBlock code={snippet} language="text" />
}
