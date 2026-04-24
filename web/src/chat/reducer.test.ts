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

    test('groups Claude-style chained reads even when parentUUID changes across tool-result hops', () => {
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
                    input: { file_path: 'worker/src/boss.ts' },
                    description: null,
                    uuid: 'read-call-1',
                    parentUUID: null
                }]
            },
            {
                id: 'read-result-1',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-1',
                    content: {
                        file: {
                            filePath: 'worker/src/boss.ts',
                            content: 'export const boss = true'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result-1',
                    parentUUID: 'read-call-1'
                }]
            },
            {
                id: 'read-call-2',
                localId: null,
                createdAt: 3,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-2',
                    name: 'Read',
                    input: { file_path: 'worker/src/jobs/aiTask.ts' },
                    description: null,
                    uuid: 'read-call-2',
                    parentUUID: 'read-result-1'
                }]
            },
            {
                id: 'read-result-2',
                localId: null,
                createdAt: 4,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-2',
                    content: {
                        file: {
                            filePath: 'worker/src/jobs/aiTask.ts',
                            content: 'export const run = true'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result-2',
                    parentUUID: 'read-call-2'
                }]
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
                    name: 'Read',
                    input: { file_path: 'worker/src/handlers/aiTask.ts' },
                    description: null,
                    uuid: 'read-call-3',
                    parentUUID: 'read-result-2'
                }]
            },
            {
                id: 'read-result-3',
                localId: null,
                createdAt: 6,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-3',
                    content: {
                        file: {
                            filePath: 'worker/src/handlers/aiTask.ts',
                            content: 'export const handle = true'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result-3',
                    parentUUID: 'read-call-3'
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
        expect(block.children).toHaveLength(3)
        expect(block.tool.input).toEqual({
            count: 3,
            files: [
                'worker/src/boss.ts',
                'worker/src/jobs/aiTask.ts',
                'worker/src/handlers/aiTask.ts'
            ]
        })
    })

    test('groups file-scoped grep and bash grep tools into the same read batch', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'grep-call-1',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'grep-1',
                    name: 'Grep',
                    input: {
                        pattern: 'message-added',
                        path: 'web/src/hooks/useSSE.ts',
                        output_mode: 'content'
                    },
                    description: null,
                    uuid: 'grep-call-1',
                    parentUUID: null
                }]
            },
            {
                id: 'grep-result-1',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'grep-1',
                    content: {
                        stdout: '120: message-added'
                    },
                    is_error: false,
                    uuid: 'grep-result-1',
                    parentUUID: null
                }]
            },
            {
                id: 'read-call-1',
                localId: null,
                createdAt: 3,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-1',
                    name: 'Read',
                    input: { file_path: 'web/src/hooks/useSSE.ts' },
                    description: null,
                    uuid: 'read-call-1',
                    parentUUID: null
                }]
            },
            {
                id: 'read-result-1',
                localId: null,
                createdAt: 4,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-1',
                    content: {
                        file: {
                            filePath: 'web/src/hooks/useSSE.ts',
                            content: 'export function useSSE() {}'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result-1',
                    parentUUID: null
                }]
            },
            {
                id: 'grep-call-2',
                localId: null,
                createdAt: 5,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'grep-2',
                    name: 'Bash',
                    input: {
                        command: 'grep -n "broadcast" server/src/sse/sseManager.ts | head -20'
                    },
                    description: null,
                    uuid: 'grep-call-2',
                    parentUUID: null
                }]
            },
            {
                id: 'grep-result-2',
                localId: null,
                createdAt: 6,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'grep-2',
                    content: {
                        stdout: '88: broadcast(message)'
                    },
                    is_error: false,
                    uuid: 'grep-result-2',
                    parentUUID: null
                }]
            },
            {
                id: 'read-call-2',
                localId: null,
                createdAt: 7,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'read-2',
                    name: 'Read',
                    input: { file_path: 'server/src/sse/sseManager.ts' },
                    description: null,
                    uuid: 'read-call-2',
                    parentUUID: null
                }]
            },
            {
                id: 'read-result-2',
                localId: null,
                createdAt: 8,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'read-2',
                    content: {
                        file: {
                            filePath: 'server/src/sse/sseManager.ts',
                            content: 'export class SSEManager {}'
                        }
                    },
                    is_error: false,
                    uuid: 'read-result-2',
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
        expect(block.children).toHaveLength(4)
        expect(block.children.map((child) => child.kind === 'tool-call' ? child.tool.name : null)).toEqual(['Grep', 'Read', 'Bash', 'Read'])
        expect(block.tool.input).toEqual({
            count: 4,
            files: [
                'web/src/hooks/useSSE.ts',
                'web/src/hooks/useSSE.ts',
                'server/src/sse/sseManager.ts',
                'server/src/sse/sseManager.ts'
            ]
        })
    })

    test('uses the command file path when Codex parsed_cmd reports a sed line range as the read name', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'sed-read-call',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'sed-read',
                    name: 'CodexBash',
                    input: {
                        command: 'sed -n "178,190p" web/src/components/ToolCard/ToolCard.tsx',
                        parsed_cmd: [{
                            type: 'read',
                            name: '178,190p'
                        }]
                    },
                    description: null,
                    uuid: 'sed-read-call',
                    parentUUID: null
                }]
            }
        ] satisfies NormalizedMessage[], null)

        const block = reduced.blocks[0]
        expect(block?.kind).toBe('tool-call')
        if (!block || block.kind !== 'tool-call') {
            throw new Error('Expected ReadBatch block')
        }

        expect(block.tool.name).toBe('ReadBatch')
        expect(block.tool.input).toEqual({
            count: 1,
            files: ['web/src/components/ToolCard/ToolCard.tsx']
        })
    })

    test('uses the upstream file path when a piped read command ends with a sed line range', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'piped-read-call',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'piped-read',
                    name: 'CodexBash',
                    input: {
                        command: 'nl -ba deploy.sh | sed -n "1,260p"',
                        parsed_cmd: [{
                            type: 'read',
                            name: '1,260p'
                        }]
                    },
                    description: null,
                    uuid: 'piped-read-call',
                    parentUUID: null
                }]
            }
        ] satisfies NormalizedMessage[], null)

        const block = reduced.blocks[0]
        expect(block?.kind).toBe('tool-call')
        if (!block || block.kind !== 'tool-call') {
            throw new Error('Expected ReadBatch block')
        }

        expect(block.tool.name).toBe('ReadBatch')
        expect(block.tool.input).toEqual({
            count: 1,
            files: ['deploy.sh']
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
