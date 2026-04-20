import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'

import type { ToolViewProps } from './_all'
import { buildClaudeEditedTextFilePatch, ClaudeEditedTextFileView } from './ClaudeEditedTextFileView'

function createProps(input: unknown): ToolViewProps {
    return {
        metadata: null,
        block: {
            kind: 'tool-call',
            id: 'tool-claude-edited',
            localId: null,
            createdAt: 0,
            tool: {
                id: 'tool-claude-edited',
                name: 'ClaudeEditedTextFile',
                state: 'completed',
                input,
                createdAt: 0,
                startedAt: 0,
                completedAt: 1,
                description: null,
                result: null
            },
            children: []
        }
    }
}

function collectRenderedText(node: ReactNode): string[] {
    if (typeof node === 'string' || typeof node === 'number') {
        return [String(node)]
    }

    if (Array.isArray(node)) {
        return node.flatMap((child) => collectRenderedText(child))
    }

    if (!isValidElement(node)) {
        return []
    }

    const props = node.props as { children?: ReactNode; code?: string }
    const texts = typeof props.code === 'string' ? [props.code] : []
    return texts.concat(collectRenderedText(props.children))
}

describe('ClaudeEditedTextFileView', () => {
    test('builds a patch preview from line-numbered snippets', () => {
        expect(buildClaudeEditedTextFilePatch({
            file_path: '/repo/src/app.ts',
            snippet: '12\tconst nextValue = 2\n13\treturn nextValue'
        })).toBe('@@ lines 12-13 @@\n+const nextValue = 2\n+return nextValue')
    })

    test('falls back to added lines when the snippet has no explicit line numbers', () => {
        expect(buildClaudeEditedTextFilePatch({
            file_path: '/repo/src/app.ts',
            snippet: 'const nextValue = 2\nreturn nextValue'
        })).toBe('+++ /repo/src/app.ts\n+const nextValue = 2\n+return nextValue')
    })

    test('renders the synthesized patch as a diff code block', () => {
        const rendered = ClaudeEditedTextFileView(createProps({
            file_path: '/repo/src/app.ts',
            snippet: '12\tconst nextValue = 2\n13\treturn nextValue'
        }))
        const text = collectRenderedText(rendered).join('\n')

        expect(text).toContain('@@ lines 12-13 @@')
        expect(text).toContain('+const nextValue = 2')
        expect(text).toContain('+return nextValue')
    })
})
