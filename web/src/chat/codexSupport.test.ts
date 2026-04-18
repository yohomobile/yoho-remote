import { describe, expect, test } from 'bun:test'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { getToolPresentation } from '../components/ToolCard/knownTools'
import type { NormalizedMessage } from './types'
import type { DecryptedMessage } from '../types/api'

function makeMessage(props: {
    id: string
    createdAt: number
    content: unknown
}): DecryptedMessage {
    return {
        id: props.id,
        seq: null,
        localId: null,
        content: props.content,
        createdAt: props.createdAt
    }
}

function normalize(message: DecryptedMessage): NormalizedMessage[] {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized) return []
    return Array.isArray(normalized) ? normalized : [normalized]
}

describe('Codex frontend support', () => {
    test('marks non-zero Codex tool results as error blocks', () => {
        const normalized = [
            ...normalize(makeMessage({
                id: 'tool-call',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'call-1',
                            name: 'CodexBash',
                            input: { command: 'bun typecheck' },
                            id: 'tool-call-item'
                        }
                    }
                }
            })),
            ...normalize(makeMessage({
                id: 'tool-result',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call-1',
                            output: {
                                command: 'bun typecheck',
                                exit_code: 127
                            },
                            id: 'tool-result-item'
                        }
                    }
                }
            }))
        ]

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block.kind).toBe('tool-call')
        if (block.kind !== 'tool-call') {
            throw new Error('Expected tool-call block')
        }
        expect(block.tool.state).toBe('error')
        expect(block.tool.result).toEqual({
            command: 'bun typecheck',
            exit_code: 127
        })
    })

    test('treats declined Codex tool results as error blocks', () => {
        const normalized = [
            ...normalize(makeMessage({
                id: 'tool-call-declined',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'call-declined',
                            name: 'CodexBash',
                            input: { command: 'rm -rf /tmp/demo' },
                            id: 'tool-call-declined-item'
                        }
                    }
                }
            })),
            ...normalize(makeMessage({
                id: 'tool-result-declined',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call-declined',
                            output: {
                                command: 'rm -rf /tmp/demo',
                                status: 'declined'
                            },
                            id: 'tool-result-declined-item'
                        }
                    }
                }
            }))
        ]

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block.kind).toBe('tool-call')
        if (block.kind !== 'tool-call') {
            throw new Error('Expected tool-call block')
        }
        expect(block.tool.state).toBe('error')
        expect(block.tool.result).toEqual({
            command: 'rm -rf /tmp/demo',
            status: 'declined'
        })
    })

    test('normalizes Codex notices into timeline events', () => {
        const normalized = normalize(makeMessage({
            id: 'codex-notice',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'notice',
                        level: 'warning',
                        source: 'item',
                        message: 'model rerouted: gpt-5 -> gpt-5-mini',
                        id: 'codex-notice-item'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'message',
                message: 'Notice: model rerouted: gpt-5 -> gpt-5-mini'
            }
        })
    })

    test('uses Codex token_count context-window usage without rendering a timeline event', () => {
        const normalized = normalize(makeMessage({
            id: 'token-count',
            createdAt: 100,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        info: {
                            total_token_usage: {
                                total_tokens: 456_789,
                                input_tokens: 400_000,
                                output_tokens: 56_789,
                                reasoning_output_tokens: 1_234
                            },
                            last_token_usage: {
                                total_tokens: 123_456,
                                input_tokens: 120_000,
                                output_tokens: 3_456,
                                reasoning_output_tokens: 789
                            },
                            model_context_window: 950_000
                        },
                        rate_limits: {
                            primary: {
                                used_percent: 65
                            }
                        },
                        id: 'token-count-item'
                    }
                }
            }
        }))

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.inputTokens).toBe(123_456)
        expect(reduced.latestUsage?.outputTokens).toBe(3_456)
        expect(reduced.latestUsage?.contextSize).toBe(123_456)
        expect(reduced.latestUsage?.modelContextWindow).toBe(950_000)
        expect(reduced.latestUsage?.reasoningOutputTokens).toBe(789)
        expect(reduced.latestUsage?.rateLimitUsedPercent).toBe(65)
    })

    test('does not treat legacy Codex exec usage totals as current context size', () => {
        const normalized = normalize(makeMessage({
            id: 'legacy-token-count',
            createdAt: 101,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        info: {
                            input_tokens: 10_970_000,
                            output_tokens: 789
                        },
                        id: 'legacy-token-count-item'
                    }
                }
            }
        }))

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.inputTokens).toBe(10_970_000)
        expect(reduced.latestUsage?.contextSize).toBeUndefined()
        expect(reduced.latestUsage?.modelContextWindow).toBeUndefined()
    })

    test('token_count reset clears older Codex context usage', () => {
        const normalized = [
            ...normalize(makeMessage({
                id: 'token-count-before-reset',
                createdAt: 100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'token_count',
                            info: {
                                total_token_usage: {
                                    total_tokens: 456_789,
                                    input_tokens: 400_000,
                                    output_tokens: 56_789
                                },
                                last_token_usage: {
                                    total_tokens: 123_456,
                                    input_tokens: 120_000,
                                    output_tokens: 3_456
                                },
                                model_context_window: 950_000
                            },
                            id: 'token-count-before-reset-item'
                        }
                    }
                }
            })),
            ...normalize(makeMessage({
                id: 'token-count-reset',
                createdAt: 101,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'token_count',
                            info: null,
                            id: 'token-count-reset-item'
                        }
                    }
                }
            }))
        ]

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.latestUsage).toBeNull()
    })

    test('preserves zero-value Codex token_count updates for compact turns', () => {
        const normalized = normalize(makeMessage({
            id: 'token-count-zero',
            createdAt: 102,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        info: {
                            total_token_usage: {
                                total_tokens: 0,
                                input_tokens: 0,
                                output_tokens: 0
                            },
                            last_token_usage: {
                                total_tokens: 0,
                                input_tokens: 0,
                                output_tokens: 0
                            },
                            model_context_window: 950_000
                        },
                        id: 'token-count-zero-item'
                    }
                }
            }
        }))

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.contextSize).toBe(0)
        expect(reduced.latestUsage?.modelContextWindow).toBe(950_000)
    })

    test('renders Codex plan messages as assistant text instead of dropping them', () => {
        const normalized = normalize(makeMessage({
            id: 'plan-message',
            createdAt: 100,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'plan',
                        entries: [
                            { content: 'Inspect the repo', priority: 'high', status: 'completed' },
                            { content: 'Patch the UI', priority: 'medium', status: 'in_progress' }
                        ]
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]?.role).toBe('agent')
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text'
        })
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Plan')
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Inspect the repo')
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Patch the UI')
    })

    test('renders Codex error messages as visible timeline events', () => {
        const normalized = normalize(makeMessage({
            id: 'error-message',
            createdAt: 101,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'error',
                        message: 'Tool chain exploded'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'message',
                message: 'Error: Tool chain exploded'
            }
        })
    })

    test('prefers Claude assistant usage over cumulative session-result usage', () => {
        const normalized: NormalizedMessage[] = [
            {
                id: 'assistant-usage',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Done',
                    uuid: 'assistant-usage',
                    parentUUID: null
                }],
                usage: {
                    input_tokens: 6,
                    output_tokens: 200,
                    cache_creation_input_tokens: 4_972,
                    cache_read_input_tokens: 806_111
                }
            },
            {
                id: 'session-result',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'session-result',
                    durationMs: 1234,
                    numTurns: 1,
                    isError: false
                },
                usage: {
                    input_tokens: 120_000,
                    output_tokens: 400,
                    cache_creation_input_tokens: 40_000,
                    cache_read_input_tokens: 5_200_000
                }
            }
        ]

        const reduced = reduceChatBlocks(normalized, null)

        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.inputTokens).toBe(6)
        expect(reduced.latestUsage?.cacheCreation).toBe(4_972)
        expect(reduced.latestUsage?.cacheRead).toBe(806_111)
        expect(reduced.latestUsage?.contextSize).toBe(811_089)
    })

    test('does not use cumulative session-result usage for context percentage', () => {
        const normalized: NormalizedMessage[] = [{
            id: 'session-result-only',
            localId: null,
            createdAt: 2,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'session-result',
                durationMs: 1234,
                numTurns: 1,
                isError: false
            },
            usage: {
                input_tokens: 6,
                output_tokens: 200,
                cache_creation_input_tokens: 4_972,
                cache_read_input_tokens: 806_111
            }
        }]

        const reduced = reduceChatBlocks(normalized, null)

        // session-result usage is cumulative across all turns — using it for
        // context percentage would produce wildly inflated values (e.g. 13162%)
        expect(reduced.latestUsage).toBeNull()
    })

    test('falls back to raw JSON for unknown Claude output types instead of dropping them', () => {
        const normalized = normalize(makeMessage({
            id: 'unknown-claude-output',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'future_claude_message',
                        foo: 'bar'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]?.role).toBe('agent')
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text'
        })
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('future_claude_message')
    })

    test('suppresses Claude last-prompt metadata messages', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-last-prompt',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'last-prompt',
                        lastPrompt: 'say lol'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(0)
    })

    test('suppresses Claude attachment metadata messages like skill listings', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-skill-listing',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'skill_listing',
                            content: '- test-skill'
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(0)
    })

    test('renders Claude plan_mode attachments as visible plan events', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-plan-mode',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'plan_mode',
                            planFilePath: '/tmp/demo-plan.md',
                            planExists: false
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'plan-mode',
                planFilePath: '/tmp/demo-plan.md',
                planExists: false
            }
        })
    })

    test('renders non-empty Claude todo_reminder attachments as structured events', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-todo-reminder',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'todo_reminder',
                            itemCount: 2,
                            content: [
                                {
                                    content: 'Inspect the repo',
                                    status: 'completed'
                                },
                                {
                                    content: 'Patch the UI',
                                    status: 'in_progress',
                                    activeForm: 'Patching the UI'
                                }
                            ]
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'todo-reminder',
                itemCount: 2,
                completedCount: 1,
                inProgressCount: 1,
                pendingCount: 0
            }
        })

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'agent-event',
            event: {
                type: 'todo-reminder'
            }
        })
    })

    test('suppresses empty Claude todo_reminder attachments', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-empty-todo-reminder',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'todo_reminder',
                            itemCount: 0,
                            content: []
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(0)
    })

    test('renders Claude plan_file_reference attachments as visible plan file events', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-plan-file',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'plan_file_reference',
                            planFilePath: '/tmp/demo-plan.md',
                            planContent: '# Demo Plan'
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'plan-file',
                planFilePath: '/tmp/demo-plan.md',
                planContent: '# Demo Plan'
            }
        })
    })

    test('renders Claude queued_command task notifications as task events instead of raw JSON', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-queued-command-task',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'queued_command',
                            commandMode: 'task-notification',
                            prompt: '<task-notification><task-id>task-1</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status><summary>Background command completed</summary></task-notification>'
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'task-notification',
                taskId: 'task-1',
                toolUseId: 'tool-1',
                status: 'completed',
                summary: 'Background command completed'
            }
        })
    })

    test('renders Claude microcompact boundary messages as compact events', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-microcompact',
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'system',
                        subtype: 'microcompact_boundary',
                        content: 'Context microcompacted'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'compact-boundary'
            }
        })
    })

    test('renders Claude local_command messages as cli output instead of raw JSON', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-local-command',
            createdAt: 3,
            content: {
                role: 'agent',
                meta: {
                    sentFrom: 'cli'
                },
                content: {
                    type: 'output',
                    data: {
                        type: 'system',
                        subtype: 'local_command',
                        content: '<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'cli-output',
            source: 'assistant'
        })
    })

    test('renders Claude user content arrays as user messages instead of assistant text', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-user-array',
            createdAt: 4,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'say lol' }
                            ]
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'user',
            content: {
                type: 'text',
                text: 'say lol'
            }
        })

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'user-text',
            text: 'say lol'
        })
    })

    test('falls back to raw text when Claude assistant content blocks are unknown', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-assistant-unknown-block',
            createdAt: 5,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'future_block', foo: 'bar' }
                            ]
                        }
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]?.role).toBe('agent')
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text'
        })
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('future_block')
    })

    test('formats yoho namespaced tools with MCP-style titles and useful subtitles', () => {
        const presentation = getToolPresentation({
            toolName: 'yoho_memory__recall',
            input: {
                input: 'Yoho Remote Codex 前端支持'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.title).toBe('MCP: Yoho Memory Recall')
        expect(presentation.subtitle).toBe('Yoho Remote Codex 前端支持')
        expect(presentation.minimal).toBe(true)
    })

    test('keeps distinct tool_result blocks when toolUseResult is present', () => {
        const normalized = normalize(makeMessage({
            id: 'tool-results',
            createdAt: 500,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'result-1'
                                },
                                {
                                    type: 'tool_result',
                                    tool_use_id: 'tool-2',
                                    content: 'result-2'
                                }
                            ]
                        },
                        toolUseResult: 'shared-cache'
                    }
                }
            }
        }))

        const reduced = reduceChatBlocks(normalized, null)
        const toolBlocks = reduced.blocks.filter((block) => block.kind === 'tool-call')
        expect(toolBlocks).toHaveLength(2)
        expect(toolBlocks.map((block) => block.kind === 'tool-call' ? block.tool.result : null)).toEqual([
            'result-1',
            'result-2'
        ])
    })
})
