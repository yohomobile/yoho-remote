import { describe, expect, test } from 'bun:test'
import type { DecryptedMessage } from '@/types/api'
import { parseBrainChildCallbackMessage } from './brainChildCallback'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'

const CALLBACK_TEXT = [
    '[子 session 任务完成]',
    'Session: child-session-123',
    '标题: 修复 brain 子任务输入区',
    '上次总结: 已完成输入区收口',
    'Context 剩余: ~92% (8,000 / 100,000 tokens) | 消息数: 12',
    '',
    '执行报告：',
    '1. 定位 SessionChat 和 composer 挂载条件',
    '2. 只对 brain-child 隐藏输入区',
    '3. 验证通过'
].join('\n')

function createMessage(text: string): DecryptedMessage {
    return {
        id: 'brain-callback-message',
        seq: 1,
        localId: null,
        createdAt: 1,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: {
                sentFrom: 'brain-callback'
            }
        }
    }
}

describe('brainChildCallback', () => {
    test('parses structured brain callback fields without truncating the report', () => {
        const longReport = `执行报告：\n${'A'.repeat(6000)}`
        const parsed = parseBrainChildCallbackMessage([
            '[子 session 任务完成]',
            'Session: child-session-999',
            '标题: 长报告验证',
            'Context 剩余: ~88% (12,345 / 100,000 tokens) | 消息数: 18',
            '',
            longReport
        ].join('\n'))

        expect(parsed).not.toBeNull()
        expect(parsed?.sessionId).toBe('child-session-999')
        expect(parsed?.title).toBe('长报告验证')
        expect(parsed?.details).toEqual([
            'Context 剩余: ~88% (12,345 / 100,000 tokens) | 消息数: 18'
        ])
        expect(parsed?.report).toBe(longReport)
        expect(parsed?.report?.length).toBe(longReport.length)
    })

    test('normalizes brain callback user text into a dedicated event block', () => {
        const normalized = normalizeDecryptedMessage(createMessage(CALLBACK_TEXT))
        const list = Array.isArray(normalized) ? normalized : normalized ? [normalized] : []

        expect(list).toHaveLength(1)
        expect(list[0]?.role).toBe('event')
        expect(list[0]?.content).toMatchObject({
            type: 'brain-child-callback',
            sessionId: 'child-session-123',
            title: '修复 brain 子任务输入区',
            previousSummary: '已完成输入区收口',
            details: ['Context 剩余: ~92% (8,000 / 100,000 tokens) | 消息数: 12'],
            report: [
                '执行报告：',
                '1. 定位 SessionChat 和 composer 挂载条件',
                '2. 只对 brain-child 隐藏输入区',
                '3. 验证通过'
            ].join('\n')
        })

        const reduced = reduceChatBlocks(list, null)
        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'agent-event',
            event: {
                type: 'brain-child-callback',
                sessionId: 'child-session-123'
            }
        })
    })
})
