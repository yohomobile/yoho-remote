/**
 * OpenAI Compatible API for Codex CLI
 *
 * 提供 /v1/chat/completions 和 /v1/models 端点，
 * 让其他应用可以通过标准 OpenAI API 格式调用 Codex CLI。
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// response_format schema 定义
const responseFormatSchema = z.object({
    type: z.enum(['text', 'json_object', 'json_schema']),
    json_schema: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        schema: z.any().optional(),  // JSON Schema 是任意结构
        strict: z.boolean().optional()
    }).optional()
}).optional()

// OpenAI function/tool 定义
const toolSchema = z.object({
    type: z.literal('function'),
    function: z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.any().optional(),  // JSON Schema
        strict: z.boolean().optional()
    })
})

// OpenAI Chat Completions 请求格式
const chatCompletionRequestSchema = z.object({
    model: z.string().default('default'),
    messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string()
    })),
    stream: z.boolean().default(false),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    // OpenAI 标准选项
    response_format: responseFormatSchema,
    tools: z.array(toolSchema).optional(),
    tool_choice: z.union([
        z.literal('auto'),
        z.literal('none'),
        z.literal('required'),
        z.object({
            type: z.literal('function'),
            function: z.object({ name: z.string() })
        })
    ]).optional(),
    // Codex 特定选项
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    working_directory: z.string().optional(),
    full_auto: z.boolean().optional()
})

type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>

// Codex JSONL 事件类型
interface CodexEvent {
    type: string
    message?: string
    content?: string
    // item.completed 事件格式
    item?: {
        id?: string
        type?: string
        role?: string
        text?: string  // 直接的文本内容
        content?: Array<{ type: string; text?: string }>
    }
    // 其他可能的响应格式
    response?: {
        output?: Array<{
            type?: string
            role?: string
            text?: string
            content?: Array<{ type: string; text?: string }>
        }>
    }
    // usage 信息
    usage?: {
        input_tokens?: number
        output_tokens?: number
        cached_input_tokens?: number
    }
}

// 可用模型列表 - 基于 Codex CLI 官方支持的模型
const AVAILABLE_MODELS = [
    // 默认模型（使用 ~/.codex/config.toml 中配置的模型）
    { id: 'default', name: 'Default', description: 'Use default model from Codex config (~/.codex/config.toml)' },
    // 推荐模型
    { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Latest frontier agentic coding model' },
    { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Frontier agentic coding model' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Smaller frontier agentic coding model' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Frontier Codex-optimized agentic coding model' },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: 'Ultra-fast coding model' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'Frontier agentic coding model' },
    { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Optimized for professional work and long-running agents' },
    // 替代模型
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'Codex-optimized model for deep and fast reasoning' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'Optimized for codex. Cheaper, faster, but less capable' },
    { id: 'gpt-5.1', name: 'GPT-5.1', description: 'Designed for coding and agentic tasks' },
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', description: 'For long-running agentic coding tasks' },
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', description: 'Tuned for extended coding tasks' },
    { id: 'gpt-5-codex-mini', name: 'GPT-5 Codex Mini', description: 'Cost-effective predecessor model' },
    { id: 'gpt-5', name: 'GPT-5', description: 'Reasoning model for coding tasks' },
    // 旧版模型（仍可使用）
    { id: 'o3', name: 'O3', description: 'OpenAI O3 reasoning model' },
    { id: 'o4-mini', name: 'O4 Mini', description: 'OpenAI O4 Mini model' },
]

type CodexOpenAIEnv = {
    Variables: {
        apiKey?: string
    }
}

/**
 * 从消息数组构建 prompt
 */
function buildPromptFromMessages(messages: ChatCompletionRequest['messages']): string {
    const parts: string[] = []

    for (const msg of messages) {
        if (msg.role === 'system') {
            parts.push(`[System]: ${msg.content}`)
        } else if (msg.role === 'user') {
            parts.push(msg.content)
        } else if (msg.role === 'assistant') {
            parts.push(`[Previous Assistant Response]: ${msg.content}`)
        }
    }

    return parts.join('\n\n')
}

/**
 * 从 Codex JSONL 事件中提取文本内容
 * Codex JSONL 格式示例：
 * {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"今天天气很好。"}}
 *
 * 注意：只提取 agent_message 类型，忽略 reasoning 类型（思考过程）
 */
function extractTextFromCodexEvent(event: CodexEvent): string | null {
    // 只处理 item.completed 类型的事件，且只要 agent_message，忽略 reasoning
    if (event.type === 'item.completed' && event.item) {
        // 忽略 reasoning 类型（思考过程）
        if (event.item.type === 'reasoning') {
            return null
        }

        // 直接从 item.text 获取文本（最常见的格式）
        if (event.item.text) {
            return event.item.text
        }

        // 从 item.content 数组中提取
        if (event.item.content) {
            for (const content of event.item.content) {
                if (content.type === 'text' && content.text) {
                    return content.text
                }
            }
        }
    }

    // 直接消息字段
    if (event.message) {
        return event.message
    }

    // 从 response.output 中提取（备用格式）
    if (event.response?.output) {
        const texts: string[] = []
        for (const output of event.response.output) {
            if (output.text) {
                texts.push(output.text)
            } else if (output.content) {
                for (const content of output.content) {
                    if (content.type === 'text' && content.text) {
                        texts.push(content.text)
                    }
                }
            }
        }
        if (texts.length > 0) {
            return texts.join('\n')
        }
    }

    return null
}

/**
 * 从文本中提取 JSON 对象
 * 用于 json_object 模式，从可能包含思考过程的响应中提取最后的 JSON
 */
function extractJsonFromText(text: string): string | null {
    // 尝试从后往前找到有效的 JSON 对象
    // 因为 Codex 通常会在最后输出 JSON 结果
    const jsonMatches: string[] = []

    // 方法1：尝试匹配 {...} 结构
    const braceRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g
    let match
    while ((match = braceRegex.exec(text)) !== null) {
        try {
            JSON.parse(match[0])
            jsonMatches.push(match[0])
        } catch {
            // 不是有效 JSON，继续
        }
    }

    // 返回最后一个有效的 JSON（通常是最终结果）
    if (jsonMatches.length > 0) {
        return jsonMatches[jsonMatches.length - 1]
    }

    // 方法2：如果整个文本就是 JSON，直接返回
    try {
        JSON.parse(text.trim())
        return text.trim()
    } catch {
        // 不是 JSON
    }

    return null
}

/**
 * 创建临时 JSON Schema 文件用于 response_format
 */
function createTempSchemaFile(schema: Record<string, unknown>): string {
    const tempFile = join(tmpdir(), `codex-schema-${randomUUID()}.json`)
    // 确保 schema 包含 additionalProperties: false（OpenAI 要求）
    const finalSchema = {
        ...schema,
        additionalProperties: false
    }
    writeFileSync(tempFile, JSON.stringify(finalSchema, null, 2))
    return tempFile
}

/**
 * Tool 定义类型
 */
interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
        strict?: boolean
    }
}

/**
 * 递归添加 additionalProperties: false 到所有 object 类型
 */
function addAdditionalPropertiesFalse(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema.type === 'object') {
        const result: Record<string, unknown> = { ...schema, additionalProperties: false }
        if (schema.properties && typeof schema.properties === 'object') {
            const newProps: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
                if (value && typeof value === 'object') {
                    newProps[key] = addAdditionalPropertiesFalse(value as Record<string, unknown>)
                } else {
                    newProps[key] = value
                }
            }
            result.properties = newProps
        }
        return result
    }
    return schema
}

/**
 * 将 OpenAI tools 转换为 output-schema
 * 生成的 schema 让模型决定是否调用函数，以及调用哪个函数
 */
function buildToolCallSchema(tools: ToolDefinition[]): Record<string, unknown> {
    // 获取第一个工具的参数 schema（确保有 additionalProperties: false）
    const firstTool = tools[0]
    const argsSchema = firstTool.function.parameters
        ? addAdditionalPropertiesFalse(firstTool.function.parameters as Record<string, unknown>)
        : { type: 'object', properties: {}, additionalProperties: false }

    // 最终的 output schema：可能调用函数，也可能直接回复
    // 注意：OpenAI 要求 required 包含所有属性
    return {
        type: 'object',
        properties: {
            // 是否调用工具
            tool_call: {
                type: 'boolean',
                description: 'Set to true if you need to call a function/tool to answer the question'
            },
            // 如果调用工具，填写此字段
            function_call: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        enum: tools.map(t => t.function.name),
                        description: 'The name of the function to call'
                    },
                    arguments: argsSchema
                },
                required: ['name', 'arguments'],
                additionalProperties: false
            },
            // 如果不调用工具，直接回复（可以为空字符串）
            content: {
                type: 'string',
                description: 'Direct text response if no tool call is needed, or empty string if calling a tool'
            }
        },
        required: ['tool_call', 'function_call', 'content'],  // 所有属性都必须
        additionalProperties: false
    }
}

/**
 * 为 tools 构建系统提示
 */
function buildToolsSystemPrompt(tools: ToolDefinition[]): string {
    const toolDescriptions = tools.map(tool => {
        const params = tool.function.parameters
            ? `\n   Parameters: ${JSON.stringify(tool.function.parameters, null, 2)}`
            : ''
        return `- ${tool.function.name}: ${tool.function.description || 'No description'}${params}`
    }).join('\n')

    return `You have access to the following tools/functions:

${toolDescriptions}

Based on the user's request:
- If you need to call a tool, set "tool_call" to true and fill in "function_call" with the function name and arguments.
- If you can answer directly without calling a tool, set "tool_call" to false and put your response in "content".`
}

/**
 * Tool call 结果类型
 */
interface ToolCallResult {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

/**
 * 运行 Codex CLI 并收集输出
 */
async function runCodexNonStreaming(
    prompt: string,
    options: {
        model?: string
        sandbox?: string
        workingDirectory?: string
        fullAuto?: boolean
        responseFormat?: {
            type: 'text' | 'json_object' | 'json_schema'
            json_schema?: {
                name?: string
                description?: string
                schema?: Record<string, unknown>
                strict?: boolean
            }
        }
        tools?: ToolDefinition[]
    }
): Promise<{ content: string; toolCalls?: ToolCallResult[]; error?: string }> {
    let tempSchemaFile: string | null = null

    return new Promise((resolve) => {
        const args = ['exec', '--json']

        // 当 model 不是 'default' 时才传 --model 参数
        if (options.model && options.model !== 'default') {
            args.push('--model', options.model)
        }

        if (options.sandbox) {
            args.push('--sandbox', options.sandbox)
        }

        if (options.fullAuto) {
            args.push('--full-auto')
        }

        // 处理 tools（function calling）
        let hasTools = false
        let finalPrompt = prompt
        if (options.tools && options.tools.length > 0) {
            hasTools = true
            // 构建 tool call schema
            const toolSchema = buildToolCallSchema(options.tools)
            tempSchemaFile = createTempSchemaFile(toolSchema)
            args.push('--output-schema', tempSchemaFile)
            // 添加系统提示
            finalPrompt = `${buildToolsSystemPrompt(options.tools)}\n\nUser request: ${prompt}`
        }
        // 处理 response_format（如果没有 tools）
        else if (options.responseFormat?.type === 'json_schema' && options.responseFormat.json_schema?.schema) {
            tempSchemaFile = createTempSchemaFile(options.responseFormat.json_schema.schema)
            args.push('--output-schema', tempSchemaFile)
        }
        // json_object 模式：Codex 不支持无 schema 的 JSON 输出，后处理提取 JSON

        args.push(finalPrompt)

        const cwd = options.workingDirectory || process.cwd()

        const child = spawn('codex', args, {
            cwd,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        })

        let output = ''
        let errorOutput = ''
        const collectedTexts: string[] = []

        child.stdout.on('data', (data: Buffer) => {
            output += data.toString()

            // 解析 JSONL
            const lines = output.split('\n')
            output = lines.pop() || '' // 保留未完成的行

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const event = JSON.parse(line) as CodexEvent
                    const text = extractTextFromCodexEvent(event)
                    if (text) {
                        collectedTexts.push(text)
                    }
                } catch {
                    // 非 JSON 行，忽略
                }
            }
        })

        child.stderr.on('data', (data: Buffer) => {
            errorOutput += data.toString()
        })

        child.on('close', (code) => {
            // 处理剩余的输出
            if (output.trim()) {
                try {
                    const event = JSON.parse(output) as CodexEvent
                    const text = extractTextFromCodexEvent(event)
                    if (text) {
                        collectedTexts.push(text)
                    }
                } catch {
                    // 忽略
                }
            }

            // 清理临时文件
            if (tempSchemaFile) {
                try {
                    unlinkSync(tempSchemaFile)
                } catch {
                    // 忽略清理错误
                }
            }

            if (code !== 0 && collectedTexts.length === 0) {
                resolve({
                    content: '',
                    error: errorOutput || `Codex exited with code ${code}`
                })
            } else {
                let content = collectedTexts.join('\n') || 'Task completed.'

                // 处理 tools 响应
                if (hasTools) {
                    try {
                        const parsed = JSON.parse(content)
                        if (parsed.tool_call && parsed.function_call) {
                            // 模型决定调用函数
                            const toolCall: ToolCallResult = {
                                id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
                                type: 'function',
                                function: {
                                    name: parsed.function_call.name,
                                    arguments: JSON.stringify(parsed.function_call.arguments)
                                }
                            }
                            resolve({ content: '', toolCalls: [toolCall] })
                            return
                        } else {
                            // 模型决定直接回复
                            resolve({ content: parsed.content || content })
                            return
                        }
                    } catch {
                        // 解析失败，返回原始内容
                    }
                }

                // 对于 json_object 模式，尝试从内容中提取 JSON
                if (options.responseFormat?.type === 'json_object') {
                    const extractedJson = extractJsonFromText(content)
                    if (extractedJson) {
                        content = extractedJson
                    }
                }

                resolve({ content })
            }
        })

        child.on('error', (err) => {
            // 清理临时文件
            if (tempSchemaFile) {
                try {
                    unlinkSync(tempSchemaFile)
                } catch {
                    // 忽略清理错误
                }
            }

            resolve({
                content: '',
                error: `Failed to spawn codex: ${err.message}`
            })
        })
    })
}

export function createCodexOpenAIRoutes(): Hono<CodexOpenAIEnv> {
    const app = new Hono<CodexOpenAIEnv>()

    // 可选的 API Key 验证中间件
    app.use('*', async (c, next) => {
        const authHeader = c.req.header('authorization')
        if (authHeader) {
            const apiKey = authHeader.replace(/^Bearer\s+/i, '')
            c.set('apiKey', apiKey)
        }
        return await next()
    })

    // GET /v1/models - 列出可用模型
    app.get('/models', (c) => {
        const models = AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'codex',
            permission: [],
            root: m.id,
            parent: null
        }))

        return c.json({
            object: 'list',
            data: models
        })
    })

    // POST /v1/chat/completions - Chat Completions API
    app.post('/chat/completions', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = chatCompletionRequestSchema.safeParse(json)

        if (!parsed.success) {
            return c.json({
                error: {
                    message: 'Invalid request body',
                    type: 'invalid_request_error',
                    param: null,
                    code: null
                }
            }, 400)
        }

        const request = parsed.data
        const prompt = buildPromptFromMessages(request.messages)
        const requestId = `chatcmpl-${randomUUID()}`
        const created = Math.floor(Date.now() / 1000)

        if (request.stream) {
            // 流式响应
            return streamSSE(c, async (stream) => {
                const args = ['exec', '--json']

                // 当 model 不是 'default' 时才传 --model 参数
                if (request.model && request.model !== 'default') {
                    args.push('--model', request.model)
                }

                if (request.sandbox) {
                    args.push('--sandbox', request.sandbox)
                }

                if (request.full_auto) {
                    args.push('--full-auto')
                }

                args.push(prompt)

                const cwd = request.working_directory || process.cwd()

                const child = spawn('codex', args, {
                    cwd,
                    env: process.env,
                    stdio: ['pipe', 'pipe', 'pipe']
                })

                let buffer = ''

                const sendDelta = async (content: string) => {
                    const chunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created,
                        model: request.model,
                        choices: [{
                            index: 0,
                            delta: { content },
                            finish_reason: null
                        }]
                    }
                    await stream.writeSSE({
                        data: JSON.stringify(chunk)
                    })
                }

                child.stdout.on('data', async (data: Buffer) => {
                    buffer += data.toString()
                    const lines = buffer.split('\n')
                    buffer = lines.pop() || ''

                    for (const line of lines) {
                        if (!line.trim()) continue
                        try {
                            const event = JSON.parse(line) as CodexEvent
                            const text = extractTextFromCodexEvent(event)
                            if (text) {
                                await sendDelta(text + '\n')
                            }
                        } catch {
                            // 非 JSON，直接发送
                            if (line.trim()) {
                                await sendDelta(line + '\n')
                            }
                        }
                    }
                })

                await new Promise<void>((resolve) => {
                    child.on('close', async () => {
                        // 处理剩余数据
                        if (buffer.trim()) {
                            try {
                                const event = JSON.parse(buffer) as CodexEvent
                                const text = extractTextFromCodexEvent(event)
                                if (text) {
                                    await sendDelta(text)
                                }
                            } catch {
                                if (buffer.trim()) {
                                    await sendDelta(buffer)
                                }
                            }
                        }

                        // 发送结束标记
                        const doneChunk = {
                            id: requestId,
                            object: 'chat.completion.chunk',
                            created,
                            model: request.model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: 'stop'
                            }]
                        }
                        await stream.writeSSE({
                            data: JSON.stringify(doneChunk)
                        })
                        await stream.writeSSE({ data: '[DONE]' })
                        resolve()
                    })

                    child.on('error', async (err) => {
                        await sendDelta(`Error: ${err.message}`)
                        resolve()
                    })
                })
            })
        } else {
            // 非流式响应
            const result = await runCodexNonStreaming(prompt, {
                model: request.model,
                sandbox: request.sandbox,
                workingDirectory: request.working_directory,
                fullAuto: request.full_auto,
                responseFormat: request.response_format,
                tools: request.tools
            })

            if (result.error) {
                return c.json({
                    error: {
                        message: result.error,
                        type: 'api_error',
                        param: null,
                        code: null
                    }
                }, 500)
            }

            // 构建响应消息
            const message: Record<string, unknown> = {
                role: 'assistant',
                content: result.toolCalls ? null : result.content
            }

            // 如果有 tool calls，添加到消息中
            if (result.toolCalls && result.toolCalls.length > 0) {
                message.tool_calls = result.toolCalls
            }

            return c.json({
                id: requestId,
                object: 'chat.completion',
                created,
                model: request.model,
                choices: [{
                    index: 0,
                    message,
                    finish_reason: result.toolCalls ? 'tool_calls' : 'stop'
                }],
                usage: {
                    prompt_tokens: 0,  // Codex CLI 不提供 token 计数
                    completion_tokens: 0,
                    total_tokens: 0
                }
            })
        }
    })

    return app
}
