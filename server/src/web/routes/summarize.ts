import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import type { WebAppEnv } from '../middleware/auth'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import { requireSyncEngine, requireSessionWithShareCheck } from './guards'

const CHAR_CAP = 30000

const summarizeBodySchema = z.object({
    text: z.string().min(1).optional(),
    sessionId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
}).refine(d => d.text || d.sessionId, { message: 'Either text or sessionId is required' })

type SummarizeResponse = {
    summary: string
    terms: string[]
}

function extractMessageText(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null
    const record = content as Record<string, unknown>
    const inner = record.content
    if (typeof inner === 'string') return inner.trim() || null
    if (inner && typeof inner === 'object') {
        const obj = inner as Record<string, unknown>
        if (obj.type === 'text' && typeof obj.text === 'string') return obj.text.trim() || null
        if (obj.type === 'codex') {
            const data = obj.data as Record<string, unknown>
            if (data?.type === 'message' && typeof data.message === 'string') return data.message.trim() || null
        }
    }
    return null
}

export function createSummarizeRoutes(
    getSyncEngine: () => SyncEngine | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/summarize', async (c) => {
        const apiKey = configuration.geminiApiKey
        if (!apiKey) {
            return c.json({ error: 'Gemini API key not configured' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = summarizeBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let inputText: string

        if (parsed.data.sessionId) {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine

            const sessionResult = await requireSessionWithShareCheck(c, engine, store, parsed.data.sessionId)
            if (sessionResult instanceof Response) return sessionResult

            const limit = parsed.data.limit ?? 20
            const messages = await store.getMessages(parsed.data.sessionId, limit)
            // getMessages returns newest-first; reverse for chronological order
            const chronological = [...messages].reverse()

            const lines = chronological
                .map(m => {
                    const record = m.content as Record<string, unknown>
                    const role = record?.role === 'assistant' ? 'Assistant' : 'User'
                    const text = extractMessageText(m.content)
                    if (!text) return null
                    return `[${role}]: ${text}`
                })
                .filter((l): l is string => l !== null)

            // 不足两轮（≤2条有效消息）没有总结意义
            if (lines.length <= 2) {
                return c.json({ summary: '', terms: [] })
            }

            // 总字符超 CHAR_CAP 时截断最早的消息
            while (lines.length > 1) {
                const total = lines.reduce((sum, l) => sum + l.length, 0)
                if (total <= CHAR_CAP) break
                lines.shift()
            }

            inputText = lines.join('\n\n')
        } else {
            const raw = parsed.data.text!
            inputText = raw.length > CHAR_CAP ? raw.slice(-CHAR_CAP) : raw
        }

        try {
            const t0 = Date.now()
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `请对以下文本进行分析，严格按照 JSON 格式输出，不要任何额外内容：
{
  "summary": "用1-3句话概括文本的核心内容",
  "terms": ["术语1", "术语2", ...]
}

terms 要求：
- 提取文本中出现的专有名词、技术术语、产品名称、人名、缩写等
- 每个术语使用其正确/标准写法（如 React、TypeScript、API、Node.js）
- 不包含普通常用词

文本：
${inputText}`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.3,
                            maxOutputTokens: 1024,
                            thinkingConfig: { thinkingBudget: 0 },
                            responseMimeType: 'application/json',
                        }
                    })
                }
            )

            if (!response.ok) {
                console.error(`[Summarize] Gemini API error: ${response.status}`)
                return c.json({ error: 'Gemini API error' }, 502)
            }

            const data = await response.json() as {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> }
                }>
            }
            const raw = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (!raw) {
                return c.json({ error: 'No response from Gemini' }, 502)
            }

            let result: SummarizeResponse
            try {
                result = JSON.parse(raw) as SummarizeResponse
            } catch {
                console.error('[Summarize] Failed to parse Gemini JSON response:', raw)
                return c.json({ error: 'Invalid response format from Gemini' }, 502)
            }

            const elapsed = Date.now() - t0
            const summary = result.summary ?? ''
            const terms = Array.isArray(result.terms) ? result.terms : []
            console.log(`[Summarize] in=${inputText.length}chars gemini=${elapsed}ms summary="${summary.substring(0, 80)}" terms=[${terms.join(', ')}]`)
            return c.json({ summary, terms })
        } catch (error) {
            console.error('[Summarize] Failed to call Gemini:', error)
            return c.json({ error: 'Failed to summarize text' }, 500)
        }
    })

    return app
}
