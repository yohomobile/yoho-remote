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

    test('returns UI labels for supported orchestration sources', () => {
        expect(getSessionOrchestrationLabels('brain-child')).toEqual({
            parentSessionLabel: '主 Brain',
            childSessionLabel: '子任务',
        })

        expect(getSessionOrchestrationLabels('orchestrator')).toEqual({
            parentSessionLabel: '主编排 Session',
            childSessionLabel: '编排子任务',
        })
    })

    test('returns presentation metadata for callback cards and header badges', () => {
        expect(getSessionOrchestrationPresentation('brain-child')).toEqual({
            parentDisplayName: 'Brain',
            badgeLabel: '🧠 子任务',
            callbackLabel: '子任务回传',
            eventIcon: '🧠',
            accentTone: 'amber',
        })

        expect(getSessionOrchestrationPresentation('orchestrator')).toEqual({
            parentDisplayName: 'Orchestrator',
            badgeLabel: '🎛 Orchestrator',
            callbackLabel: '编排子任务回传',
            eventIcon: '🎛',
            accentTone: 'sky',
        })
    })

    test('returns source-aware queue and ready copy', () => {
        expect(getSessionOrchestrationReadyPhaseCopy('brain', 'ready')).toBe(
            '可开始使用：Brain 已准备就绪，现在可以开始派发任务。'
        )
        expect(
            getSessionOrchestrationReadyPhaseCopy(
                'orchestrator',
                'initializing'
            )
        ).toBe(
            '初始化中：Orchestrator 已上线，正在加载编排工具和运行上下文，暂时不要把“创建成功”误当成“已经完全可用”。'
        )
        expect(getSessionOrchestrationInactiveQueueCopy('brain')).toBe(
            'Brain 当前未运行。新消息会先入队，等恢复后再消费。'
        )
        expect(getSessionOrchestrationInactiveQueueCopy('orchestrator')).toBe(
            'Orchestrator 当前未运行。新消息会先入队，等恢复后再消费。'
        )
    })
})
