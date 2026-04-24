import { describe, expect, test } from 'bun:test'
import {
    getSessionOrchestrationInactiveQueueCopy,
    getSessionOrchestrationLabels,
    getSessionOrchestrationParentSessionId,
    getSessionOrchestrationPresentation,
    getSessionOrchestrationReadyPhaseCopy,
    isSessionOrchestrationChildSource,
    isSessionOrchestrationParentSource,
} from './sessionOrchestration'

describe('sessionOrchestration', () => {
    test('recognizes orchestration parent and child sources', () => {
        expect(isSessionOrchestrationParentSource('brain')).toBe(true)
        expect(isSessionOrchestrationParentSource('orchestrator')).toBe(true)
        expect(isSessionOrchestrationParentSource('webapp')).toBe(false)

        expect(isSessionOrchestrationChildSource('brain-child')).toBe(true)
        expect(isSessionOrchestrationChildSource('orchestrator-child')).toBe(
            true
        )
        expect(isSessionOrchestrationChildSource('brain')).toBe(false)
    })

    test('extracts parent session id only for orchestration child metadata', () => {
        expect(
            getSessionOrchestrationParentSessionId({
                path: '/tmp/child',
                host: 'ncu',
                source: 'orchestrator-child',
                mainSessionId: 'orchestrator-main',
            })
        ).toBe('orchestrator-main')

        expect(
            getSessionOrchestrationParentSessionId({
                path: '/tmp/parent',
                host: 'ncu',
                source: 'orchestrator',
                mainSessionId: 'ignored-parent-link',
            })
        ).toBeUndefined()
    })

    test('returns UI labels only for Brain orchestration sources', () => {
        expect(getSessionOrchestrationLabels('brain-child')).toEqual({
            parentSessionLabel: '主 Brain',
            childSessionLabel: '子任务',
        })

        expect(getSessionOrchestrationLabels('orchestrator')).toBeNull()
        expect(getSessionOrchestrationLabels('orchestrator-child')).toBeNull()
    })

    test('returns presentation metadata only for Brain callback cards and header badges', () => {
        expect(getSessionOrchestrationPresentation('brain-child')).toEqual({
            parentDisplayName: 'Brain',
            badgeLabel: '🧠 子任务',
            callbackLabel: '子任务回传',
            eventIcon: '🧠',
            accentTone: 'amber',
        })

        expect(getSessionOrchestrationPresentation('orchestrator')).toBeNull()
        expect(getSessionOrchestrationPresentation('orchestrator-child')).toBeNull()
    })

    test('returns queue and ready copy only for Brain UI', () => {
        expect(getSessionOrchestrationReadyPhaseCopy('brain', 'ready')).toBe(
            '可开始使用：Brain 已准备就绪，现在可以开始派发任务。'
        )
        expect(getSessionOrchestrationReadyPhaseCopy('orchestrator', 'ready')).toBeNull()
        expect(getSessionOrchestrationInactiveQueueCopy('brain')).toBe(
            'Brain 当前未运行。新消息会先入队，等恢复后再消费。'
        )
        expect(getSessionOrchestrationInactiveQueueCopy('orchestrator')).toBeNull()
    })
})
