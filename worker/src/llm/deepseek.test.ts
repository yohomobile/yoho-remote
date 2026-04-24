import { afterEach, describe, expect, it } from 'bun:test'
import { DeepSeekClient } from './deepseek'

const originalFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('DeepSeekClient.summarizeTurn', () => {
    it('accepts valid JSON Output and parses it into the L1 summary structure', async () => {
        let requestBody: Record<string, unknown> | null = null

        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>

            return new Response(JSON.stringify({
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: JSON.stringify({
                            summary: '用户要求检查 DeepSeek JSON Output 配置，assistant 已确认字段结构和调用参数。',
                            topic: '配置检查',
                            tools: ['Read', 'Read'],
                            entities: ['deepseek-chat', 'response_format'],
                        }),
                    },
                }],
                usage: {
                    prompt_tokens: 123,
                    completion_tokens: 45,
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': 'req-deepseek-1',
                },
            })
        }) as typeof fetch

        const client = new DeepSeekClient({
            apiKey: 'test-key',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            timeoutMs: 5_000,
        })

        const result = await client.summarizeTurn({
            userText: '检查 worker 的 JSON Output 设置',
            assistantText: '我已经核对完成。',
            toolUses: ['Read worker/src/llm/deepseek.ts'],
            files: ['worker/src/llm/deepseek.ts'],
        })

        expect(requestBody).toMatchObject({
            model: 'deepseek-chat',
            max_tokens: 10_000,
            response_format: { type: 'json_object' },
        })
        expect(result).toEqual({
            summary: '用户要求检查 DeepSeek JSON Output 配置，assistant 已确认字段结构和调用参数。',
            topic: '配置检查',
            tools: ['Read'],
            entities: ['deepseek-chat', 'response_format'],
            memory: {
                action: 'skip',
                text: null,
                reason: null,
            },
            skill: {
                action: 'skip',
                name: null,
                description: null,
                content: null,
                tags: [],
                requiredTools: [],
                antiTriggers: [],
                reason: null,
            },
            tokensIn: 123,
            tokensOut: 45,
            rawResponse: JSON.stringify({
                summary: '用户要求检查 DeepSeek JSON Output 配置，assistant 已确认字段结构和调用参数。',
                topic: '配置检查',
                tools: ['Read', 'Read'],
                entities: ['deepseek-chat', 'response_format'],
            }),
            provider: {
                provider: 'deepseek',
                model: 'deepseek-chat',
                statusCode: 200,
                requestId: 'req-deepseek-1',
                finishReason: 'stop',
                errorCode: null,
            },
        })
    })

    it('sends prompts that preserve failures, fixes, evidence, and operational detail across levels', async () => {
        const requestBodies: Array<Record<string, unknown>> = []

        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
            requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)

            return new Response(JSON.stringify({
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: JSON.stringify({
                            summary: '摘要保留了失败、修正路径、验证依据和最终状态。',
                            topic: '部署验证',
                            tools: ['systemd'],
                            entities: ['DeepSeek', 'pg-boss'],
                        }),
                    },
                }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }) as typeof fetch

        const client = new DeepSeekClient({
            apiKey: 'test-key',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            timeoutMs: 5_000,
        })

        await client.summarizeTurn({
            userText: '部署 worker',
            assistantText: '第一次配置失败，修正后 healthz ready。',
            toolUses: ['systemctl restart yoho-remote-worker'],
            files: [],
        })
        await client.summarizeSegment([
            { topic: '部署验证', summary: 'worker 启动失败，补 token 后 health ready。' },
        ])
        await client.summarizeSession([
            { topic: '部署验证', summary: 'L2 记录了配置失败、修正路径和最终 ready。' },
            { topic: '最后验证', summary: 'orphan L1 记录了 session summary smoke 结果。' },
        ], 2)

        const systemPrompts = requestBodies.map((body) => {
            const messages = body.messages as Array<{ role: string; content: string }>
            return messages.find((message) => message.role === 'system')?.content ?? ''
        })

        expect(requestBodies.map((body) => body.max_tokens)).toEqual([10_000, 10_000, 10_000])

        expect(systemPrompts[0]).toContain('失败/修正路径')
        expect(systemPrompts[0]).toContain('不要把失败过程抹平成')
        expect(systemPrompts[0]).toContain('成功依据')
        expect(systemPrompts[0]).toContain('不要复述 secret 值')
        expect(systemPrompts[0]).toContain('memory 提案规则')
        expect(systemPrompts[0]).toContain('L1 的 skill.action 必须返回 skip')

        expect(systemPrompts[1]).toContain('operational segment')
        expect(systemPrompts[1]).toContain('被废弃方案')
        expect(systemPrompts[1]).toContain('成功结论必须带依据')
        expect(systemPrompts[1]).toContain('skill 提案规则')

        expect(systemPrompts[2]).toContain('长期 operational memory')
        expect(systemPrompts[2]).toContain('不要把过程抹平成')
        expect(systemPrompts[2]).toContain('orphan L1')
        expect(systemPrompts[2]).toContain('未验证项')
        expect(systemPrompts[2]).toContain('memory 提案规则')
    })
})
