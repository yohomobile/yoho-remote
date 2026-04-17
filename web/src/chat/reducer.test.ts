import { describe, expect, test } from 'bun:test'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

describe('reduceChatBlocks duplicate handling', () => {
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
})
