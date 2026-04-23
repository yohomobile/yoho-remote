import { z } from 'zod'
import type { WorkerConfig } from '../config'
import type { L1SummaryResult, LLMSummaryResult } from '../types'

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
            '  "summary": "2-4 句话总结本 turn 的用户目标、assistant 实际操作、失败/修正路径、当前结果或阻塞",',
            '  "topic": "一个简短主题短语",',
            '  "tools": ["实际影响结果的工具名或命令类别"],',
            '  "entities": ["关键文件、库、命令、服务、API、配置项等技术实体"]',
            '}',
            '字段要求：',
            '- summary 必填，优先保留本 turn 的增量信息：改了什么、验证了什么、失败了什么、如何修正、最终停在哪。',
            '- 如果出现错误、误判、回滚、配置不匹配、测试失败或外部依赖问题，必须写进 summary；不要把失败过程抹平成“已成功”。',
            '- 如果确认成功，要写清楚成功依据，例如通过的命令、状态码、health endpoint、DB 写入或测试名称。',
            '- 涉及密钥或 token 时只写“已配置/已保存/已脱敏”，不要复述 secret 值。',
            '- topic 必填，简短明确，例如“Worker 部署”“DeepSeek 配置修正”“DB 连接排查”。',
            '- tools / entities 必须是数组；只保留对结果有影响的项，避免机械重复；没有就返回空数组 []。',
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

    private async callDeepSeek(
        systemPrompt: string,
        userPrompt: string,
        maxTokens: number,
    ): Promise<{ content: string; resolvedModel: string; requestId: string | null; finishReason: string | null; tokensIn: number | null; tokensOut: number | null; status: number }> {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
                model: this.config.model,
                temperature: 0.1,
                max_tokens: maxTokens,
                stream: false,
                response_format: { type: 'json_object' },
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
            choices?: Array<{ finish_reason?: string | null; message?: { content?: unknown } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        try {
            data = await response.json() as typeof data
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

        return {
            content,
            resolvedModel,
            requestId,
            finishReason,
            tokensIn: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
            tokensOut: typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null,
            status: response.status,
        }
    }

    private parseAndValidate<T>(
        raw: string,
        schema: z.ZodType<T>,
        context: { statusCode: number; requestId: string | null; finishReason: string | null; model: string },
    ): T {
        let jsonValue: unknown
        try {
            jsonValue = parseJsonContent(raw)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw createDeepSeekError(message, context)
        }
        const parsed = schema.safeParse(jsonValue)
        if (!parsed.success) {
            throw createDeepSeekError(
                `DeepSeek JSON schema validation failed: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
                context,
            )
        }
        return parsed.data
    }

    async summarizeSegment(l1Summaries: Array<{ summary: string; topic: string | null }>): Promise<LLMSummaryResult> {
        const systemPrompt = [
            '你是 coding session 的 L2 segment 摘要器。',
            '你会收到若干个 L1 turn 摘要，代表一个连续的工作片段。',
            '必须只返回一个合法的 json object，不要 markdown，不要代码块，不要额外解释。',
            'json schema:',
            '{',
            '  "summary": "3-6 句话综合描述这个片段的目标、关键操作、失败/修正路径、最终结果和残留风险",',
            '  "topic": "一个简短主题短语",',
            '  "tools": ["片段中实际影响结果的工具名或命令类别"],',
            '  "entities": ["关键文件、库、命令、服务、API、配置项等技术实体"]',
            '}',
            '字段要求：',
            '- summary/topic 必填，tools/entities 可为空数组，不要编造。',
            '- 不要逐条复述 L1；要压缩成一个可用于回看和继续工作的 operational segment。',
            '- 必须保留片段内的失败、误判、被废弃方案、配置差异、连接/权限/外部 API 问题和修正方式。',
            '- 成功结论必须带依据，例如测试名、状态、health endpoint、队列/DB 写入、部署单元或 smoke 结果。',
            '- 如果片段中既有失败也有成功，要同时写出，不要只写最终成功。',
            '- entities/tools 去重并只保留关键项，避免把每个 L1 反复出现的实体机械堆叠。',
        ].join('\n')

        const userPrompt = [
            `以下是 ${l1Summaries.length} 个 turn 摘要，请综合生成 segment 摘要：`,
            '',
            ...l1Summaries.map((s, i) => [
                `[Turn ${i + 1}${s.topic ? ` - ${s.topic}` : ''}]`,
                truncate(s.summary, 600),
            ].join('\n')),
        ].join('\n')

        const segResponseSchema = z.object({
            summary: z.string().trim().min(1).max(2_000),
            topic: z.string().trim().min(1).max(80),
            tools: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
            entities: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
        }).strict()

        const { content, resolvedModel, requestId, finishReason, tokensIn, tokensOut, status } =
            await this.callDeepSeek(systemPrompt, userPrompt, 800)

        const parsed = this.parseAndValidate(content, segResponseSchema, {
            statusCode: status,
            requestId,
            finishReason,
            model: resolvedModel,
        })

        return {
            summary: parsed.summary,
            topic: parsed.topic,
            tools: normalizeStringArray(parsed.tools),
            entities: normalizeStringArray(parsed.entities),
            tokensIn,
            tokensOut,
            rawResponse: content,
            provider: { provider: 'deepseek', model: resolvedModel, statusCode: status, requestId, finishReason, errorCode: null },
        }
    }

    async summarizeSession(
        summaries: Array<{ summary: string; topic: string | null }>,
        sourceLevel: 1 | 2,
    ): Promise<LLMSummaryResult> {
        const sourceLabel = sourceLevel === 2 ? 'segment' : 'turn'
        const systemPrompt = [
            '你是 coding session 的 L3 session 摘要器。',
            `你会收到若干个 ${sourceLabel} 摘要，代表整个 session 的工作内容。`,
            '必须只返回一个合法的 json object，不要 markdown，不要代码块，不要额外解释。',
            'json schema:',
            '{',
            '  "summary": "5-8 句话综合描述整个 session 的最终状态、主要工作、失败/修正路径、关键配置、验证结果和残留风险",',
            '  "topic": "一个简短主题短语，概括整个 session",',
            '  "tools": ["session 中实际影响结果的工具名或命令类别"],',
            '  "entities": ["关键文件、库、命令、服务、API、配置项等技术实体"]',
            '}',
            '字段要求：',
            '- summary/topic 必填，tools/entities 可为空数组，不要编造。',
            '- L3 是给未来 agent 继续工作的长期 operational memory，不是宣传稿或泛泛验收报告。',
            '- 开头先写最终状态；随后保留关键配置、部署路径、命令/测试、健康检查、DB/队列状态等可复现依据。',
            '- 必须保留重要失败、误判、连接耗尽、配置不匹配、外部 API 不兼容、被废弃方案及修正路径；不要把过程抹平成“无阻塞”。',
            '- 如果 source 只提供压缩后的 L2 和 orphan L1，要合并两者；不要丢掉最后几个未进入 L2 的 turn。',
            '- 如果仍有风险或未验证项，明确写出；没有可靠依据时不要声称完全成功。',
            '- 涉及密钥或 token 时只写“已配置/已保存/已脱敏”，不要复述 secret 值。',
            '- entities/tools 去重并只保留关键项，避免重复堆实体。',
        ].join('\n')

        const userPrompt = [
            `以下是 ${summaries.length} 个 ${sourceLabel} 摘要，请综合生成 session 摘要：`,
            '',
            ...summaries.map((s, i) => [
                `[${sourceLabel === 'segment' ? 'Segment' : 'Turn'} ${i + 1}${s.topic ? ` - ${s.topic}` : ''}]`,
                truncate(s.summary, 800),
            ].join('\n')),
        ].join('\n')

        const sessResponseSchema = z.object({
            summary: z.string().trim().min(1).max(3_000),
            topic: z.string().trim().min(1).max(80),
            tools: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
            entities: z.array(z.string().trim().min(1).max(160)).max(60).default([]),
        }).strict()

        const { content, resolvedModel, requestId, finishReason, tokensIn, tokensOut, status } =
            await this.callDeepSeek(systemPrompt, userPrompt, 1_000)

        const parsed = this.parseAndValidate(content, sessResponseSchema, {
            statusCode: status,
            requestId,
            finishReason,
            model: resolvedModel,
        })

        return {
            summary: parsed.summary,
            topic: parsed.topic,
            tools: normalizeStringArray(parsed.tools),
            entities: normalizeStringArray(parsed.entities),
            tokensIn,
            tokensOut,
            rawResponse: content,
            provider: { provider: 'deepseek', model: resolvedModel, statusCode: status, requestId, finishReason, errorCode: null },
        }
    }
}
