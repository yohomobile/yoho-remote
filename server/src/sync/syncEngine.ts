/**
 * Sync Engine for Yoho Remote (Direct Connect)
 *
 * In the direct-connect architecture:
 * - yoho-remote server is the server (Socket.IO + REST)
 * - yoho-remote CLI connects directly to the server (no relay)
 * - No E2E encryption; data is stored as JSON in PostgreSQL
 */

import { z } from 'zod'
import type { Server } from 'socket.io'
import type { IStore } from '../store/interface'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { extractTodoWriteTodosFromMessageContent, TodosSchema, type TodoItem } from './todos'
import { getWebPushService } from '../services/webPush'

export type ConnectionStatus = 'disconnected' | 'connected'

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    source: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    flavor: z.string().nullish(),
    runtimeAgent: z.string().optional(),
    runtimeModel: z.string().optional(),
    runtimeModelReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    worktree: z.object({
        basePath: z.string(),
        branch: z.string(),
        name: z.string(),
        worktreePath: z.string().optional(),
        createdAt: z.number().optional()
    }).optional()
}).passthrough()

export type Metadata = z.infer<typeof MetadataSchema>

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish()
    }).passthrough()).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().optional(),
        mode: z.string().optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
        allowTools: z.array(z.string()).optional(),
        answers: z.record(z.string(), z.array(z.string())).optional()
    }).passthrough()).nullish()
}).passthrough()

export type AgentState = z.infer<typeof AgentStateSchema>

const machineMetadataSchema = z.object({
    host: z.string().optional(),
    platform: z.string().optional(),
    yohoRemoteCliVersion: z.string().optional(),
    displayName: z.string().optional()
}).passthrough()

export interface Session {
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    createdBy?: string  // 创建者 email
    metadata: Metadata | null
    metadataVersion: number
    agentState: AgentState | null
    agentStateVersion: number
    thinking: boolean
    thinkingAt: number
    todos?: TodoItem[]
    permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
    modelMode?: 'default' | 'sonnet' | 'opus' | 'glm-5.1' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
    /** Timestamp of the last abort request; heartbeats within the grace window won't override thinking=false */
    abortedAt?: number
}

export interface Machine {
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: {
        host: string
        platform: string
        yohoRemoteCliVersion: string
        displayName?: string
        [key: string]: unknown
    } | null
    metadataVersion: number
    daemonState: unknown | null
    daemonStateVersion: number
    orgId: string | null
}

export interface DecryptedMessage {
    id: string
    seq: number
    localId: string | null
    content: unknown
    createdAt: number
}

export type FetchMessagesResult =
    | { ok: true; messages: DecryptedMessage[] }
    | { ok: false; status: number | null; error: string }

export type RpcCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type RpcReadFileResponse = {
    success: boolean
    content?: string
    error?: string
}

export type RpcWriteFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type RpcPathExistsResponse = {
    exists: Record<string, boolean>
}

export type SyncEventType =
    | 'session-added'
    | 'session-updated'
    | 'session-removed'
    | 'message-received'
    | 'messages-cleared'
    | 'machine-updated'
    | 'connection-changed'
    | 'online-users-changed'
    | 'typing-changed'
    | 'group-message'
    | 'file-ready'

export type OnlineUser = {
    email: string
    clientId: string
    deviceType?: string
    sessionId: string | null
}

export type TypingUser = {
    email: string
    clientId: string
    text: string
    updatedAt: number
}

export type GroupMessageData = {
    id: string
    groupId: string
    sourceSessionId: string | null
    senderType: 'agent' | 'user' | 'system'
    content: string
    messageType: 'chat' | 'task' | 'feedback' | 'decision'
    createdAt: number
    // 可选的发送者信息（用于前端显示）
    senderName?: string
    agentType?: string
}

type GroupSessionRef = {
    id: string
}

type GroupMessageInsert = {
    groupId: string
    sourceSessionId: string
    content: string
    senderType: 'agent'
    messageType: 'chat'
}

type GroupMessageRecord = {
    id: string
    groupId: string
    sourceSessionId: string | null
    senderType: 'agent' | 'user' | 'system'
    content: string
    messageType: 'chat' | 'task' | 'feedback' | 'decision'
    createdAt: number
}

type GroupStoreLike = {
    getGroupsForSession(sessionId: string): Promise<GroupSessionRef[]>
    addGroupMessage(input: GroupMessageInsert): Promise<GroupMessageRecord>
}

export interface SyncEvent {
    type: SyncEventType
    namespace?: string
    sessionId?: string
    machineId?: string
    groupId?: string
    data?: unknown
    message?: DecryptedMessage
    users?: OnlineUser[]
    typing?: TypingUser
    groupMessage?: GroupMessageData
    fileInfo?: { id: string; filename: string; size: number; mimeType: string }
    // 任务完成通知的接收者列表（用于过滤 SSE 广播）
    notifyRecipientClientIds?: string[]
}

export type SyncEventListener = (event: SyncEvent) => void

function clampAliveTime(t: number): number | null {
    if (!Number.isFinite(t)) return null
    const now = Date.now()
    if (t > now) return now
    if (t < now - 1000 * 60 * 10) return null
    return t
}

const DEBUG_THINKING = process.env.DEBUG_THINKING === '1'

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8)
}

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

export class SyncEngine {
    private sessions: Map<string, Session> = new Map()
    private machines: Map<string, Machine> = new Map()
    private sessionMessages: Map<string, DecryptedMessage[]> = new Map()
    private listeners: Set<SyncEventListener> = new Set()
    private connectionStatus: ConnectionStatus = 'connected'

    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly lastBroadcastAtByMachineId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()
    private readonly deletingSessions: Set<string> = new Set()
    private _dbActiveSessionIds: Set<string> = new Set() // Sessions that were active in DB at startup
    private inactivityTimer: NodeJS.Timeout | null = null

    // 推送频率限制：每个 session 最少间隔 30 秒才能再次发送推送
    private readonly lastPushNotificationAt: Map<string, number> = new Map()
    private readonly PUSH_NOTIFICATION_MIN_INTERVAL_MS = 30_000

    constructor(
        private readonly store: IStore,
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry,
        private readonly sseManager: SSEManager
    ) {
        this.reloadAllAsync()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    start(): Promise<void> {
        return Promise.resolve()
    }

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: SyncEvent): void {
        const namespace = this.resolveNamespace(event)
        const enrichedEvent = namespace ? { ...event, namespace } : event

        for (const listener of this.listeners) {
            try {
                listener(enrichedEvent)
            } catch (error) {
                console.error('[SyncEngine] Listener error:', error)
            }
        }

        // 同步 agent 消息到群组
        if (event.type === 'message-received' && event.sessionId && event.message) {
            const msgContent = event.message.content as Record<string, unknown> | null
            if (msgContent) {
                const role = msgContent.role as string
                // 只同步 agent 的回复，不同步 user 消息
                if (role === 'agent' || role === 'assistant') {
                    const text = this.extractTextFromMessageContent(msgContent)
                    if (text) {
                        this.syncAgentMessageToGroups(event.sessionId, text)
                    }
                }
            }
        }

        const webappEvent: SyncEvent = event.type === 'message-received'
            ? {
                type: event.type,
                namespace,
                sessionId: event.sessionId,
                machineId: event.machineId,
                message: event.message
            }
            : event.type === 'typing-changed'
            ? {
                type: event.type,
                namespace,
                sessionId: event.sessionId,
                typing: event.typing
            }
            : event.type === 'online-users-changed'
            ? {
                type: event.type,
                namespace,
                users: event.users
            }
            : event.type === 'group-message'
            ? {
                type: event.type,
                namespace,
                groupId: event.groupId,
                groupMessage: event.groupMessage
            }
            : {
                type: event.type,
                namespace,
                sessionId: event.sessionId,
                machineId: event.machineId,
                data: event.data
            }

        this.sseManager.broadcast(webappEvent)
        this.broadcastWebSocketEvent(webappEvent)
    }

    private broadcastWebSocketEvent(event: SyncEvent): void {
        const eventsNamespace = this.io.of('/events')
        if (event.type === 'connection-changed' && !event.namespace) {
            eventsNamespace.emit('event', event)
            return
        }
        if (!event.namespace) {
            return
        }
        eventsNamespace.to(`namespace:${event.namespace}`).emit('event', event)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if (event.sessionId) {
            return this.sessions.get(event.sessionId)?.namespace
        }
        if (event.machineId) {
            return this.machines.get(event.machineId)?.namespace
        }
        return undefined
    }

    /**
     * 同步 agent 消息到群组
     * 当 AI 回复消息时，如果该 session 属于某个活跃群组，自动将回复同步到群组消息表
     * 同时广播 SSE 事件给群组订阅者
     */
    private async syncAgentMessageToGroups(sessionId: string, content: string): Promise<void> {
        try {
            const groupStore = this.store as Partial<GroupStoreLike>
            if (typeof groupStore.getGroupsForSession !== 'function' || typeof groupStore.addGroupMessage !== 'function') {
                return
            }

            const groups = await groupStore.getGroupsForSession(sessionId)
            const session = this.sessions.get(sessionId)

            for (const group of groups) {
                // 存储消息到群组
                const message = await groupStore.addGroupMessage({
                    groupId: group.id,
                    sourceSessionId: sessionId,
                    content,
                    senderType: 'agent',
                    messageType: 'chat'
                })

                // 广播 SSE 事件给群组订阅者
                const groupMessageData: GroupMessageData = {
                    id: message.id,
                    groupId: message.groupId,
                    sourceSessionId: message.sourceSessionId,
                    senderType: message.senderType,
                    content: message.content,
                    messageType: message.messageType,
                    createdAt: message.createdAt,
                    senderName: session?.metadata?.name || undefined,
                    agentType: (session?.metadata as Record<string, unknown>)?.agent as string | undefined
                }

                this.sseManager.broadcastToGroup(group.id, {
                    type: 'group-message',
                    groupId: group.id,
                    groupMessage: groupMessageData
                })
            }

            if (groups.length > 0) {
                console.log(`[SyncEngine] Synced agent message to ${groups.length} group(s) for session ${sessionId}`)
            }
        } catch (error) {
            // 群组同步失败不应该影响主流程
            console.error('[SyncEngine] Failed to sync to group:', error)
        }
    }

    /**
     * 从消息内容中提取文本
     */
    private extractTextFromMessageContent(content: unknown): string | null {
        if (!content || typeof content !== 'object') return null
        const record = content as Record<string, unknown>

        const innerContent = record.content as Record<string, unknown> | string | null
        if (typeof innerContent === 'string') {
            return innerContent
        }
        if (innerContent && typeof innerContent === 'object') {
            const contentType = (innerContent as Record<string, unknown>).type as string
            if (contentType === 'codex') {
                const data = (innerContent as Record<string, unknown>).data as Record<string, unknown>
                if (data?.type === 'message' && typeof data.message === 'string') {
                    return data.message
                }
            } else if (contentType === 'text') {
                return ((innerContent as Record<string, unknown>).text as string) || null
            }
        }
        return null
    }

    getConnectionStatus(): ConnectionStatus {
        return this.connectionStatus
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.getSessions().filter((session) => session.namespace === namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessions.get(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    async deleteSession(sessionId: string, options?: { terminateSession?: boolean; force?: boolean }): Promise<boolean> {
        const session = this.sessions.get(sessionId)

        // Cascade: if this is a Brain session, delete all its child sessions first
        const source = (session?.metadata as any)?.source
        if (source === 'brain') {
            const childSessions = this.getSessions().filter(s => {
                const meta = s.metadata as any
                return meta?.source === 'brain-child' && meta?.mainSessionId === sessionId
            })
            for (const child of childSessions) {
                try {
                    await this.deleteSession(child.id, { terminateSession: child.active, force: true })
                } catch (err) {
                    console.error(`[deleteSession] Failed to cascade-delete child session ${child.id}:`, err)
                }
            }
        }

        this.deletingSessions.add(sessionId)
        try {
            if (options?.terminateSession && session?.active) {
                await this.killSession(sessionId)
            }
        } catch (error) {
            this.deletingSessions.delete(sessionId)
            throw error
        }

        const deleted = await this.store.deleteSession(sessionId)
        if (!deleted && !options?.force) {
            this.deletingSessions.delete(sessionId)
            return false
        }
        if (!deleted && !session) {
            this.deletingSessions.delete(sessionId)
            return false
        }

        this.sessions.delete(sessionId)
        this.sessionMessages.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)
        this.lastPushNotificationAt.delete(sessionId)
        this.deletingSessions.delete(sessionId)
        this.emit({ type: 'session-removed', sessionId })
        return deleted || Boolean(session)
    }

    async killSession(sessionId: string): Promise<void> {
        const result = await this.sessionRpc(sessionId, 'killSession', {})
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid killSession response')
        }

        const payload = result as { success?: boolean; message?: string }
        if (!payload.success) {
            throw new Error(payload.message || 'Failed to kill session')
        }
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter(s => s.active)
    }

    getMachines(): Machine[] {
        return Array.from(this.machines.values())
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.getMachines().filter((machine) => machine.namespace === namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machines.get(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        const machine = this.machines.get(machineId)
        if (!machine || machine.namespace !== namespace) {
            return undefined
        }
        return machine
    }

    getOnlineMachines(): Machine[] {
        return this.getMachines().filter(m => m.active)
    }

    getOnlineMachinesByNamespace(namespace: string, orgId?: string | null): Machine[] {
        const machines = this.getMachinesByNamespace(namespace).filter((machine) => machine.active)
        if (orgId) {
            return machines.filter((machine) => machine.orgId === orgId)
        }
        return machines
    }

    getSessionMessages(sessionId: string): DecryptedMessage[] {
        return this.sessionMessages.get(sessionId) || []
    }

    async getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): Promise<{
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    }> {
        const stored = await this.store.getMessages(sessionId, options.limit, options.beforeSeq ?? undefined)
        const messages: DecryptedMessage[] = stored.map((m) => ({
            id: m.id,
            seq: m.seq,
            localId: m.localId,
            content: m.content,
            createdAt: m.createdAt
        }))

        let oldestSeq: number | null = null
        for (const message of messages) {
            if (typeof message.seq !== 'number') continue
            if (oldestSeq === null || message.seq < oldestSeq) {
                oldestSeq = message.seq
            }
        }

        const nextBeforeSeq = oldestSeq
        const hasMoreMessages = await this.store.getMessages(sessionId, 1, nextBeforeSeq ?? undefined)
        const hasMore = nextBeforeSeq !== null && hasMoreMessages.length > 0

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: options.beforeSeq,
                nextBeforeSeq,
                hasMore
            }
        }
    }

    async getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): Promise<DecryptedMessage[]> {
        const stored = await this.store.getMessagesAfter(sessionId, options.afterSeq, options.limit)
        return stored.map((m) => ({
            id: m.id,
            seq: m.seq,
            localId: m.localId,
            content: m.content,
            createdAt: m.createdAt
        }))
    }

    // 获取所有消息（分页循环获取）
    async getAllMessages(sessionId: string): Promise<DecryptedMessage[]> {
        const allMessages: DecryptedMessage[] = []
        const PAGE_SIZE = 200
        let beforeSeq: number | null = null

        while (true) {
            const result = await this.getMessagesPage(sessionId, { limit: PAGE_SIZE, beforeSeq })
            if (result.messages.length === 0) {
                break
            }

            // 消息已经按 seq 排序（从小到大），添加到开头
            allMessages.unshift(...result.messages)

            if (!result.page.hasMore) {
                break
            }

            beforeSeq = result.page.nextBeforeSeq
        }

        return allMessages
    }

    async getMessageCount(sessionId: string): Promise<number> {
        return await this.store.getMessageCount(sessionId)
    }

    async clearSessionMessages(sessionId: string, keepCount: number = 30): Promise<{ deleted: number; remaining: number }> {
        const result = await this.store.clearMessages(sessionId, keepCount)

        // Clear the in-memory cache for this session
        this.sessionMessages.delete(sessionId)

        // Emit an event to notify clients
        this.emit({ type: 'messages-cleared', sessionId })

        return result
    }

    async patchSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            return { ok: false, error: 'Session not found' }
        }

        const success = await this.store.patchSessionMetadata(sessionId, patch, session.namespace)
        if (!success) {
            return { ok: false, error: 'Database update failed' }
        }

        // Refresh in-memory session from DB
        await this.refreshSession(sessionId)
        return { ok: true }
    }

    async getLastUsageForSession(sessionId: string): Promise<{
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
        contextSize: number
    } | null> {
        const messages = await this.store.getMessages(sessionId, 30)

        // IMPORTANT: result message usage is CUMULATIVE (all steps in the query() call summed),
        // while assistant message usage is PER-STEP (single API request).
        // For contextSize calculation we MUST use assistant message usage (per-step),
        // because it reflects the actual current context window usage.
        // We do two passes: first look for assistant message, then fallback to result.

        // Pass 1: find last assistant message with usage (per-step, accurate for contextSize)
        for (let i = messages.length - 1; i >= 0; i--) {
            const content = messages[i].content as any
            if (!content || content.role !== 'agent') continue
            const data = content.content?.data
            if (data?.type === 'assistant') {
                const usage = data.message?.usage
                if (usage && typeof usage.input_tokens === 'number') {
                    const inputTokens = usage.input_tokens ?? 0
                    const cacheRead = usage.cache_read_input_tokens ?? 0
                    const cacheCreation = usage.cache_creation_input_tokens ?? 0
                    return {
                        input_tokens: inputTokens,
                        output_tokens: usage.output_tokens ?? 0,
                        cache_read_input_tokens: cacheRead || undefined,
                        cache_creation_input_tokens: cacheCreation || undefined,
                        contextSize: cacheCreation + cacheRead + inputTokens,
                    }
                }
            }
        }

        // Pass 2: fallback to result message (cumulative usage — contextSize less accurate)
        for (let i = messages.length - 1; i >= 0; i--) {
            const content = messages[i].content as any
            if (!content || content.role !== 'agent') continue
            const data = content.content?.data
            if (data?.type === 'result' && data.usage) {
                const inputTokens = data.usage.input_tokens ?? 0
                const cacheRead = data.usage.cache_read_input_tokens ?? 0
                const cacheCreation = data.usage.cache_creation_input_tokens ?? 0
                return {
                    input_tokens: inputTokens,
                    output_tokens: data.usage.output_tokens ?? 0,
                    cache_read_input_tokens: cacheRead || undefined,
                    cache_creation_input_tokens: cacheCreation || undefined,
                    contextSize: cacheCreation + cacheRead + inputTokens,
                }
            }
        }

        return null
    }

    async handleRealtimeEvent(event: SyncEvent): Promise<void> {
        if (event.type === 'session-updated' && event.sessionId) {
            await this.refreshSession(event.sessionId)
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            await this.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.sessions.has(event.sessionId)) {
                await this.refreshSession(event.sessionId)
            }
        }

        this.emit(event)
    }

    async handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
        modelMode?: 'default' | 'sonnet' | 'opus' | 'glm-5.1' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
        fastMode?: boolean
    }): Promise<void> {
        if (this.deletingSessions.has(payload.sid)) {
            return
        }
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? await this.refreshSession(payload.sid)
        if (!session) return

        // Check if session is archived in database (don't reactivate archived sessions)
        // This prevents zombie heartbeats from reactivating aborted sessions
        if (!session.active) {
            // Verify with database - if DB says inactive, don't reactivate
            const stored = await this.store.getSession(payload.sid)
            if (stored && !stored.active) {
                // Session is archived in DB, ignore heartbeat
                return
            }
        }

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModelMode = session.modelMode
        const previousReasoningEffort = session.modelReasoningEffort
        const previousFastMode = session.fastMode

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        // payload.thinking 是可选字段：未提供时不要覆盖已有 thinking 状态。
        // 否则会把 session 误判为 thinking=false，导致 wasThinking 误触发。
        if (payload.thinking !== undefined) {
            // After an abort, ignore thinking=true heartbeats for a grace period (5s)
            // to prevent stale CLI heartbeats from overriding the abort
            const ABORT_GRACE_MS = 5_000
            const inAbortGrace = session.abortedAt && (t - session.abortedAt < ABORT_GRACE_MS)
            if (inAbortGrace && payload.thinking === true) {
                // Stale heartbeat during abort grace period — ignore thinking=true
                session.thinkingAt = t
            } else {
                if (payload.thinking === true && session.abortedAt) {
                    // CLI confirmed it's thinking again after grace period — clear abort state
                    session.abortedAt = undefined
                }
                session.thinking = payload.thinking
                session.thinkingAt = t
            }
        } else {
            // 仍然更新 thinkingAt 以反映最近一次心跳时间（但不改变 thinking 状态）
            session.thinkingAt = t
        }
        // Only update mode values from CLI heartbeat if server doesn't have authoritative values
        // This prevents CLI heartbeats with stale values from overwriting server-set values
        // (e.g., when Web UI just set a new mode via applySessionConfig but CLI hasn't synced yet)
        let needsPersist = false
        if (payload.permissionMode !== undefined && session.permissionMode === undefined) {
            session.permissionMode = payload.permissionMode
            needsPersist = true
        }
        if (payload.modelMode !== undefined && session.modelMode === undefined) {
            session.modelMode = payload.modelMode
            needsPersist = true
        }
        if (payload.modelReasoningEffort !== undefined && session.modelReasoningEffort === undefined) {
            session.modelReasoningEffort = payload.modelReasoningEffort
            needsPersist = true
        }
        if (payload.fastMode !== undefined && session.fastMode === undefined) {
            session.fastMode = payload.fastMode
            needsPersist = true
        }

        // If session just became active, persist to database
        if (!wasActive) {
            this.store.setSessionActive(session.id, true, session.activeAt, session.namespace).catch(err => {
                console.error(`[handleSessionAlive] Failed to persist active=true for session ${session.id}:`, err)
            })
        }

        // Persist model config if updated from heartbeat
        if (needsPersist) {
            this.store.setSessionModelConfig(session.id, {
                permissionMode: session.permissionMode,
                modelMode: session.modelMode,
                modelReasoningEffort: session.modelReasoningEffort,
                fastMode: session.fastMode
            }, session.namespace).catch(err => {
                console.error(`[handleSessionAlive] Failed to persist model config for session ${session.id}:`, err)
            })
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModelMode !== session.modelMode
            || previousReasoningEffort !== session.modelReasoningEffort
            || previousFastMode !== session.fastMode
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || modeChanged
            || (now - lastBroadcastAt > 10_000)

        if (DEBUG_THINKING && (wasThinking !== session.thinking || wasActive !== session.active)) {
            const machineId = session.metadata?.machineId ?? 'unknown'
            console.log(
                `[sync] session-alive sid=${shortId(session.id)} machine=${machineId} ` +
                `active ${wasActive}->${session.active} thinking ${wasThinking}->${session.thinking} ` +
                `mode=${payload.mode ?? 'n/a'} perm=${session.permissionMode ?? 'unset'} model=${session.modelMode ?? 'unset'}`
            )
        }

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            const taskJustCompleted = wasThinking && !session.thinking

            // 如果任务刚完成，需要获取订阅者信息以过滤 SSE 广播
            if (taskJustCompleted) {
                this.emitTaskCompleteEvent(session)
            } else {
                this.emit({
                    type: 'session-updated',
                    sessionId: session.id,
                    data: {
                        active: session.active,
                        activeAt: session.activeAt,
                        thinking: session.thinking,
                        wasThinking: false,
                        permissionMode: session.permissionMode,
                        modelMode: session.modelMode,
                        modelReasoningEffort: session.modelReasoningEffort,
                        fastMode: session.fastMode
                    }
                })
            }
        }
    }

    /**
     * 发送任务完成事件（带订阅者信息以过滤 SSE 广播）
     * Toast 通知只发给 owner 和订阅者
     */
    private emitTaskCompleteEvent(session: Session): void {
        if (DEBUG_THINKING) {
            console.log(
                `[sync] task-complete sid=${shortId(session.id)} ` +
                `active=${session.active} thinking=${session.thinking}`
            )
        }

        // 异步获取订阅者信息，然后发送事件
        this.store.getSessionNotificationRecipientClientIds(session.id).then(recipientClientIds => {
            this.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: session.active,
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    wasThinking: true,
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode,
                    modelReasoningEffort: session.modelReasoningEffort,
                    fastMode: session.fastMode
                },
                notifyRecipientClientIds: recipientClientIds
            })

            // 同时发送 Web Push 通知
            this.sendTaskCompletePushNotification(session)

            // Brain 回调：如果这是 brain-child session，把结果推回 Brain session
            this.sendBrainCallbackIfNeeded(session)
        }).catch(error => {
            console.error('[syncEngine] failed to get notification recipients:', error)
            // 出错时发送空订阅者列表，这样 SSE 过滤器不会广播给 all:true 订阅
            // 只有正在查看该 session 的用户会收到（用于更新 UI 状态）
            this.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: session.active,
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    wasThinking: true,
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode,
                    modelReasoningEffort: session.modelReasoningEffort,
                    fastMode: session.fastMode
                },
                notifyRecipientClientIds: []  // 空数组，防止广播
            })
            this.sendTaskCompletePushNotification(session)
        })
    }

    /**
     * Brain callback: when a brain-child session completes, push the result back to the Brain session.
     * This enables true async orchestration - Brain sends a task and gets notified when it's done.
     */
    private async sendBrainCallbackIfNeeded(session: Session): Promise<void> {
        try {
            const source = (session.metadata as any)?.source
            const mainSessionId = (session.metadata as any)?.mainSessionId
            if (source !== 'brain-child' || !mainSessionId) {
                return
            }

            // Check Brain session exists
            const brainSession = this.getSession(mainSessionId)
            if (!brainSession) {
                console.warn(`[brain-callback] Brain session ${mainSessionId} not found, will retry`)
                // Brain may be temporarily offline (restarting, etc.) - retry with delay
                await this.retryBrainCallback(session, mainSessionId, 'brain session not found')
                return
            }

            // Get the last few messages from child session to extract result + usage
            const messages = await this.store.getMessages(session.id, 30)
            let resultText: string | null = null

            // Extract usage: prefer assistant message (per-step) over result message (cumulative)
            // Result message usage is cumulative across all steps and would inflate contextSize.
            let lastUsage: { input_tokens: number; output_tokens: number; contextSize: number } | null = null
            for (let i = messages.length - 1; i >= 0; i--) {
                const content = messages[i].content as any
                if (!content || content.role !== 'agent') continue
                const data = content.content?.data
                if (data?.type === 'assistant') {
                    const usage = data.message?.usage
                    if (usage && typeof usage.input_tokens === 'number') {
                        const inputTokens = usage.input_tokens ?? 0
                        const cacheRead = usage.cache_read_input_tokens ?? 0
                        const cacheCreation = usage.cache_creation_input_tokens ?? 0
                        lastUsage = {
                            input_tokens: inputTokens,
                            output_tokens: usage.output_tokens ?? 0,
                            contextSize: cacheCreation + cacheRead + inputTokens,
                        }
                        break
                    }
                }
            }
            if (!lastUsage) {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const content = messages[i].content as any
                    if (!content || content.role !== 'agent') continue
                    const data = content.content?.data
                    if (data?.type === 'result' && data.usage) {
                        const inputTokens = data.usage.input_tokens ?? 0
                        const cacheRead = data.usage.cache_read_input_tokens ?? 0
                        const cacheCreation = data.usage.cache_creation_input_tokens ?? 0
                        lastUsage = {
                            input_tokens: inputTokens,
                            output_tokens: data.usage.output_tokens ?? 0,
                            contextSize: cacheCreation + cacheRead + inputTokens,
                        }
                        break
                    }
                }
            }

            // Extract result text from messages
            for (let i = messages.length - 1; i >= 0; i--) {
                const content = messages[i].content as any
                if (!content || content.role !== 'agent') continue
                const data = content.content?.data

                if (!resultText) {
                    if (data?.type === 'assistant' && data.message?.content) {
                        const blocks = data.message.content
                        if (Array.isArray(blocks)) {
                            const texts = blocks
                                .filter((b: any) => b.type === 'text')
                                .map((b: any) => b.text?.trim())
                                .filter(Boolean)
                            if (texts.length > 0) {
                                resultText = texts.join('\n')
                            }
                        }
                    }
                    // simpler agent format
                    if (typeof data?.message === 'string') {
                        resultText = data.message
                    } else if (typeof data === 'string') {
                        resultText = data
                    }
                }

                if (resultText) break
            }

            const sessionTitle = session.metadata?.summary?.text || session.metadata?.path || session.id
            const brainSummary = (session.metadata as any)?.brainSummary
            const truncatedResult = resultText
                ? resultText.length > 4000 ? resultText.slice(0, 4000) + '\n...(truncated)' : resultText
                : '（无文本输出）'

            // Build token stats line (contextSize formula matches frontend: cache_creation + cache_read + input_tokens)
            const messageCount = await this.store.getMessageCount(session.id)
            const CONTEXT_BUDGET = getContextBudget(session.modelMode)
            let statsLine = `消息数: ${messageCount}`
            if (lastUsage) {
                const remainingPercent = Math.max(0, Math.round((1 - lastUsage.contextSize / CONTEXT_BUDGET) * 100))
                statsLine = `Context 剩余: ~${remainingPercent}% (${lastUsage.contextSize.toLocaleString()} / ${CONTEXT_BUDGET.toLocaleString()} tokens) | ${statsLine}`
            }

            const callbackMessage = [
                `[子 session 任务完成]`,
                `Session: ${session.id}`,
                `标题: ${sessionTitle}`,
                brainSummary ? `上次总结: ${brainSummary}` : null,
                statsLine,
                ``,
                truncatedResult
            ].filter(Boolean).join('\n')

            console.log(`[brain-callback] Pushing result from child ${shortId(session.id)} to brain ${shortId(mainSessionId)} (${truncatedResult.length} chars)`)

            // Retry sendMessage up to 3 times with exponential backoff
            let lastError: Error | null = null
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await this.sendMessage(mainSessionId, {
                        text: callbackMessage,
                        sentFrom: 'brain-callback',
                    })
                    return // success
                } catch (e) {
                    lastError = e as Error
                    if (attempt < 2) {
                        const delay = (attempt + 1) * 2000 // 2s, 4s
                        console.warn(`[brain-callback] Send failed (attempt ${attempt + 1}/3), retrying in ${delay}ms:`, (e as Error).message)
                        await new Promise(r => setTimeout(r, delay))
                    }
                }
            }
            console.error(`[brain-callback] Failed to send callback for session ${session.id} after 3 attempts:`, lastError)
        } catch (error) {
            console.error(`[brain-callback] Failed to send callback for session ${session.id}:`, error)
        }
    }

    /**
     * Retry brain callback with delay - used when Brain session is temporarily unavailable
     */
    private async retryBrainCallback(childSession: Session, mainSessionId: string, reason: string): Promise<void> {
        const MAX_RETRIES = 5
        const RETRY_DELAYS = [5_000, 10_000, 30_000, 60_000, 120_000] // 5s, 10s, 30s, 1m, 2m

        for (let i = 0; i < MAX_RETRIES; i++) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[i]))
            const brainSession = this.getSession(mainSessionId)
            if (brainSession) {
                console.log(`[brain-callback] Brain session ${shortId(mainSessionId)} came back online (retry ${i + 1}), re-sending callback`)
                // Re-invoke the full callback logic
                await this.sendBrainCallbackIfNeeded(childSession)
                return
            }
            console.log(`[brain-callback] Brain session ${shortId(mainSessionId)} still offline (retry ${i + 1}/${MAX_RETRIES}, reason: ${reason})`)
        }
        console.error(`[brain-callback] Gave up waiting for brain session ${shortId(mainSessionId)} after ${MAX_RETRIES} retries. Child session: ${shortId(childSession.id)}`)
    }

    /**
     * Send push notification when a task completes
     * Sends to session owner and subscribers
     *
     * 支持两种订阅方式：
     * 1. 通过 chatId（Telegram 用户）
     * 2. 通过 clientId（非 Telegram 用户）
     */
    private async sendTaskCompletePushNotification(session: Session): Promise<void> {
        const webPush = getWebPushService()
        if (!webPush || !webPush.isConfigured()) {
            return
        }

        // 频率限制：同一 session 30 秒内最多发送一次推送
        const now = Date.now()
        const lastPushAt = this.lastPushNotificationAt.get(session.id) ?? 0
        if (now - lastPushAt < this.PUSH_NOTIFICATION_MIN_INTERVAL_MS) {
            console.log('[webpush] rate limited for session:', session.id,
                `(last push ${Math.round((now - lastPushAt) / 1000)}s ago)`)
            return
        }
        this.lastPushNotificationAt.set(session.id, now)

        const title = session.metadata?.summary?.text || session.metadata?.name || 'Task completed'
        const projectName = session.metadata?.path?.split('/').pop() || 'Session'

        // 获取应该接收通知的 chatIds（Telegram 用户）
        const recipientChatIds = await this.store.getSessionNotificationRecipients(session.id)
        // 获取应该接收通知的 clientIds（非 Telegram 用户）
        const recipientClientIds = await this.store.getSessionNotificationRecipientClientIds(session.id)

        if (recipientChatIds.length === 0 && recipientClientIds.length === 0) {
            console.log('[webpush] no recipients for session:', session.id)
            return
        }

        const payload = {
            title: `${projectName}: Task completed`,
            body: title,
            icon: '/pwa-192x192.png',
            badge: '/pwa-64x64.png',
            tag: `task-complete-${session.id}`,
            data: {
                type: 'task-complete',
                sessionId: session.id,
                url: `/sessions/${session.id}`
            }
        }

        // 发送给 Telegram 用户（通过 chatId）
        if (recipientChatIds.length > 0) {
            console.log('[webpush] sending to chatIds:', recipientChatIds)
            webPush.sendToChatIds(session.namespace, recipientChatIds, payload).catch(error => {
                console.error('[webpush] failed to send to chatIds:', recipientChatIds, error)
            })
        }

        // 发送给非 Telegram 用户（通过 clientId）
        if (recipientClientIds.length > 0) {
            console.log('[webpush] sending to clientIds:', recipientClientIds)
            for (const clientId of recipientClientIds) {
                webPush.sendToClient(session.namespace, clientId, payload).catch(error => {
                    console.error('[webpush] failed to send to clientId:', clientId, error)
                })
            }
        }
    }

    async handleSessionEnd(payload: { sid: string; time: number }): Promise<void> {
        if (this.deletingSessions.has(payload.sid)) {
            return
        }
        const t = clampAliveTime(payload.time) ?? Date.now()

        const session = this.sessions.get(payload.sid) ?? await this.refreshSession(payload.sid)
        if (!session) return

        if (!session.active && !session.thinking) {
            return
        }

        const wasThinking = session.thinking
        session.active = false
        session.thinking = false
        session.thinkingAt = t

        // Persist active=false to database so it survives server restarts
        await this.store.setSessionActive(session.id, false, t, session.namespace)

        // 如果任务刚完成，使用带订阅者过滤的事件
        if (wasThinking) {
            this.emitTaskCompleteEvent(session)
        } else {
            this.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false, wasThinking: false } })
        }
    }

    async handleMachineAlive(payload: { machineId: string; time: number }): Promise<void> {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const machine = this.machines.get(payload.machineId) ?? await this.refreshMachine(payload.machineId)
        if (!machine) return

        const wasActive = machine.active
        machine.active = true
        machine.activeAt = Math.max(machine.activeAt, t)

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtByMachineId.get(machine.id) ?? 0
        const shouldBroadcast = (!wasActive && machine.active) || (now - lastBroadcastAt > 10_000)
        if (shouldBroadcast) {
            this.lastBroadcastAtByMachineId.set(machine.id, now)
            this.emit({ type: 'machine-updated', machineId: machine.id, data: { activeAt: machine.activeAt } })
        }

        // Auto-resume sessions when machine comes back online
        if (!wasActive && machine.active) {
            void this.autoResumeSessions(machine.id, machine.namespace)
        }
    }

    private expireInactive(): void {
        const now = Date.now()
        const sessionTimeoutMs = 1_800_000 // 30 minutes
        const machineTimeoutMs = 1_800_000 // 30 minutes

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            session.thinking = false

            // Persist active=false to database so it survives server restarts
            this.store.setSessionActive(session.id, false, now, session.namespace).catch(err => {
                console.error(`[expireInactive] Failed to persist active=false for session ${session.id}:`, err)
            })

            // Notify CLI to terminate its process
            const cliNamespace = this.io.of('/cli')
            cliNamespace.to(`session:${session.id}`).emit('session-timeout', {
                sessionId: session.id,
                reason: 'inactivity',
                idleMinutes: Math.floor((now - session.activeAt) / 60000)
            })

            this.emit({ type: 'session-updated', sessionId: session.id, data: { active: false } })
        }

        for (const machine of this.machines.values()) {
            if (!machine.active) continue
            if (now - machine.activeAt <= machineTimeoutMs) continue
            machine.active = false
            this.emit({ type: 'machine-updated', machineId: machine.id, data: { active: false } })
        }
    }

    /**
     * Auto-resume inactive sessions when their machine comes back online.
     * Called when a machine transitions from offline to online (e.g. daemon restart).
     */
    private _autoResumeInProgress = new Set<string>()

    private async autoResumeSessions(machineId: string, namespace: string): Promise<void> {
        // Prevent concurrent auto-resume for the same machine
        if (this._autoResumeInProgress.has(machineId)) return
        this._autoResumeInProgress.add(machineId)

        try {
            // Wait for daemon RPC handlers to be registered (poll instead of fixed delay)
            const rpcMethod = `${machineId}:spawn-yoho-remote-session`
            const maxWait = 10_000
            const start = Date.now()
            while (Date.now() - start < maxWait) {
                if (this.rpcRegistry.getSocketIdForMethod(rpcMethod)) break
                await new Promise(r => setTimeout(r, 500))
            }

            // Verify machine is still online after waiting
            const machine = this.machines.get(machineId)
            if (!machine?.active) return

            const candidates = Array.from(this.sessions.values()).filter(s =>
                !s.active &&
                this._dbActiveSessionIds.has(s.id) &&
                s.metadata?.machineId === machineId &&
                s.namespace === namespace &&
                s.metadata?.path &&
                (s.metadata?.flavor === 'claude' || s.metadata?.flavor === 'codex') &&
                (typeof s.metadata?.claudeSessionId === 'string' || typeof s.metadata?.codexSessionId === 'string')
            )

            if (candidates.length === 0) return
            console.log(`[auto-resume] Machine ${machineId.slice(0, 8)} online, resuming ${candidates.length} session(s)`)

            for (const session of candidates) {
                this._dbActiveSessionIds.delete(session.id)
                try {
                    const flavor = session.metadata!.flavor as string
                    const rawId = flavor === 'claude' ? session.metadata?.claudeSessionId : session.metadata?.codexSessionId
                    if (typeof rawId !== 'string' || !rawId) continue

                    const directory = session.metadata!.path
                    const sessionType = session.metadata!.worktree ? 'worktree' as const : 'simple' as const
                    const worktreeName = session.metadata!.worktree?.name

                    // Pre-activate so heartbeats are accepted
                    const activateTime = Date.now()
                    await this.store.setSessionActive(session.id, true, activateTime, namespace)
                    session.active = true
                    session.activeAt = activateTime
                    session.thinking = false

                    const result = await this.spawnSession(
                        machineId, directory, flavor, undefined,
                        sessionType, worktreeName,
                        {
                            sessionId: session.id,
                            resumeSessionId: rawId,
                            permissionMode: session.permissionMode,
                            modelMode: session.modelMode,
                            modelReasoningEffort: session.modelReasoningEffort
                        }
                    )

                    if (result.type === 'success') {
                        console.log(`[auto-resume] Resumed session ${session.id.slice(0, 8)}`)
                    } else {
                        await this.store.setSessionActive(session.id, false, activateTime, namespace)
                        session.active = false
                        console.warn(`[auto-resume] Failed to resume session ${session.id.slice(0, 8)}: ${result.message}`)
                    }
                } catch (err) {
                    console.error(`[auto-resume] Error resuming session ${session.id.slice(0, 8)}:`, err)
                }
            }
        } catch (err) {
            console.error('[auto-resume] Unexpected error:', err)
        } finally {
            this._autoResumeInProgress.delete(machineId)
        }
    }

    /** Public alias for refreshSession - used by guards.ts and events.ts */
    async getOrRefreshSession(sessionId: string): Promise<Session | null> {
        return this.refreshSession(sessionId)
    }

    private async refreshSession(sessionId: string): Promise<Session | null> {
        let stored = await this.store.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = await this.store.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = await this.store.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
                    if (updated) {
                        stored = await this.store.getSession(sessionId) ?? stored
                    }
                    break
                }
            }
        }

        const metadata = (() => {
            const parsed = MetadataSchema.safeParse(stored.metadata)
            return parsed.success ? parsed.data : null
        })()

        const agentState = (() => {
            const parsed = AgentStateSchema.safeParse(stored.agentState)
            return parsed.success ? parsed.data : null
        })()

        const todos = (() => {
            if (stored.todos === null) return undefined
            const parsed = TodosSchema.safeParse(stored.todos)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: existing?.active ?? stored.active,
            activeAt: existing?.activeAt ?? (stored.activeAt ?? stored.createdAt),
            createdBy: stored.createdBy ?? undefined,
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            todos,
            permissionMode: existing?.permissionMode ?? (stored.permissionMode as any) ?? undefined,
            modelMode: existing?.modelMode ?? (stored.modelMode as any) ?? undefined,
            modelReasoningEffort: existing?.modelReasoningEffort ?? (stored.modelReasoningEffort as any) ?? undefined,
            fastMode: existing?.fastMode ?? stored.fastMode ?? undefined
        }

        this.sessions.set(sessionId, session)
        this.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    private async refreshMachine(machineId: string): Promise<Machine | null> {
        const stored = await this.store.getMachine(machineId)
        if (!stored) {
            const existed = this.machines.delete(machineId)
            if (existed) {
                this.emit({ type: 'machine-updated', machineId, data: null })
            }
            return null
        }

        const existing = this.machines.get(machineId)

        const metadata = (() => {
            const parsed = machineMetadataSchema.safeParse(stored.metadata)
            if (!parsed.success) return null
            const data = parsed.data as Record<string, unknown>
            const host = typeof data.host === 'string' ? data.host : 'unknown'
            const platform = typeof data.platform === 'string' ? data.platform : 'unknown'
            const yohoRemoteCliVersion = typeof data.yohoRemoteCliVersion === 'string' ? data.yohoRemoteCliVersion : 'unknown'
            const displayName = typeof data.displayName === 'string' ? data.displayName : undefined
            return { host, platform, yohoRemoteCliVersion, displayName, ...data }
        })()

        const storedActiveAt = stored.activeAt ?? stored.createdAt
        const existingActiveAt = existing?.activeAt ?? 0
        const useStoredActivity = storedActiveAt > existingActiveAt

        const machine: Machine = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: useStoredActivity ? stored.active : (existing?.active ?? stored.active),
            activeAt: useStoredActivity ? storedActiveAt : (existingActiveAt || storedActiveAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            daemonState: stored.daemonState,
            daemonStateVersion: stored.daemonStateVersion,
            orgId: stored.orgId ?? null
        }

        this.machines.set(machineId, machine)
        this.emit({ type: 'machine-updated', machineId, data: machine })
        return machine
    }

    private async reloadAllAsync(): Promise<void> {
        const sessions = await this.store.getSessions()

        for (const s of sessions) {
            await this.refreshSession(s.id)
        }

        const machines = await this.store.getMachines()
        for (const m of machines) {
            await this.refreshMachine(m.id)
        }

        // On server startup, no daemon/CLI is connected yet.
        // Mark all machines and sessions as inactive in memory so that:
        // - handleMachineAlive correctly detects offline→online transition for auto-resume
        // - Only sessions that were active in DB before restart are candidates for auto-resume
        // Note: We track DB-active sessions separately for auto-resume before clearing.
        this._dbActiveSessionIds = new Set(
            Array.from(this.sessions.values())
                .filter(s => s.active)
                .map(s => s.id)
        )
        for (const machine of this.machines.values()) {
            machine.active = false
        }
        for (const session of this.sessions.values()) {
            session.active = false
        }

        // Don't clean up zombie sessions on startup.
        // expireInactive() will handle stale sessions after the timer fires,
        // giving CLI processes time to reconnect and send heartbeats.
    }

    async getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Promise<Session> {
        const stored = await this.store.getOrCreateSession(tag, metadata, agentState, namespace)
        return await this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    async getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown, namespace: string): Promise<Machine> {
        const stored = await this.store.getOrCreateMachine(id, metadata, daemonState, namespace)
        return await this.refreshMachine(stored.id) ?? (() => { throw new Error('Failed to load machine') })()
    }

    async fetchMessages(sessionId: string): Promise<FetchMessagesResult> {
        try {
            const stored = await this.store.getMessages(sessionId, 200)
            const messages: DecryptedMessage[] = stored.map((m) => ({
                id: m.id,
                seq: m.seq,
                localId: m.localId,
                content: m.content,
                createdAt: m.createdAt
            }))
            this.sessionMessages.set(sessionId, messages)
            return { ok: true, messages }
        } catch (error) {
            return { ok: false, status: null, error: error instanceof Error ? error.message : 'Failed to load messages' }
        }
    }

    /**
     * Wait for at least one socket to join the session room.
     * This is useful for ensuring init prompts are received after session spawn.
     */
    async waitForSocketInRoom(sessionId: string, timeoutMs: number = 2000): Promise<boolean> {
        const roomName = `session:${sessionId}`
        const cliNamespace = this.io.of('/cli')
        const startTime = Date.now()

        while (Date.now() - startTime < timeoutMs) {
            const sockets = await cliNamespace.in(roomName).fetchSockets()
            if (sockets.length > 0) {
                return true
            }
            await new Promise(resolve => setTimeout(resolve, 50))
        }
        return false
    }

    async sendMessage(sessionId: string, payload: { text: string; localId?: string | null; sentFrom?: 'telegram-bot' | 'webapp' | 'feishu' | 'brain-callback'; meta?: Record<string, unknown> }): Promise<void> {
        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text
            },
            meta: {
                sentFrom,
                ...(payload.meta ?? {})
            }
        }

        const msg = await this.store.addMessage(sessionId, content, payload.localId ?? undefined)

        const update = {
            id: msg.id,
            seq: Date.now(),
            createdAt: msg.createdAt,
            body: {
                t: 'new-message' as const,
                sid: sessionId,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)

        // Keep a small in-memory cache for Telegram rendering.
        const cached = this.sessionMessages.get(sessionId) ?? []
        cached.push({ id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt })
        this.sessionMessages.set(sessionId, cached.slice(-200))

        this.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    }

    /**
     * 直接添加消息到 session（用于后端注入消息）
     */
    async addMessage(sessionId: string, content: unknown): Promise<void> {
        const msg = await this.store.addMessage(sessionId, content)

        // Keep a small in-memory cache
        const cached = this.sessionMessages.get(sessionId) ?? []
        cached.push({ id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt })
        this.sessionMessages.set(sessionId, cached.slice(-200))

        this.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: 'bypassPermissions',
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]>
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: true,
            mode,
            allowTools,
            decision,
            answers
        })

        // Update server-side permissionMode when mode is changed via permission approval
        if (mode !== undefined) {
            const session = this.sessions.get(sessionId)
            if (session && session.permissionMode !== mode) {
                session.permissionMode = mode
                this.emit({ type: 'session-updated', sessionId, data: { permissionMode: mode } })
            }
        }
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session) {
            // Only stop thinking, keep session active so user can continue
            session.thinking = false
            session.abortedAt = Date.now()

            // Notify clients that thinking stopped (session remains active)
            this.emit({ type: 'session-updated', sessionId, data: { thinking: false } })
        }

        // Send abort RPC to CLI (may not respond if process is hung)
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted' }).catch(err => {
            console.warn(`[abortSession] RPC failed for session ${sessionId}:`, err)
        })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }

    async setPermissionMode(
        sessionId: string,
        mode: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
    ): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session) {
            session.permissionMode = mode
            this.emit({ type: 'session-updated', sessionId, data: session })
        }
    }

    async setModelMode(
        sessionId: string,
        model: 'default' | 'sonnet' | 'opus' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2',
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    ): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session) {
            session.modelMode = model
            if (modelReasoningEffort !== undefined) {
                session.modelReasoningEffort = modelReasoningEffort
            }
            // Persist to database
            await this.store.setSessionModelConfig(sessionId, {
                modelMode: model,
                modelReasoningEffort: modelReasoningEffort
            }, session.namespace)
            this.emit({ type: 'session-updated', sessionId, data: session })
        }
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
            modelMode?: 'default' | 'sonnet' | 'opus' | 'glm-5.1' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
            modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
            fastMode?: boolean
        }
    ): Promise<{
        permissionMode?: Session['permissionMode']
        modelMode?: Session['modelMode']
        modelReasoningEffort?: Session['modelReasoningEffort']
        fastMode?: Session['fastMode']
    }> {
        const result = await this.sessionRpc(sessionId, 'set-session-config', config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as { applied?: { permissionMode?: Session['permissionMode']; modelMode?: Session['modelMode']; modelReasoningEffort?: Session['modelReasoningEffort']; fastMode?: boolean } }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        const session = this.sessions.get(sessionId) ?? await this.refreshSession(sessionId)
        if (session) {
            if (applied.permissionMode !== undefined) {
                session.permissionMode = applied.permissionMode
            }
            if (applied.modelMode !== undefined) {
                session.modelMode = applied.modelMode
            }
            if (applied.modelReasoningEffort !== undefined) {
                session.modelReasoningEffort = applied.modelReasoningEffort
            }
            if (applied.fastMode !== undefined) {
                session.fastMode = applied.fastMode
            }
            if (applied.modelMode === undefined && config.modelMode !== undefined) {
                session.modelMode = config.modelMode
            }
            if (applied.modelReasoningEffort === undefined && config.modelReasoningEffort !== undefined) {
                session.modelReasoningEffort = config.modelReasoningEffort
            }

            // Persist to database
            await this.store.setSessionModelConfig(sessionId, {
                permissionMode: session.permissionMode,
                modelMode: session.modelMode,
                modelReasoningEffort: session.modelReasoningEffort,
                fastMode: session.fastMode
            }, session.namespace)

            this.emit({ type: 'session-updated', sessionId, data: session })
            return {
                permissionMode: session.permissionMode,
                modelMode: session.modelMode,
                modelReasoningEffort: session.modelReasoningEffort,
                fastMode: session.fastMode
            }
        }
        return applied
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: string = 'claude',
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        options?: {
            sessionId?: string
            resumeSessionId?: string
            token?: string
            claudeSettingsType?: 'litellm' | 'claude'
            claudeAgent?: string
            opencodeModel?: string
            opencodeVariant?: string
            openrouterModel?: string
            codexModel?: string
            droidModel?: string
            droidReasoningEffort?: string
            permissionMode?: Session['permissionMode']
            modelMode?: Session['modelMode']
            modelReasoningEffort?: Session['modelReasoningEffort']
            source?: string
            mainSessionId?: string
            caller?: string
            reuseExistingWorktree?: boolean
        }
    ): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }> {
        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-yoho-remote-session',
                {
                    type: 'spawn-in-directory',
                    directory,
                    agent,
                    yolo,
                    sessionType,
                    worktreeName,
                    sessionId: options?.sessionId,
                    resumeSessionId: options?.resumeSessionId,
                    token: options?.token,
                    claudeSettingsType: options?.claudeSettingsType,
                    claudeAgent: options?.claudeAgent,
                    opencodeModel: options?.opencodeModel,
                    opencodeVariant: options?.opencodeVariant,
                    openrouterModel: options?.openrouterModel,
                    codexModel: options?.codexModel,
                    droidModel: options?.droidModel,
                    droidReasoningEffort: options?.droidReasoningEffort,
                    permissionMode: options?.permissionMode,
                    modelMode: options?.modelMode,
                    modelReasoningEffort: options?.modelReasoningEffort,
                    source: options?.source,
                    mainSessionId: options?.mainSessionId,
                    caller: options?.caller,
                    reuseExistingWorktree: options?.reuseExistingWorktree,
                }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                const logs = Array.isArray(obj.logs) ? obj.logs : undefined
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId, logs }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage, logs }
                }
            }
            return { type: 'error', message: 'Unexpected spawn result' }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, 'path-exists', { paths }) as RpcPathExistsResponse | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const existsValue = (result as RpcPathExistsResponse).exists
        if (!existsValue || typeof existsValue !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const exists: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(existsValue)) {
            exists[key] = value === true
        }
        return exists
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-status', { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-numstat', options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-file', options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readFile', { path }) as RpcReadFileResponse
    }

    async readAbsoluteFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readAbsoluteFile', { path }) as RpcReadFileResponse
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'ripgrep', { args, cwd }) as RpcCommandResponse
    }

    async uploadImage(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcWriteFileResponse> {
        return await this.sessionRpc(sessionId, 'uploadImage', { filename, content, mimeType }) as RpcWriteFileResponse
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcWriteFileResponse> {
        return await this.sessionRpc(sessionId, 'uploadFile', { filename, content, mimeType }) as RpcWriteFileResponse
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSlashCommands', { agent }) as {
            success: boolean
            commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
            error?: string
        }
    }

    async getUsage(machineId: string): Promise<{
        claude: {
            fiveHour: { utilization: number; resetsAt: string } | null
            sevenDay: { utilization: number; resetsAt: string } | null
            error?: string
        } | null
        codex: {
            model?: string
            approvalPolicy?: string
            writableRoots?: string[]
            tokenUsage?: { used?: number; remaining?: number }
            error?: string
        } | null
        timestamp: number
    }> {
        return await this.machineRpc(machineId, 'get-usage', {}) as {
            claude: {
                fiveHour: { utilization: number; resetsAt: string } | null
                sevenDay: { utilization: number; resetsAt: string } | null
                error?: string
            } | null
            codex: {
                model?: string
                approvalPolicy?: string
                writableRoots?: string[]
                tokenUsage?: { used?: number; remaining?: number }
                error?: string
            } | null
            timestamp: number
        }
    }

    private async sessionRpc(sessionId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params)
    }

    private async machineRpc(machineId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params)
    }

    private async rpcCall(method: string, params: unknown): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new Error(`RPC handler not registered: ${method}`)
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error(`RPC socket disconnected: ${method}`)
        }

        const response = await socket.timeout(30_000).emitWithAck('rpc-request', {
            method,
            params: JSON.stringify(params)
        }) as unknown

        if (typeof response !== 'string') {
            return response
        }

        try {
            return JSON.parse(response) as unknown
        } catch {
            return response
        }
    }
}
