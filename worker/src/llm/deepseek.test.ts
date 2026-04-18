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
            response_format: { type: 'json_object' },
        })
        expect(result).toEqual({
            summary: '用户要求检查 DeepSeek JSON Output 配置，assistant 已确认字段结构和调用参数。',
            topic: '配置检查',
            tools: ['Read'],
            entities: ['deepseek-chat', 'response_format'],
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
})
