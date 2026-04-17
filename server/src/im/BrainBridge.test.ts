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
                { text: '主 session 最终总结', messageId: 'msg-final', seq: 1 },
            ])
        }, 80)

        await (bridge as any).sendSummary(chatId)

        expect(replies).toHaveLength(1)
        expect(replies[0]?.chatId).toBe(chatId)
        expect(replies[0]?.payload.text).toContain('主 session 最终总结')
    })

    test('recovers final summary from database tail when in-memory agent messages lag behind', async () => {
        const replies: Array<{ chatId: string; payload: { text: string } }> = []
        const sessionId = 'session-db-tail'
        const chatId = 'oc_db_tail'

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
            } as any,
            store: {
                getMessagesAfter: async () => [
                    {
                        id: 'm-45',
                        seq: 45,
                        localId: null,
                        createdAt: 1045,
                        content: {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'assistant',
                                    message: {
                                        id: 'msg-final',
                                        content: [{ type: 'text', text: '今天上午 Medusa 总订单 254 单' }],
                                    },
                                },
                            },
                        },
                    },
                    {
                        id: 'm-46',
                        seq: 46,
                        localId: null,
                        createdAt: 1046,
                        content: {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'result',
                                    result: '今天上午 Medusa 总订单 254 单',
                                },
                            },
                        },
                    },
                ],
                updateFeishuChatState: async () => true,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async (targetChatId: string, payload: { text: string }) => {
                    replies.push({ chatId: targetChatId, payload })
                },
            } as any,
        })

        ;(bridge as any).chatIdToSessionId.set(chatId, sessionId)
        ;(bridge as any).agentMessages.set(chatId, [
            { text: '等子 session 回传结果。', messageId: 'msg-waiting', seq: 39 },
        ])
        ;(bridge as any).lastDeliveredSeq.set(chatId, 39)

        await (bridge as any).sendSummary(chatId)

        expect(replies).toHaveLength(1)
        expect(replies[0]?.payload.text).toContain('今天上午 Medusa 总订单 254 单')
        expect(replies[0]?.payload.text).not.toContain('等子 session 回传结果')
        expect((bridge as any).lastDeliveredSeq.get(chatId)).toBe(46)
    })

    test('merges cumulative Claude assistant text into a single final summary', async () => {
        const replies: Array<{ chatId: string; payload: { text: string } }> = []
        const chatId = 'oc_cumulative'

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
                sendReply: async (targetChatId: string, payload: { text: string }) => {
                    replies.push({ chatId: targetChatId, payload })
                },
            } as any,
        })

        ;(bridge as any).agentMessages.set(chatId, [
            { text: '今天上午 Medusa', messageId: 'msg-1', seq: 1 },
            { text: '今天上午 Medusa 总订单 254 单', messageId: 'msg-1', seq: 2 },
            { text: '今天上午 Medusa 总订单 254 单', messageId: null, seq: 3 },
        ])

        await (bridge as any).sendSummary(chatId)

        expect(replies).toHaveLength(1)
        expect(replies[0]?.payload.text).toContain('今天上午 Medusa 总订单 254 单')
        expect(replies[0]?.payload.text).not.toContain('今天上午 Medusa\n今天上午 Medusa 总订单 254 单')
    })
})
