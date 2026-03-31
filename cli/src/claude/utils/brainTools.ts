/**
 * Brain MCP Tools
 *
 * Provides session orchestration tools for Brain mode.
 * Brain sessions can create, control, and monitor other yoho-remote sessions.
 *
 * Uses true async callback: session_send returns immediately,
 * and the server pushes results back to the Brain session when
 * the child session completes (via sendBrainCallbackIfNeeded in syncEngine).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

/** Context window budget by model mode (matches web/src/chat/modelConfig.ts) */
function getContextBudget(modelMode?: string): number {
    const HEADROOM = 10_000
    const windows: Record<string, number> = {
        default: 1_000_000,
        sonnet: 1_000_000,
        opus: 1_000_000,
    }
    return (windows[modelMode ?? 'default'] ?? 1_000_000) - HEADROOM
}

interface BrainToolsOptions {
    apiClient: ApiClient
    machineId: string
    brainSessionId: string
}

export function registerBrainTools(
    mcp: McpServer,
    toolNames: string[],
    options: BrainToolsOptions
): void {
    const { apiClient: api, machineId, brainSessionId } = options

    // ===== Helper: wait for session to come online =====
    async function waitForSessionOnline(sessionId: string, timeoutSec = 30): Promise<boolean> {
        for (let i = 0; i < timeoutSec; i++) {
            try {
                const session = await api.getSession(sessionId)
                if (session.active) return true
            } catch { /* not ready yet */ }
            await new Promise(r => setTimeout(r, 1000))
        }
        return false
    }

    // ===== 1. session_create =====
    const createSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径，如 /home/guang/softwares/yoho-remote'),
        machineId: z.string().optional().describe('目标机器 ID。不填则使用当前机器。'),
        agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent 类型，默认 claude'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).optional().describe('模型选择。sonnet（默认）适合 80-90% 的任务：日常开发、代码补全、测试编写、文档等。opus 适合 10-20% 的复杂任务：大型代码库重构、安全审计、多代理工作流、架构设计等。不填默认使用 sonnet。'),
    })

    mcp.registerTool<any, any>('session_create', {
        title: 'Create Session',
        description: '强制创建新的工作 session。如果只想发任务到已有目录，优先使用 session_find_or_create 来复用空闲 session。\n\n模型选择建议（基于 2026 年最佳实践）：\n- sonnet（默认）：适合 80-90% 的任务，包括日常开发、代码补全、测试编写、文档、标准功能开发、自动化脚本等。性价比高，响应快。\n- opus：仅用于 10-20% 的高复杂度任务，包括大型代码库重构（数万行代码的架构调整）、安全审计、多代理协作工作流、深度架构设计、复杂的多步推理任务等。成本是 sonnet 的 5 倍。\n\n推荐策略：默认使用 sonnet，仅在任务明确需要更深度推理时才使用 opus。',
        inputSchema: createSchema,
    }, async (args: { directory: string; machineId?: string; agent?: string; modelMode?: string }) => {
        try {
            const targetMachineId = args.machineId || machineId
            logger.debug(`[brain] Creating session: machine=${targetMachineId}, dir=${args.directory}, agent=${args.agent || 'claude'}, modelMode=${args.modelMode || 'sonnet'}`)

            const result = await api.brainSpawnSession({
                machineId: targetMachineId,
                directory: args.directory,
                agent: args.agent,
                modelMode: args.modelMode,
                source: 'brain-child',
                mainSessionId: brainSessionId,
            })

            if (result.type === 'success') {
                const ready = await waitForSessionOnline(result.sessionId)
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session 创建成功。\n\nsessionId: ${result.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}`,
                    }],
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${result.message}`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 2. session_find_or_create =====
    const findOrCreateSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径'),
        hint: z.string().optional().describe('任务意图关键词（如 "订单API 优惠券"），用于匹配已有上下文的 session，优先复用做过相关工作的 session，省去重新理解代码的成本'),
        machineId: z.string().optional().describe('目标机器 ID。不填则使用当前机器。'),
        agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent 类型，默认 claude'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).optional().describe('模型选择。sonnet（默认）适合 80-90% 的任务：日常开发、代码补全、测试编写、文档等。opus 适合 10-20% 的复杂任务：大型代码库重构、安全审计、多代理工作流、架构设计等。复用时会优先匹配相同 modelMode 的 session。'),
    })

    mcp.registerTool<any, any>('session_find_or_create', {
        title: 'Find or Create Session',
        description: '智能查找可复用的空闲子 session。匹配 directory + 属于当前 Brain + modelMode，并通过 hint 优先选择上下文相关的 session（基于 brainSummary 匹配）。找不到则创建新 session。推荐优先使用此工具。\n\n模型选择建议（基于 2026 年最佳实践）：\n- sonnet（默认）：适合 80-90% 的任务，包括日常开发、代码补全、测试编写、文档、标准功能开发、自动化脚本等。性价比高，响应快。\n- opus：仅用于 10-20% 的高复杂度任务，包括大型代码库重构（数万行代码的架构调整）、安全审计、多代理协作工作流、深度架构设计、复杂的多步推理任务等。成本是 sonnet 的 5 倍。\n\n推荐策略：默认使用 sonnet，仅在任务明确需要更深度推理时才使用 opus。复用逻辑会优先匹配相同 modelMode 的 session。',
        inputSchema: findOrCreateSchema,
    }, async (args: { directory: string; hint?: string; machineId?: string; agent?: string; modelMode?: string }) => {
        try {
            const targetMachineId = args.machineId || machineId

            // Step 1: List online sessions
            const data = await api.listSessions({ includeOffline: false })

            // Step 2: Find reusable child session
            const targetModelMode = args.modelMode || 'sonnet'
            const candidates = data.sessions.filter(s => {
                if (!s.metadata) return false
                if (s.metadata.source !== 'brain-child') return false
                if (s.metadata.mainSessionId !== brainSessionId) return false
                if (s.metadata.path !== args.directory) return false
                if (s.metadata.machineId !== targetMachineId) return false
                if (!s.active) return false
                if (s.thinking) return false
                // Don't reuse sessions with pending permission requests
                if (s.pendingRequestsCount > 0) return false
                return true
            })

            // Pick the best candidate: prefer modelMode match, then context-relevant (hint matches brainSummary), then most recently active
            if (candidates.length > 0) {
                let best = candidates.sort((a, b) => b.activeAt - a.activeAt)[0]
                let matchReason = '最近活跃'

                // Step 1: Prefer exact modelMode match
                // Note: 'default' is normalized to 'sonnet' for matching purposes
                const normalizeModelMode = (mode?: string) => {
                    if (!mode || mode === 'default') return 'sonnet'
                    return mode
                }
                const exactModelMatches = candidates.filter(s => {
                    return normalizeModelMode(s.modelMode) === normalizeModelMode(targetModelMode)
                })
                const candidatesForHint = exactModelMatches.length > 0 ? exactModelMatches : candidates

                if (exactModelMatches.length > 0 && exactModelMatches.length < candidates.length) {
                    best = exactModelMatches.sort((a, b) => b.activeAt - a.activeAt)[0]
                    matchReason = `模型匹配 (${targetModelMode})`
                }

                // Step 2: If hint provided, prefer context match within modelMode-filtered candidates
                if (args.hint && candidatesForHint.length > 1) {
                    // Tokenize hint into keywords, match against brainSummary + session title
                    const hintKeywords = args.hint.toLowerCase().split(/[\s,，/]+/).filter(k => k.length > 0)
                    if (hintKeywords.length > 0) {
                        const scored = candidatesForHint.map(s => {
                            const text = [
                                s.metadata?.brainSummary || '',
                                s.metadata?.summary?.text || '',
                            ].join(' ').toLowerCase()
                            const hits = hintKeywords.filter(k => text.includes(k)).length
                            return { session: s, hits }
                        })
                        const topMatch = scored.sort((a, b) =>
                            b.hits - a.hits || b.session.activeAt - a.session.activeAt
                        )[0]
                        if (topMatch.hits > 0) {
                            best = topMatch.session
                            matchReason = `模型+上下文匹配 (${targetModelMode}, ${topMatch.hits}/${hintKeywords.length} 关键词)`
                        }
                    }
                }

                const title = best.metadata?.summary?.text || best.metadata?.brainSummary || '未命名'
                const summary = best.metadata?.brainSummary ? `\n上次总结: ${best.metadata.brainSummary}` : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `复用已有 Session。\n\nsessionId: ${best.id}\n标题: ${title}\n匹配: ${matchReason}${summary}\n状态: ✅ 空闲`,
                    }],
                }
            }

            // Step 3: No reusable session, create new one
            logger.debug(`[brain] No reusable session for dir=${args.directory}, modelMode=${targetModelMode}, creating new one`)

            const result = await api.brainSpawnSession({
                machineId: targetMachineId,
                directory: args.directory,
                agent: args.agent,
                modelMode: args.modelMode,
                source: 'brain-child',
                mainSessionId: brainSessionId,
            })

            if (result.type === 'success') {
                const ready = await waitForSessionOnline(result.sessionId)
                return {
                    content: [{
                        type: 'text' as const,
                        text: `无可复用 session，已创建新 session。\n\nsessionId: ${result.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}`,
                    }],
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${result.message}`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `查找/创建失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 3. session_send (async, non-blocking) =====
    const sendSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        message: z.string().describe('要发送的消息/任务指令'),
    })

    mcp.registerTool<any, any>('session_send', {
        title: 'Send to Session',
        description: '向指定 session 发送消息/任务。非阻塞：立即返回，子 session 完成后结果会自动推送到你的对话中。你可以继续处理其他任务。',
        inputSchema: sendSchema,
    }, async (args: { sessionId: string; message: string }) => {
        try {
            // Check if session is thinking first
            let session
            try {
                session = await api.getSession(args.sessionId)
            } catch (err: any) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 未找到或无法访问: ${err.message}`,
                    }],
                    isError: true,
                }
            }

            if (session.thinking) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 正在处理上一个任务（thinking=true）。请稍后再发送。`,
                    }],
                }
            }

            if (!session.active) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前不在线（active=false）。请创建新 session 或等待其重新上线。`,
                    }],
                }
            }

            // Send message - fire and forget
            await api.sendMessageToSession(args.sessionId, args.message, 'brain')

            logger.debug(`[brain] Message sent to session ${args.sessionId}, returning immediately (async callback mode)`)

            return {
                content: [{
                    type: 'text' as const,
                    text: `任务已发送到 Session ${args.sessionId}。\n\n子 session 正在后台执行，完成后结果会自动推送到你的对话中。你可以继续处理其他任务。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `发送失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 4. session_list =====
    const listSchema: z.ZodTypeAny = z.object({
        includeOffline: z.boolean().optional().describe('是否包含离线 session，默认 false（只返回在线的）'),
    })

    mcp.registerTool<any, any>('session_list', {
        title: 'List Sessions',
        description: '列出 session 及其状态。默认只返回在线 session，传 includeOffline=true 可包含离线 session。',
        inputSchema: listSchema,
    }, async (args: { includeOffline?: boolean }) => {
        try {
            const data = await api.listSessions({ includeOffline: args.includeOffline })
            if (!data.sessions || data.sessions.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: '当前没有任何 session。',
                    }],
                }
            }

            const lines = data.sessions.map(s => {
                const status = !s.active
                    ? '⬜ 离线'
                    : s.thinking
                        ? '🔄 执行中'
                        : '✅ 空闲'
                const name = s.metadata?.summary?.text || s.metadata?.path || '未命名'
                const source = s.metadata?.source ? ` [${s.metadata.source}]` : ''
                const isMine = s.metadata?.mainSessionId === brainSessionId ? ' 📌' : ''
                const model = s.modelMode && s.modelMode !== 'default' ? ` [${s.modelMode}]` : ''
                const summary = s.metadata?.brainSummary ? `\n  总结: ${s.metadata.brainSummary}` : ''
                return `- ${s.id.slice(0, 8)} [${status}]${model} ${name}${source}${isMine}${summary}`
            })

            return {
                content: [{
                    type: 'text' as const,
                    text: `当前 sessions (${data.sessions.length}):\n${lines.join('\n')}`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `列出失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 5. session_close =====
    const closeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要关闭的 session ID'),
    })

    mcp.registerTool<any, any>('session_close', {
        title: 'Close Session',
        description: '关闭指定 session。',
        inputSchema: closeSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const result = await api.deleteSession(args.sessionId)
            if (result.ok) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 已关闭。`,
                    }],
                }
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: `关闭失败: 操作未成功。`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `关闭失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 6. session_update =====
    const updateSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        brainSummary: z.string().describe('Brain 写入的任务总结（持久化到 session metadata）'),
    })

    mcp.registerTool<any, any>('session_update', {
        title: 'Update Session',
        description: '更新子 session 的元信息。用于写入 brainSummary（任务总结），方便后续复用时识别 session 做过什么。',
        inputSchema: updateSchema,
    }, async (args: { sessionId: string; brainSummary: string }) => {
        try {
            await api.patchSessionMetadata(args.sessionId, {
                brainSummary: args.brainSummary,
            })
            return {
                content: [{
                    type: 'text' as const,
                    text: `已更新 Session ${args.sessionId} 的总结。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `更新失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 7. session_status =====
    const statusSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要查询的 session ID'),
    })

    mcp.registerTool<any, any>('session_status', {
        title: 'Session Status',
        description: '查询 session 的详细状态：在线/执行中/消息数/token 用量/context 使用率。用于判断是否需要 compact。',
        inputSchema: statusSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const status = await api.getSessionStatus(args.sessionId)

            const lines = [
                `Session: ${args.sessionId}`,
                `状态: ${!status.active ? '离线' : status.thinking ? '执行中' : '空闲'}`,
                `消息数: ${status.messageCount}`,
            ]

            if (status.metadata?.brainSummary) {
                lines.push(`总结: ${status.metadata.brainSummary}`)
            }

            if (status.lastUsage) {
                const contextBudget = getContextBudget(status.modelMode)
                const contextSize = status.lastUsage.contextSize ?? status.lastUsage.input_tokens
                const remainingPercent = Math.max(0, Math.round((1 - contextSize / contextBudget) * 100))
                lines.push(`Context 剩余: ~${remainingPercent}% (${contextSize.toLocaleString()} / ${contextBudget.toLocaleString()} tokens)`)

                if (remainingPercent <= 20) {
                    lines.push(`⚠️ Context 剩余不足，建议发送 /compact 命令`)
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: lines.join('\n'),
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `查询失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 8. session_set_model_mode =====
    const setModelModeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).describe('要切换到的模型。sonnet 适合日常任务，opus 适合复杂推理任务。'),
    })

    mcp.registerTool<any, any>('session_set_model_mode', {
        title: 'Set Session Model Mode',
        description: '切换指定 session 的模型。适用场景：当任务复杂度发生变化时，可以从 sonnet 切换到 opus（或反之）。注意：切换模型不会影响已有的对话历史，但会影响后续的推理能力和成本。',
        inputSchema: setModelModeSchema,
    }, async (args: { sessionId: string; modelMode: string }) => {
        try {
            await api.setSessionModelMode(args.sessionId, args.modelMode as any)
            return {
                content: [{
                    type: 'text' as const,
                    text: `已将 Session ${args.sessionId} 的模型切换为 ${args.modelMode}。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `切换模型失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 9. chat_messages =====
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

            const lines = messages.reverse().map((m: any) =>
                `[${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}] ${m.senderName}: ${m.content}`
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

    toolNames.push(
        'session_create',
        'session_find_or_create',
        'session_send',
        'session_list',
        'session_close',
        'session_update',
        'session_status',
        'session_set_model_mode',
        'chat_messages',
    )

    logger.debug(`[brain] Registered 9 brain tools (async mode) for session ${brainSessionId}`)
}
