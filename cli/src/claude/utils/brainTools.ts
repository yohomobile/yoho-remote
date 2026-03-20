/**
 * Brain MCP Tools
 *
 * Provides session orchestration tools for Brain mode.
 * Brain sessions can create, control, and monitor other hapi sessions.
 *
 * Uses true async callback: hapi_session_send returns immediately,
 * and the server pushes results back to the Brain session when
 * the child session completes (via sendBrainCallbackIfNeeded in syncEngine).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

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

    // ===== 1. hapi_session_create =====
    const createSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径，如 /home/guang/softwares/hapi'),
        machineId: z.string().optional().describe('目标机器 ID。不填则使用当前机器。'),
        agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent 类型，默认 claude'),
    })

    mcp.registerTool<any, any>('session_create', {
        title: 'Create Session',
        description: '强制创建新的工作 session。如果只想发任务到已有目录，优先使用 session_find_or_create 来复用空闲 session。',
        inputSchema: createSchema,
    }, async (args: { directory: string; machineId?: string; agent?: string }) => {
        try {
            const targetMachineId = args.machineId || machineId
            logger.debug(`[brain] Creating session: machine=${targetMachineId}, dir=${args.directory}, agent=${args.agent || 'claude'}`)

            const result = await api.brainSpawnSession({
                machineId: targetMachineId,
                directory: args.directory,
                agent: args.agent,
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

    // ===== 2. hapi_session_find_or_create =====
    const findOrCreateSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径'),
        hint: z.string().optional().describe('任务意图关键词（如 "订单API 优惠券"），用于匹配已有上下文的 session，优先复用做过相关工作的 session，省去重新理解代码的成本'),
        machineId: z.string().optional().describe('目标机器 ID。不填则使用当前机器。'),
        agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent 类型，默认 claude'),
    })

    mcp.registerTool<any, any>('session_find_or_create', {
        title: 'Find or Create Session',
        description: '智能查找可复用的空闲子 session。匹配 directory + 属于当前 Brain，并通过 hint 优先选择上下文相关的 session（基于 brainSummary 匹配）。找不到则创建新 session。推荐优先使用此工具。',
        inputSchema: findOrCreateSchema,
    }, async (args: { directory: string; hint?: string; machineId?: string; agent?: string }) => {
        try {
            const targetMachineId = args.machineId || machineId

            // Step 1: List online sessions
            const data = await api.listSessions({ includeOffline: false })

            // Step 2: Find reusable child session
            const candidates = data.sessions.filter(s => {
                if (!s.metadata) return false
                if (s.metadata.source !== 'brain-child') return false
                if (s.metadata.mainSessionId !== brainSessionId) return false
                if (s.metadata.path !== args.directory) return false
                if (s.metadata.machineId !== targetMachineId) return false
                if (!s.active) return false
                if (s.thinking) return false
                return true
            })

            // Pick the best candidate: prefer context-relevant (hint matches brainSummary), then most recently active
            if (candidates.length > 0) {
                let best = candidates.sort((a, b) => b.activeAt - a.activeAt)[0]
                let matchReason = '最近活跃'

                if (args.hint && candidates.length > 1) {
                    // Tokenize hint into keywords, match against brainSummary + session title
                    const hintKeywords = args.hint.toLowerCase().split(/[\s,，/]+/).filter(k => k.length > 0)
                    if (hintKeywords.length > 0) {
                        const scored = candidates.map(s => {
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
                            matchReason = `上下文匹配 (${topMatch.hits}/${hintKeywords.length} 关键词命中)`
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
            logger.debug(`[brain] No reusable session for dir=${args.directory}, creating new one`)

            const result = await api.brainSpawnSession({
                machineId: targetMachineId,
                directory: args.directory,
                agent: args.agent,
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

    // ===== 3. hapi_session_send (async, non-blocking) =====
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

    // ===== 4. hapi_session_list =====
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
                const summary = s.metadata?.brainSummary ? `\n  总结: ${s.metadata.brainSummary}` : ''
                return `- ${s.id.slice(0, 8)} [${status}] ${name}${source}${isMine}${summary}`
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

    // ===== 5. hapi_session_close =====
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

    // ===== 6. hapi_session_update =====
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

    // ===== 7. hapi_session_status =====
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
                const contextBudget = 990_000  // 1M - 10K headroom
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

    toolNames.push(
        'session_create',
        'session_find_or_create',
        'session_send',
        'session_list',
        'session_close',
        'session_update',
        'session_status',
    )

    logger.debug(`[brain] Registered 7 brain tools (async mode) for session ${brainSessionId}`)
}
