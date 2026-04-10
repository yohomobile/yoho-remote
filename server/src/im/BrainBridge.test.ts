import { describe, expect, test } from 'bun:test'
import { BrainBridge } from './BrainBridge'

describe('BrainBridge', () => {
    test('waits for late agent messages before sending final summary', async () => {
        const replies: Array<{ chatId: string; payload: { text: string } }> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
            } as any,
            store: {
                updateFeishuChatState: async () => true,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async (chatId: string, payload: { text: string }) => {
                    replies.push({ chatId, payload })
                },
            } as any,
        })

        const chatId = 'oc_test_chat'

        setTimeout(() => {
            ;(bridge as any).agentMessages.set(chatId, [
                { text: '主 session 最终总结', messageId: 'msg-final' },
            ])
        }, 80)

        await (bridge as any).sendSummary(chatId)

        expect(replies).toHaveLength(1)
        expect(replies[0]?.chatId).toBe(chatId)
        expect(replies[0]?.payload.text).toContain('主 session 最终总结')
    })
})
