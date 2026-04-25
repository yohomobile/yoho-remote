import { afterEach, describe, expect, it } from 'bun:test'
import {
    appendSelfSystemPrompt,
    extractSelfSystemConfig,
    matchesProfileScope,
    resolveSessionSelfSystemContext,
} from './selfSystem'
import type { StoredAIProfile } from '../store'

const originalFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('selfSystem', () => {
    it('extracts self system config from BrainConfig.extra', () => {
        expect(extractSelfSystemConfig({
            selfSystem: {
                enabled: true,
                defaultProfileId: 'profile-1',
                memoryProvider: 'none',
            },
        })).toEqual({
            enabled: true,
            defaultProfileId: 'profile-1',
            memoryProvider: 'none',
        })

        expect(extractSelfSystemConfig(null)).toEqual({
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        })
    })

    it('builds prompt and metadata patch from AI profile plus controlled yoho-memory self profile', async () => {
        const requests: Array<{ url: string; body: any }> = []
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            requests.push({
                url: String(input),
                body: init?.body ? JSON.parse(String(init.body)) : null,
            })
            return new Response(JSON.stringify({
                result: {
                    content: 'K1 长期偏好：遇到模糊需求时先澄清目标，再拆执行路径。',
                    sources: ['memories/self/preferences.md'],
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'brain',
            store: {
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
                    specialties: ['TypeScript', 'Systems'],
                    behaviorAnchors: [],
                    personality: '冷静、结构化',
                    greetingTemplate: '先把问题拆干净。',
                    preferredProjects: ['yoho-remote'],
                    workStyle: '先澄清，再推进',
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
        })

        expect(requests).toHaveLength(1)
        expect(requests[0].url).toBe('http://localhost:3100/api/self_profile_get')
        expect(requests[0].body).toEqual({
            agentId: 'K1',
            profileMode: 'brain-init',
        })
        expect(context.metadataPatch).toEqual({
            selfSystemEnabled: true,
            selfProfileId: 'profile-1',
            selfProfileName: 'K1',
            selfProfileResolved: true,
            selfMemoryProvider: 'yoho-memory',
            selfMemoryAttached: true,
            selfMemoryStatus: 'attached',
        })
        expect(context.prompt).toContain('## K1 自我系统')
        expect(context.prompt).toContain('名称：K1')
        expect(context.prompt).toContain('长期自我记忆（yoho-memory）')
        expect(context.prompt).toContain('K1 长期偏好')
        expect(appendSelfSystemPrompt('#InitPrompt', context.prompt)).toContain('## K1 自我系统')
    })

    it('falls back to recall when controlled self profile endpoint is unavailable', async () => {
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
            if (String(input).endsWith('/self_profile_get')) {
                return new Response('', { status: 404 })
            }
            return new Response(JSON.stringify({
                result: {
                    answer: 'K1 default 长期偏好：遇到模糊需求时先澄清目标，再拆执行路径。',
                    filesSearched: 1,
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'brain',
            store: {
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
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(context.metadataPatch.selfMemoryStatus).toBe('attached')
        expect(context.prompt).toContain('长期自我记忆（yoho-memory）')
        expect(context.prompt).toContain('K1 default 长期偏好')
    })

    it('returns metadata-only context when profile is missing or mismatched', async () => {
        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            store: {
                getBrainConfigByOrg: async () => ({
                    namespace: 'org:org-1',
                    orgId: 'org-1',
                    agent: 'claude',
                    claudeModelMode: 'opus',
                    codexModel: 'gpt-5.4',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: 'missing-profile',
                            memoryProvider: 'yoho-memory',
                        },
                    },
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getAIProfile: async () => ({
                    id: 'missing-profile',
                    orgId: 'org-2',
                    namespace: 'org:org-2',
                    name: 'Other',
                }),
            } as any,
        })

        expect(context.prompt).toBeNull()
        expect(context.metadataPatch).toEqual({
            selfSystemEnabled: true,
            selfProfileId: 'missing-profile',
            selfProfileName: null,
            selfProfileResolved: false,
            selfMemoryProvider: 'yoho-memory',
            selfMemoryAttached: false,
            selfMemoryStatus: 'skipped',
        })
    })

    it('marks yoho-memory recall failures as error without blocking profile prompt injection', async () => {
        globalThis.fetch = (async () => {
            throw new Error('timeout')
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'brain',
            store: {
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
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(context.prompt).toContain('## K1 自我系统')
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
        expect(context.metadataPatch.selfMemoryStatus).toBe('error')
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
    })

    it('does not attach low-confidence yoho-memory recall as self memory', async () => {
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
            if (String(input).endsWith('/self_profile_get')) {
                return new Response('', { status: 404 })
            }
            return new Response(JSON.stringify({
                answer: 'K1 可能喜欢极简回答。',
                filesSearched: 1,
                confidence: 0.2,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'brain',
            store: {
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
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(context.metadataPatch.selfMemoryStatus).toBe('empty')
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
    })

    it('prefers user self-system config over org default and skips memory for regular sessions', async () => {
        const requests: string[] = []
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
            requests.push(String(input))
            return new Response('', { status: 500 })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            userEmail: 'dev@example.com',
            includeMemory: false,
            store: {
                getUserSelfSystemConfig: async () => ({
                    orgId: 'org-1',
                    userEmail: 'dev@example.com',
                    enabled: true,
                    defaultProfileId: 'profile-user',
                    memoryProvider: 'yoho-memory',
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getBrainConfigByOrg: async () => ({
                    namespace: 'org:org-1',
                    orgId: 'org-1',
                    agent: 'claude',
                    claudeModelMode: 'opus',
                    codexModel: 'gpt-5.4',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: 'profile-org',
                            memoryProvider: 'yoho-memory',
                        },
                    },
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getAIProfile: async (id: string) => ({
                    id,
                    orgId: 'org-1',
                    namespace: 'org:org-1',
                    name: id === 'profile-user' ? 'User Style' : 'Other Style',
                    role: 'developer',
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(requests).toEqual([])
        expect(context.metadataPatch.selfProfileId).toBe('profile-user')
        expect(context.metadataPatch.selfProfileName).toBe('User Style')
        expect(context.metadataPatch.selfMemoryStatus).toBe('skipped')
        expect(context.prompt).toContain('名称：User Style')
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
    })

    it('returns disabled context when org config is missing', async () => {
        let getAIProfileCalled = false
        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            store: {
                getUserSelfSystemConfig: async () => null,
                getBrainConfigByOrg: async () => null,
                getAIProfile: async () => {
                    getAIProfileCalled = true
                    return null
                },
            } as any,
        })

        expect(getAIProfileCalled).toBe(false)
        expect(context.prompt).toBeNull()
        expect(context.metadataPatch.selfSystemEnabled).toBe(false)
        expect(context.metadataPatch.selfProfileId).toBeNull()
        expect(context.metadataPatch.selfMemoryStatus).toBe('disabled')
    })

    it('returns disabled context when orgId is missing and never checks legacy namespace config', async () => {
        let getLegacyBrainConfigCalled = false
        let getAIProfileCalled = false

        const context = await resolveSessionSelfSystemContext({
            userEmail: 'dev@example.com',
            store: {
                getUserSelfSystemConfig: async () => ({
                    orgId: 'org-1',
                    userEmail: 'dev@example.com',
                    enabled: true,
                    defaultProfileId: 'profile-user',
                    memoryProvider: 'yoho-memory',
                    updatedAt: 1,
                    updatedBy: null,
                }),
                getBrainConfig: async () => {
                    getLegacyBrainConfigCalled = true
                    return {
                        namespace: 'default',
                        orgId: null,
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
                    }
                },
                getAIProfile: async () => {
                    getAIProfileCalled = true
                    return null
                },
            } as any,
        })

        expect(getLegacyBrainConfigCalled).toBe(false)
        expect(getAIProfileCalled).toBe(false)
        expect(context.prompt).toBeNull()
        expect(context.metadataPatch.selfSystemEnabled).toBe(false)
        expect(context.metadataPatch.selfProfileId).toBeNull()
        expect(context.metadataPatch.selfMemoryStatus).toBe('disabled')
    })

    it('skips entire self system for brain-child source', async () => {
        let fetchCalled = false
        globalThis.fetch = (async () => {
            fetchCalled = true
            return new Response('', { status: 200 })
        }) as unknown as typeof fetch

        let getAIProfileCalled = false
        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'brain-child',
            store: {
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
                getAIProfile: async () => {
                    getAIProfileCalled = true
                    return null
                },
            } as any,
        })

        expect(fetchCalled).toBe(false)
        expect(getAIProfileCalled).toBe(false)
        expect(context.prompt).toBeNull()
        expect(context.metadataPatch.selfProfileResolved).toBe(false)
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
        expect(context.metadataPatch.selfMemoryStatus).toBe('skipped')
    })

    it('injects header but skips memory for webapp source', async () => {
        let fetchCalled = false
        globalThis.fetch = (async () => {
            fetchCalled = true
            return new Response(JSON.stringify({
                result: {
                    content: '不应被读取',
                    sources: ['memories/self/preferences.md'],
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'webapp',
            store: {
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
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(fetchCalled).toBe(false)
        expect(context.prompt).toContain('## K1 自我系统')
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
        expect(context.metadataPatch.selfProfileResolved).toBe(true)
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
        expect(context.metadataPatch.selfMemoryStatus).toBe('skipped')
    })

    it('injects header but skips memory for orchestrator source', async () => {
        let fetchCalled = false
        globalThis.fetch = (async () => {
            fetchCalled = true
            return new Response('', { status: 200 })
        }) as unknown as typeof fetch

        const context = await resolveSessionSelfSystemContext({
            orgId: 'org-1',
            source: 'orchestrator',
            store: {
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
                    specialties: [],
                    behaviorAnchors: [],
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
        })

        expect(fetchCalled).toBe(false)
        expect(context.prompt).toContain('## K1 自我系统')
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
    })

    it('matchesProfileScope rejects null orgId with warning', () => {
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = ((...args: unknown[]) => {
            warnings.push(args.map(String).join(' '))
        }) as typeof console.warn

        try {
            const profile = {
                id: 'profile-1',
                orgId: 'org-1',
                namespace: 'org:org-1',
                name: 'K1',
                role: 'architect',
                specialties: [],
                personality: null,
                greetingTemplate: null,
                preferredProjects: [],
                workStyle: null,
                avatarEmoji: '🤖',
                status: 'idle',
                stats: { tasksCompleted: 0, activeMinutes: 0, lastActiveAt: null },
                createdAt: 1,
                updatedAt: 1,
            } as unknown as StoredAIProfile

            expect(matchesProfileScope(profile, null)).toBe(false)
            expect(warnings.some(w => w.includes('session orgId is null'))).toBe(true)
            warnings.length = 0

            expect(matchesProfileScope(profile, 'org-1')).toBe(true)
            expect(warnings.length).toBe(0)

            expect(matchesProfileScope(profile, 'org-2')).toBe(false)
            expect(warnings.length).toBe(0)
        } finally {
            console.warn = originalWarn
        }
    })
})
