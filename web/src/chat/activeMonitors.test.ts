import { describe, expect, test } from 'bun:test'
import { collectActiveMonitors } from './activeMonitors'
import type { ChatBlock } from './types'

function createMonitorToolBlock(state: 'pending' | 'running' | 'completed' | 'error' = 'completed'): ChatBlock {
    return {
        kind: 'tool-call',
        id: 'block-monitor',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'mon-1',
            name: 'Monitor',
            state,
            input: {
                description: 'watch logs',
                command: 'tail -f app.log',
                timeout_ms: 30_000,
            },
            createdAt: 1_000,
            startedAt: state === 'pending' ? null : 1_000,
            completedAt: state === 'completed' ? 1_001 : null,
            description: 'watch logs',
        },
        children: [],
    }
}

function createTaskStartedBlock(status?: string): ChatBlock {
    return {
        kind: 'agent-event',
        id: 'event-started',
        createdAt: 1_010,
        event: {
            type: 'task-started',
            toolUseId: 'mon-1',
            taskId: 'task-1',
            ...(status ? { status } : {})
        }
    }
}

describe('collectActiveMonitors', () => {
    test('keeps monitor active when tool card is completed but task has started', () => {
        const monitors = collectActiveMonitors([
            createMonitorToolBlock('completed'),
            createTaskStartedBlock(),
        ])

        expect(monitors).toEqual([{
            id: 'mon-1',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: 30_000,
            startedAt: 1_010,
            taskId: 'task-1',
            state: 'running',
        }])
    })

    test('drops monitor when merged task-started carries terminal status', () => {
        const monitors = collectActiveMonitors([
            createMonitorToolBlock('completed'),
            createTaskStartedBlock('completed'),
        ])

        expect(monitors).toEqual([])
    })

    test('falls back to in-flight tool state when task events are missing', () => {
        const monitors = collectActiveMonitors([
            createMonitorToolBlock('running'),
        ])

        expect(monitors).toEqual([{
            id: 'mon-1',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: 30_000,
            startedAt: 1_000,
            taskId: null,
            state: 'running',
        }])
    })
})
