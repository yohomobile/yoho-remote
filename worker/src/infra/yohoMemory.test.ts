import { afterEach, describe, expect, it } from 'bun:test'
import {
    buildSkillTags,
    isValuableForL2Skill,
    isValuableForL3Skill,
    YohoMemoryClient,
} from './yohoMemory'

const originalFetch = globalThis.fetch
const originalWarn = console.warn

afterEach(() => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
})

describe('YohoMemoryClient', () => {
    it('posts remember requests with sync mode and bearer auth', async () => {
        let requestUrl = ''
        let requestInit: RequestInit | undefined

        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            requestUrl = String(input)
            requestInit = init
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }) as typeof fetch

        const client = new YohoMemoryClient({
            baseUrl: 'http://127.0.0.1:3100/',
            token: 'token-1',
            timeoutMs: 5000,
        })

        await client.remember({
            input: 'summary',
            source: 'automation',
            approvedForLongTerm: false,
            idempotencyKey: 'k1',
        })

        expect(requestUrl).toBe('http://127.0.0.1:3100/api/remember')
        expect(requestInit?.method).toBe('POST')
        expect(requestInit?.headers).toMatchObject({
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-1',
        })
        expect(JSON.parse(String(requestInit?.body))).toMatchObject({
            input: 'summary',
            source: 'automation',
            approvedForLongTerm: false,
            idempotencyKey: 'k1',
            __sync__: true,
        })
    })

    it('warns without throwing on non-2xx responses and network errors', async () => {
        const warnings: unknown[][] = []
        console.warn = ((...args: unknown[]) => {
            warnings.push(args)
        }) as typeof console.warn

        globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch
        const client = new YohoMemoryClient({
            baseUrl: 'http://127.0.0.1:3100',
            token: '',
            timeoutMs: 5000,
        })

        await expect(client.saveSkill({
            name: 'Skill',
            category: '工程',
            content: 'content',
        })).resolves.toBeUndefined()

        globalThis.fetch = (async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch

        await expect(client.remember({ input: 'summary' })).resolves.toBeUndefined()

        expect(warnings).toHaveLength(2)
        expect(String(warnings[0]?.[0])).toContain('[yohoMemory] skill_save failed')
        expect(String(warnings[1]?.[0])).toContain('[yohoMemory] remember failed')
    })
})

describe('yoho-memory summary helpers', () => {
    it('keeps only specific, tool-backed summaries as skill candidates', () => {
        expect(isValuableForL2Skill({
            topic: 'Worker 摘要接入',
            tools: ['Bash'],
            l1Count: 3,
        })).toBe(true)
        expect(isValuableForL2Skill({
            topic: 'General discussion',
            tools: ['Bash'],
            l1Count: 3,
        })).toBe(false)
        expect(isValuableForL3Skill({
            topic: '部署修复',
            tools: ['Read'],
            sourceCount: 3,
        })).toBe(true)
        expect(isValuableForL3Skill({
            topic: '部署修复',
            tools: ['Read'],
            sourceCount: 4,
        })).toBe(false)
        expect(buildSkillTags(['Read', 'Read'], ['worker', 'Read'])).toEqual(['Read', 'worker'])
    })
})
