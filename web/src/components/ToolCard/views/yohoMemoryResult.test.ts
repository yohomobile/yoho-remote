import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { extractYohoMemoryDisplayData, getToolResultViewComponent, sanitizeYohoMemoryRawResult } from './_results'

function withWindowStub<T>(run: () => T): T {
    const globalWithWindow = globalThis as unknown as { window?: Window }
    const previousWindow = globalWithWindow.window
    globalWithWindow.window = {
        matchMedia: () => ({
            matches: false,
        } as MediaQueryList),
    } as unknown as Window

    try {
        return run()
    } finally {
        if (previousWindow === undefined) {
            globalWithWindow.window = undefined
        } else {
            globalWithWindow.window = previousWindow
        }
    }
}

describe('extractYohoMemoryDisplayData', () => {
    test('renders recall answer as markdown and keeps the rest as structured json', () => {
        const result = {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    answer: '## 搜索结果\n- 第一条\n- 第二条',
                    sources: ['memories/a.md', 'memories/b.md'],
                    keywords: ['yoho-remote', 'recall'],
                    filesSearched: 2
                })
            }]
        }

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'answer',
                label: 'Answer',
                text: '## 搜索结果\n- 第一条\n- 第二条'
            }
        ])
        expect(display.jsonValue).toEqual({
            sources: ['memories/a.md', 'memories/b.md'],
            keywords: ['yoho-remote', 'recall'],
            filesSearched: 2
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
    })

    test('renders remember message as markdown and pretty-prints remaining json', () => {
        const result = JSON.stringify({
            status: 'accepted',
            message: 'Memory save started in **background**.'
        })

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'message',
                label: 'Message',
                text: 'Memory save started in **background**.'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'accepted'
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
    })

    test('supports nested markdown fields for yoho memory results', () => {
        const result = {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    status: 'in_progress',
                    checks: '- 第一项\n- 第二项',
                    current_step: {
                        index: 2,
                        content: '**执行部署**：确认回滚步骤并上线'
                    }
                })
            }]
        }

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'checks',
                label: 'Checks',
                text: '- 第一项\n- 第二项'
            },
            {
                key: 'current_step.content',
                label: 'Current Step',
                text: '**执行部署**：确认回滚步骤并上线'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'in_progress',
            current_step: {
                index: 2
            }
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
    })

    test('does not expose internal gate fields in structured data', () => {
        const display = extractYohoMemoryDisplayData(JSON.stringify({
            answer: '## 可见答案',
            message: '可见消息',
            content: '可见内容',
            status: 'accepted',
            metadata: {
                source: 'memory',
                items: [
                    {
                        name: 'keep-me',
                        _yohoMemoryGate: {
                            kind: 'recall',
                            directUseAllowed: false
                        }
                    }
                ],
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
                key: 'message',
                label: 'Message',
                text: '可见消息'
            },
            {
                key: 'content',
                label: 'Content',
                text: '可见内容'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'accepted',
            metadata: {
                source: 'memory',
                items: [
                    {
                        name: 'keep-me'
                    }
                ]
            }
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoMemoryGate')
    })

    test('returns a visible sanitized consumption gate without leaking internal gate fields', () => {
        const display = extractYohoMemoryDisplayData(JSON.stringify({
            answer: '## 可用结果',
            filesSearched: 1,
            confidence: 0.9,
            isDirectlyUsable: true,
            scope: {
                matched: true,
            },
            _yohoConsumptionGate: {
                kind: 'recall',
                directUseAllowed: false,
            }
        }), 'mcp__yoho-vault__recall')

        expect(display.consumptionGate).toMatchObject({
            kind: 'recall',
            directUseAllowed: true,
            reason: 'recall 结果满足基础可靠性门槛',
        })
        expect(JSON.stringify(display.jsonValue)).not.toContain('_yohoConsumptionGate')
    })

    test('blocks skill_search direct use when scope does not match', () => {
        const display = extractYohoMemoryDisplayData(JSON.stringify({
            directUseAllowed: true,
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.95,
            scope: {
                matched: false,
            },
            results: [{ name: 'repo-review' }],
        }), 'mcp__yoho-vault__skill_search')

        expect(display.consumptionGate).toMatchObject({
            kind: 'skill_search',
            directUseAllowed: false,
        })
        expect(display.consumptionGate?.reason).toContain('scope.matched=false')
    })

    test('renders the consumption gate while hiding raw internal gate fields', () => {
        const View = getToolResultViewComponent('mcp__yoho-vault__skill_search')
        const html = withWindowStub(() => renderToStaticMarkup(createElement(View, {
            block: {
                kind: 'tool-call',
                id: 'tool-1',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                    id: 'tool-1',
                    name: 'mcp__yoho-vault__skill_search',
                    state: 'completed',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 1,
                    description: null,
                    parentUUID: null,
                    result: JSON.stringify({
                        directUseAllowed: false,
                        suggestedNextAction: 'use_results',
                        hasLocalMatch: true,
                        confidence: 0.95,
                        _yohoConsumptionGate: {
                            kind: 'skill_search',
                        },
                    }),
                },
            },
            metadata: null,
        } as any)))

        expect(html).toContain('Direct use blocked')
        expect(html).toContain('directUseAllowed=false')
        expect(html).not.toContain('_yohoConsumptionGate')
    })

    test('sanitizes raw JSON string payloads without leaking gate fields', () => {
        const raw = JSON.stringify({
            answer: '## 可见答案',
            content: '可见内容',
            value: '可见值',
            summary: '可见摘要',
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.9,
            _yohoConsumptionGate: {
                kind: 'skill_search',
                directUseAllowed: false,
            },
        })

        const sanitized = sanitizeYohoMemoryRawResult(raw)

        expect(sanitized).toEqual({
            answer: '## 可见答案',
            content: '可见内容',
            value: '可见值',
            summary: '可见摘要',
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.9,
        })
        expect(JSON.stringify(sanitized)).not.toContain('_yohoConsumptionGate')
    })

    test('renders gate-only results as a gate card instead of raw JSON', () => {
        const View = getToolResultViewComponent('mcp__yoho-vault__skill_search')
        const html = withWindowStub(() => renderToStaticMarkup(createElement(View, {
            block: {
                kind: 'tool-call',
                id: 'tool-gate-only',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                    id: 'tool-gate-only',
                    name: 'mcp__yoho-vault__skill_search',
                    state: 'completed',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 1,
                    description: null,
                    parentUUID: null,
                    result: JSON.stringify({
                        _yohoConsumptionGate: {
                            kind: 'skill_search',
                            directUseAllowed: false,
                            reason: 'blocked by server gate'
                        }
                    }),
                },
            },
            metadata: null,
        } as any)))

        expect(html).toContain('Direct use blocked')
        expect(html).toContain('结果仅包含内部门控信息')
        expect(html).not.toContain('_yohoConsumptionGate')
    })

    test('redacts unparseable sensitive JSON strings conservatively', () => {
        const View = getToolResultViewComponent('mcp__yoho-vault__skill_search')
        const html = withWindowStub(() => renderToStaticMarkup(createElement(View, {
            block: {
                kind: 'tool-call',
                id: 'tool-bad-json',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                    id: 'tool-bad-json',
                    name: 'mcp__yoho-vault__skill_search',
                    state: 'completed',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 1,
                    description: null,
                    parentUUID: null,
                    result: '{"_yohoConsumptionGate":',
                },
            },
            metadata: null,
        } as any)))

        expect(html).toContain('结果包含内部门控信息，已隐藏原始 JSON')
        expect(html).not.toContain('_yohoConsumptionGate')
    })
})
