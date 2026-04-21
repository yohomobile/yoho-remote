import { describe, expect, test } from 'bun:test'
import { reduceChatBlocks } from './reducer'
import { renderEventLabel } from './presentation'
import type { NormalizedMessage } from './types'

describe('reduceChatBlocks duplicate handling', () => {
    test('wraps even a single read tool in a ReadBatch block', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'read-call',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-1',
                    name: 'Read',
                    input: { file_path: 'README.md' },
                    description: null,
                    uuid: 'read-call',
                    parentUUID: null
                }]
            },
            {
                id: 'read-result',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-1',
                    content: {
                        file: {
                            filePath: 'README.md',
                            content: '# Hello'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result',
                    parentUUID: null
                }]
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block?.kind).toBe('tool-call')
        if (!block || block.kind !== 'tool-call') {
            throw new Error('Expected ReadBatch block')
        }
        expect(block.tool.name).toBe('ReadBatch')
        expect(block.children).toHaveLength(1)
        expect(block.children[0]?.kind).toBe('tool-call')
        if (block.children[0]?.kind !== 'tool-call') {
            throw new Error('Expected nested read tool')
        }
        expect(block.children[0].tool.name).toBe('Read')
        expect(block.children[0].tool.result).toEqual({
            file: {
                filePath: 'README.md',
                content: '# Hello'
            }
        })
    })

    test('groups consecutive read-like tools into a single ReadBatch until another block breaks the run', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'read-call-1',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-1',
                    name: 'Read',
                    input: { file_path: 'README.md' },
                    description: null,
                    uuid: 'read-call-1',
                    parentUUID: null
                }]
            },
            {
                id: 'read-call-2',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-2',
                    name: 'CodexBash',
                    input: {
                        command: 'sed -n \"1,20p\" web/src/app.ts',
                        parsed_cmd: [{
                            type: 'read',
                            name: 'web/src/app.ts'
                        }]
                    },
                    description: null,
                    uuid: 'read-call-2',
                    parentUUID: null
                }]
            },
            {
                id: 'read-result-2',
                localId: null,
                createdAt: 3,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-2',
                    content: {
                        output: 'const app = true'
                    },
                    is_error: false,
                    uuid: 'read-result-2',
                    parentUUID: null
                }]
            },
            {
                id: 'event-between',
                localId: null,
                createdAt: 4,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: 'Scanning complete'
                }
            },
            {
                id: 'read-call-3',
                localId: null,
                createdAt: 5,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-3',
                    name: 'NotebookRead',
                    input: { notebook_path: 'notes.ipynb' },
                    description: null,
                    uuid: 'read-call-3',
                    parentUUID: null
                }]
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks.map((block) => block.kind)).toEqual(['tool-call', 'agent-event', 'tool-call'])

        const first = reduced.blocks[0]
        const second = reduced.blocks[2]
        if (!first || first.kind !== 'tool-call' || !second || second.kind !== 'tool-call') {
            throw new Error('Expected ReadBatch blocks')
        }

        expect(first.tool.name).toBe('ReadBatch')
        expect(first.children).toHaveLength(2)
        expect(first.children.map((child) => child.kind === 'tool-call' ? child.tool.name : null)).toEqual(['Read', 'CodexBash'])
        expect(first.tool.input).toEqual({
            count: 2,
            files: ['README.md', 'web/src/app.ts']
        })

        expect(second.tool.name).toBe('ReadBatch')
        expect(second.children).toHaveLength(1)
        expect(second.tool.input).toEqual({
            count: 1,
            files: ['notes.ipynb']
        })
    })

    test('dedupes webapp user message and Claude cli echo with the same text', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'user-webapp',
                localId: 'local-1',
                createdAt: 1,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'fix the bug' },
                meta: { sentFrom: 'webapp' }
            },
            {
                id: 'user-cli-echo',
                localId: null,
                createdAt: 2,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'fix the bug' },
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const userBlocks = reduced.blocks.filter((block) => block.kind === 'user-text')
        expect(userBlocks).toHaveLength(1)
        expect(userBlocks[0]?.kind === 'user-text' ? userBlocks[0].text : '').toBe('fix the bug')
        expect(userBlocks[0]?.kind === 'user-text' ? userBlocks[0].localId : null).toBe('local-1')
    })

    test('dedupes Claude cli user echo even when an event is interleaved', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'user-webapp',
                localId: 'local-1',
                createdAt: 1,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'fix the bug' },
                meta: { sentFrom: 'webapp' }
            },
            {
                id: 'event-between',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: { type: 'message', message: 'Working...' }
            },
            {
                id: 'user-cli-echo',
                localId: null,
                createdAt: 3,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'fix the bug' },
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const userBlocks = reduced.blocks.filter((block) => block.kind === 'user-text')
        expect(userBlocks).toHaveLength(1)
        expect(userBlocks[0]?.kind === 'user-text' ? userBlocks[0].localId : null).toBe('local-1')
    })

    test('replaces cumulative Claude assistant text instead of duplicating prefixes', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'assistant-a',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello',
                    uuid: 'claude-msg-1',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'assistant-b',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello world',
                    uuid: 'claude-msg-2',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const agentBlocks = reduced.blocks.filter((block) => block.kind === 'agent-text')
        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0]?.kind === 'agent-text' ? agentBlocks[0].text : '').toBe('Hello world')
    })

    test('replaces cumulative Claude assistant text when an event is interleaved', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'assistant-a',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello',
                    uuid: 'claude-msg-1',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'event-between',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: { type: 'message', message: 'Working...' }
            },
            {
                id: 'assistant-b',
                localId: null,
                createdAt: 3,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello world',
                    uuid: 'claude-msg-2',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks.map((block) => block.kind)).toEqual(['agent-event', 'agent-text'])
        const agentBlocks = reduced.blocks.filter((block) => block.kind === 'agent-text')
        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0]?.kind === 'agent-text' ? agentBlocks[0].text : '').toBe('Hello world')
    })

    test('drops identical consecutive Claude assistant text duplicates', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'assistant-a',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Done',
                    uuid: 'claude-msg-1',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'assistant-b',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Done',
                    uuid: 'claude-msg-2',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const agentBlocks = reduced.blocks.filter((block) => block.kind === 'agent-text')
        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0]?.kind === 'agent-text' ? agentBlocks[0].text : '').toBe('Done')
    })

    test('orders reasoning deltas by seq and drops duplicates for the same reasoning id', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'reasoning-late',
                seq: 2,
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'reasoning',
                    text: 'Hello world',
                    uuid: 'reasoning-1',
                    parentUUID: 'parent-1'
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'reasoning-early',
                seq: 1,
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'reasoning',
                    text: 'Hello',
                    uuid: 'reasoning-1',
                    parentUUID: 'parent-1',
                    isDelta: true
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'reasoning-dup',
                seq: 1,
                localId: null,
                createdAt: 3,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'reasoning',
                    text: 'Hello',
                    uuid: 'reasoning-1',
                    parentUUID: 'parent-1',
                    isDelta: true
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const reasoningBlocks = reduced.blocks.filter((block) => block.kind === 'agent-reasoning')
        expect(reasoningBlocks).toHaveLength(1)
        expect(reasoningBlocks[0]?.kind === 'agent-reasoning' ? reasoningBlocks[0].text : '').toBe('Hello world')
        expect(reasoningBlocks[0]?.kind === 'agent-reasoning' ? reasoningBlocks[0].isDelta : null).toBe(false)
    })

    test('does not merge reasoning deltas with different reasoning ids', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'reasoning-a',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'reasoning',
                    text: 'First',
                    uuid: 'reasoning-1',
                    parentUUID: null,
                    isDelta: true
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'reasoning-b',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'reasoning',
                    text: 'Second',
                    uuid: 'reasoning-2',
                    parentUUID: null,
                    isDelta: true
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const reasoningBlocks = reduced.blocks.filter((block) => block.kind === 'agent-reasoning')
        expect(reasoningBlocks).toHaveLength(2)
        expect(reasoningBlocks.map((block) => block.kind === 'agent-reasoning' ? block.text : null))
            .toEqual(['First', 'Second'])
    })

    test('merges assistant text blocks when the base id contains colons', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'turn:foo:0',
                seq: 1,
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello',
                    uuid: 'turn-foo',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'turn:foo:1',
                seq: 2,
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Hello world',
                    uuid: 'turn-foo',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            }
        ] satisfies NormalizedMessage[], null)

        const agentBlocks = reduced.blocks.filter((block) => block.kind === 'agent-text')
        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0]?.kind === 'agent-text' ? agentBlocks[0].text : '').toBe('Hello world')
    })

    test('converts assistant summary content into a visible event block', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'summary-msg',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'summary',
                    summary: '已完成文本摘要',
                }],
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block?.kind).toBe('agent-event')
        if (!block || block.kind !== 'agent-event') {
            throw new Error('Expected summary to become an agent-event block')
        }
        expect(block.event).toEqual({
            type: 'message',
            message: '已完成文本摘要',
        })
        expect(renderEventLabel(block.event)).toBe('已完成文本摘要')
    })

    test('merges tool-result into the matching tool-call block', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'tool-call-message',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Write',
                    input: { path: 'README.md' },
                    description: null,
                    uuid: 'tool-call-message',
                    parentUUID: 'parent-1',
                }],
            },
            {
                id: 'tool-result-message',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: {
                        file: {
                            filePath: 'README.md',
                            content: '# Hello',
                        },
                    },
                    is_error: false,
                    uuid: 'tool-result-message',
                    parentUUID: 'parent-1',
                }],
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block?.kind).toBe('tool-call')
        if (!block || block.kind !== 'tool-call') {
            throw new Error('Expected merged tool-call block')
        }
        expect(block.tool).toMatchObject({
            id: 'tool-1',
            name: 'Write',
            state: 'completed',
            input: { path: 'README.md' },
            result: {
                file: {
                    filePath: 'README.md',
                    content: '# Hello',
                },
            },
        })
        expect(block.tool.startedAt).toBe(1)
        expect(block.tool.completedAt).toBe(2)
        expect(block.children).toHaveLength(0)
    })

    test('preserves task_notification summary when folding into task_started', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'task-started',
                localId: null,
                createdAt: 1,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-started',
                    taskId: 'task-1',
                    toolUseId: 'monitor-1',
                    description: 'watch logs'
                }
            },
            {
                id: 'task-completed',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-notification',
                    taskId: 'task-1',
                    toolUseId: 'monitor-1',
                    status: 'completed',
                    summary: '日志监控结束，发现端口已恢复'
                }
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block?.kind).toBe('agent-event')
        if (!block || block.kind !== 'agent-event') {
            throw new Error('Expected merged agent-event block')
        }
        expect(block.event).toMatchObject({
            type: 'task-started',
            taskId: 'task-1',
            toolUseId: 'monitor-1',
            status: 'completed',
            summary: '日志监控结束，发现端口已恢复'
        })
        expect(renderEventLabel(block.event)).toBe('日志监控结束，发现端口已恢复')
    })

    test('keeps standalone task_notification when no matching task_started exists', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'task-completed',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-notification',
                    taskId: 'task-2',
                    toolUseId: 'monitor-2',
                    status: 'completed',
                    summary: '后台命令已完成'
                }
            }
        ] satisfies NormalizedMessage[], null)

        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block?.kind).toBe('agent-event')
        if (!block || block.kind !== 'agent-event') {
            throw new Error('Expected task-notification block to be preserved')
        }
        expect(block.event).toMatchObject({
            type: 'task-notification',
            taskId: 'task-2',
            toolUseId: 'monitor-2',
            status: 'completed',
            summary: '后台命令已完成'
        })
        expect(renderEventLabel(block.event)).toBe('后台命令已完成')
    })
})
