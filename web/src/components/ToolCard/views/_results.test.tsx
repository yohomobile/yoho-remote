import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { extractWebSearchDisplayData, extractYohoMemoryDisplayData, getToolResultViewComponent } from './_results'

describe('Tool result views', () => {
    test('extracts WebSearch query and action details', () => {
        const display = extractWebSearchDisplayData(
            {
                query: 'codex exec json'
            },
            {
                id: 'search-1',
                query: 'codex exec json',
                action: {
                    type: 'search',
                    queries: ['codex exec json', 'codex thread events']
                }
            }
        )

        expect(display).toEqual({
            query: 'codex exec json',
            actionLabel: 'Search',
            actionDetails: ['codex exec json', 'codex thread events']
        })
    })

    test('filters internal yoho gate fields from structured data', () => {
        const display = extractYohoMemoryDisplayData(JSON.stringify({
            answer: '## 可见答案',
            content: '可见内容',
            status: 'accepted',
            details: {
                source: 'recall',
                _yohoMemoryGate: {
                    kind: 'recall',
                    directUseAllowed: false
                }
            },
            _yohoConsumptionGate: {
                kind: 'recall',
                directUseAllowed: false
            }
        }), 'mcp__yoho-vault__recall')

        expect(display.markdownSections).toEqual([
            {
                key: 'answer',
                label: 'Answer',
                text: '## 可见答案'
            },
            {
                key: 'content',
                label: 'Content',
                text: '可见内容'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'accepted',
            details: {
                source: 'recall'
            }
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoMemoryGate')
    })

    test('renders CodexDiff results from result.diff payloads', () => {
        const unified = [
            'diff --git a/web/src/app.ts b/web/src/app.ts',
            '--- a/web/src/app.ts',
            '+++ b/web/src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new'
        ].join('\n')

        const View = getToolResultViewComponent('CodexDiff')
        const globalAny = globalThis as Record<string, unknown>
        const previousWindow = globalAny.window
        globalAny.window = {
            matchMedia: () => ({ matches: false }),
        }

        try {
            const html = renderToStaticMarkup(
                <View
                    block={{
                        kind: 'tool-call',
                        id: 'codex-diff-result',
                        localId: null,
                        createdAt: 1,
                        seq: null,
                        tool: {
                            id: 'codex-diff-result',
                            name: 'CodexDiff',
                            state: 'completed',
                            input: {},
                            createdAt: 1,
                            startedAt: 1,
                            completedAt: 2,
                            description: null,
                            result: { diff: unified },
                            parentUUID: null
                        },
                        children: [],
                        meta: undefined
                    }}
                    metadata={null}
                />
            )

            expect(html).toContain('web/src/app.ts')
            expect(html).toContain('old')
            expect(html).toContain('new')
            expect(html).not.toContain('"diff"')
        } finally {
            globalAny.window = previousWindow
        }
    })
})
