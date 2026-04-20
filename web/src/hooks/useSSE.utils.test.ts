import { describe, expect, test } from 'bun:test'
import {
    applySessionSummaryStatusUpdate,
    getSessionCompletionNotificationKind,
    hasSessionStatusFields,
    isFullSessionPayload,
    isSidOnlySessionRefreshHint,
    mergeSessionNotificationState,
    shouldSuppressNotificationWithoutPreviousState,
    toSessionNotificationState,
    toSessionFromSsePayload,
    toSessionSummaryFromSsePayload,
    upsertSessionSummary,
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

    test('maps full session payloads into session summaries with derived fields', () => {
        const summary = toSessionSummaryFromSsePayload({
            id: 'session-1',
            createdAt: 1,
            updatedAt: 2,
            activeAt: 3,
            lastMessageAt: 4,
            active: true,
            thinking: false,
            createdBy: 'user@example.com',
            metadata: {
                path: '/tmp/project',
                name: 'Brain child',
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
                archivedBy: 'brain',
                archiveReason: 'Brain closed session',
                summary: { text: 'child summary', updatedAt: 99 },
                runtimeAgent: 'claude',
                runtimeModel: 'sonnet',
            },
            agentState: {
                requests: {
                    req1: { tool: 'AskUserQuestion', arguments: {} },
                    req2: { tool: 'RequestApproval', arguments: {} },
                }
            },
            todos: [
                { id: 'todo-1', content: 'A', status: 'completed', priority: 'high' },
                { id: 'todo-2', content: 'B', status: 'in_progress', priority: 'medium' },
            ],
            modelMode: 'sonnet',
            modelReasoningEffort: 'high',
            fastMode: true,
            terminationReason: 'LICENSE_EXPIRED',
        })

        expect(summary).toEqual({
            id: 'session-1',
            createdAt: 1,
            active: true,
            activeAt: 3,
            updatedAt: 2,
            lastMessageAt: 4,
            createdBy: 'user@example.com',
            metadata: {
                path: '/tmp/project',
                name: 'Brain child',
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
                archivedBy: 'brain',
                archiveReason: 'Brain closed session',
                summary: { text: 'child summary' },
                runtimeAgent: 'claude',
                runtimeModel: 'sonnet',
            },
            todoProgress: {
                completed: 1,
                total: 2,
            },
            pendingRequestsCount: 2,
            thinking: false,
            modelMode: 'sonnet',
            modelReasoningEffort: 'high',
            fastMode: true,
            terminationReason: 'LICENSE_EXPIRED',
        })
    })

    test('does not expose stale mainSessionId in summaries when SSE payload is not a brain-child session', () => {
        const summary = toSessionSummaryFromSsePayload({
            id: 'session-plain',
            createdAt: 1,
            updatedAt: 2,
            activeAt: 3,
            lastMessageAt: 4,
            active: true,
            thinking: false,
            metadata: {
                path: '/tmp/project',
                source: 'manual',
                mainSessionId: 'brain-1',
            },
            agentState: null,
        })

        expect(summary.metadata).toEqual({
            path: '/tmp/project',
            source: 'manual',
        })
    })

    test('upserts session summaries while preserving list-only fields not present in SSE payload', () => {
        const previous = {
            sessions: [{
                id: 'session-1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                updatedAt: 1,
                lastMessageAt: null,
                ownerEmail: 'owner@example.com',
                metadata: { path: '/tmp/project' },
                todoProgress: null,
                pendingRequestsCount: 0,
                thinking: false,
                viewers: [{ email: 'viewer@example.com', clientId: 'client-1' }],
            }]
        }

        const next = upsertSessionSummary(previous, {
            id: 'session-1',
            createdAt: 1,
            active: true,
            activeAt: 5,
            updatedAt: 6,
            lastMessageAt: 7,
            metadata: { path: '/tmp/project', source: 'brain-child' },
            todoProgress: { completed: 0, total: 1 },
            pendingRequestsCount: 1,
            thinking: true,
        })

        expect(next).toEqual({
            sessions: [{
                id: 'session-1',
                createdAt: 1,
                active: true,
                activeAt: 5,
                updatedAt: 6,
                lastMessageAt: 7,
                ownerEmail: 'owner@example.com',
                metadata: { path: '/tmp/project', source: 'brain-child' },
                todoProgress: { completed: 0, total: 1 },
                pendingRequestsCount: 1,
                thinking: true,
                viewers: [{ email: 'viewer@example.com', clientId: 'client-1' }],
            }]
        })
    })

    test('applies lastMessageAt-only status updates to session summaries', () => {
        const previous = {
            sessions: [{
                id: 'session-1',
                createdAt: 1,
                active: true,
                activeAt: 10,
                updatedAt: 20,
                lastMessageAt: 30,
                todoProgress: null,
                pendingRequestsCount: 0,
                thinking: false,
                metadata: { path: '/tmp/project' },
            }]
        }

        const next = applySessionSummaryStatusUpdate(previous, 'session-1', {
            lastMessageAt: 99,
        })

        expect(next).toEqual({
            sessions: [{
                ...previous.sessions[0],
                lastMessageAt: 99,
            }]
        })
    })

    test('keeps cache reference when status update does not change any session summary field', () => {
        const previous = {
            sessions: [{
                id: 'session-1',
                createdAt: 1,
                active: true,
                activeAt: 10,
                updatedAt: 20,
                lastMessageAt: 30,
                todoProgress: null,
                pendingRequestsCount: 0,
                thinking: false,
                metadata: { path: '/tmp/project' },
            }]
        }

        const next = applySessionSummaryStatusUpdate(previous, 'session-1', {
            lastMessageAt: 30,
        })

        expect(next).toBe(previous)
    })

    test('extracts notification state from session summaries', () => {
        expect(toSessionNotificationState({
            active: true,
            thinking: false,
            terminationReason: 'LICENSE_EXPIRED',
        })).toEqual({
            active: true,
            thinking: false,
            terminationReason: 'LICENSE_EXPIRED',
        })
    })

    test('merges notification state with partial status updates', () => {
        expect(mergeSessionNotificationState({
            active: true,
            thinking: true,
            terminationReason: null,
        }, {
            thinking: false,
        })).toEqual({
            active: true,
            thinking: false,
            terminationReason: null,
        })
    })

    test('emits a license notification only on a new license termination edge', () => {
        expect(getSessionCompletionNotificationKind({
            previousState: {
                active: true,
                thinking: false,
                terminationReason: null,
            },
            data: {
                active: false,
                terminationReason: 'LICENSE_EXPIRED',
            },
        })).toBe('license-terminated')

        expect(getSessionCompletionNotificationKind({
            previousState: {
                active: false,
                thinking: false,
                terminationReason: 'LICENSE_EXPIRED',
            },
            data: {
                active: false,
                terminationReason: 'LICENSE_EXPIRED',
            },
        })).toBeNull()
    })

    test('emits task-complete notification only when thinking actually flips to false', () => {
        expect(getSessionCompletionNotificationKind({
            previousState: {
                active: true,
                thinking: true,
                terminationReason: null,
            },
            data: {
                wasThinking: true,
                thinking: false,
            },
        })).toBe('task-completed')

        expect(getSessionCompletionNotificationKind({
            previousState: {
                active: true,
                thinking: false,
                terminationReason: null,
            },
            data: {
                wasThinking: true,
                thinking: false,
            },
        })).toBeNull()
    })

    test('suppresses first completion-style event after reconnect when no prior state exists', () => {
        expect(getSessionCompletionNotificationKind({
            previousState: null,
            data: {
                active: false,
                terminationReason: 'LICENSE_EXPIRED',
            },
            suppressWithoutPreviousState: true,
        })).toBeNull()

        expect(getSessionCompletionNotificationKind({
            previousState: null,
            data: {
                wasThinking: true,
                thinking: false,
            },
            suppressWithoutPreviousState: true,
        })).toBeNull()
    })

    test('keeps suppressing no-prior-state notifications until a reliable baseline is ready', () => {
        expect(shouldSuppressNotificationWithoutPreviousState({
            previousState: null,
            baselineReady: false,
            lastConnectAt: 1_000,
            replayGuardMs: 5_000,
            now: 20_000,
        })).toBe(true)

        expect(shouldSuppressNotificationWithoutPreviousState({
            previousState: null,
            baselineReady: true,
            lastConnectAt: 10_000,
            replayGuardMs: 5_000,
            now: 12_000,
        })).toBe(true)

        expect(shouldSuppressNotificationWithoutPreviousState({
            previousState: null,
            baselineReady: true,
            lastConnectAt: 10_000,
            replayGuardMs: 5_000,
            now: 20_000,
        })).toBe(false)

        expect(shouldSuppressNotificationWithoutPreviousState({
            previousState: {
                active: true,
                thinking: true,
                terminationReason: null,
            },
            baselineReady: false,
            lastConnectAt: 1_000,
            replayGuardMs: 5_000,
            now: 20_000,
        })).toBe(false)
    })
})
