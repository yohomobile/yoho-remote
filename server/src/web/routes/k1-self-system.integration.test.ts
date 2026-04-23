import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createSettingsRoutes } from './settings'
import { createSessionsRoutes } from './sessions'

function createStoredSession(overrides: Partial<StoredSession>): StoredSession {
    return {
        id: 'session-default',
        tag: null,
        namespace: 'default',
        machineId: 'machine-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: null,
        orgId: null,
        metadata: {
            path: '/tmp/default',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: null,
        todosUpdatedAt: null,
        active: true,
        activeAt: Date.now(),
        thinking: false,
        thinkingAt: null,
        seq: 0,
        advisorTaskId: null,
        creatorChatId: null,
        advisorMode: false,
        advisorPromptInjected: false,
        rolePromptSent: false,
        permissionMode: null,
        modelMode: null,
        modelReasoningEffort: null,
        fastMode: null,
        terminationReason: null,
        lastMessageAt: null,
        activeMonitors: null,
        ...overrides,
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return
        }
        await Bun.sleep(10)
    }
}

describe('K1 self system phase 1 flow', () => {
    it('persists settings, injects brain-init self profile, and exposes session metadata for UI summaries', async () => {
        const originalFetch = globalThis.fetch
        const fetchCalls: Array<{ url: string; body: unknown }> = []
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = input.toString()
            fetchCalls.push({
                url,
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
            })
            return new Response(JSON.stringify({
                result: {
                    content: 'K1 默认先收敛任务边界，再决定是否分派子 session。',
                    sources: ['memories/self/identity.md', 'memories/self/preferences.md'],
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        try {
            let brainConfig: Record<string, unknown> | null = null
            const storedSessions: StoredSession[] = []
            let liveSession: any = null
            const patchCalls: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
            const sendCalls: Array<{ sessionId: string; text: string }> = []

            const profile = {
                id: 'profile-k1',
                namespace: 'default',
                name: 'K1',
                role: 'architect',
                specialties: ['TypeScript', '系统编排'],
                personality: '结构化',
                greetingTemplate: '先把目标和边界说清楚。',
                preferredProjects: ['yoho-remote', 'yoho-memory'],
                workStyle: '先收敛，再分派，再验收',
                avatarEmoji: '🤖',
                status: 'idle',
                stats: {
                    tasksCompleted: 0,
                    activeMinutes: 0,
                    lastActiveAt: null,
                },
                createdAt: 1,
                updatedAt: 1,
            }

            const store = {
                getAIProfile: async (id: string) => id === profile.id ? profile : null,
                getBrainConfig: async () => brainConfig,
                setBrainConfig: async (namespace: string, config: Record<string, unknown>) => {
                    brainConfig = {
                        namespace,
                        agent: config.agent,
                        claudeModelMode: config.claudeModelMode ?? 'sonnet',
                        codexModel: config.codexModel ?? 'gpt-5.4',
                        extra: config.extra ?? {},
                        updatedAt: 1,
                        updatedBy: config.updatedBy ?? null,
                    }
                    return brainConfig
                },
                setSessionCreatedBy: async (sessionId: string, email: string) => {
                    const stored = storedSessions.find((session) => session.id === sessionId)
                    if (stored) {
                        stored.createdBy = email
                    }
                    return true
                },
                setSessionOrgId: async () => true,
                getSessions: async () => storedSessions,
                getSessionsSharedWithUser: async () => [],
                getViewOthersSessions: async () => false,
                getUsersWithShareAllSessions: async () => [],
            } as any

            const engine = {
                getMachine: (id: string) => id === 'machine-1'
                    ? {
                        id: 'machine-1',
                        active: true,
                        namespace: 'default',
                        metadata: { homeDir: '/home/dev' },
                        supportedAgents: ['claude', 'codex'],
                    }
                    : null,
                getOnlineMachinesByNamespace: () => [],
                spawnSession: async (machineId: string, directory: string, agent: string, _yolo: boolean, options?: Record<string, unknown>) => {
                    const now = Date.now()
                    liveSession = {
                        id: 'brain-session-k1',
                        namespace: 'default',
                        createdAt: now,
                        updatedAt: now,
                        active: true,
                        activeAt: now,
                        lastMessageAt: null,
                        createdBy: null,
                        metadata: {
                            path: directory,
                            source: options?.source,
                            machineId,
                            runtimeAgent: agent,
                            brainPreferences: options?.brainPreferences,
                        },
                        agentState: null,
                        todos: null,
                        thinking: false,
                        modelMode: null,
                        modelReasoningEffort: null,
                        fastMode: null,
                        activeMonitors: [],
                        terminationReason: null,
                    }
                    storedSessions.push(createStoredSession({
                        id: liveSession.id,
                        namespace: liveSession.namespace,
                        machineId,
                        createdAt: now,
                        updatedAt: now,
                        activeAt: now,
                        metadata: { ...liveSession.metadata },
                    }))
                    return { type: 'success', sessionId: liveSession.id }
                },
                getSession: (id: string) => id === liveSession?.id ? liveSession : null,
                getSessions: () => liveSession ? [liveSession] : [],
                getSessionsByNamespace: () => liveSession ? [liveSession] : [],
                patchSessionMetadata: async (sessionId: string, patch: Record<string, unknown>) => {
                    patchCalls.push({ sessionId, patch })
                    if (liveSession?.id === sessionId) {
                        liveSession.metadata = {
                            ...liveSession.metadata,
                            ...patch,
                        }
                    }
                    const stored = storedSessions.find((session) => session.id === sessionId)
                    if (stored) {
                        stored.metadata = {
                            ...(stored.metadata as Record<string, unknown> | null ?? {}),
                            ...patch,
                        }
                    }
                    return { ok: true }
                },
                waitForSocketInRoom: async () => true,
                sendMessage: async (sessionId: string, payload: { text: string }) => {
                    sendCalls.push({ sessionId, text: payload.text })
                    return true
                },
                subscribe: () => () => {},
                isSessionStartupRecovering: () => false,
            } as any

            const app = new Hono<WebAppEnv>()
            app.use('/api/*', async (c, next) => {
                c.set('namespace', 'default')
                c.set('role', 'operator')
                c.set('email', 'operator@example.com')
                c.set('name', 'Guang Yang')
                c.set('orgs', [])
                await next()
            })
            app.route('/api', createSettingsRoutes(store))
            app.route('/api', createSessionsRoutes(() => engine, () => null, store))

            const settingsResponse = await app.request('/api/settings/brain-config', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    agent: 'claude',
                    claudeModelMode: 'sonnet',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: profile.id,
                            memoryProvider: 'yoho-memory',
                        },
                    },
                }),
            })
            expect(settingsResponse.status).toBe(200)
            expect(await settingsResponse.json()).toEqual({
                ok: true,
                config: expect.objectContaining({
                    namespace: 'default',
                    updatedBy: 'operator@example.com',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: profile.id,
                            memoryProvider: 'yoho-memory',
                        },
                    },
                }),
            })

            const createResponse = await app.request('/api/brain/sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: 'machine-1',
                    agent: 'claude',
                    childClaudeModels: ['sonnet'],
                    childCodexModels: ['gpt-5.4'],
                }),
            })
            expect(createResponse.status).toBe(200)
            expect(await createResponse.json()).toEqual({ type: 'success', sessionId: 'brain-session-k1' })

            await waitFor(() => sendCalls.length > 0 && patchCalls.some((call) => call.patch.selfMemoryStatus === 'attached'))

            expect(fetchCalls[0]).toEqual({
                url: expect.stringContaining('/self_profile_get'),
                body: {
                    agentId: 'K1',
                    profileMode: 'brain-init',
                },
            })
            expect(patchCalls).toContainEqual({
                sessionId: 'brain-session-k1',
                patch: {
                    selfSystemEnabled: true,
                    selfProfileId: profile.id,
                    selfProfileName: 'K1',
                    selfProfileResolved: true,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: true,
                    selfMemoryStatus: 'attached',
                },
            })
            expect(sendCalls[0]?.text).toContain('## K1 自我系统')
            expect(sendCalls[0]?.text).toContain('K1 默认先收敛任务边界')

            const listResponse = await app.request('/api/sessions')
            expect(listResponse.status).toBe(200)
            const listPayload = await listResponse.json() as {
                sessions: Array<{ id: string; metadata: Record<string, unknown> | null }>
            }
            expect(listPayload.sessions).toHaveLength(1)
            expect(listPayload.sessions[0]).toEqual(expect.objectContaining({
                id: 'brain-session-k1',
                metadata: expect.objectContaining({
                    source: 'brain',
                    selfSystemEnabled: true,
                    selfProfileId: profile.id,
                    selfProfileName: 'K1',
                    selfProfileResolved: true,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: true,
                    selfMemoryStatus: 'attached',
                }),
            }))
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
