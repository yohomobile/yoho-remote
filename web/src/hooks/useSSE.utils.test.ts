import { describe, expect, test } from 'bun:test'
import {
    hasSessionStatusFields,
    isFullSessionPayload,
    isSidOnlySessionRefreshHint,
    toSessionFromSsePayload,
} from './useSSE.utils'

describe('useSSE utils', () => {
    test('recognizes heartbeat-style status updates', () => {
        expect(hasSessionStatusFields({
            active: true,
            thinking: false,
        })).toBe(true)

        expect(hasSessionStatusFields({
            activeMonitorCount: 1,
        })).toBe(true)
    })

    test('recognizes sid-only refresh hints', () => {
        expect(isSidOnlySessionRefreshHint({ sid: 'session-1' })).toBe(true)
        expect(isSidOnlySessionRefreshHint({ sid: 'session-1', active: true })).toBe(false)
    })

    test('recognizes full session payloads even when they contain status fields', () => {
        expect(isFullSessionPayload({
            id: 'session-1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            thinking: true,
            metadataVersion: 3,
            agentStateVersion: 4,
            agentState: {
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        arguments: { prompt: 'pick one' },
                    }
                }
            }
        }, 'session-1')).toBe(true)

        expect(isFullSessionPayload({
            active: true,
            thinking: true,
            permissionMode: 'yolo',
        }, 'session-1')).toBe(false)
    })

    test('maps full session payload into session cache shape', () => {
        const session = toSessionFromSsePayload({
            id: 'session-1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            thinking: false,
            metadata: { path: '/tmp/project', host: 'ncu' },
            agentState: {
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        arguments: { prompt: 'pick one' },
                    }
                }
            },
            todos: [{ id: 'todo-1', content: 'Fix SSE', status: 'in_progress', priority: 'high' }],
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5.4',
            modelReasoningEffort: 'high',
            fastMode: true,
        })

        expect(session.agentState?.requests?.req1?.tool).toBe('AskUserQuestion')
        expect(session.todos?.[0]?.content).toBe('Fix SSE')
        expect(session.permissionMode).toBe('safe-yolo')
        expect(session.modelMode).toBe('gpt-5.4')
        expect(session.fastMode).toBe(true)
    })

    test('maps active monitors from full session payloads', () => {
        const session = toSessionFromSsePayload({
            id: 'session-1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            thinking: false,
            metadata: { path: '/tmp/project', host: 'ncu' },
            agentState: null,
            activeMonitors: [{
                id: 'mon-1',
                description: 'watch logs',
                command: 'tail -f app.log',
                persistent: false,
                timeoutMs: 30_000,
                startedAt: 123,
                taskId: 'task-1',
                state: 'running',
            }],
        })

        expect(session.activeMonitors).toEqual([{
            id: 'mon-1',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: 30_000,
            startedAt: 123,
            taskId: 'task-1',
            state: 'running',
        }])
    })
})
