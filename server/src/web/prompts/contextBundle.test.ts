import { describe, expect, it } from 'bun:test'
import { buildSessionContextBundle, renderSessionContextBundlePrompt } from './contextBundle'
import type { IStore } from '../../store'

describe('ContextBundle prompt', () => {
    it('loads session summaries through optional store hook and renders recall as fallback', async () => {
        const store = {
            getSessionContextSummaries: async () => ({
                latestL3: {
                    id: 'l3-1',
                    level: 3,
                    summary: '最终修复了 orgId 隔离和 L3 defer。',
                    topic: 'summary pipeline',
                    seqStart: null,
                    seqEnd: null,
                    createdAt: 10,
                },
                latestL2: [{
                    id: 'l2-1',
                    level: 2,
                    summary: '片段聚合了 worker L2 并发锁。',
                    topic: 'l2 lock',
                    seqStart: 20,
                    seqEnd: 40,
                    createdAt: 8,
                }],
                recentL1: [{
                    id: 'l1-1',
                    level: 1,
                    summary: '最近一轮调整了 MCP 策略。',
                    topic: 'mcp policy',
                    seqStart: 42,
                    seqEnd: 43,
                    createdAt: 9,
                }],
            }),
        } as unknown as IStore

        const bundle = await buildSessionContextBundle(store, {
            orgId: 'org-a',
            sessionId: 'session-a',
        })
        const prompt = renderSessionContextBundlePrompt(bundle)

        expect(bundle?.summaries.latestL3?.id).toBe('l3-1')
        expect(prompt).toContain('Yoho ContextBundle（自动上下文，优先使用）')
        expect(prompt).toContain('L3 topic=summary pipeline id=l3-1')
        expect(prompt).toContain('L2 seq=20-40 topic=l2 lock id=l2-1')
        expect(prompt).toContain('L1 seq=42-43 topic=mcp policy id=l1-1')
        expect(prompt).toContain('才调用 recall')
    })

    it('returns null when orgId is missing', async () => {
        const bundle = await buildSessionContextBundle({} as IStore, {
            orgId: null,
            sessionId: 'session-a',
        })

        expect(bundle).toBeNull()
        expect(renderSessionContextBundlePrompt(bundle)).toBe('')
    })
})
