import { describe, expect, test } from 'bun:test'
import { BrainBridge } from './BrainBridge'

describe('BrainBridge', () => {
    test('filters unreliable yoho-memory user profile recall before prompt injection', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => new Response(JSON.stringify({
            answer: '另一个用户的历史偏好',
            filesSearched: 1,
            confidence: 0.9,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

        try {
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
                    sendReply: async () => {},
                } as any,
            })

            await expect((bridge as any).fetchUserProfile('Dev', 'ou_user_1')).resolves.toBeNull()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('keeps the current busy Brain turn running for normal p2p follow-up context', async () => {
        const aborted: string[] = []
        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                abortSession: async (sessionId: string) => {
                    aborted.push(sessionId)
                },
            } as any,
            store: {
                updateFeishuChatState: async () => true,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
            } as any,
        })

        const chatId = 'oc_busy_keep'
        ;(bridge as any).chatIdToSessionId.set(chatId, 'session-keep')
        ;(bridge as any).chatStates.set(chatId, {
            incoming: [],
            debounceTimer: null,
            passiveDebounceTimer: null,
            busy: true,
            creating: false,
        })

        bridge.onMessage(chatId, 'p2p', {
            text: '补充一点上下文：报错只在 iOS 端出现，先继续原来的任务。',
            messageId: 'msg-1',
            senderName: 'Dev',
            senderId: 'user-1',
            senderEmail: null,
            chatType: 'p2p',
            addressed: true,
        })

        expect(aborted).toHaveLength(0)
    })

    test('aborts the current busy Brain turn only for explicit redirect text', async () => {
        const aborted: string[] = []
        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                abortSession: async (sessionId: string) => {
                    aborted.push(sessionId)
                },
            } as any,
            store: {
                updateFeishuChatState: async () => true,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
            } as any,
        })

        const chatId = 'oc_busy_abort'
        ;(bridge as any).chatIdToSessionId.set(chatId, 'session-abort')
        ;(bridge as any).chatStates.set(chatId, {
            incoming: [],
            debounceTimer: null,
            passiveDebounceTimer: null,
            busy: true,
            creating: false,
        })

        bridge.onMessage(chatId, 'p2p', {
            text: '停止刚才那个，之前的方向不对，改个方向重新来。',
            messageId: 'msg-2',
            senderName: 'Dev',
            senderId: 'user-1',
            senderEmail: null,
            chatType: 'p2p',
            addressed: true,
        })

        expect(aborted).toEqual(['session-abort'])
    })

    test('attaches resolved Feishu actor metadata when flushing user messages', async () => {
        const observations: Array<Record<string, unknown>> = []
        const sentMessages: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getSession: (sessionId: string) => ({
                    id: sessionId,
                    namespace: 'default',
                    active: true,
                    activeAt: Date.now(),
                    metadata: { source: 'brain' },
                }),
                sendMessage: async (sessionId: string, payload: Record<string, unknown>) => {
                    sentMessages.push({ sessionId, payload })
                    return { status: 'delivered' }
                },
            } as any,
            store: {
                getSession: async () => ({ orgId: 'org-1' }),
                touchFeishuChatSession: async () => true,
                updateFeishuChatState: async () => true,
                resolveActorByIdentityObservation: async (observation: Record<string, unknown>) => {
                    observations.push(observation)
                    return {
                        identityId: 'identity-feishu-1',
                        personId: 'person-1',
                        channel: 'feishu',
                        resolution: 'admin_verified',
                        displayName: 'Dev User',
                        email: 'dev@example.com',
                        externalId: 'ou_user_1',
                        accountType: 'human',
                    }
                },
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendText: async () => {},
                sendReply: async () => {},
            } as any,
        })

        const chatId = 'oc_actor_chat'
        ;(bridge as any).chatIdToSessionId.set(chatId, 'session-feishu')
        ;(bridge as any).chatStates.set(chatId, {
            incoming: [{
                text: '查一下这个订单',
                messageId: 'msg-1',
                senderName: 'Dev User',
                senderId: 'ou_user_1',
                senderEmail: 'dev@example.com',
                chatType: 'p2p',
                addressed: true,
            }],
            debounceTimer: null,
            passiveDebounceTimer: null,
            busy: false,
            creating: false,
        })
        ;(bridge as any).buildUserProfilePrompt = async () => undefined

        await (bridge as any).flushIncomingMessages(chatId)

        expect(observations).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            channel: 'feishu',
            externalId: 'ou_user_1',
            canonicalEmail: 'dev@example.com',
            displayName: 'Dev User',
            accountType: 'human',
            assurance: 'medium',
            attributes: {
                platform: 'feishu',
                chatType: 'p2p',
                messageId: 'msg-1',
            },
        }])
        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]).toEqual({
            sessionId: 'session-feishu',
            payload: {
                text: '查一下这个订单',
                sentFrom: 'feishu',
                meta: {
                    feishuChatId: chatId,
                    feishuChatType: 'p2p',
                    senderName: 'Dev User',
                    senderOpenId: 'ou_user_1',
                    actor: {
                        identityId: 'identity-feishu-1',
                        personId: 'person-1',
                        channel: 'feishu',
                        resolution: 'admin_verified',
                        displayName: 'Dev User',
                        email: 'dev@example.com',
                        externalId: 'ou_user_1',
                        accountType: 'human',
                    },
                },
            },
        })
    })

    test('patches Feishu p2p session identityContext during initialization', async () => {
        const patchCalls: Array<Record<string, unknown>> = []
        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getSession: () => ({
                    id: 'session-feishu-init',
                    namespace: 'default',
                    active: true,
                    metadata: {
                        path: '/tmp/brain',
                        source: 'brain',
                    },
                }),
                patchSessionMetadata: async (_sessionId: string, patch: Record<string, unknown>) => {
                    patchCalls.push(patch)
                    return { ok: true }
                },
                waitForSocketInRoom: async () => true,
                sendMessage: async () => ({ status: 'delivered' }),
            } as any,
            store: {
                getSession: async () => ({ orgId: 'org-1' }),
                getBrainConfigByOrg: async () => ({
                    namespace: 'org:org-1',
                    orgId: 'org-1',
                    agent: 'claude',
                    claudeModelMode: 'opus',
                    codexModel: 'gpt-5.4',
                    extra: {
                        selfSystem: {
                            enabled: false,
                            defaultProfileId: null,
                            memoryProvider: 'yoho-memory',
                        },
                    },
                    updatedAt: 1,
                    updatedBy: null,
                }),
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                buildSessionTitle: () => '飞书: 与 Dev User 的对话',
                buildInitPrompt: async () => '#InitPrompt-Brain',
            } as any,
        })

        await (bridge as any).initializeSession('session-feishu-init', 'oc_p2p', 'p2p', undefined, 'Dev User', {
            identityId: 'identity-feishu-1',
            personId: 'person-1',
            channel: 'feishu',
            resolution: 'admin_verified',
            displayName: 'Dev User',
            email: 'dev@example.com',
            externalId: 'ou_user_1',
            accountType: 'human',
        })

        expect(patchCalls[0]).toEqual({
            summary: { text: '飞书: 与 Dev User 的对话', updatedAt: expect.any(Number) },
            identityContext: {
                version: 1,
                mode: 'single-actor',
                defaultActor: {
                    identityId: 'identity-feishu-1',
                    personId: 'person-1',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    displayName: 'Dev User',
                    email: 'dev@example.com',
                    externalId: 'ou_user_1',
                    accountType: 'human',
                },
                chat: {
                    platform: 'feishu',
                    chatId: 'oc_p2p',
                    chatType: 'p2p',
                },
            },
        })
    })

    test('uses senderEmail fallback for self-system and createdBy when identity actor is missing', async () => {
        const setCreatedByCalls: Array<[string, string, string]> = []
        const sentMessages: Array<{ sessionId: string; text: string }> = []
        const patchCalls: Array<Record<string, unknown>> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getSession: () => ({
                    id: 'session-user-email',
                    namespace: 'default',
                    active: true,
                    metadata: {
                        path: '/tmp/brain',
                        source: 'brain',
                    },
                }),
                patchSessionMetadata: async (_sessionId: string, patch: Record<string, unknown>) => {
                    patchCalls.push(patch)
                    return { ok: true }
                },
                waitForSocketInRoom: async () => true,
                sendMessage: async (sessionId: string, payload: { text: string }) => {
                    sentMessages.push({ sessionId, text: payload.text })
                },
            } as any,
            store: {
                getSession: async () => ({ orgId: 'org-1' }),
                setSessionCreatedBy: async (sessionId: string, email: string, namespace: string) => {
                    setCreatedByCalls.push([sessionId, email, namespace])
                },
                getUserSelfSystemConfig: async () => ({
                    orgId: 'org-1',
                    userEmail: 'dev@example.com',
                    enabled: true,
                    defaultProfileId: 'profile-1',
                    memoryProvider: 'none',
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getAIProfile: async () => ({
                    id: 'profile-1',
                    orgId: 'org-1',
                    namespace: 'org:org-1',
                    name: 'K1',
                    role: 'developer',
                    specialties: ['TypeScript'],
                    personality: '结构化',
                    greetingTemplate: null,
                    preferredProjects: [],
                    workStyle: '先澄清再执行',
                    avatarEmoji: '🤖',
                    status: 'idle',
                    stats: {
                        tasksCompleted: 0,
                        activeMinutes: 0,
                        lastActiveAt: null,
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }),
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                buildSessionTitle: () => '飞书: 测试会话',
                buildInitPrompt: async () => '#InitPrompt-Brain',
            } as any,
        })

        await (bridge as any).initializeSession(
            'session-user-email',
            'chat-1',
            'p2p',
            undefined,
            'Dev',
            null,
            'dev@example.com',
        )

        expect(setCreatedByCalls).toEqual([
            ['session-user-email', 'dev@example.com', 'org-1'],
        ])
        expect(patchCalls[1]).toEqual({
            selfSystemEnabled: true,
            selfProfileId: 'profile-1',
            selfProfileName: 'K1',
            selfProfileResolved: true,
            selfMemoryProvider: 'none',
            selfMemoryAttached: false,
            selfMemoryStatus: 'disabled',
        })
        expect(sentMessages[0]?.text).toContain('## K1 自我系统')
    })

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

    test('appends self system prompt and patches metadata during IM Brain initialization', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => new Response(JSON.stringify({
            result: {
                content: 'K1 长期记忆：namespace:default 收到模糊输入时，优先把上下文结构化。',
                sources: ['memories/self/preferences.md'],
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

        try {
            const patchCalls: Array<Record<string, unknown>> = []
            const sentMessages: Array<{ sessionId: string; text: string }> = []

            const bridge = new BrainBridge({
                syncEngine: {
                    subscribe: () => () => {},
                    getSession: () => ({
                        id: 'session-im-self',
                        namespace: 'default',
                        active: true,
                        metadata: {
                            path: '/tmp/brain',
                            source: 'brain',
                        },
                    }),
                    patchSessionMetadata: async (_sessionId: string, patch: Record<string, unknown>) => {
                        patchCalls.push(patch)
                        return { ok: true }
                    },
                    waitForSocketInRoom: async () => true,
                    sendMessage: async (sessionId: string, payload: { text: string }) => {
                        sentMessages.push({ sessionId, text: payload.text })
                    },
            } as any,
            store: {
                    getSession: async () => ({ orgId: 'org-1' }),
                    getBrainConfigByOrg: async () => ({
                        namespace: 'org:org-1',
                        orgId: 'org-1',
                        agent: 'claude',
                        claudeModelMode: 'opus',
                        codexModel: 'gpt-5.4',
                        extra: {
                            selfSystem: {
                                enabled: true,
                                defaultProfileId: 'profile-1',
                                memoryProvider: 'yoho-memory',
                            },
                        },
                        updatedAt: 1,
                        updatedBy: null,
                    }),
                    getAIProfile: async () => ({
                        id: 'profile-1',
                        orgId: 'org-1',
                        namespace: 'org:org-1',
                        name: 'K1',
                        role: 'architect',
                        specialties: ['TypeScript'],
                        personality: '结构化',
                        greetingTemplate: null,
                        preferredProjects: [],
                        workStyle: '先澄清再执行',
                        avatarEmoji: '🤖',
                        status: 'idle',
                        stats: {
                            tasksCompleted: 0,
                            activeMinutes: 0,
                            lastActiveAt: null,
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    }),
                } as any,
                adapter: {
                    platform: 'feishu',
                    start: async () => {},
                    stop: async () => {},
                    sendReply: async () => {},
                    buildSessionTitle: () => '飞书: 测试会话',
                    buildInitPrompt: async () => '#InitPrompt-Brain',
                } as any,
            })

            await (bridge as any).initializeSession('session-im-self', 'chat-1', 'p2p', undefined, 'Dev')

            expect(patchCalls[0]).toEqual({
                summary: { text: '飞书: 测试会话', updatedAt: expect.any(Number) },
            })
            expect(patchCalls[1]).toEqual({
                selfSystemEnabled: true,
                selfProfileId: 'profile-1',
                selfProfileName: 'K1',
                selfProfileResolved: true,
                selfMemoryProvider: 'yoho-memory',
                selfMemoryAttached: true,
                selfMemoryStatus: 'attached',
            })
            expect(sentMessages).toHaveLength(1)
            expect(sentMessages[0]?.sessionId).toBe('session-im-self')
            expect(sentMessages[0]?.text).toContain('## K1 自我系统')
            expect(sentMessages[0]?.text).toContain('K1 长期记忆')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('does not apply legacy namespace self-system during IM initialization when session org is missing', async () => {
        const sentMessages: Array<{ sessionId: string; text: string }> = []
        const patchCalls: Array<Record<string, unknown>> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getSession: () => ({
                    id: 'session-im-no-org',
                    namespace: 'default',
                    active: true,
                    metadata: {
                        path: '/tmp/brain',
                        source: 'brain',
                    },
                }),
                patchSessionMetadata: async (_sessionId: string, patch: Record<string, unknown>) => {
                    patchCalls.push(patch)
                    return { ok: true }
                },
                waitForSocketInRoom: async () => true,
                sendMessage: async (sessionId: string, payload: { text: string }) => {
                    sentMessages.push({ sessionId, text: payload.text })
                },
            } as any,
            store: {
                getSession: async () => ({ orgId: null }),
                getBrainConfig: async () => ({
                    namespace: 'default',
                    agent: 'claude',
                    claudeModelMode: 'opus',
                    codexModel: 'gpt-5.4',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: 'profile-legacy',
                            memoryProvider: 'yoho-memory',
                        },
                    },
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getAIProfile: async () => ({
                    id: 'profile-legacy',
                    namespace: 'default',
                    name: 'Legacy',
                    role: 'architect',
                    specialties: [],
                    personality: null,
                    greetingTemplate: null,
                    preferredProjects: [],
                    workStyle: null,
                    avatarEmoji: '🤖',
                    status: 'idle',
                    stats: {
                        tasksCompleted: 0,
                        activeMinutes: 0,
                        lastActiveAt: null,
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }),
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                buildSessionTitle: () => '飞书: 测试会话',
                buildInitPrompt: async () => '#InitPrompt-Brain',
            } as any,
        })

        await (bridge as any).initializeSession('session-im-no-org', 'chat-1', 'p2p', undefined, 'Dev')

        expect(patchCalls[1]).toEqual({
            selfSystemEnabled: false,
            selfProfileId: null,
            selfProfileName: null,
            selfProfileResolved: false,
            selfMemoryProvider: 'yoho-memory',
            selfMemoryAttached: false,
            selfMemoryStatus: 'disabled',
        })
        expect(sentMessages[0]?.text).not.toContain('## K1 自我系统')
    })

    test('prefers the sender org when senderEmail belongs to exactly one organization', async () => {
        const machineSelections: Array<{ namespace: string }> = []
        const setSessionOrgIdCalls: Array<[string, string]> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getOnlineMachinesByNamespace: (namespace: string) => {
                    machineSelections.push({ namespace })
                    return [{
                        id: 'machine-1',
                        namespace,
                        orgId: 'org-1',
                        metadata: { homeDir: '/home/dev' },
                        supportedAgents: ['claude', 'codex'],
                    }]
                },
                spawnSession: async () => ({
                    type: 'success',
                    sessionId: 'session-org-preferred',
                }),
            } as any,
            store: {
                getOrganizationsForUser: async () => [{
                    id: 'org-1',
                    name: 'Org One',
                    slug: 'org-one',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: 1,
                    settings: {},
                    myRole: 'member',
                }],
                createFeishuChatSession: async () => true,
                setSessionOrgId: async (sessionId: string, orgId: string) => {
                    setSessionOrgIdCalls.push([sessionId, orgId])
                },
                getBrainConfigByOrg: async () => null,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
            } as any,
        })
        ;(bridge as any).initializeSession = async () => {}

        const sessionId = await (bridge as any).createBrainSession('chat-org', 'p2p', undefined, {
            text: '帮我查下问题',
            messageId: 'msg-org',
            senderName: 'Dev',
            senderId: 'ou_user_1',
            senderEmail: 'dev@example.com',
            chatType: 'p2p',
            addressed: true,
        })

        expect(sessionId).toBe('session-org-preferred')
        expect(machineSelections).toEqual([
            { namespace: 'org-1' },
        ])
        expect(setSessionOrgIdCalls).toEqual([
            ['session-org-preferred', 'org-1'],
        ])
    })

    test('resolves org through adapter email when senderEmail is missing', async () => {
        const machineSelections: Array<{ namespace: string }> = []
        const setSessionOrgIdCalls: Array<[string, string]> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getOnlineMachinesByNamespace: (namespace: string) => {
                    machineSelections.push({ namespace })
                    return [{
                        id: 'machine-1',
                        namespace,
                        orgId: 'org-1',
                        metadata: { homeDir: '/home/dev' },
                        supportedAgents: ['claude', 'codex'],
                    }]
                },
                spawnSession: async () => ({
                    type: 'success',
                    sessionId: 'session-org-from-adapter',
                }),
            } as any,
            store: {
                getOrganizationsForUser: async () => [{
                    id: 'org-1',
                    name: 'Org One',
                    slug: 'org-one',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: 1,
                    settings: {},
                    myRole: 'member',
                }],
                createFeishuChatSession: async () => true,
                setSessionOrgId: async (sessionId: string, orgId: string) => {
                    setSessionOrgIdCalls.push([sessionId, orgId])
                },
                getBrainConfigByOrg: async () => null,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                resolveSenderInfo: async () => ({
                    name: 'Dev',
                    email: 'dev@example.com',
                }),
            } as any,
        })
        ;(bridge as any).initializeSession = async () => {}

        const sessionId = await (bridge as any).createBrainSession('chat-org-adapter', 'p2p', undefined, {
            text: '帮我查下问题',
            messageId: 'msg-org-adapter',
            senderName: 'Dev',
            senderId: 'ou_user_1',
            senderEmail: null,
            chatType: 'p2p',
            addressed: true,
        })

        expect(sessionId).toBe('session-org-from-adapter')
        expect(machineSelections).toEqual([
            { namespace: 'org-1' },
        ])
        expect(setSessionOrgIdCalls).toEqual([
            ['session-org-from-adapter', 'org-1'],
        ])
    })

    test('resolves org through identity email when senderEmail is missing', async () => {
        const machineSelections: Array<{ namespace: string }> = []
        const setSessionOrgIdCalls: Array<[string, string]> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getOnlineMachinesByNamespace: (namespace: string) => {
                    machineSelections.push({ namespace })
                    return [{
                        id: 'machine-1',
                        namespace,
                        orgId: 'org-1',
                        metadata: { homeDir: '/home/dev' },
                        supportedAgents: ['claude', 'codex'],
                    }]
                },
                spawnSession: async () => ({
                    type: 'success',
                    sessionId: 'session-org-from-identity',
                }),
            } as any,
            store: {
                findResolvedActorByChannelExternalId: async () => ({
                    identityId: 'identity-feishu-1',
                    personId: 'person-1',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    displayName: 'Dev User',
                    email: 'dev@example.com',
                    externalId: 'ou_user_1',
                    accountType: 'human',
                }),
                getOrganizationsForUser: async () => [{
                    id: 'org-1',
                    name: 'Org One',
                    slug: 'org-one',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: 1,
                    settings: {},
                    myRole: 'member',
                }],
                createFeishuChatSession: async () => true,
                setSessionOrgId: async (sessionId: string, orgId: string) => {
                    setSessionOrgIdCalls.push([sessionId, orgId])
                },
                getBrainConfigByOrg: async () => null,
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                resolveSenderInfo: async () => ({
                    name: 'Dev',
                    email: null,
                }),
            } as any,
        })
        ;(bridge as any).initializeSession = async () => {}

        const sessionId = await (bridge as any).createBrainSession('chat-org-identity', 'p2p', undefined, {
            text: '帮我查下问题',
            messageId: 'msg-org-identity',
            senderName: 'Dev',
            senderId: 'ou_user_1',
            senderEmail: null,
            chatType: 'p2p',
            addressed: true,
        })

        expect(sessionId).toBe('session-org-from-identity')
        expect(machineSelections).toEqual([
            { namespace: 'org-1' },
        ])
        expect(setSessionOrgIdCalls).toEqual([
            ['session-org-from-identity', 'org-1'],
        ])
    })

    test('does not create a Brain session when senderEmail matches multiple organizations', async () => {
        const machineSelections: Array<{ namespace: string }> = []

        const bridge = new BrainBridge({
            syncEngine: {
                subscribe: () => () => {},
                getOnlineMachinesByNamespace: (namespace: string) => {
                    machineSelections.push({ namespace })
                    return [{
                        id: 'machine-1',
                        namespace,
                        orgId: 'org-1',
                        metadata: { homeDir: '/home/dev' },
                        supportedAgents: ['claude', 'codex'],
                    }]
                },
                spawnSession: async () => ({
                    type: 'success',
                    sessionId: 'session-should-not-exist',
                }),
            } as any,
            store: {
                getOrganizationsForUser: async () => ([
                    {
                        id: 'org-1',
                        name: 'Org One',
                        slug: 'org-one',
                        createdBy: 'owner@example.com',
                        createdAt: 1,
                        updatedAt: 1,
                        settings: {},
                        myRole: 'member',
                    },
                    {
                        id: 'org-2',
                        name: 'Org Two',
                        slug: 'org-two',
                        createdBy: 'owner@example.com',
                        createdAt: 1,
                        updatedAt: 1,
                        settings: {},
                        myRole: 'member',
                    },
                ]),
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
            } as any,
        })

        const sessionId = await (bridge as any).createBrainSession('chat-org-ambiguous', 'p2p', undefined, {
            text: '帮我查下问题',
            messageId: 'msg-org-ambiguous',
            senderName: 'Dev',
            senderId: 'ou_user_1',
            senderEmail: 'dev@example.com',
            chatType: 'p2p',
            addressed: true,
        })

        expect(sessionId).toBeNull()
        expect(machineSelections).toEqual([])
    })
})
