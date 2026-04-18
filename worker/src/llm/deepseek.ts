import { z } from 'zod'
import type { WorkerConfig } from '../config'
import type { L1SummaryResult } from '../types'

const l1ResponseSchema = z.object({
    summary: z.string().trim().min(1).max(1_500),
    topic: z.string().trim().min(1).max(80),
    tools: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    entities: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
}).strict()

type DeepSeekConfig = WorkerConfig['deepseek']

type SummarizeTurnInput = {
    userText: string
    assistantText: string
    toolUses: string[]
    files: string[]
}

type DeepSeekError = Error & {
    status?: number
    statusCode?: number
    requestId?: string | null
    finishReason?: string | null
    provider?: string
    model?: string | null
    code?: string | null
}

function getProviderRequestId(headers: Headers): string | null {
    return headers.get('x-request-id')
        ?? headers.get('request-id')
        ?? headers.get('x-trace-id')
        ?? null
}

function createDeepSeekError(
    message: string,
    context: {
        statusCode?: number
        requestId?: string | null
        finishReason?: string | null
        model?: string | null
        code?: string | null
    } = {}
): DeepSeekError {
    const error = new Error(message) as DeepSeekError
    error.status = context.statusCode
    error.statusCode = context.statusCode
    error.requestId = context.requestId ?? null
    error.finishReason = context.finishReason ?? null
    error.provider = 'deepseek'
    error.model = context.model ?? null
    error.code = context.code ?? null
    return error
}

function extractContentText(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : null
    }
    if (!Array.isArray(value)) {
        return null
    }
    const parts = value
        .map((item) => {
            if (!item || typeof item !== 'object') {
                return null
            }
            const record = item as Record<string, unknown>
            if (record.type === 'text' && typeof record.text === 'string') {
                return record.text
            }
            return null
        })
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
    const joined = parts.join('\n').trim()
    return joined.length > 0 ? joined : null
}

function extractJsonObject(raw: string): string {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
        return fenced[1].trim()
    }

    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return raw.slice(firstBrace, lastBrace + 1)
    }

    return raw.trim()
}

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value
    }
    return `${value.slice(0, maxLength - 3)}...`
}

function normalizeStringArray(value: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const entry of value) {
        const trimmed = entry.trim()
        if (trimmed.length === 0 || seen.has(trimmed)) {
            continue
        }
        seen.add(trimmed)
        result.push(trimmed)
    }
    return result
}

function parseJsonContent(raw: string): unknown {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
        throw new Error('DeepSeek returned empty content in JSON mode')
    }

    try {
        return JSON.parse(trimmed)
    } catch (firstError) {
        const extracted = extractJsonObject(trimmed)
        if (extracted !== trimmed) {
            try {
                return JSON.parse(extracted)
            } catch {
                // Fall through to the explicit invalid JSON error below.
            }
        }

        const message = firstError instanceof Error ? firstError.message : String(firstError)
        throw new Error(`DeepSeek returned invalid JSON: ${message}`)
    }
}

export class DeepSeekClient {
    constructor(private readonly config: DeepSeekConfig) {}

    async summarizeTurn(input: SummarizeTurnInput): Promise<L1SummaryResult> {
        const systemPrompt = [
            '你是 coding session 的 L1 turn 摘要器。',
            '你会收到一次用户请求、该轮 assistant 的输出、工具调用和相关文件。',
            '必须只返回一个合法的 json object，不要 markdown，不要代码块，不要额外解释。',
            'json schema:',
            '{',
            '  "summary": "2-3 句话总结用户目标、assistant 实际操作、当前结果或阻塞",',
            '  "topic": "一个简短主题短语",',
            '  "tools": ["实际使用过的工具名或命令类别"],',
            '  "entities": ["文件、库、命令、服务、API 等技术实体"]',
            '}',
            '字段要求：',
            '- summary 必填，保留关键文件、命令、错误和结果，不要编造。',
            '- topic 必填，简短明确，例如“Bug 修复”“配置调整”“调研”。',
            '- tools / entities 必须是数组；没有就返回空数组 []。',
            '- 所有字符串字段都不要返回空字符串。',
            '英文技术名保持原样。',
        ].join('\n')

        const userPrompt = [
            '请基于以下 turn 内容生成 json object：',
            '',
            'userText:',
            truncate(input.userText || '(empty)', 4_000),
            '',
            'assistantText:',
            truncate(input.assistantText || '(empty)', 8_000),
            '',
            'toolUses:',
            input.toolUses.length > 0 ? input.toolUses.join('\n') : '(none)',
            '',
            'files:',
            input.files.length > 0 ? input.files.join('\n') : '(none)',
        ].join('\n')

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
                model: this.config.model,
                temperature: 0.1,
                max_tokens: 600,
                stream: false,
                response_format: {
                    type: 'json_object',
                },
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
            signal: AbortSignal.timeout(this.config.timeoutMs),
        })
        const requestId = getProviderRequestId(response.headers)

        if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw createDeepSeekError(body || `DeepSeek request failed with ${response.status}`, {
                statusCode: response.status,
                requestId,
                model: this.config.model,
            })
        }

        let data: {
            model?: string
            choices?: Array<{
                finish_reason?: string | null
                message?: {
                    content?: unknown
                }
            }>
            usage?: {
                prompt_tokens?: number
                completion_tokens?: number
            }
        }
        try {
            data = await response.json() as {
                model?: string
                choices?: Array<{
                    finish_reason?: string | null
                    message?: {
                        content?: unknown
                    }
                }>
                usage?: {
                    prompt_tokens?: number
                    completion_tokens?: number
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw createDeepSeekError(`DeepSeek returned invalid JSON response: ${message}`, {
                statusCode: response.status,
                requestId,
                model: this.config.model,
            })
        }
        const resolvedModel = typeof data.model === 'string' && data.model.trim().length > 0
            ? data.model
            : this.config.model

        const choice = data.choices?.[0]
        if (!choice) {
            throw createDeepSeekError('DeepSeek returned no choices', {
                statusCode: response.status,
                requestId,
                model: resolvedModel,
            })
        }
        const finishReason = choice.finish_reason ?? null

        if (finishReason && finishReason !== 'stop') {
            throw createDeepSeekError(`DeepSeek JSON output did not finish cleanly: finish_reason=${finishReason}`, {
                statusCode: response.status,
                requestId,
                finishReason,
                model: resolvedModel,
            })
        }

        const content = extractContentText(choice.message?.content)
        if (!content) {
            throw createDeepSeekError('DeepSeek returned empty content', {
                statusCode: response.status,
                requestId,
                finishReason,
                model: resolvedModel,
            })
        }

        let jsonValue: unknown
        try {
            jsonValue = parseJsonContent(content)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw createDeepSeekError(message, {
                statusCode: response.status,
                requestId,
                finishReason,
                model: resolvedModel,
            })
        }
        const parsedResult = l1ResponseSchema.safeParse(jsonValue)
        if (!parsedResult.success) {
            throw createDeepSeekError(
                `DeepSeek JSON schema validation failed: ${JSON.stringify(parsedResult.error.flatten().fieldErrors)}`,
                {
                    statusCode: response.status,
                    requestId,
                    finishReason,
                    model: resolvedModel,
                }
            )
        }
        const parsed = parsedResult.data

        return {
            summary: parsed.summary,
            topic: parsed.topic,
            tools: normalizeStringArray(parsed.tools),
            entities: normalizeStringArray(parsed.entities),
            tokensIn: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
            tokensOut: typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null,
            rawResponse: content,
            provider: {
                provider: 'deepseek',
                model: resolvedModel,
                statusCode: response.status,
                requestId,
                finishReason,
                errorCode: null,
            },
        }
    }
}
