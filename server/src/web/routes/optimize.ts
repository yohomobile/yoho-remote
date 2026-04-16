import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import type { WebAppEnv } from '../middleware/auth'

const optimizeBodySchema = z.object({
    text: z.string().min(1).max(10000),
    context: z.string().max(20000).optional(),
    terms: z.array(z.string().max(100)).max(200).optional()
})

export function createOptimizeRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/optimize', async (c) => {
        const apiKey = configuration.geminiApiKey
        if (!apiKey) {
            return c.json({ error: 'Gemini API key not configured' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = optimizeBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const { text, context, terms } = parsed.data

        try {
            const t0 = Date.now()
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `直接输出优化后的文本，不要任何解释或额外内容。

你是语音转文字纠错助手。规则：
1. 修正同音字错误和断句问题
2. 修正中英文混合识别错误：英文单词被识别成中文发音（如"瑞艾克特"→"React"）、拼写错误（如"componet"→"component"）、技术术语错误（API、TypeScript、Node.js 等）
3. 保持原意，不添加额外信息
4. 不修改标点符号、空格和缩进
5. 保留所有 @ 开头的文件引用（如 @deploy.sh），不得修改或删除
${terms && terms.length > 0 ? `6. 以下是已知术语列表，仅供参考。只有当输入中某个词明显是该术语的中文音译（如"瑞艾克特"→React）或明显拼写错误时才替换；如果不能确定是同一个词，一律保持原文不变，禁止猜测或强行匹配：\n${terms.map(t => `- ${t}`).join('\n')}` : ''}
${context ? `${terms && terms.length > 0 ? '7' : '6'}. 以下是参考上下文，用于辅助理解用户输入中可能涉及的专有名词、技术术语或背景信息，不要将上下文内容混入输出：\n<context>\n${context}\n</context>` : ''}
用户输入：
${text}`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.3,
                            maxOutputTokens: 2048,
                            thinkingConfig: { thinkingBudget: 0 }
                        }
                    })
                }
            )

            if (!response.ok) {
                console.error(`[Optimize] Gemini API error: ${response.status}`)
                return c.json({ error: 'Gemini API error' }, 502)
            }

            const data = await response.json() as {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> }
                }>
            }
            const optimizedText = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (!optimizedText) {
                return c.json({ error: 'No response from Gemini' }, 502)
            }

            const elapsed = Date.now() - t0
            console.log(`[Optimize] in=${text.length}chars gemini=${elapsed}ms out="${optimizedText.trim().substring(0, 100)}"`)
            return c.json({ optimized: optimizedText.trim() })
        } catch (error) {
            console.error('[Optimize] Failed to call Gemini:', error)
            return c.json({ error: 'Failed to optimize text' }, 500)
        }
    })

    return app
}
