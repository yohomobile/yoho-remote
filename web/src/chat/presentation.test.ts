import { describe, expect, test } from 'bun:test'
import { activeItem, buildDisplayTurns, getEventPresentation } from './presentation'
import type { AgentEvent, ChatBlock } from './types'
import type { Session } from '@/types/api'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
        active: true,
        thinking: false,
        metadata: {
            path: '/tmp/session',
            host: 'localhost',
            source: 'brain',
        },
        agentState: null,
        ...overrides,
    }
}

describe('buildDisplayTurns', () => {
    test('selects the latest live item as the active item within a turn', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Continue',
                status: 'sent',
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Thinking'
            },
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 3,
                event: { type: 'message', message: 'Still working' }
            },
            {
                kind: 'tool-call',
                id: 'tool-1',
                localId: null,
                createdAt: 4,
                tool: {
                    id: 'tool-1',
                    name: 'Read',
                    state: 'running',
                    input: { file_path: 'README.md' },
                    createdAt: 4,
                    startedAt: 4,
                    completedAt: null,
                    description: null,
                },
                children: [],
            },
        ] satisfies ChatBlock[], createSession({
            thinking: true,
        }))

        expect(turns).toHaveLength(2)
        expect(turns[0]?.items.map((item) => item.kind)).toEqual(['user-text'])
        expect(activeItem(turns[0]!)).toBeNull()
        expect(turns[1]?.items.map((item) => item.kind)).toEqual([
            'agent-text',
            'agent-event',
            'tool-call',
        ])
        expect(activeItem(turns[1]!)?.id).toBe('tool-1')
        expect(activeItem(turns[1]!)?.kind).toBe('tool-call')
    })

    test('treats a sending user message as the active item when no assistant work exists yet', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Ping',
                status: 'sending',
            },
        ] satisfies ChatBlock[], createSession())

        expect(turns).toHaveLength(1)
        expect(activeItem(turns[0]!)?.kind).toBe('user-text')
        expect(activeItem(turns[0]!)?.id).toBe('user-1')
    })

    test('keeps assistant blocks inactive when the session is not thinking', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Continue',
                status: 'sent',
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Working',
            },
            {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                localId: null,
                createdAt: 3,
                text: 'Thinking out loud',
            },
        ] satisfies ChatBlock[], createSession({
            thinking: false,
        }))

        expect(turns).toHaveLength(2)
        expect(turns[1]?.items.map((item) => item.kind)).toEqual([
            'agent-text',
            'agent-reasoning',
        ])
        expect(activeItem(turns[1]!)).toBeNull()
    })

    test('keeps a pure agent-event turn inactive even when the session is thinking', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 1,
                event: {
                    type: 'message',
                    message: 'Working...'
                },
            },
        ] satisfies ChatBlock[], createSession({
            thinking: true,
        }))

        expect(turns).toHaveLength(1)
        expect(turns[0]?.items.map((item) => item.kind)).toEqual(['agent-event'])
        expect(activeItem(turns[0]!)).toBeNull()
    })

    test('treats direct brain delivery metadata as active', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Continue',
                status: 'sent',
                meta: {
                    brainDelivery: {
                        phase: 'queued',
                        acceptedAt: 1,
                    },
                },
            },
        ] satisfies ChatBlock[], createSession({
            active: false,
        }))

        expect(turns).toHaveLength(1)
        expect(activeItem(turns[0]!)?.kind).toBe('user-text')
        expect(activeItem(turns[0]!)?.id).toBe('user-1')
    })

    test('treats brain session queue metadata as active', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Continue',
                status: 'sent',
                meta: {
                    brainSessionQueue: {
                        delivery: 'queued',
                        acceptedAt: 1,
                        wakeQueueDepth: 1,
                    },
                },
            },
        ] satisfies ChatBlock[], createSession({
            active: false,
        }))

        expect(turns).toHaveLength(1)
        expect(activeItem(turns[0]!)?.kind).toBe('user-text')
        expect(activeItem(turns[0]!)?.id).toBe('user-1')
    })

    test('prefers brain delivery over brain session queue when both are present', () => {
        const turns = buildDisplayTurns([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Continue',
                status: 'sent',
                meta: {
                    brainDelivery: {
                        phase: 'pending_consume',
                        acceptedAt: 1,
                    },
                    brainSessionQueue: {
                        delivery: 'queued',
                        acceptedAt: 2,
                        wakeQueueDepth: 1,
                    },
                },
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Working',
            },
        ] satisfies ChatBlock[], createSession({
            thinking: true,
        }))

        expect(turns).toHaveLength(2)
        expect(activeItem(turns[0]!)?.kind).toBe('user-text')
        expect(activeItem(turns[0]!)?.id).toBe('user-1')
        expect(activeItem(turns[1]!)?.kind).toBe('agent-text')
    })
})

describe('getEventPresentation', () => {
    test('renders compact, status, todo, brain-child-callback, and unknown events consistently', () => {
        expect(getEventPresentation({ type: 'compact-boundary' } as AgentEvent)).toEqual({
            icon: '📦',
            text: 'Context compacted',
        })

        expect(getEventPresentation({ type: 'status', status: 'compacting' } as AgentEvent)).toEqual({
            icon: '📦',
            text: 'Compacting context...',
        })

        expect(getEventPresentation({ type: 'status', status: 'idle' } as AgentEvent)).toEqual({
            icon: null,
            text: 'idle',
        })

        expect(getEventPresentation({
            type: 'todo-reminder',
            items: [
                { content: 'Ship it', status: 'completed' },
                { content: 'Clean up', status: 'in_progress' },
            ],
            itemCount: 2,
            pendingCount: 0,
            inProgressCount: 1,
            completedCount: 1,
        } as AgentEvent)).toEqual({
            icon: '📝',
            text: 'Plan progress 1/2',
        })

        expect(getEventPresentation({
            type: 'brain-child-callback',
            title: '子任务完成',
            sessionId: 'child-1',
            details: [],
        } as AgentEvent)).toEqual({
            icon: '🧠',
            text: '子任务回传 · 子任务完成',
        })

        const fallback = getEventPresentation({
            type: 'mystery-event',
            foo: 'bar',
        } as AgentEvent)
        expect(fallback.icon).toBeNull()
        expect(fallback.text).toContain('"type":"mystery-event"')
        expect(fallback.text).toContain('"foo":"bar"')
    })
})
