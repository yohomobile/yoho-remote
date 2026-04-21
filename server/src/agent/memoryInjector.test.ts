import { describe, expect, test } from 'bun:test'
import { MemoryInjector } from './memoryInjector'
import type { StoredAIProfileMemory } from '../store/interface'

function makeMemory(overrides: Partial<StoredAIProfileMemory>): StoredAIProfileMemory {
    const now = Date.now()
    return {
        id: overrides.id ?? 'mem',
        namespace: 'default',
        profileId: 'profile-1',
        memoryType: 'knowledge',
        content: '可靠记忆',
        importance: 0.7,
        accessCount: 0,
        lastAccessedAt: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
        metadata: null,
        ...overrides,
    }
}

describe('MemoryInjector', () => {
    test('filters expired, conflicted, stale, and low-relevance memories before injection', async () => {
        const now = Date.now()
        const accessed: string[] = []
        const memories = [
            makeMemory({ id: 'good', content: '当前项目可靠事实', metadata: { relevance: 0.9 } }),
            makeMemory({ id: 'expired', content: '过期事实', expiresAt: now - 1 }),
            makeMemory({ id: 'conflict', content: '冲突事实', metadata: { conflictStatus: 'open' } }),
            makeMemory({ id: 'low-relevance', content: '弱相关事实', metadata: { confidence: 0.1 } }),
            makeMemory({
                id: 'stale',
                content: '很旧的低重要性上下文',
                importance: 0.4,
                updatedAt: now - 400 * 24 * 60 * 60 * 1000,
            }),
            makeMemory({
                id: 'stable-preference',
                memoryType: 'preference',
                content: '稳定偏好',
                importance: 0.4,
                updatedAt: now - 400 * 24 * 60 * 60 * 1000,
            }),
        ]

        const injector = new MemoryInjector({
            getProfileMemories: async () => memories,
            updateMemoryAccess: async (_namespace: string, memoryId: string) => {
                accessed.push(memoryId)
            },
        } as any, {
            maxMemories: 10,
            maxPromptLength: 3000,
        })

        const result = await injector.injectMemories('default', 'profile-1')

        expect(result.memories.map(memory => memory.id)).toEqual(['good', 'stable-preference'])
        expect(result.promptFragment).toContain('当前项目可靠事实')
        expect(result.promptFragment).toContain('稳定偏好')
        expect(result.promptFragment).not.toContain('过期事实')
        expect(result.promptFragment).not.toContain('冲突事实')
        expect(accessed).toEqual(['good', 'stable-preference'])
    })
})
