import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'

import type { ToolViewProps } from './_all'
import { CodexPatchCompactView, CodexPatchView, shouldRenderCodexPatchEntryTitle } from './CodexPatchView'

function createProps(result: unknown): ToolViewProps {
    return {
        metadata: null,
        block: {
            kind: 'tool-call',
            id: 'tool-1',
            localId: null,
            createdAt: 0,
            tool: {
                id: 'tool-1',
                name: 'CodexPatch',
                state: 'completed',
                input: { file_path: '/repo/src/app.ts' },
                createdAt: 0,
                startedAt: 0,
                completedAt: 1,
                description: null,
                result
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

describe('CodexPatchView', () => {
    test('hides redundant single-file titles when code content is already shown', () => {
        expect(shouldRenderCodexPatchEntryTitle(true, 1, true)).toBe(false)
        expect(shouldRenderCodexPatchEntryTitle(false, 1, true)).toBe(false)
    })

    test('keeps file titles when they still carry structure', () => {
        expect(shouldRenderCodexPatchEntryTitle(false, 2, true)).toBe(true)
        expect(shouldRenderCodexPatchEntryTitle(false, 1, false)).toBe(true)
    })

    test('omits the duplicate file title for a single rendered diff', () => {
        const rendered = CodexPatchView(createProps({
            file_path: '/repo/src/app.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n'
        }))
        const text = collectRenderedText(rendered).join('\n')

        expect(text).not.toContain('app.ts')
        expect(text).toContain('@@ -1 +1 @@')
    })

    test('keeps file titles when the full view contains multiple files', () => {
        const rendered = CodexPatchView(createProps({
            changes: [
                {
                    path: '/repo/src/app.ts',
                    unified_diff: '@@ -1 +1 @@\n-old\n+new\n'
                },
                {
                    path: '/repo/src/utils.ts',
                    unified_diff: '@@ -1 +1 @@\n-before\n+after\n'
                }
            ]
        }))
        const text = collectRenderedText(rendered).join('\n')

        expect(text).toContain('app.ts')
        expect(text).toContain('utils.ts')
    })

    test('shows file names in compact preview for multi-file patches without inline diffs', () => {
        const rendered = CodexPatchCompactView({
            ...createProps(null),
            block: {
                ...createProps(null).block,
                tool: {
                    ...createProps(null).block.tool,
                    input: {
                        changes: {
                            '/repo/src/app.ts': { kind: 'update' },
                            '/repo/src/utils.ts': { kind: 'update' },
                            '/repo/src/state.ts': { kind: 'update' },
                            '/repo/src/view.ts': { kind: 'update' }
                        }
                    }
                }
            }
        })
        const text = collectRenderedText(rendered).join('\n')
        const normalizedText = text.replace(/\s+/g, ' ')

        expect(text).toContain('app.ts')
        expect(text).toContain('utils.ts')
        expect(text).toContain('state.ts')
        expect(normalizedText).toContain('(+ 1 more files)')
    })

    test('shows the file name in compact preview for a single-file patch without inline diff', () => {
        const rendered = CodexPatchCompactView({
            ...createProps(null),
            block: {
                ...createProps(null).block,
                tool: {
                    ...createProps(null).block.tool,
                    input: {
                        changes: {
                            '/repo/src/app.ts': { kind: 'update' }
                        }
                    }
                }
            }
        })
        const text = collectRenderedText(rendered).join('\n')

        expect(text).toContain('app.ts')
    })
})
