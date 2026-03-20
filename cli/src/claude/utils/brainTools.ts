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

    // ===== 1. hapi_session_create =====
    const createSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径，如 /home/guang/softwares/hapi'),
        machineId: z.string().optional().describe('目标机器 ID。不填则使用当前机器。'),
        agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent 类型，默认 claude'),
    })

    mcp.registerTool<any, any>('hapi_session_create', {
        title: 'Create Session',
        description: '在指定机器上创建新的工作 session。返回 sessionId 用于后续操作。',
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
                // Wait for session to come online (up to 30s)
                let ready = false
                for (let i = 0; i < 30; i++) {
                    try {
                        const session = await api.getSession(result.sessionId)
                        if (session.active) {
                            ready = true
                            break
                        }
                    } catch { /* not ready yet */ }
                    await new Promise(r => setTimeout(r, 1000))
                }

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

    // ===== 2. hapi_session_send (async, non-blocking) =====
    const sendSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        message: z.string().describe('要发送的消息/任务指令'),
    })

    mcp.registerTool<any, any>('hapi_session_send', {
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

    // ===== 3. hapi_session_list =====
    const listSchema: z.ZodTypeAny = z.object({})

    mcp.registerTool<any, any>('hapi_session_list', {
        title: 'List Sessions',
        description: '列出所有可用的 session 及其状态。',
        inputSchema: listSchema,
    }, async () => {
        try {
            const data = await api.listSessions()
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
                return `- ${s.id.slice(0, 8)} [${status}] ${name}${source}`
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

    // ===== 4. hapi_session_close =====
    const closeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要关闭的 session ID'),
    })

    mcp.registerTool<any, any>('hapi_session_close', {
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

    toolNames.push(
        'hapi_session_create',
        'hapi_session_send',
        'hapi_session_list',
        'hapi_session_close',
    )

    logger.debug(`[brain] Registered 4 brain tools (async mode) for session ${brainSessionId}`)
}
