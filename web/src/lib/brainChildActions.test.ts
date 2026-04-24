import { describe, expect, test } from 'bun:test'
import type { DecryptedMessage, Session } from '@/types/api'
import {
    deriveBrainChildPageActionState,
    extractBrainChildTailPreview,
    getBrainChildPageInactiveHint,
} from './brainChildActions'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'child-session',
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
        active: true,
        thinking: false,
        metadata: {
            path: '/tmp/child',
            host: 'ncu',
            source: 'brain-child',
            mainSessionId: 'brain-main',
        },
        agentState: null,
        ...overrides,
    }
}

function createMessage(overrides: Partial<DecryptedMessage>): DecryptedMessage {
    return {
        id: 'message-1',
        seq: 1,
        localId: null,
        createdAt: 1,
        content: {
            role: 'assistant',
            content: '默认输出'
        },
        ...overrides,
    }
}

describe('brainChildActions', () => {
    test('derives stop and resume affordances for child pages', () => {
        expect(deriveBrainChildPageActionState(createSession({
            active: true,
            thinking: true,
        }))).toEqual({
            mainSessionId: 'brain-main',
            canStop: true,
            canResume: false,
        })

        expect(deriveBrainChildPageActionState(createSession({
            active: false,
            thinking: false,
        }))).toEqual({
            mainSessionId: 'brain-main',
            canStop: false,
            canResume: true,
        })
    })

    test('handles missing main brain linkage gracefully', () => {
        expect(deriveBrainChildPageActionState(createSession({
            metadata: {
                path: '/tmp/child',
                host: 'ncu',
                source: 'brain-child',
            }
        }))).toEqual({
            mainSessionId: null,
            canStop: false,
            canResume: false,
        })
    })

    test('explains available child-page actions when the session is inactive', () => {
        expect(getBrainChildPageInactiveHint({
            childSource: 'brain-child',
            resumeError: false,
            hasMainSessionId: true,
            hasMessages: true,
        })).toBe('子任务当前未运行。此页不接受直接发消息；可使用上方操作条返回主 Brain、恢复或查看最近片段。')

        expect(getBrainChildPageInactiveHint({
            childSource: 'brain-child',
            resumeError: true,
            hasMainSessionId: false,
            hasMessages: true,
        })).toBe('恢复失败。此页不接受直接发消息；可使用上方操作条恢复或查看最近片段。')
    })

    test('uses orchestration-specific labels for orchestrator child pages', () => {
        expect(getBrainChildPageInactiveHint({
            childSource: 'orchestrator-child',
            resumeError: false,
            hasMainSessionId: true,
            hasMessages: false,
        })).toBe('正在等待编排子任务启动。此页不接受直接发消息；可使用上方操作条返回主编排 Session、恢复或查看最近片段。')
    })

    test('extracts recent tail preview items from normalized messages', () => {
        const items = extractBrainChildTailPreview([
            createMessage({
                id: 'user-1',
                createdAt: 10,
                content: {
                    role: 'user',
                    content: '先检查 SessionChat 和 child callback'
                }
            }),
            createMessage({
                id: 'assistant-1',
                createdAt: 20,
                content: {
                    role: 'assistant',
                    content: '已定位到 SessionChat 的 composer 挂载条件。'
                }
            }),
            createMessage({
                id: 'assistant-2',
                createdAt: 30,
                content: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'text',
                            text: '最后确认 callback 卡片可以直接打开子任务。'
                        }
                    ]
                }
            })
        ], 3)

        expect(items).toEqual([
            {
                id: 'user-1',
                createdAt: 10,
                label: '输入',
                snippet: '先检查 SessionChat 和 child callback'
            },
            {
                id: 'assistant-1:text:0',
                createdAt: 20,
                label: '输出',
                snippet: '已定位到 SessionChat 的 composer 挂载条件。'
            },
            {
                id: 'assistant-2:text:0',
                createdAt: 30,
                label: '输出',
                snippet: '最后确认 callback 卡片可以直接打开子任务。'
            }
        ])
    })

    test('drops reasoning and summary blocks from recent snippet preview', () => {
        const items = extractBrainChildTailPreview([
            createMessage({
                id: 'assistant-3',
                createdAt: 50,
                content: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'thinking',
                            thinking: '先看一下内部推理'
                        },
                        {
                            type: 'text',
                            text: '最终只展示可直接观察的输出。'
                        }
                    ]
                }
            })
        ])

        expect(items).toEqual([
            {
                id: 'assistant-3:text:0',
                createdAt: 50,
                label: '输出',
                snippet: '最终只展示可直接观察的输出。'
            }
        ])
    })

    test('falls back to raw message text when normalization does not yield visible blocks', () => {
        const items = extractBrainChildTailPreview([
            createMessage({
                id: 'raw-1',
                createdAt: 40,
                content: 'raw terminal output line'
            })
        ])

        expect(items).toEqual([
            {
                id: 'raw-1',
                createdAt: 40,
                label: '消息',
                snippet: 'raw terminal output line'
            }
        ])
    })
})
