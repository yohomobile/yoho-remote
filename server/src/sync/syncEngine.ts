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
import type { SpawnAgentType } from '../store/types'
import { isRealActivityMessage } from '../store/messageUtils'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { buildSessionClearMessagesUpdate } from '../socket/handlers/cli'
import { extractTodoWriteTodosFromMessageContent, TodosSchema, type TodoItem } from './todos'
import { getWebPushService } from '../services/webPush'
import { extractResumeSpawnMetadata } from '../resumeSpawnMetadata'
import {
    SUMMARIZE_TURN_QUEUE_NAME,
    type SummarizeTurnJobPayload,
    type SummarizeTurnQueuePublisher
} from './summarizeTurnQueue'

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

export const SessionActiveMonitorSchema = z.object({
    id: z.string(),
    description: z.string(),
    command: z.string(),
    persistent: z.boolean(),
    timeoutMs: z.number().nullable(),
    startedAt: z.number(),
    taskId: z.string().nullable(),
    state: z.enum(['running', 'unknown']).default('running')
}).passthrough()

export const SessionActiveMonitorsSchema = z.array(SessionActiveMonitorSchema)

export type SessionActiveMonitor = z.infer<typeof SessionActiveMonitorSchema>

const machineMetadataSchema = z.object({
    host: z.string().optional(),
    platform: z.string().optional(),
    yohoRemoteCliVersion: z.string().optional(),
    displayName: z.string().optional(),
}).passthrough()

export interface Session {
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    lastMessageAt: number | null
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
    modelMode?: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'glm-5.1' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
    activeMonitors: SessionActiveMonitor[]
    /** Timestamp of the last abort request; heartbeats within the grace window won't override thinking=false */
    abortedAt?: number
    /** Set when the session was forcibly terminated (e.g. 'license-expired', 'license-suspended') */
    terminationReason?: string
    /** Set during resume to prevent session-end from old process undoing pre-activate.
     *  Value is the timestamp until which the resume guard is active. */
    resumingUntil?: number
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
    supportedAgents: SpawnAgentType[] | null  // null = no restriction (all agents allowed)
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

type AutoResumeGraceOptions = {
    baseTimeoutMs?: number
    maxTimeoutMs?: number
    quietWindowMs?: number
    checkIntervalMs?: number
}

function clampAliveTime(t: number): number | null {
    if (!Number.isFinite(t)) return null
    const now = Date.now()
    if (t > now) return now
    if (t < now - 1000 * 60 * 10) return null
    return t
}

const DEBUG_THINKING = process.env.DEBUG_THINKING === '1'
const INIT_PROMPT_PREFIX = '#InitPrompt-'

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8)
}

function getUserTextMessage(message: DecryptedMessage): string | null {
    const content = message.content as Record<string, unknown> | null
    if (!content || content.role !== 'user') {
        return null
    }
    const inner = content.content as Record<string, unknown> | null | undefined
    if (!inner || inner.type !== 'text' || typeof inner.text !== 'string') {
        return null
    }
    return inner.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isMonitorToolName(name: string): boolean {
    return name === 'Monitor' || name.endsWith('__Monitor')
}

function parseMonitorToolInput(input: unknown): {
    description: string
    command: string
    persistent: boolean
    timeoutMs: number | null
} {
    let value = input
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value) as unknown
        } catch {
            // Keep raw string when parsing fails.
        }
    }
    const record = isRecord(value) ? value : {}
    return {
        description: typeof record.description === 'string' ? record.description : '',
        command: typeof record.command === 'string' ? record.command : '',
        persistent: record.persistent === true,
        timeoutMs: asNumber(record.timeout_ms)
    }
}

type MonitorChange =
    | {
        type: 'remember-tool-call'
        monitor: {
            id: string
            description: string
            command: string
            persistent: boolean
            timeoutMs: number | null
            startedAt: number
        }
    }
    | {
        type: 'start'
        id: string
        taskId: string | null
        startedAt: number
    }
    | {
        type: 'discard-pending'
        id: string
    }
    | {
        type: 'close'
        id: string
    }

type PendingMonitorCall = {
    id: string
    description: string
    command: string
    persistent: boolean
    timeoutMs: number | null
    startedAt: number
}

function isTerminalMonitorStatus(status: string | null): boolean {
    return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed'
}

function extractMonitorChangesFromMessageContent(content: unknown, createdAt: number): MonitorChange[] {
    if (!isRecord(content)) {
        return []
    }

    const role = content.role
    if (role !== 'agent' && role !== 'assistant') {
        return []
    }

    const output = isRecord(content.content) ? content.content : null
    if (!output || output.type !== 'output') {
        return []
    }

    const data = isRecord(output.data) ? output.data : null
    if (!data || typeof data.type !== 'string') {
        return []
    }

    if (data.type === 'assistant' || data.type === 'user') {
        const message = isRecord(data.message) ? data.message : null
        const blocks = Array.isArray(message?.content) ? message.content : []
        const out: MonitorChange[] = []
        for (const block of blocks) {
            if (!isRecord(block)) continue
            if ((block.type !== 'tool_use' && block.type !== 'server_tool_use') || typeof block.id !== 'string') {
                continue
            }
            const name = asString(block.name)
            if (!name || !isMonitorToolName(name)) {
                continue
            }
            const info = parseMonitorToolInput('input' in block ? block.input : undefined)
            out.push({
                type: 'remember-tool-call',
                monitor: {
                    id: block.id,
                    description: info.description,
                    command: info.command,
                    persistent: info.persistent,
                    timeoutMs: info.timeoutMs,
                    startedAt: createdAt,
                }
            })
        }
        for (const block of blocks) {
            if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
                continue
            }
            const permissions = isRecord(block.permissions) ? block.permissions : null
            const deniedByPermission = permissions?.result === 'denied'
                || permissions?.decision === 'denied'
                || permissions?.decision === 'abort'
            if (Boolean(block.is_error) || deniedByPermission) {
                out.push({ type: 'discard-pending', id: block.tool_use_id })
            }
        }
        return out
    }

    if (data.type === 'system') {
        const subtype = asString(data.subtype)
        if (subtype === 'task_started') {
            const toolUseId = asString(data.tool_use_id)
            if (!toolUseId) {
                return []
            }
            return [{
                type: 'start',
                id: toolUseId,
                taskId: asString(data.task_id),
                startedAt: createdAt
            }]
        }

        if (subtype === 'task_notification') {
            const toolUseId = asString(data.tool_use_id)
            if (!toolUseId || !isTerminalMonitorStatus(asString(data.status))) {
                return []
            }
            return [
                { type: 'discard-pending', id: toolUseId },
                { type: 'close', id: toolUseId }
            ]
        }
    }

    return []
}

function sortActiveMonitors(monitors: SessionActiveMonitor[]): SessionActiveMonitor[] {
    return [...monitors].sort((left, right) => {
        if (left.startedAt !== right.startedAt) {
            return left.startedAt - right.startedAt
        }
        return left.id.localeCompare(right.id)
    })
}

function areActiveMonitorsEqual(left: SessionActiveMonitor[], right: SessionActiveMonitor[]): boolean {
    if (left.length !== right.length) return false
    return left.every((monitor, index) => {
        const other = right[index]
        return monitor.id === other.id
            && monitor.description === other.description
            && monitor.command === other.command
            && monitor.persistent === other.persistent
            && monitor.timeoutMs === other.timeoutMs
            && monitor.startedAt === other.startedAt
            && monitor.taskId === other.taskId
            && monitor.state === other.state
    })
}

function applyMonitorChanges(
    current: SessionActiveMonitor[],
    changes: MonitorChange[],
    pendingCalls: Map<string, PendingMonitorCall>
): { monitors: SessionActiveMonitor[]; pendingCalls: Map<string, PendingMonitorCall> } {
    const next = new Map(current.map((monitor) => [monitor.id, monitor]))
    const pending = new Map(pendingCalls)

    for (const change of changes) {
        if (change.type === 'close') {
            next.delete(change.id)
            continue
        }

        if (change.type === 'discard-pending') {
            pending.delete(change.id)
            continue
        }

        if (change.type === 'remember-tool-call') {
            pending.set(change.monitor.id, change.monitor)
            continue
        }

        const prev = next.get(change.id)
        const remembered = pending.get(change.id)
        if (!prev && !remembered) {
            continue
        }

        next.set(change.id, {
            id: change.id,
            description: remembered?.description ?? prev?.description ?? '',
            command: remembered?.command ?? prev?.command ?? '',
            persistent: remembered?.persistent ?? prev?.persistent ?? false,
            timeoutMs: remembered?.timeoutMs ?? prev?.timeoutMs ?? null,
            startedAt: change.startedAt,
            taskId: change.taskId,
            state: 'running'
        })
        pending.delete(change.id)
    }

    return {
        monitors: sortActiveMonitors(Array.from(next.values())),
        pendingCalls: pending
    }
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
    private pendingMonitorCallsBySessionId: Map<string, Map<string, PendingMonitorCall>> = new Map()
    private listeners: Set<SyncEventListener> = new Set()
    private connectionStatus: ConnectionStatus = 'connected'

    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly lastBroadcastAtByMachineId: Map<string, number> = new Map()
    private readonly todoBackfillStateBySessionId: Map<string, { attempts: number; timer: NodeJS.Timeout | null; nextRetryAt: number }> = new Map()
    private readonly deletingSessions: Set<string> = new Set()
    // Tracks brain-child sessions that have completed their init prompt at least once.
    // First thinking→false is the init prompt; subsequent completions are real task results.
    private readonly brainChildInitCompleted: Set<string> = new Set()
    // Messages sent from brain to a brain-child session before init prompt completes.
    // Held here and flushed once the init prompt finishes.
    private readonly brainChildPendingMessages: Map<string, string[]> = new Map()
    private _dbActiveSessionIds: Set<string> = new Set() // Sessions that were active in DB at startup
    private inactivityTimer: NodeJS.Timeout | null = null

    // 推送频率限制：每个 session 最少间隔 30 秒才能再次发送推送
    private readonly lastPushNotificationAt: Map<string, number> = new Map()
    private readonly PUSH_NOTIFICATION_MIN_INTERVAL_MS = 30_000
    // task-complete 通知冷却：同一 session 60 秒内只发一次完整通知（toast + push）
    // 防止 Monitor/loop 等高频 thinking→done 转换导致通知轰炸
    private readonly lastTaskCompleteAt: Map<string, number> = new Map()
    // 启动 hydrate 出来的历史状态只应被静默消化一次，不能在 server 重启后再次触发 toast。
    private readonly startupSuppressedTaskCompleteSessionIds: Set<string> = new Set()
    private readonly startupSuppressedTerminationReplaySessionIds: Set<string> = new Set()
    private missingSummarizeTurnQueueLogged = false
    private readonly TASK_COMPLETE_COOLDOWN_MS = 60_000
    private static readonly TASK_MESSAGE_SETTLE_POLL_MS = 50
    private static readonly TASK_MESSAGE_SETTLE_WINDOW_MS = 200
    private static readonly TASK_MESSAGE_SETTLE_MAX_WAIT_MS = 3_000
    private autoResumeBaseGraceMs = 10_000
    private autoResumeMaxGraceMs = 30_000
    private autoResumeGraceQuietWindowMs = 5_000
    private autoResumeGraceCheckIntervalMs = 1_000

    // Server 启动静默窗口：启动后 30 秒内
    // - reloadAllAsync hydrate session 时不广播 session-added/session-updated
    // - daemon 重连触发的 thinking→done 不发 task-complete toast
    // - handleSessionEnd 不带上历史 terminationReason
    // 避免 server 重启后前端出现 toast 弹窗风暴
    private readonly serverStartedAt = Date.now()
    private static readonly STARTUP_QUIET_WINDOW_MS = 30_000

    constructor(
        private readonly store: IStore,
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry,
        private readonly sseManager: SSEManager,
        private readonly boss?: SummarizeTurnQueuePublisher
    ) {
        this.reloadAllAsync().catch(err => {
            console.error('[SyncEngine] Failed to load initial state from database:', err)
        })
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

    /**
     * 判断当前是否处于 server 启动静默窗口内。
     * 在此窗口内应抑制 hydrate 引起的广播、task-complete 通知与 terminationReason 回显，
     * 避免 server 重启后前端出现 toast 风暴。
     */
    private inStartupQuietWindow(): boolean {
        return Date.now() - this.serverStartedAt < SyncEngine.STARTUP_QUIET_WINDOW_MS
    }

    private markStartupNotificationSuppression(session: Session): void {
        if (session.thinking) {
            this.startupSuppressedTaskCompleteSessionIds.add(session.id)
        }
        if (session.terminationReason) {
            this.startupSuppressedTerminationReplaySessionIds.add(session.id)
        }
    }

    private clearStartupTaskCompleteSuppression(sessionId: string): void {
        this.startupSuppressedTaskCompleteSessionIds.delete(sessionId)
    }

    private consumeStartupTaskCompleteSuppression(sessionId: string): boolean {
        const suppressed = this.startupSuppressedTaskCompleteSessionIds.has(sessionId)
        if (suppressed) {
            this.startupSuppressedTaskCompleteSessionIds.delete(sessionId)
        }
        return suppressed
    }

    private clearStartupTerminationReplaySuppression(sessionId: string): boolean {
        const suppressed = this.startupSuppressedTerminationReplaySessionIds.has(sessionId)
        if (suppressed) {
            this.startupSuppressedTerminationReplaySessionIds.delete(sessionId)
        }
        return suppressed
    }

    private consumeStartupTerminationReplaySuppression(session: Session): boolean {
        const suppressed = this.clearStartupTerminationReplaySuppression(session.id)
        if (suppressed) {
            session.terminationReason = undefined
        }
        return suppressed
    }

    private getEventTerminationReason(session: Session): string | undefined {
        if (this.startupSuppressedTerminationReplaySessionIds.has(session.id)) {
            return undefined
        }
        return session.terminationReason
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

    private async persistSessionActiveMonitors(session: Session): Promise<void> {
        try {
            await (this.store as Partial<IStore>).setSessionActiveMonitors?.(session.id, session.activeMonitors, session.namespace)
        } catch (error) {
            console.error(`[syncEngine] Failed to persist active monitors for session ${session.id}:`, error)
        }
    }

    private emitSessionActiveMonitors(session: Session): void {
        this.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: {
                activeMonitorCount: session.activeMonitors.length
            }
        })
        this.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: {
                activeMonitors: session.activeMonitors
            },
            notifyRecipientClientIds: []
        })
    }

    private buildSessionPayload(session: Session): Record<string, unknown> {
        return {
            id: session.id,
            namespace: session.namespace,
            seq: session.seq,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastMessageAt: session.lastMessageAt,
            active: session.active,
            activeAt: session.activeAt,
            createdBy: session.createdBy,
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
            thinking: session.thinking,
            todos: session.todos,
            permissionMode: session.permissionMode,
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort,
            fastMode: session.fastMode,
            terminationReason: this.getEventTerminationReason(session)
        }
    }

    private async updateSessionActiveMonitorsFromMessage(sessionId: string, message: DecryptedMessage): Promise<void> {
        const changes = extractMonitorChangesFromMessageContent(message.content, message.createdAt)
        if (changes.length === 0) {
            return
        }

        const session = this.sessions.get(sessionId) ?? await this.refreshSession(sessionId)
        if (!session) {
            return
        }

        const pending = this.pendingMonitorCallsBySessionId.get(sessionId) ?? new Map<string, PendingMonitorCall>()
        const result = applyMonitorChanges(session.activeMonitors, changes, pending)
        if (result.pendingCalls.size > 0) {
            this.pendingMonitorCallsBySessionId.set(sessionId, result.pendingCalls)
        } else {
            this.pendingMonitorCallsBySessionId.delete(sessionId)
        }

        if (areActiveMonitorsEqual(session.activeMonitors, result.monitors)) {
            return
        }

        session.activeMonitors = result.monitors
        session.updatedAt = Math.max(session.updatedAt, message.createdAt)
        await this.persistSessionActiveMonitors(session)
        this.emitSessionActiveMonitors(session)
    }

    private async clearSessionActiveMonitors(session: Session): Promise<boolean> {
        if (session.activeMonitors.length === 0) {
            return false
        }
        session.activeMonitors = []
        session.updatedAt = Date.now()
        await this.persistSessionActiveMonitors(session)
        return true
    }

    private async markSessionActiveMonitorsUnknown(session: Session): Promise<boolean> {
        if (session.activeMonitors.length === 0) {
            return false
        }
        const next = session.activeMonitors.map((monitor) => (
            monitor.state === 'unknown' ? monitor : { ...monitor, state: 'unknown' as const }
        ))
        if (areActiveMonitorsEqual(session.activeMonitors, next)) {
            return false
        }
        session.activeMonitors = next
        session.updatedAt = Date.now()
        await this.persistSessionActiveMonitors(session)
        return true
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
            // killSession RPC failed — the CLI process is likely dead or unreachable.
            // Try daemon-level stop as fallback, then proceed with deletion to avoid zombie sessions.
            console.warn(`[deleteSession] killSession RPC failed for ${sessionId}, attempting daemon fallback:`, error)

            const machineId = session?.metadata?.machineId
            if (machineId) {
                try {
                    await this.machineRpc(machineId, 'stop-session', { sessionId })
                } catch (fallbackError) {
                    console.warn(`[deleteSession] Daemon stop-session fallback also failed for ${sessionId}:`, fallbackError)
                }
            }

            // Mark session as inactive so heartbeats won't resurrect it
            if (session) {
                session.active = false
                session.thinking = false
                await this.store.setSessionActive(sessionId, false, Date.now(), session.namespace).catch(() => {})
            }
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
        this.pendingMonitorCallsBySessionId.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.clearTodoBackfillState(sessionId)
        this.lastPushNotificationAt.delete(sessionId)
        this.lastTaskCompleteAt.delete(sessionId)
        this.deletingSessions.delete(sessionId)
        this.brainChildInitCompleted.delete(sessionId)
        this.brainChildPendingMessages.delete(sessionId)
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

    /**
     * Best-effort process termination: tries CLI-level killSession RPC first,
     * then falls back to daemon-level stop-session (kills by PID).
     * Swallows all errors — callers use this for cleanup, not for guaranteed kill.
     */
    async terminateSessionProcess(sessionId: string): Promise<void> {
        try {
            await this.killSession(sessionId)
            return
        } catch {
            // killSession RPC failed — process likely hasn't registered handlers yet
        }
        const session = this.sessions.get(sessionId)
        const machineId = session?.metadata?.machineId
        if (machineId) {
            try {
                await this.machineRpc(machineId, 'stop-session', { sessionId })
            } catch {
                // Process may have never started or already exited
            }
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

    isBrainChildInitDone(sessionId: string): boolean {
        return this.brainChildInitCompleted.has(sessionId)
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

        this.io.of('/cli').to(`session:${sessionId}`).emit('update', buildSessionClearMessagesUpdate({
            sessionId,
            keepCount,
            deleted: result.deleted,
            remaining: result.remaining
        }))

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
            if (event.message) {
                const cached = this.sessionMessages.get(event.sessionId) ?? []
                cached.push(event.message)
                this.sessionMessages.set(event.sessionId, cached.slice(-200))
                await this.updateSessionActiveMonitorsFromMessage(event.sessionId, event.message)
            }
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
        modelMode?: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'glm-5.1' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
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
        // But during resume, the DB may briefly say inactive due to the old process's
        // session-end racing with pre-activate — allow heartbeats through.
        const resumeGuardActive = session.resumingUntil && Date.now() < session.resumingUntil
        if (!session.active && !resumeGuardActive) {
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
        const hadTerminationReason = Boolean(session.terminationReason)

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        this._dbActiveSessionIds.add(session.id)
        if (hadTerminationReason) {
            session.terminationReason = undefined
        }
        this.clearStartupTerminationReplaySuppression(session.id)
        // Resume guard fulfilled — new CLI is alive, clear the guard
        if (session.resumingUntil) {
            session.resumingUntil = undefined
        }
        // payload.thinking 是可选字段：未提供时不要覆盖已有 thinking 状态。
        // 否则会把 session 误判为 thinking=false，导致 wasThinking 误触发。
        if (payload.thinking !== undefined) {
            // While abortedAt is set, block thinking=true heartbeats entirely.
            // The CLI may not have received the abort, so its heartbeats are stale.
            // abortedAt is cleared when: (a) CLI sends thinking=false, or (b) user sends a new message.
            if (session.abortedAt && payload.thinking === true) {
                // Stale heartbeat while abort is active — ignore thinking=true
                session.thinkingAt = t
            } else {
                if (payload.thinking === false && session.abortedAt) {
                    // CLI confirmed abort was processed — clear abort state
                    session.abortedAt = undefined
                }
                session.thinking = payload.thinking
                session.thinkingAt = t
            }
        } else {
            // 仍然更新 thinkingAt 以反映最近一次心跳时间（但不改变 thinking 状态）
            session.thinkingAt = t
        }
        if (payload.thinking === true) {
            this.clearStartupTaskCompleteSuppression(session.id)
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
        if (!wasActive || hadTerminationReason) {
            this.store.setSessionActive(
                session.id,
                true,
                session.activeAt,
                session.namespace,
                hadTerminationReason ? null : undefined
            ).catch(err => {
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
        const thinkingChanged = wasThinking !== session.thinking
        const taskJustCompleted = wasThinking && !session.thinking

        if (thinkingChanged) {
            this.persistSessionThinking(session)
        }

        if (taskJustCompleted) {
            this.enqueueTurnSummary(session).catch(error => {
                console.error(`[syncEngine] failed to enqueue summarize-turn for session ${session.id}:`, error)
            })
        }

        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModelMode !== session.modelMode
            || previousReasoningEffort !== session.modelReasoningEffort
            || previousFastMode !== session.fastMode
        const shouldBroadcast = (!wasActive && session.active)
            || thinkingChanged
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

            // 冷却期内的 thinking→done 转换：只广播状态变化，不发通知
            // 防止 Monitor/loop 等高频循环导致通知轰炸
            // 启动静默窗口内：daemon 重连触发的 thinking→done 不发 task-complete toast
            // 避免 server 重启后前端弹出大量 "Task completed"
            const lastCompleteAt = this.lastTaskCompleteAt.get(session.id) ?? 0
            const inCooldown = taskJustCompleted && (now - lastCompleteAt < this.TASK_COMPLETE_COOLDOWN_MS)
            const inQuietWindow = this.inStartupQuietWindow()
            const suppressStartupReplay = taskJustCompleted
                ? this.consumeStartupTaskCompleteSuppression(session.id)
                : false

            if (taskJustCompleted && !inCooldown && !inQuietWindow && !suppressStartupReplay) {
                this.lastTaskCompleteAt.set(session.id, now)
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
                    fastMode: session.fastMode,
                    activeMonitorCount: session.activeMonitors.length
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
                    fastMode: session.fastMode,
                    activeMonitorCount: session.activeMonitors.length
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
    private getSessionMessageTailFingerprint(sessionId: string): string {
        const cached = this.sessionMessages.get(sessionId) ?? []
        const tail = cached.slice(-5)
        return tail.map(message => {
            const record = message.content as Record<string, unknown> | null
            const role = record?.role as string | undefined
            const inner = record?.content as Record<string, unknown> | string | null | undefined
            const contentType = inner && typeof inner === 'object'
                ? (((inner.data as Record<string, unknown> | undefined)?.type as string | undefined) ?? (inner.type as string | undefined) ?? '')
                : typeof inner === 'string'
                ? 'text'
                : ''
            return `${message.seq}:${role ?? ''}:${contentType}`
        }).join('|')
    }

    private async waitForSessionMessagesToSettle(sessionId: string): Promise<void> {
        const start = Date.now()
        let lastFingerprint: string | null = null
        let stableSince = 0

        while (Date.now() - start < SyncEngine.TASK_MESSAGE_SETTLE_MAX_WAIT_MS) {
            const fingerprint = this.getSessionMessageTailFingerprint(sessionId)
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint
                stableSince = Date.now()
            } else if (stableSince !== 0 && Date.now() - stableSince >= SyncEngine.TASK_MESSAGE_SETTLE_WINDOW_MS) {
                return
            }
            await new Promise(resolve => setTimeout(resolve, SyncEngine.TASK_MESSAGE_SETTLE_POLL_MS))
        }
    }

    private persistSessionThinking(session: Session): void {
        this.store.setSessionThinking(session.id, session.thinking, session.namespace).catch(error => {
            console.error(`[syncEngine] failed to persist thinking for session ${session.id}:`, error)
        })
    }

    private async enqueueTurnSummary(session: Session): Promise<void> {
        if (!this.boss) {
            if (!this.missingSummarizeTurnQueueLogged) {
                this.missingSummarizeTurnQueueLogged = true
                console.warn('[syncEngine] summarize-turn queue publisher is unavailable; enqueue skipped')
            }
            return
        }

        await this.waitForSessionMessagesToSettle(session.id)

        const boundary = await this.store.getTurnBoundary(session.id)
        if (!boundary) {
            return
        }

        const userSeq = boundary.turnStartSeq
        if (!Number.isInteger(userSeq) || userSeq <= 0 || boundary.turnEndSeq <= userSeq) {
            return
        }

        const payload: SummarizeTurnJobPayload = {
            sessionId: session.id,
            namespace: session.namespace,
            userSeq,
            scheduledAtMs: Date.now()
        }

        await this.boss.send(SUMMARIZE_TURN_QUEUE_NAME, payload, {
            singletonKey: `turn:${session.id}:${userSeq}`
        })
    }

    private shouldSkipInitialBrainCallback(messages: DecryptedMessage[]): boolean {
        let sawInitPrompt = false
        for (const message of messages) {
            const text = getUserTextMessage(message)
            if (!text) {
                continue
            }
            if (text.trimStart().startsWith(INIT_PROMPT_PREFIX)) {
                sawInitPrompt = true
                continue
            }
            return false
        }
        return sawInitPrompt
    }

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

            // Task-complete may arrive slightly before the final assistant/result messages.
            // Wait for the in-memory message tail to stop changing before extracting output.
            await this.waitForSessionMessagesToSettle(session.id)
            const messages = await this.store.getMessages(session.id, 30)

            // Skip the first callback only when the message history shows the child is still
            // finishing its init prompt. This avoids dropping legitimate task results in
            // tests or resumed sessions where no init prompt is present in history.
            if (!this.brainChildInitCompleted.has(session.id)) {
                this.brainChildInitCompleted.add(session.id)
                if (this.shouldSkipInitialBrainCallback(messages)) {
                    console.log(`[brain-callback] Skipping init prompt callback for ${shortId(session.id)}`)
                    // Flush any brain messages that arrived before init was done
                    const pending = this.brainChildPendingMessages.get(session.id)
                    if (pending && pending.length > 0) {
                        this.brainChildPendingMessages.delete(session.id)
                        console.log(`[brain-queue] Flushing ${pending.length} buffered message(s) to ${shortId(session.id)}`)
                        for (const text of pending) {
                            await this.sendMessage(session.id, { text, sentFrom: 'brain' })
                        }
                    }
                    return
                }
            }

            let resultText: string | null = null
            let resultSource: 'result' | 'assistant' | 'message' | 'raw-data' | 'none' = 'none'
            let resultSeq: number | null = null

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
                    if (data?.type === 'result' && typeof data.result === 'string') {
                        resultText = data.result
                        resultSource = 'result'
                        resultSeq = messages[i].seq
                    }
                    if (data?.type === 'assistant' && data.message?.content) {
                        const blocks = data.message.content
                        if (Array.isArray(blocks)) {
                            const texts = blocks
                                .filter((b: any) => b.type === 'text')
                                .map((b: any) => b.text?.trim())
                                .filter(Boolean)
                            if (texts.length > 0) {
                                resultText = texts.join('\n')
                                resultSource = 'assistant'
                                resultSeq = messages[i].seq
                            }
                        }
                    }
                    // simpler agent format
                    if (typeof data?.message === 'string') {
                        resultText = data.message
                        resultSource = 'message'
                        resultSeq = messages[i].seq
                    } else if (typeof data === 'string') {
                        resultText = data
                        resultSource = 'raw-data'
                        resultSeq = messages[i].seq
                    }
                }

                if (resultText) break
            }

            const sessionTitle = session.metadata?.summary?.text || session.metadata?.path || session.id
            const brainSummary = (session.metadata as any)?.brainSummary
            const callbackResult = resultText
                ? resultText
                : '（无文本输出）'

            const preview = callbackResult.length > 120
                ? `${callbackResult.slice(0, 120)}...`
                : callbackResult

            const tailSummary = messages.slice(-5).map(message => {
                const content = message.content as any
                const dataType = content?.content?.data?.type ?? content?.content?.type ?? 'unknown'
                return `${message.seq}:${dataType}`
            }).join(',')
            console.log(
                `[brain-callback] Extracted sid=${shortId(session.id)} main=${shortId(mainSessionId)} ` +
                `source=${resultSource} seq=${resultSeq ?? 'n/a'} len=${callbackResult.length} ` +
                `messages=${messages.length} tail=[${tailSummary}] preview=${JSON.stringify(preview)}`
            )

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
                callbackResult
            ].filter(Boolean).join('\n')

            console.log(`[brain-callback] Pushing result from child ${shortId(session.id)} to brain ${shortId(mainSessionId)} (${callbackResult.length} chars)`)

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

        // During resume, the daemon kills the old process before spawning the new one.
        // The old process's session-end must not undo the pre-activate, otherwise the
        // new CLI's heartbeats get blocked (DB says inactive) and resume times out.
        if (session.resumingUntil && Date.now() < session.resumingUntil) {
            return
        }

        if (!session.active && !session.thinking) {
            return
        }

        const wasThinking = session.thinking
        session.active = false
        session.thinking = false
        session.thinkingAt = t
        if (wasThinking !== session.thinking) {
            this.persistSessionThinking(session)
        }
        const suppressStartupTaskComplete = wasThinking
            ? this.consumeStartupTaskCompleteSuppression(session.id)
            : false
        this.consumeStartupTerminationReplaySuppression(session)
        const clearedActiveMonitors = await this.clearSessionActiveMonitors(session)
        this.pendingMonitorCallsBySessionId.delete(session.id)

        // Persist active=false (and terminationReason if set) to database so it survives server restarts
        await this.store.setSessionActive(session.id, false, t, session.namespace, session.terminationReason ?? null)
        this._dbActiveSessionIds.delete(session.id)

        // 如果任务刚完成，使用带订阅者过滤的事件（受 cooldown 限制）
        // 启动静默窗口内：既不发 task-complete toast，也不回显历史 terminationReason，
        // 避免 server 重启后前端弹出 "Task completed" 或 "License expired" 风暴。
        const lastCompleteAt = this.lastTaskCompleteAt.get(session.id) ?? 0
        const inQuietWindow = this.inStartupQuietWindow()
        if (wasThinking && (t - lastCompleteAt >= this.TASK_COMPLETE_COOLDOWN_MS) && !inQuietWindow && !suppressStartupTaskComplete) {
            this.lastTaskCompleteAt.set(session.id, t)
            this.emitTaskCompleteEvent(session)
        } else {
            this.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: false,
                    thinking: false,
                    wasThinking: false,
                    ...(clearedActiveMonitors ? { activeMonitorCount: 0 } : {}),
                    ...(this.getEventTerminationReason(session) && !inQuietWindow
                        ? { terminationReason: this.getEventTerminationReason(session) }
                        : {})
                }
            })
        }
        if (clearedActiveMonitors) {
            this.emitSessionActiveMonitors(session)
        }
    }

    handleSessionDisconnect(payload: { sid: string; time: number }): void {
        if (this.deletingSessions.has(payload.sid)) {
            return
        }

        const session = this.sessions.get(payload.sid)
        if (!session || !session.active) {
            return
        }

        session.active = false
        const wasThinking = session.thinking
        session.thinking = false
        session.thinkingAt = clampAliveTime(payload.time) ?? Date.now()
        if (wasThinking !== session.thinking) {
            this.persistSessionThinking(session)
        }
        const changedActiveMonitors = session.activeMonitors.length > 0
            ? this.markSessionActiveMonitorsUnknown(session)
            : undefined
        this.pendingMonitorCallsBySessionId.delete(session.id)

        this.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: {
                active: false,
                thinking: false,
                wasThinking: false,
                ...(session.activeMonitors.length > 0 ? { activeMonitorCount: session.activeMonitors.length } : {}),
            }
        })
        if (changedActiveMonitors !== undefined) {
            void changedActiveMonitors.then((changed) => {
                if (changed) {
                    this.emitSessionActiveMonitors(session)
                }
            })
        }
    }

    handleMachineDisconnect(payload: { machineId: string; time: number }): void {
        const machine = this.machines.get(payload.machineId)
        if (!machine || !machine.active) {
            return
        }

        machine.active = false
        this.emit({
            type: 'machine-updated',
            machineId: machine.id,
            data: {
                active: false,
            }
        })
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
            const wasThinking = session.thinking
            session.thinking = false
            if (wasThinking !== session.thinking) {
                this.persistSessionThinking(session)
            }
            this._dbActiveSessionIds.delete(session.id)
            const changedActiveMonitors = session.activeMonitors.length > 0
                ? this.markSessionActiveMonitorsUnknown(session)
                : undefined
            this.pendingMonitorCallsBySessionId.delete(session.id)

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

            this.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: false,
                    ...(session.activeMonitors.length > 0 ? { activeMonitorCount: session.activeMonitors.length } : {})
                }
            })
            if (changedActiveMonitors !== undefined) {
                void changedActiveMonitors.then((changed) => {
                    if (changed) {
                        this.emitSessionActiveMonitors(session)
                    }
                })
            }
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
    private _autoResumePending = new Map<string, string>()

    private getAutoResumeSkipReasons(
        session: Session,
        machineId: string,
        namespace: string,
        machineSupportedAgents: SpawnAgentType[] | null | undefined,
        now: number
    ): string[] {
        const reasons: string[] = []
        const cliArchived = session.metadata?.archivedBy === 'cli'
        const flavor = session.metadata?.flavor
        const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000
        const CLI_ARCHIVE_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000

        if (session.active) reasons.push('already-active')
        if (!this._dbActiveSessionIds.has(session.id) && !cliArchived) reasons.push('not-in-dbActive')
        if (session.terminationReason) reasons.push(`terminated:${session.terminationReason}`)
        if (session.metadata?.archivedBy && !cliArchived) reasons.push(`archived:${session.metadata.archivedBy}`)
        if (session.metadata?.startedFromDaemon !== true && session.metadata?.startedBy !== 'daemon') reasons.push('not-daemon-started')
        const maxAge = cliArchived ? CLI_ARCHIVE_RESUME_WINDOW_MS : RESUME_WINDOW_MS
        if (now - session.activeAt > maxAge) reasons.push('too-old')
        if (session.metadata?.machineId !== machineId) reasons.push('wrong-machine')
        if (session.namespace !== namespace) reasons.push('wrong-namespace')
        if (!session.metadata?.path) reasons.push('no-path')
        if (flavor !== 'claude' && flavor !== 'codex') reasons.push(`bad-flavor:${flavor}`)
        if (typeof session.metadata?.claudeSessionId !== 'string' && typeof session.metadata?.codexSessionId !== 'string') reasons.push('no-native-session-id')
        if (machineSupportedAgents && machineSupportedAgents.length > 0 && (flavor === 'claude' || flavor === 'codex') && !machineSupportedAgents.includes(flavor)) {
            reasons.push('unsupported-agent')
        }
        return reasons
    }

    private getAutoResumeCandidates(
        machineId: string,
        namespace: string,
        machineSupportedAgents: SpawnAgentType[] | null | undefined,
        now: number
    ): Session[] {
        return Array.from(this.sessions.values()).filter(session =>
            this.getAutoResumeSkipReasons(session, machineId, namespace, machineSupportedAgents, now).length === 0
        )
    }

    private async autoResumeSessions(machineId: string, namespace: string): Promise<void> {
        console.log(`[auto-resume] Triggered for machine ${machineId.slice(0, 8)}, namespace=${namespace}`)
        if (this._autoResumeInProgress.has(machineId)) {
            console.log(`[auto-resume] Already in progress for ${machineId.slice(0, 8)}, queuing`)
            this._autoResumePending.set(machineId, namespace)
            return
        }
        this._autoResumeInProgress.add(machineId)

        try {
            const rpcMethod = `${machineId}:spawn-yoho-remote-session`
            const maxWait = 10_000
            const start = Date.now()
            while (Date.now() - start < maxWait) {
                if (this.rpcRegistry.getSocketIdForMethod(rpcMethod)) break
                await new Promise(r => setTimeout(r, 500))
            }

            const rpcReady = Boolean(this.rpcRegistry.getSocketIdForMethod(rpcMethod))
            console.log(`[auto-resume] RPC ready=${rpcReady} after ${Date.now() - start}ms`)

            const machine = this.machines.get(machineId)
            if (!machine?.active) {
                console.log(`[auto-resume] Machine ${machineId.slice(0, 8)} no longer active, aborting`)
                return
            }

            await this.waitForAutoResumeGrace(machineId, namespace, machine.supportedAgents)

            if (!this.machines.get(machineId)?.active) {
                console.log(`[auto-resume] Machine ${machineId.slice(0, 8)} went inactive during grace, aborting`)
                return
            }

            const machineSupportedAgents = machine.supportedAgents
            const RESUME_TIMEOUT_MS = 60_000

            const allSessions = Array.from(this.sessions.values())
            const dbActiveCount = Array.from(this._dbActiveSessionIds).length
            const inactiveForMachine = allSessions.filter(s =>
                !s.active && s.metadata?.machineId === machineId && s.namespace === namespace
            )
            console.log(`[auto-resume] Stats: total=${allSessions.length}, dbActiveIds=${dbActiveCount}, inactiveForMachine=${inactiveForMachine.length}`)

            if (inactiveForMachine.length > 0 && inactiveForMachine.length <= 20) {
                for (const s of inactiveForMachine) {
                    const reasons = this.getAutoResumeSkipReasons(s, machineId, namespace, machineSupportedAgents, Date.now())
                        .filter(reason => reason !== 'already-active' && reason !== 'wrong-machine' && reason !== 'wrong-namespace')
                    if (s.metadata?.archivedBy === 'cli') reasons.unshift('cli-archived(ok)')
                    if (reasons.length > 0) {
                        console.log(`[auto-resume] Skip ${s.id.slice(0, 8)}: ${reasons.join(', ')}`)
                    }
                }
            }

            const candidates = this.getAutoResumeCandidates(machineId, namespace, machineSupportedAgents, Date.now())

            if (candidates.length === 0) {
                console.log(`[auto-resume] No candidates found for machine ${machineId.slice(0, 8)}`)
                return
            }
            console.log(`[auto-resume] Machine ${machineId.slice(0, 8)} online, resuming ${candidates.length} session(s)`)

            const resumeOne = async (session: typeof candidates[0]) => {
                try {
                    const flavor = session.metadata!.flavor as string
                    const rawId = flavor === 'claude' ? session.metadata?.claudeSessionId : session.metadata?.codexSessionId
                    if (typeof rawId !== 'string' || !rawId) return

                    const directory = session.metadata!.path
                    const previousActiveAt = session.activeAt
                    await this.store.setSessionActive(session.id, true, previousActiveAt, namespace)
                    session.active = true
                    const previousThinking = session.thinking
                    session.thinking = false
                    if (previousThinking !== session.thinking) {
                        this.persistSessionThinking(session)
                    }
                    session.resumingUntil = Date.now() + RESUME_TIMEOUT_MS
                    const resumeMetadata = extractResumeSpawnMetadata(session.metadata)

                    const result = await this.spawnSession(
                        machineId, directory, flavor, undefined,
                        {
                            sessionId: session.id,
                            resumeSessionId: rawId,
                            permissionMode: session.permissionMode,
                            modelMode: session.modelMode,
                            modelReasoningEffort: session.modelReasoningEffort,
                            ...resumeMetadata
                        }
                    )

                    if (result.type === 'success') {
                        const heartbeatReceived = await this.waitForSessionHeartbeatAfter(session.id, previousActiveAt, RESUME_TIMEOUT_MS)
                        if (!heartbeatReceived) {
                            await this.store.setSessionActive(session.id, false, previousActiveAt, namespace)
                            this._dbActiveSessionIds.delete(session.id)
                            session.active = false
                            const timedOutThinking = session.thinking
                            session.activeAt = previousActiveAt
                            session.thinking = false
                            if (timedOutThinking !== session.thinking) {
                                this.persistSessionThinking(session)
                            }
                            session.resumingUntil = undefined
                            console.warn(`[auto-resume] Session ${session.id.slice(0, 8)} spawn succeeded but no reconnect heartbeat arrived within ${RESUME_TIMEOUT_MS}ms`)
                            return
                        }
                        // Clear stale archive metadata from old CLI cleanup
                        if (session.metadata?.archivedBy === 'cli') {
                            const cleaned = { ...session.metadata }
                            delete cleaned.archivedBy
                            delete (cleaned as any).archiveReason
                            if (cleaned.lifecycleState === 'archived') {
                                cleaned.lifecycleState = 'active'
                                cleaned.lifecycleStateSince = Date.now()
                            }
                            session.metadata = cleaned
                            this.store.updateSessionMetadata(session.id, cleaned, session.metadataVersion, session.namespace).then(r => {
                                if (r.result === 'success') session.metadataVersion = r.version
                            }).catch(err => {
                                console.error(`[auto-resume] Failed to clear archive metadata for ${session.id.slice(0, 8)}:`, err)
                            })
                        }
                        console.log(`[auto-resume] Resumed session ${session.id.slice(0, 8)}`)
                    } else {
                        await this.store.setSessionActive(session.id, false, previousActiveAt, namespace)
                        this._dbActiveSessionIds.delete(session.id)
                        session.active = false
                        session.activeAt = previousActiveAt
                        session.resumingUntil = undefined
                        console.warn(`[auto-resume] Failed to resume session ${session.id.slice(0, 8)}: ${result.message}`)
                    }
                } catch (err) {
                    console.error(`[auto-resume] Error resuming session ${session.id.slice(0, 8)}:`, err)
                }
            }

            const BATCH_SIZE = 5
            for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
                const batch = candidates.slice(i, i + BATCH_SIZE)
                await Promise.allSettled(batch.map(resumeOne))
            }
        } catch (err) {
            console.error('[auto-resume] Unexpected error:', err)
        } finally {
            this._autoResumeInProgress.delete(machineId)
            const pendingNamespace = this._autoResumePending.get(machineId)
            if (pendingNamespace !== undefined) {
                this._autoResumePending.delete(machineId)
                void this.autoResumeSessions(machineId, pendingNamespace)
            }
        }
    }

    private async waitForSessionHeartbeatAfter(sessionId: string, afterActiveAt: number, timeoutMs: number): Promise<boolean> {
        const existing = this.sessions.get(sessionId)
        if (existing?.active && existing.activeAt > afterActiveAt) {
            return true
        }

        return await new Promise((resolve) => {
            let settled = false
            let unsubscribe = () => {}

            const finish = (value: boolean) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                unsubscribe()
                resolve(value)
            }

            const timer = setTimeout(() => finish(false), timeoutMs)

            unsubscribe = this.subscribe((event) => {
                if (event.sessionId !== sessionId) {
                    return
                }
                if (event.type !== 'session-added' && event.type !== 'session-updated') {
                    return
                }
                const current = this.sessions.get(sessionId)
                if (current?.active && current.activeAt > afterActiveAt) {
                    finish(true)
                }
            })

            const current = this.sessions.get(sessionId)
            if (current?.active && current.activeAt > afterActiveAt) {
                finish(true)
            }
        })
    }

    private async waitForAutoResumeGrace(
        machineId: string,
        namespace: string,
        machineSupportedAgents: SpawnAgentType[] | null | undefined,
        options: AutoResumeGraceOptions = {}
    ): Promise<void> {
        const baseTimeoutMs = options.baseTimeoutMs ?? this.autoResumeBaseGraceMs
        const maxTimeoutMs = Math.max(baseTimeoutMs, options.maxTimeoutMs ?? this.autoResumeMaxGraceMs)
        const quietWindowMs = options.quietWindowMs ?? this.autoResumeGraceQuietWindowMs
        const checkIntervalMs = options.checkIntervalMs ?? this.autoResumeGraceCheckIntervalMs

        if (maxTimeoutMs <= 0) return

        const start = Date.now()
        // Always wait through the base grace, then require a short quiet window
        // with no candidate-set changes before we trigger replacement resumes.
        let quietReferenceAt = start + baseTimeoutMs
        let previousPendingKey = this.getAutoResumeCandidates(machineId, namespace, machineSupportedAgents, start)
            .map(session => session.id)
            .sort()
            .join(',')

        if (!previousPendingKey) return

        while (Date.now() - start < maxTimeoutMs) {
            const now = Date.now()
            if (now - start >= baseTimeoutMs && now - quietReferenceAt >= quietWindowMs) {
                return
            }
            await new Promise(r => setTimeout(r, checkIntervalMs))
            if (!this.machines.get(machineId)?.active) {
                return
            }
            const pendingKey = this.getAutoResumeCandidates(machineId, namespace, machineSupportedAgents, Date.now())
                .map(session => session.id)
                .sort()
                .join(',')
            if (!pendingKey) {
                return
            }
            if (pendingKey !== previousPendingKey) {
                quietReferenceAt = Math.max(start + baseTimeoutMs, Date.now())
                previousPendingKey = pendingKey
            }
        }
    }

    /** Public alias for refreshSession - used by guards.ts and events.ts */
    async getOrRefreshSession(sessionId: string): Promise<Session | null> {
        return this.refreshSession(sessionId)
    }

    private async refreshSession(
        sessionId: string,
        opts?: { silent?: boolean }
    ): Promise<Session | null> {
        let stored = await this.store.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            this.pendingMonitorCallsBySessionId.delete(sessionId)
            this.clearTodoBackfillState(sessionId)
            if (existed && !opts?.silent) {
                this.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        const backfillState = this.todoBackfillStateBySessionId.get(sessionId)
        if (stored.todos === null && (!backfillState || (!backfillState.timer && Date.now() >= backfillState.nextRetryAt))) {
            const backfilled = await this.backfillTodosFromHistory(sessionId, stored.namespace)
            if (backfilled) {
                this.clearTodoBackfillState(sessionId)
                stored = await this.store.getSession(sessionId) ?? stored
            } else {
                this.scheduleTodoBackfillRetry(sessionId, 'todo markers not found in history')
            }
        } else if (stored.todos !== null) {
            this.clearTodoBackfillState(sessionId)
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

        const activeMonitors = (() => {
            const parsed = SessionActiveMonitorsSchema.safeParse(stored.activeMonitors)
            return parsed.success ? sortActiveMonitors(parsed.data) : []
        })()

        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            lastMessageAt: existing?.lastMessageAt ?? stored.lastMessageAt,
            active: existing?.active ?? stored.active,
            activeAt: existing?.activeAt ?? (stored.activeAt ?? stored.createdAt),
            createdBy: stored.createdBy ?? undefined,
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? stored.thinking,
            thinkingAt: existing?.thinkingAt ?? (stored.thinkingAt ?? 0),
            todos,
            permissionMode: existing?.permissionMode ?? (stored.permissionMode as any) ?? undefined,
            modelMode: existing?.modelMode ?? (stored.modelMode as any) ?? undefined,
            modelReasoningEffort: existing?.modelReasoningEffort ?? (stored.modelReasoningEffort as any) ?? undefined,
            fastMode: existing?.fastMode ?? stored.fastMode ?? undefined,
            activeMonitors: existing?.activeMonitors ?? activeMonitors,
            terminationReason: existing?.terminationReason ?? stored.terminationReason ?? undefined,
            resumingUntil: existing?.resumingUntil
        }

        this.sessions.set(sessionId, session)
        if (!opts?.silent) {
            this.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: this.buildSessionPayload(session) })
        }
        return session
    }

    private async refreshMachine(
        machineId: string,
        opts?: { silent?: boolean }
    ): Promise<Machine | null> {
        const stored = await this.store.getMachine(machineId)
        if (!stored) {
            const existed = this.machines.delete(machineId)
            if (existed && !opts?.silent) {
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
            orgId: stored.orgId ?? null,
            supportedAgents: stored.supportedAgents ?? null
        }

        this.machines.set(machineId, machine)
        if (!opts?.silent) {
            this.emit({ type: 'machine-updated', machineId, data: machine })
        }
        return machine
    }

    private async reloadAllAsync(): Promise<void> {
        const sessions = await this.store.getSessions()

        // silent 模式：启动 hydrate 时不广播 session-added/session-updated，
        // 避免前端订阅者（含 SSE）在 server 重启后收到大量带历史 terminationReason
        // 的 payload 触发 "License expired" 等 toast 风暴。
        for (const s of sessions) {
            await this.refreshSession(s.id, { silent: true })
        }

        const machines = await this.store.getMachines()
        for (const m of machines) {
            await this.refreshMachine(m.id, { silent: true })
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
        this.startupSuppressedTaskCompleteSessionIds.clear()
        this.startupSuppressedTerminationReplaySessionIds.clear()
        for (const session of this.sessions.values()) {
            this.markStartupNotificationSuppression(session)
        }
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

    private clearTodoBackfillState(sessionId: string): void {
        const state = this.todoBackfillStateBySessionId.get(sessionId)
        if (state?.timer) {
            clearTimeout(state.timer)
        }
        this.todoBackfillStateBySessionId.delete(sessionId)
    }

    private scheduleTodoBackfillRetry(sessionId: string, reason: string): void {
        const state = this.todoBackfillStateBySessionId.get(sessionId) ?? {
            attempts: 0,
            timer: null as NodeJS.Timeout | null,
            nextRetryAt: 0
        }

        if (state.timer) {
            return
        }

        if (state.attempts >= 3) {
            console.warn(`[todo-backfill] Giving up on session ${sessionId.slice(0, 8)} after ${state.attempts} attempts: ${reason}`)
            this.clearTodoBackfillState(sessionId)
            return
        }

        state.attempts += 1
        const delay = 1_000 * (2 ** (state.attempts - 1))
        state.nextRetryAt = Date.now() + delay
        state.timer = setTimeout(() => {
            const current = this.todoBackfillStateBySessionId.get(sessionId)
            if (current) {
                current.timer = null
            }
            void this.refreshSession(sessionId)
        }, delay)

        this.todoBackfillStateBySessionId.set(sessionId, state)
        console.warn(`[todo-backfill] Failed attempt ${state.attempts} for session ${sessionId.slice(0, 8)}: ${reason}; retrying in ${delay}ms`)
    }

    private async backfillTodosFromHistory(sessionId: string, namespace: string): Promise<boolean> {
        const PAGE_SIZE = 200
        let afterSeq = 0

        while (true) {
            const messages = await this.store.getMessagesAfter(sessionId, afterSeq, PAGE_SIZE)
            if (messages.length === 0) {
                return false
            }

            for (const message of messages) {
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (!todos) {
                    continue
                }

                const updated = await this.store.setSessionTodos(sessionId, todos, message.createdAt, namespace)
                if (!updated) {
                    return false
                }

                return true
            }

            if (messages.length < PAGE_SIZE) {
                return false
            }

            afterSeq = messages[messages.length - 1].seq
        }
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

    private async recoverBrainChildInitFromHistory(sessionId: string, session: Session | undefined): Promise<boolean> {
        if (!session || session.metadata?.source !== 'brain-child') {
            return false
        }
        if (this.brainChildInitCompleted.has(sessionId) || session.thinking !== false) {
            return false
        }

        const messages = await this.store.getMessages(sessionId, 20)
        const sawInitPrompt = messages.some((message) => {
            const text = getUserTextMessage(message)
            return Boolean(text?.trimStart().startsWith(INIT_PROMPT_PREFIX))
        })
        const sawAgentReply = messages.some((message) => {
            const content = message.content as Record<string, unknown> | null
            return content?.role === 'agent'
        })

        if (!sawInitPrompt || !sawAgentReply) {
            return false
        }

        this.brainChildInitCompleted.add(sessionId)
        console.warn(`[brain-queue] Recovered init completion state for ${shortId(sessionId)} from persisted history`)
        return true
    }

    async sendMessage(sessionId: string, payload: { text: string; localId?: string | null; sentFrom?: string; meta?: Record<string, unknown> }): Promise<void> {
        // If this is a brain-sent message and the brain-child hasn't finished its init prompt yet,
        // buffer it and deliver it once the init prompt completes.
        if ((payload.sentFrom as string) === 'brain') {
            const session = this.sessions.get(sessionId)
            const isBrainChild = session?.metadata?.source === 'brain-child'
            if (isBrainChild && !this.brainChildInitCompleted.has(sessionId)) {
                const recovered = await this.recoverBrainChildInitFromHistory(sessionId, session)
                if (recovered) {
                    console.log(`[brain-queue] Recovered buffered-send path for ${shortId(sessionId)}`)
                } else {
                    const pending = this.brainChildPendingMessages.get(sessionId) ?? []
                    pending.push(payload.text)
                    this.brainChildPendingMessages.set(sessionId, pending)
                    console.log(`[brain-queue] Buffered brain message for ${sessionId.slice(0, 8)} (init not done yet), queue size=${pending.length}`)
                    return
                }
            }
        }

        // Clear abort state so the CLI's new thinking heartbeats are accepted
        const session = this.sessions.get(sessionId)
        if (session?.abortedAt) {
            session.abortedAt = undefined
        }
        if (session) {
            const consumedStartupThinking = this.consumeStartupTaskCompleteSuppression(sessionId)
            if (consumedStartupThinking) {
                session.thinking = false
                session.thinkingAt = Date.now()
                await this.store.setSessionThinking(session.id, false, session.namespace).catch(error => {
                    console.error(`[sendMessage] Failed to clear stale thinking for session ${session.id}:`, error)
                })
            }
            if (this.clearStartupTerminationReplaySuppression(sessionId)) {
                session.terminationReason = undefined
                await this.store.setSessionActive(session.id, session.active, session.activeAt, session.namespace, null).catch(error => {
                    console.error(`[sendMessage] Failed to clear stale termination for session ${session.id}:`, error)
                })
            }
        }

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

        // 用户主动发消息 → 重置 task-complete 冷却期
        // 确保用户交互后的下一次 thinking→done 能正常触发通知
        this.lastTaskCompleteAt.delete(sessionId)

        if (session) {
            session.lastMessageAt = msg.createdAt
            this.emit({ type: 'session-updated', sessionId, data: this.buildSessionPayload(session) })
        }

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

        if (isRealActivityMessage(content)) {
            const session = this.sessions.get(sessionId)
            if (session) {
                session.lastMessageAt = msg.createdAt
                this.emit({ type: 'session-updated', sessionId, data: this.buildSessionPayload(session) })
            }
        }

        // Keep a small in-memory cache
        const cached = this.sessionMessages.get(sessionId) ?? []
        cached.push({ id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt })
        this.sessionMessages.set(sessionId, cached.slice(-200))
        await this.updateSessionActiveMonitorsFromMessage(sessionId, {
            id: msg.id,
            seq: msg.seq,
            localId: msg.localId,
            content: msg.content,
            createdAt: msg.createdAt
        })

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
        console.log(`[AskUserQuestion] approvePermission`, {
            sessionId,
            requestId,
            hasAnswers: !!answers,
            answersKeys: answers ? Object.keys(answers) : [],
            decision,
        })
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
            const wasThinking = session.thinking
            session.thinking = false
            session.abortedAt = Date.now()
            if (wasThinking !== session.thinking) {
                this.persistSessionThinking(session)
            }

            // Notify clients that thinking stopped (session remains active)
            this.emit({ type: 'session-updated', sessionId, data: { thinking: false } })
        }

        // Send abort RPC to CLI (may not respond if process is hung)
        const rpcFailed = await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted' })
            .then(() => false)
            .catch(err => {
                console.warn(`[abortSession] RPC failed for session ${sessionId}:`, err)
                return true
            })

        // If RPC failed and abort state is still active (user hasn't sent a new message since),
        // escalate to daemon-level stop to actually kill the process.
        // We check abortedAt to avoid killing a process that's already working on a new user message.
        if (rpcFailed && session?.abortedAt && session?.metadata?.machineId) {
            await this.machineRpc(session.metadata.machineId, 'stop-session', { sessionId }).catch(err => {
                console.warn(`[abortSession] Daemon stop-session fallback also failed for ${sessionId}:`, err)
            })
        }
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
            this.emit({ type: 'session-updated', sessionId, data: this.buildSessionPayload(session) })
        }
    }

    async setModelMode(
        sessionId: string,
        model: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2',
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
            this.emit({ type: 'session-updated', sessionId, data: this.buildSessionPayload(session) })
        }
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
            modelMode?: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'glm-5.1' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
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

            this.emit({ type: 'session-updated', sessionId, data: this.buildSessionPayload(session) })
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
        options?: {
            sessionId?: string
            resumeSessionId?: string
            token?: string
            sessionType?: 'simple' | 'worktree'
            worktreeName?: string
            tokenSourceId?: string
            tokenSourceName?: string
            tokenSourceType?: 'claude' | 'codex'
            tokenSourceBaseUrl?: string
            tokenSourceApiKey?: string
            claudeSettingsType?: 'litellm' | 'claude'
            claudeAgent?: string
            opencodeModel?: string
            opencodeVariant?: string
            openrouterModel?: string
            codexModel?: string
            permissionMode?: Session['permissionMode']
            modelMode?: Session['modelMode']
            modelReasoningEffort?: Session['modelReasoningEffort']
            source?: string
            mainSessionId?: string
            caller?: string
            brainPreferences?: Record<string, unknown>
            reuseExistingWorktree?: boolean
        }
    ): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }> {
        // Validate that the machine supports the requested agent
        const machine = this.machines.get(machineId)
        if (machine?.supportedAgents && machine.supportedAgents.length > 0) {
            const requestedAgent = (agent || 'claude') as SpawnAgentType
            if (!machine.supportedAgents.includes(requestedAgent)) {
                const displayName = machine.metadata?.displayName || machine.metadata?.host || machineId.slice(0, 8)
                return {
                    type: 'error',
                    message: `Machine "${displayName}" does not support agent "${requestedAgent}". Supported: ${machine.supportedAgents.join(', ')}`
                }
            }
        }

        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-yoho-remote-session',
                {
                    type: 'spawn-in-directory',
                    directory,
                    agent,
                    yolo,
                    sessionType: options?.sessionType,
                    worktreeName: options?.worktreeName,
                    sessionId: options?.sessionId,
                    resumeSessionId: options?.resumeSessionId,
                    token: options?.token,
                    tokenSourceId: options?.tokenSourceId,
                    tokenSourceName: options?.tokenSourceName,
                    tokenSourceType: options?.tokenSourceType,
                    tokenSourceBaseUrl: options?.tokenSourceBaseUrl,
                    tokenSourceApiKey: options?.tokenSourceApiKey,
                    claudeSettingsType: options?.claudeSettingsType,
                    claudeAgent: options?.claudeAgent,
                    opencodeModel: options?.opencodeModel,
                    opencodeVariant: options?.opencodeVariant,
                    openrouterModel: options?.openrouterModel,
                    codexModel: options?.codexModel,
                    permissionMode: options?.permissionMode,
                    modelMode: options?.modelMode,
                    modelReasoningEffort: options?.modelReasoningEffort,
                    source: options?.source,
                    mainSessionId: options?.mainSessionId,
                    caller: options?.caller,
                    brainPreferences: options?.brainPreferences,
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

    async machineRpcPublic(machineId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params)
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
