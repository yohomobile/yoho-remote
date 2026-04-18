import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

const askUserQuestionOptionSchema = z.object({
    label: z.string().min(1).describe('选项标签'),
    description: z.string().optional().describe('选项说明'),
})

const askUserQuestionQuestionSchema = z.object({
    header: z.string().optional().describe('问题头部标签，建议简短'),
    question: z.string().min(1).describe('用户要回答的问题'),
    options: z.array(askUserQuestionOptionSchema).max(8).optional().describe('可选项；留空表示自由输入'),
    multiSelect: z.boolean().optional().describe('是否允许多选'),
})

const askUserQuestionInputSchema = z.object({
    questions: z.array(askUserQuestionQuestionSchema).min(1).max(3).describe('1 到 3 个结构化问题'),
})

type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>

function pushToolNameOnce(toolNames: string[], toolName: string): void {
    if (!toolNames.includes(toolName)) {
        toolNames.push(toolName)
    }
}

function buildAskUserQuestionSchema(input: AskUserQuestionInput): Record<string, unknown> {
    const properties = Object.fromEntries(input.questions.map((question, index) => {
        const key = String(index)
        const options = question.options ?? []
        if (options.length === 0) {
            return [key, {
                type: 'string',
                title: question.header ?? `Question ${index + 1}`,
                description: question.question,
                minLength: 1,
            }]
        }

        if (question.multiSelect) {
            return [key, {
                type: 'array',
                title: question.header ?? `Question ${index + 1}`,
                description: question.question,
                items: {
                    type: 'string',
                    enum: options.map((option) => option.label),
                },
                minItems: 1,
            }]
        }

        return [key, {
            type: 'string',
            title: question.header ?? `Question ${index + 1}`,
            description: question.question,
            oneOf: options.map((option) => ({
                const: option.label,
                title: option.label,
                description: option.description,
            })),
        }]
    }))

    return {
        type: 'object',
        properties,
        required: input.questions.map((_, index) => String(index)),
    }
}

function normalizeAskUserQuestionAnswers(content: unknown, questionCount: number): Record<string, string[]> {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return {}
    }

    const record = content as Record<string, unknown>
    const answers: Record<string, string[]> = {}
    for (let index = 0; index < questionCount; index += 1) {
        const key = String(index)
        const value = record[key]
        if (typeof value === 'string' && value.trim().length > 0) {
            answers[key] = [value.trim()]
            continue
        }
        if (Array.isArray(value)) {
            const normalized = value
                .filter((entry): entry is string => typeof entry === 'string')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            if (normalized.length > 0) {
                answers[key] = normalized
            }
        }
    }
    return answers
}

function formatAskUserQuestionAnswers(input: AskUserQuestionInput, answers: Record<string, string[]>): string {
    const lines = input.questions.map((question, index) => {
        const key = String(index)
        const values = answers[key] ?? []
        const title = question.header?.trim() || question.question
        return `${title}: ${values.length > 0 ? values.join(', ') : '(no answer)'}`
    })

    return `User answered:\n${lines.join('\n')}`
}

export function registerChatMessagesTool(
    mcp: McpServer,
    toolNames: string[],
    options: { apiClient: ApiClient }
): void {
    const { apiClient: api } = options
    const chatMessagesSchema: z.ZodTypeAny = z.object({
        chatId: z.string().describe('飞书 chat_id（群聊或单聊）'),
        limit: z.number().optional().describe('返回条数，默认 50，最大 200'),
        beforeTimestamp: z.number().optional().describe('只返回此时间戳之前的消息（毫秒），用于翻页'),
    })

    mcp.registerTool<any, any>('chat_messages', {
        title: 'Chat Messages',
        description: '查询飞书聊天的历史消息记录（单聊或群聊）。返回持久化的消息列表，按时间倒序。可用于了解对话上下文、查找之前讨论的内容。',
        inputSchema: chatMessagesSchema,
    }, async (args: { chatId: string; limit?: number; beforeTimestamp?: number }) => {
        try {
            const limit = Math.min(args.limit || 50, 200)
            const messages = await api.getFeishuChatMessages(args.chatId, limit, args.beforeTimestamp)

            if (messages.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: '没有找到消息记录。' }],
                }
            }

            const lines = messages.reverse().map((message: any) =>
                `[${new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}] ${message.senderName}: ${message.content}`
            )
            return {
                content: [{
                    type: 'text' as const,
                    text: `共 ${messages.length} 条消息：\n${lines.join('\n')}`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{ type: 'text' as const, text: `查询失败: ${err.message || String(err)}` }],
                isError: true,
            }
        }
    })

    pushToolNameOnce(toolNames, 'chat_messages')
}

export function registerAskUserQuestionTool(
    mcp: McpServer,
    toolNames: string[]
): void {
    mcp.registerTool<any, any>('ask_user_question', {
        title: 'Ask User Question',
        description: '向用户发起 1-3 个结构化问题，等待用户通过现有问答链回答后再继续。用于需要用户选择或补充关键信息的场景。',
        inputSchema: askUserQuestionInputSchema,
    }, async (args: AskUserQuestionInput) => {
        try {
            const result = await mcp.server.elicitInput({
                mode: 'form',
                message: args.questions.length === 1
                    ? args.questions[0]!.question
                    : 'Please answer the following questions:',
                requestedSchema: buildAskUserQuestionSchema(args),
                _meta: {
                    codex_approval_kind: 'mcp_tool_call',
                    tool_name: 'ask_user_question',
                    tool_params: {
                        questions: args.questions,
                    },
                },
            } as any)

            if (result.action !== 'accept' || !result.content) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: result.action === 'decline'
                            ? 'User declined to answer the questions.'
                            : 'User canceled the questions.',
                    }],
                }
            }

            const answers = normalizeAskUserQuestionAnswers(result.content, args.questions.length)
            return {
                content: [{
                    type: 'text' as const,
                    text: formatAskUserQuestionAnswers(args, answers),
                }],
                structuredContent: {
                    answers,
                },
            }
        } catch (error) {
            logger.debug('[interactionTools] ask_user_question error:', error)
            return {
                content: [{
                    type: 'text' as const,
                    text: `Failed to collect answers: ${error instanceof Error ? error.message : String(error)}`,
                }],
                isError: true,
            }
        }
    })

    pushToolNameOnce(toolNames, 'ask_user_question')
}
