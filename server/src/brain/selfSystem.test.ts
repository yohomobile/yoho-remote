import { afterEach, describe, expect, it } from 'bun:test'
import { appendSelfSystemPrompt, extractSelfSystemConfig, resolveBrainSelfSystemContext } from './selfSystem'

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

    it('builds prompt and metadata patch from AI profile plus yoho-memory recall', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            answer: 'K1 长期偏好：遇到模糊需求时先澄清目标，再拆执行路径。',
            filesSearched: 1,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

        const context = await resolveBrainSelfSystemContext({
            namespace: 'default',
            store: {
                getBrainConfig: async () => ({
                    namespace: 'default',
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
                    namespace: 'default',
                    name: 'K1',
                    role: 'architect',
                    specialties: ['TypeScript', 'Systems'],
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

    it('returns metadata-only context when profile is missing or mismatched', async () => {
        const context = await resolveBrainSelfSystemContext({
            namespace: 'default',
            store: {
                getBrainConfig: async () => ({
                    namespace: 'default',
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
                    namespace: 'other',
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

        const context = await resolveBrainSelfSystemContext({
            namespace: 'default',
            store: {
                getBrainConfig: async () => ({
                    namespace: 'default',
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
                    namespace: 'default',
                    name: 'K1',
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
        })

        expect(context.prompt).toContain('## K1 自我系统')
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
        expect(context.metadataPatch.selfMemoryStatus).toBe('error')
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
    })

    it('does not attach low-confidence yoho-memory recall as self memory', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            answer: 'K1 可能喜欢极简回答。',
            filesSearched: 1,
            confidence: 0.2,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

        const context = await resolveBrainSelfSystemContext({
            namespace: 'default',
            store: {
                getBrainConfig: async () => ({
                    namespace: 'default',
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
                    namespace: 'default',
                    name: 'K1',
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
        })

        expect(context.metadataPatch.selfMemoryStatus).toBe('empty')
        expect(context.metadataPatch.selfMemoryAttached).toBe(false)
        expect(context.prompt).not.toContain('长期自我记忆（yoho-memory）')
    })
})
