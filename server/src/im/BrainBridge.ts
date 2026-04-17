/**
 * BrainBridge — Platform-independent orchestration layer.
 *
 * Manages the bidirectional bridge between IM chats and Brain sessions:
 * - IM → Brain: message buffering, debouncing, session lifecycle
 * - Brain → IM: agent message accumulation, summary sending
 *
 * Platform-specific behavior is delegated to an IMAdapter.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, writeFile } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { IStore } from '../store/interface'
import type { StoredMessage } from '../store/types'
import type { IMAdapter, IMMessage, IMBridgeCallbacks, BrainBridgeConfig } from './types'
import {
    buildBrainSessionPreferences,
    extractBrainChildModelDefaults,
    extractBrainSessionPreferencesFromMetadata,
} from '../brain/brainSessionPreferences'
import { extractAgentText, extractAgentMessageMeta, isInternalBrainMessage } from './agentMessage'
import { buildFeishuMessage, buildFeishuMessageForEdit } from './feishu/formatter'
import { extractActions, actionsToExtras } from './feishu/actionExtractor'
import { lookupKeycloakUserByEmail, type KeycloakUserInfo } from './keycloakLookup'
import { getLicenseService } from '../license/licenseService'

// ========== Structured logging ==========

type LogLevel = 'info' | 'warn' | 'error'

function slog(level: LogLevel, event: string, data: Record<string, unknown>): void {
    const entry = JSON.stringify({ ts: Date.now(), level, event, ...data })
    if (level === 'error') {
        console.error(entry)
    } else if (level === 'warn') {
        console.warn(entry)
    } else {
        console.log(entry)
    }
}

interface ChatState {
    // Buffered incoming messages not yet sent to Brain
    incoming: IMMessage[]
    // Debounce timer for addressed messages (@bot / DM) — 3s
    debounceTimer: ReturnType<typeof setTimeout> | null
    // Debounce timer for passive messages (group non-@bot) — 20s
    passiveDebounceTimer: ReturnType<typeof setTimeout> | null
    // Whether Brain is currently processing (thinking)
    busy: boolean
    // Whether session creation is in progress
    creating: boolean
}

type BufferedAgentMessage = {
    text: string
    messageId: string | null
    seq: number | null
}

function mergeStreamingAgentTexts(texts: string[]): string[] {
    const merged: string[] = []

    for (const rawText of texts) {
        const text = rawText.trim()
        if (!text) {
            continue
        }

        const previous = merged.at(-1)
        if (!previous) {
            merged.push(text)
            continue
        }

        if (previous === text) {
            continue
        }

        if (text.startsWith(previous) && text.length > previous.length) {
            merged[merged.length - 1] = text
            continue
        }

        if (previous.startsWith(text) && previous.length > text.length) {
            continue
        }

        merged.push(text)
    }

    return merged
}

export class BrainBridge implements IMBridgeCallbacks {
    private syncEngine: SyncEngine
    private store: IStore
    private adapter: IMAdapter
    private unsubscribeSyncEvents: (() => void) | null = null
    private isRunning = false

    // Bidirectional mapping cache (loaded from DB at startup)
    private sessionToChatId: Map<string, string> = new Map()
    private chatIdToSessionId: Map<string, string> = new Map()
    private chatIdToChatType: Map<string, string> = new Map()

    // Per-chat state for message buffering
    private chatStates: Map<string, ChatState> = new Map()

    // Accumulate agent messages per chatId (tagged with messageId for thinking removal)
    private agentMessages: Map<string, BufferedAgentMessage[]> = new Map()
    private lastSeenSeq: Map<string, number> = new Map()
    private lastDeliveredSeq: Map<string, number> = new Map()

    // Promise that resolves when session init (initPrompt) is fully processed
    private initReady: Map<string, Promise<void>> = new Map()
    private initReadyResolvers: Map<string, () => void> = new Map()

    // Track the last user message ID per chat for reply threading
    private lastUserMessageId: Map<string, string> = new Map()

    // Track sender IDs for the current round (group chats: @ them in reply)
    private lastSenderIds: Map<string, Set<string>> = new Map()

    // Track whether the last batch was passive-only (no @bot)
    private lastBatchPassive: Map<string, boolean> = new Map()

    // Per-round trace: ID + receive timestamp for latency tracking
    private traceIds: Map<string, string> = new Map()
    private traceStartTimes: Map<string, number> = new Map()

    // "Thinking" indicator: message ID of the thinking placeholder per chat
    private thinkingMessageId: Map<string, string> = new Map()
    private thinkingTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
    private thinkingEditFailures: Map<string, number> = new Map()

    // Tracked timers (cleared on stop)
    private cleanupInterval: ReturnType<typeof setInterval> | null = null
    private recoveryTimeout: ReturnType<typeof setTimeout> | null = null
    private busyWatchdogInterval: ReturnType<typeof setInterval> | null = null
    private initTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
    private initStartTimes: Map<string, number> = new Map()

    // Busy watchdog: detect chats stuck busy after Brain crash
    private busySinceAt: Map<string, number> = new Map()
    private static readonly BUSY_TIMEOUT_MS = 10 * 60_000   // 10 minutes

    // Rebuild rate limiting
    private lastRebuildAt: Map<string, number> = new Map()
    private readonly REBUILD_COOLDOWN_MS = 30_000
    private readonly INPUT_DEBOUNCE_MS = 0
    private readonly PASSIVE_DEBOUNCE_MS = 3_000

    // Brain sessions must run on ncu — it has yoho-memory, yoho-credentials MCP deps
    private static readonly NCU_MACHINE_ID = 'e16b3653-ad9f-46a7-89fd-48a3d576cccb'

    private readonly YOHO_MEMORY_URL = process.env.YOHO_MEMORY_URL || 'http://localhost:3100/api'

    private get logPrefix(): string {
        return `[BrainBridge:${this.adapter.platform}]`
    }

    constructor(config: BrainBridgeConfig) {
        this.syncEngine = config.syncEngine
        this.store = config.store
        this.adapter = config.adapter
    }

    async start(): Promise<void> {
        if (this.isRunning) return
        this.isRunning = true

        // 1. Load existing chat↔session mappings from DB (BEFORE adapter starts receiving events)
        await this.loadMappings()

        // 2. Subscribe to syncEngine events (Brain → IM)
        this.unsubscribeSyncEvents = this.syncEngine.subscribe((event) => {
            this.handleSyncEvent(event)
        })

        // 3. Start the platform adapter (connects to IM, begins receiving messages)
        await this.adapter.start(this)

        console.log(`${this.logPrefix} Started with ${this.sessionToChatId.size} active mapping(s)`)
    }

    async stop(): Promise<void> {
        if (!this.isRunning) return
        this.isRunning = false

        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        // Flush pending incoming messages before shutdown
        for (const [chatId, state] of this.chatStates.entries()) {
            if (state.debounceTimer) clearTimeout(state.debounceTimer)
            if (state.passiveDebounceTimer) clearTimeout(state.passiveDebounceTimer)
            if (state.incoming.length > 0) {
                console.log(`${this.logPrefix} Shutdown: flushing ${state.incoming.length} pending message(s) for ${chatId.slice(0, 12)}`)
                try {
                    await this.flushIncomingMessages(chatId)
                } catch (err) {
                    console.error(`${this.logPrefix} Shutdown flush failed for ${chatId.slice(0, 12)}:`, err)
                }
            }
        }

        // Persist any remaining agentMessages
        for (const chatId of this.agentMessages.keys()) {
            await this.persistChatState(chatId)
        }

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = null
        }
        if (this.busyWatchdogInterval) {
            clearInterval(this.busyWatchdogInterval)
            this.busyWatchdogInterval = null
        }
        if (this.recoveryTimeout) {
            clearTimeout(this.recoveryTimeout)
            this.recoveryTimeout = null
        }
        this.busySinceAt.clear()
        for (const t of this.initTimeouts.values()) clearTimeout(t)
        this.initTimeouts.clear()
        this.initStartTimes.clear()

        this.agentMessages.clear()
        this.lastSeenSeq.clear()
        this.lastDeliveredSeq.clear()
        this.initReady.clear()
        this.initReadyResolvers.clear()
        this.chatStates.clear()
        this.lastUserMessageId.clear()
        this.lastSenderIds.clear()
        this.lastBatchPassive.clear()
        this.lastRebuildAt.clear()
        for (const t of this.thinkingTimers.values()) clearInterval(t)
        this.thinkingTimers.clear()
        this.thinkingMessageId.clear()
        this.thinkingStartTime.clear()
        this.thinkingEditFailures.clear()
        for (const t of this.streamingTimers.values()) clearTimeout(t)
        this.streamingTimers.clear()
        this.streamingMessageId.clear()
        this.streamingUpdateCount.clear()

        await this.adapter.stop()
        console.log(`${this.logPrefix} Stopped`)
    }

    // ========== IMBridgeCallbacks ==========

    getSessionIdForChat(chatId: string): string | null {
        return this.chatIdToSessionId.get(chatId) ?? null
    }

    /**
     * Called when a user reacts to a message with an emoji.
     * Sends a notification to the Brain session as a lightweight message.
     */
    onReaction(chatId: string, messageId: string, emoji: string, userId: string): void {
        // Log for observability; reactions are passive signals — don't interrupt Brain
        console.log(`${this.logPrefix} Reaction ${emoji} on ${messageId.slice(0, 12)} in ${chatId.slice(0, 12)} by ${userId.slice(0, 8)}`)
    }

    /**
     * Called when a user clicks a button/action in an interactive card.
     * Routes the action to the Brain session for processing.
     */
    onCardAction(chatId: string, actionTag: string, actionValue: unknown, userId: string): void {
        const sessionId = this.chatIdToSessionId.get(chatId)
        if (!sessionId) return
        const valueStr = typeof actionValue === 'string' ? actionValue : JSON.stringify(actionValue)

        // Pre-assign traceId so the card action and the resulting reply share the same trace
        if (!this.traceIds.has(chatId)) {
            this.traceIds.set(chatId, `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`)
            this.traceStartTimes.set(chatId, Date.now())
        }
        const traceId = this.traceIds.get(chatId)
        slog('info', 'card.action', {
            traceId,
            chatId: chatId.slice(0, 12),
            userId: userId.slice(0, 8),
            tag: actionTag,
            value: valueStr,
        })

        // Immediate acknowledgment: send a quick 🤔 indicator so user sees the click registered
        this.sendThinkingIndicator(chatId).catch(() => {})

        this.onMessage(chatId, this.chatIdToChatType.get(chatId) || 'p2p', {
            text: `[卡片操作] 用户点击了按钮 "${actionTag}"${valueStr ? `，值: ${valueStr}` : ''}`,
            messageId: `card-action-${Date.now()}`,
            senderName: userId.slice(0, 8),
            senderId: userId,
            senderEmail: null,
            chatType: this.chatIdToChatType.get(chatId) || 'p2p',
            addressed: true,
        })
    }

    /**
     * Called by the adapter when an incoming message is received.
     */
    onMessage(chatId: string, chatType: string, message: IMMessage): void {
        // Get or create chat state
        let state = this.chatStates.get(chatId)
        if (!state) {
            state = { incoming: [], debounceTimer: null, passiveDebounceTimer: null, busy: false, creating: false }
            this.chatStates.set(chatId, state)
        }

        // Generate trace ID for this round (first message starts a new trace)
        if (!this.traceIds.has(chatId)) {
            this.traceIds.set(chatId, `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`)
            this.traceStartTimes.set(chatId, Date.now())
        }
        const traceId = this.traceIds.get(chatId)!

        // Empty addressed message = user pinged bot with no text (e.g. sent @K1 alone)
        // Don't buffer it — instead trigger an immediate flush of any buffered passive messages
        if (message.addressed && !message.text.trim()) {
            slog('info', 'im.message.received', {
                traceId,
                chatId: chatId.slice(0, 12),
                chatType,
                addressed: true,
                msgLen: 0,
                busy: state.busy,
                note: 'ping',
            })
            if (!state.busy && !state.creating && state.incoming.length > 0) {
                if (state.passiveDebounceTimer) {
                    clearTimeout(state.passiveDebounceTimer)
                    state.passiveDebounceTimer = null
                }
                if (state.debounceTimer) clearTimeout(state.debounceTimer)
                // Remember ping sender so bot @mentions them in reply
                if (chatType === 'group') {
                    this.lastSenderIds.set(chatId, new Set([message.senderId]))
                }
                state.debounceTimer = setTimeout(() => {
                    this.flushIncomingMessages(chatId, true).catch(err => {
                        console.error(`${this.logPrefix} flushIncomingMessages (ping) error for ${chatId.slice(0, 12)}:`, err)
                    })
                }, this.INPUT_DEBOUNCE_MS)
            }
            return
        }

        // Add message to buffer
        state.incoming.push(message)
        slog('info', 'im.message.received', {
            traceId,
            chatId: chatId.slice(0, 12),
            chatType,
            addressed: message.addressed,
            msgLen: message.text.length,
            busy: state.busy,
        })

        if (state.busy || state.creating) {
            console.log(`${this.logPrefix} Chat ${chatId.slice(0, 12)} busy, buffered (${state.incoming.length} pending)`)

            // Abort current Brain turn if the new addressed message warrants it:
            //   - p2p: always abort (single user, new message = new intent)
            //   - group: abort only if the sender is already in the current processing batch
            //     (same person adding context / correcting themselves; don't interrupt for a different user)
            if (message.addressed && !state.creating) {
                const isSameSender = chatType === 'p2p'
                    || (this.lastSenderIds.get(chatId)?.has(message.senderId) ?? false)
                if (isSameSender) {
                    const sessionId = this.chatIdToSessionId.get(chatId)
                    if (sessionId) {
                        console.log(`${this.logPrefix} Aborting current Brain turn for ${chatId.slice(0, 12)} (${chatType}, sender=${message.senderId.slice(0, 8)})`)
                        this.syncEngine.abortSession(sessionId).catch(() => {})
                    }
                }
            }
            return
        }

        if (message.addressed) {
            // Addressed message (@bot or DM): 3s debounce, cancels pending passive timer
            if (state.passiveDebounceTimer) {
                clearTimeout(state.passiveDebounceTimer)
                state.passiveDebounceTimer = null
            }
            if (state.debounceTimer) clearTimeout(state.debounceTimer)
            state.debounceTimer = setTimeout(() => {
                this.flushIncomingMessages(chatId).catch(err => {
                    console.error(`${this.logPrefix} flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
                })
            }, this.INPUT_DEBOUNCE_MS)
        } else {
            // Passive message (group non-@bot): 20s debounce
            if (state.debounceTimer) return // addressed flush is coming, it will include this
            if (state.passiveDebounceTimer) clearTimeout(state.passiveDebounceTimer)
            state.passiveDebounceTimer = setTimeout(() => {
                this.flushIncomingMessages(chatId).catch(err => {
                    console.error(`${this.logPrefix} flushIncomingMessages (passive) error for ${chatId.slice(0, 12)}:`, err)
                })
            }, this.PASSIVE_DEBOUNCE_MS)
        }
    }

    // ========== Mapping management ==========

    private async loadMappings(): Promise<void> {
        const mappings = await this.store.getActiveFeishuChatSessions()
        this.sessionToChatId.clear()
        this.chatIdToSessionId.clear()
        this.chatIdToChatType.clear()

        const chatsToRecover: string[] = []

        for (const m of mappings) {
            this.sessionToChatId.set(m.sessionId, m.feishuChatId)
            this.chatIdToSessionId.set(m.feishuChatId, m.sessionId)
            this.chatIdToChatType.set(m.feishuChatId, m.feishuChatType)

            // Restore persisted state from DB
            const s = m.state as {
                agentMessages?: string[]
                lastUserMessageId?: string | null
                busy?: boolean
                lastDeliveredSeq?: number
            } | null
            if (typeof s?.lastDeliveredSeq === 'number') {
                this.lastDeliveredSeq.set(m.feishuChatId, s.lastDeliveredSeq)
            }
            if (s && (s.agentMessages?.length || s.lastUserMessageId || s.busy || s.lastDeliveredSeq !== undefined)) {
                if (s.agentMessages?.length) {
                    this.agentMessages.set(m.feishuChatId, s.agentMessages.map(t => ({ text: t, messageId: null, seq: null })))
                }
                if (s.lastUserMessageId) {
                    this.lastUserMessageId.set(m.feishuChatId, s.lastUserMessageId)
                }
                if (s.busy) {
                    this.chatStates.set(m.feishuChatId, {
                        incoming: [], debounceTimer: null, passiveDebounceTimer: null, busy: true, creating: false,
                    })
                    chatsToRecover.push(m.feishuChatId)
                } else if (s.agentMessages?.length) {
                    chatsToRecover.push(m.feishuChatId)
                }
                console.log(`${this.logPrefix} Restored state for chat ${m.feishuChatId.slice(0, 12)}: ${s.agentMessages?.length || 0} agentMsgs, busy=${s.busy}`)
            }
        }

        // For chats that were busy before restart, check if Brain already finished
        if (chatsToRecover.length > 0) {
            this.recoveryTimeout = setTimeout(() => {
                this.recoveryTimeout = null
                for (const chatId of chatsToRecover) {
                    const sessionId = this.chatIdToSessionId.get(chatId)
                    if (!sessionId) continue
                    const session = this.syncEngine.getSession(sessionId)
                    if (session && !session.thinking) {
                        console.log(`${this.logPrefix} Recovering: Brain already done for chat ${chatId.slice(0, 12)}, sending summary`)
                        this.sendSummary(chatId).catch(err => {
                            console.error(`${this.logPrefix} Recovery sendSummary error for ${chatId.slice(0, 12)}:`, err)
                        })
                        const state = this.chatStates.get(chatId)
                        if (state) { state.busy = false; this.busySinceAt.delete(chatId) }
                    }
                }
            }, 5000)
        }

        // Periodic cleanup: delete messages older than 7 days
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
        const cleanup = () => {
            this.store.cleanOldFeishuChatMessages(SEVEN_DAYS_MS)
                .then(n => { if (n > 0) console.log(`${this.logPrefix} Cleaned ${n} old chat messages`) })
                .catch(err => console.error(`${this.logPrefix} Chat message cleanup error:`, err))
        }
        cleanup()
        this.cleanupInterval = setInterval(cleanup, 60 * 60 * 1000)

        // Busy watchdog: reset chats stuck busy >10min after Brain crash
        this.busyWatchdogInterval = setInterval(() => {
            this.checkBusyWatchdog().catch(() => {})
        }, 5 * 60_000)
    }

    // ========== State persistence ==========

    private async persistChatState(chatId: string): Promise<void> {
        const state = this.chatStates.get(chatId)
        const rawMsgs = this.agentMessages.get(chatId) || []
        const lastMsgId = this.lastUserMessageId.get(chatId) || null
        const persisted = {
            agentMessages: rawMsgs.map(m => m.text),
            lastUserMessageId: lastMsgId,
            busy: state?.busy || false,
            lastDeliveredSeq: this.lastDeliveredSeq.get(chatId) ?? 0,
        }
        try {
            await this.store.updateFeishuChatState(chatId, persisted)
        } catch (err) {
            console.error(`${this.logPrefix} persistChatState failed for ${chatId.slice(0, 12)}:`, err)
        }
    }

    private async clearPersistedState(chatId: string): Promise<void> {
        try {
            const lastDeliveredSeq = this.lastDeliveredSeq.get(chatId) ?? 0
            await this.store.updateFeishuChatState(chatId, lastDeliveredSeq > 0 ? { lastDeliveredSeq } : {})
        } catch (err) {
            console.error(`${this.logPrefix} clearPersistedState failed for ${chatId.slice(0, 12)}:`, err)
        }
    }

    // ========== Busy watchdog ==========

    private async checkBusyWatchdog(): Promise<void> {
        const now = Date.now()
        for (const [chatId, sinceAt] of this.busySinceAt) {
            if (now - sinceAt < BrainBridge.BUSY_TIMEOUT_MS) continue
            const state = this.chatStates.get(chatId)
            if (!state?.busy) {
                this.busySinceAt.delete(chatId)
                continue
            }
            const busyMs = now - sinceAt
            slog('warn', 'busy.timeout', { chatId: chatId.slice(0, 12), busyMs })
            state.busy = false
            this.busySinceAt.delete(chatId)
            await this.clearThinkingIndicator(chatId).catch(() => {})
            this.adapter.sendText(chatId, '⚠️ 处理超时，已自动恢复。如需继续，请重新发送消息。').catch(() => {})
            await this.clearPersistedState(chatId).catch(() => {})
        }
    }

    // ========== Message flushing ==========

    private async flushIncomingMessages(chatId: string, forceAddressed = false): Promise<void> {
        const state = this.chatStates.get(chatId)
        if (!state || state.incoming.length === 0) return
        if (state.creating) return

        const messages = [...state.incoming]
        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer)
            state.debounceTimer = null
        }
        if (state.passiveDebounceTimer) {
            clearTimeout(state.passiveDebounceTimer)
            state.passiveDebounceTimer = null
        }

        const chatType = messages[0].chatType
        const senderName = messages[0].senderName
        const sessionId = await this.ensureSession(chatId, chatType, senderName)
        if (!sessionId) {
            await this.adapter.sendText(chatId, '⚠️ 暂时无法响应——没有可用的计算节点。稍后会自动恢复，请过几分钟再试。')
            state.incoming.splice(0, messages.length)
            return
        }

        // Wait for initPrompt to be sent first
        const initPromise = this.initReady.get(chatId)
        if (initPromise) {
            try {
                await initPromise
            } catch (err) {
                console.warn(`${this.logPrefix} initPromise failed for ${chatId.slice(0, 12)}:`, err)
            } finally {
                this.initReady.delete(chatId)
            }
        }

        await this.store.touchFeishuChatSession(chatId).catch(() => {})

        // Format merged messages
        const hasAddressed = forceAddressed || messages.some(m => m.addressed)
        const hasPassive = messages.some(m => !m.addressed)
        const formattedParts = messages.map(m => {
            if (chatType === 'group') {
                const prefix = m.addressed ? '[指令] ' : ''
                return `${prefix}${m.senderName} (${m.senderId}): ${m.text}`
            }
            return m.text
        })

        let combined = formattedParts.join('\n')

        if (chatType === 'group') {
            if (forceAddressed) {
                // User pinged bot (@K1 alone) to respond to buffered passive messages
                combined = `[指令] 请回复群内以下消息：\n${combined}`
            } else if (hasPassive && !hasAddressed) {
                const uniqueSenders = new Set(messages.map(m => m.senderId))
                if (uniqueSenders.size > 1) {
                    // Multiple people chatting — let LLM decide engagement level
                    combined = `[群聊] 以下是群里的新消息，根据内容决定参与方式（回复/表情/沉默）：\n${combined}`
                } else {
                    // Single sender without @ — likely talking to the bot
                    combined = `[群聊] 群里有消息（对方没有@你，但可能在跟你说话）：\n${combined}`
                }
            }
        }

        // Fetch user profiles for appendSystemPrompt
        const appendSystemPrompt = await this.buildUserProfilePrompt(messages, chatType)

        // Remember last user message ID for reply threading
        const lastMsgId = messages[messages.length - 1].messageId
        if (lastMsgId) {
            this.lastUserMessageId.set(chatId, lastMsgId)
        }

        // Remember addressed sender IDs for @ mention in reply (passive senders excluded)
        // forceAddressed (ping): sender already set in onMessage — don't overwrite with empty set
        if (chatType === 'group' && !forceAddressed) {
            const addressedSenderIds = new Set(messages.filter(m => m.addressed).map(m => m.senderId))
            this.lastSenderIds.set(chatId, addressedSenderIds)
        }

        // Track if this batch is passive-only
        this.lastBatchPassive.set(chatId, chatType === 'group' && hasPassive && !hasAddressed)

        const flushStart = Date.now()
        console.log(`${this.logPrefix} Sending ${messages.length} merged message(s) to session ${sessionId.slice(0, 8)}${appendSystemPrompt ? ' (with user profiles)' : ''}`)
        const traceId = this.traceIds.get(chatId)
        slog('info', 'brain.flush', {
            traceId,
            chatId: chatId.slice(0, 12),
            sessionId: sessionId.slice(0, 8),
            msgCount: messages.length,
            hasAddressed,
            hasPassive,
            combinedLen: combined.length,
            waitMs: Date.now() - (this.traceStartTimes.get(chatId) ?? Date.now()),
        })

        state.busy = true
        this.busySinceAt.set(chatId, Date.now())
        this.persistChatState(chatId)

        // Send to Brain session
        try {
            await this.syncEngine.sendMessage(sessionId, {
                text: combined,
                sentFrom: this.adapter.platform as any,
                meta: {
                    feishuChatId: chatId,
                    feishuChatType: chatType,
                    senderName: messages[messages.length - 1].senderName,
                    senderOpenId: messages[messages.length - 1].senderId,
                    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
                }
            })
            // Clear buffer only after successful send
            state.incoming.splice(0, messages.length)

            // Show "thinking" indicator for addressed messages (not passive/listen mode)
            if (hasAddressed) {
                this.sendThinkingIndicator(chatId, lastMsgId).catch(() => {})
            }
        } catch (err) {
            console.error(`${this.logPrefix} sendMessage failed for ${chatId.slice(0, 12)}, releasing busy:`, err)

            // FK constraint violation means the session row was deleted from the DB while
            // our in-memory mapping still references it. Clear the stale mapping and retry
            // so the next flush creates a fresh session — no error shown to the user.
            const errCode = (err as Record<string, unknown>)?.code
            const isForeignKeyViolation = errCode === '23503'
            if (isForeignKeyViolation) {
                const staleSessionId = this.chatIdToSessionId.get(chatId)
                if (staleSessionId) {
                    console.log(`${this.logPrefix} Session ${staleSessionId.slice(0, 8)} deleted from DB — clearing stale mapping for ${chatId.slice(0, 12)} and retrying`)
                    this.chatIdToSessionId.delete(chatId)
                    this.sessionToChatId.delete(staleSessionId)
                    this.store.deleteFeishuChatSession(chatId).catch(() => {})
                }
                state.busy = false
                this.busySinceAt.delete(chatId)
                this.persistChatState(chatId)
                await this.clearThinkingIndicator(chatId)
                // Retry: state.incoming still has messages since buffer is only cleared on success
                this.flushIncomingMessages(chatId).catch(retryErr => {
                    console.error(`${this.logPrefix} Retry after stale-session error failed for ${chatId.slice(0, 12)}:`, retryErr)
                    this.adapter.sendText(chatId, '⚠️ 消息发送失败，请重试。').catch(() => {})
                })
                return
            }

            state.busy = false
            this.busySinceAt.delete(chatId)
            this.persistChatState(chatId)
            await this.clearThinkingIndicator(chatId)
            await this.adapter.sendText(chatId, '⚠️ 消息发送失败，请重试。').catch(() => {})
        }
    }

    // ========== Session management ==========

    private async ensureSession(chatId: string, chatType: string, senderName?: string): Promise<string | null> {
        const state = this.chatStates.get(chatId)
        if (state) state.creating = true

        try {
            const existingSessionId = this.chatIdToSessionId.get(chatId)
            if (existingSessionId) {
                const session = this.syncEngine.getSession(existingSessionId)
                if (session?.active) {
                    return existingSessionId
                }

                const activeAt = session?.activeAt || 0
                const offlineDuration = Date.now() - activeAt

                if (session && offlineDuration < 120_000) {
                    console.log(`${this.logPrefix} Session ${existingSessionId.slice(0, 8)} recently offline (${Math.round(offlineDuration / 1000)}s), waiting...`)
                    await new Promise(resolve => setTimeout(resolve, 10_000))
                    const retrySession = this.syncEngine.getSession(existingSessionId)
                    if (retrySession?.active) {
                        return existingSessionId
                    }
                }

                return await this.rebuildSession(chatId, chatType, senderName)
            }

            // No mapping exists — create new session
            let chatName: string | undefined
            if (chatType === 'group') {
                chatName = await this.adapter.fetchChatName(chatId) || undefined
            }
            return await this.createBrainSession(chatId, chatType, chatName, senderName)
        } finally {
            if (state) state.creating = false
        }
    }

    private async createBrainSession(chatId: string, chatType: string, chatName?: string, senderName?: string): Promise<string | null> {
        try {
            const namespace = 'default'
            // Load Brain config first to know which agent we need
            const brainConfig = await this.store.getBrainConfig(namespace)
            const agent = brainConfig?.agent ?? 'claude'
            const childModelDefaults = extractBrainChildModelDefaults(brainConfig?.extra)

            const machines = this.syncEngine.getOnlineMachinesByNamespace(namespace)
            if (machines.length === 0) {
                console.error(`${this.logPrefix} No online machines available`)
                return null
            }

            // Filter by supportedAgents (DB-configured) — primary filter
            const compatibleMachines = machines.filter(m =>
                !m.supportedAgents || m.supportedAgents.includes(agent)
            )
            if (compatibleMachines.length === 0) {
                console.error(`${this.logPrefix} No online machines support agent "${agent}"`)
                return null
            }

            const orderedMachines = [
                ...compatibleMachines.filter(m => m.id === BrainBridge.NCU_MACHINE_ID),
                ...compatibleMachines.filter(m => m.id !== BrainBridge.NCU_MACHINE_ID),
            ]

            // Try each compatible machine in order; skip on license failure or AGENT_NOT_AVAILABLE
            let spawnResult: Awaited<ReturnType<typeof this.syncEngine.spawnSession>> | null = null
            let selectedMachine: typeof orderedMachines[0] | null = null
            for (const m of orderedMachines) {
                if (m.orgId) {
                    try {
                        const licenseService = getLicenseService()
                        const licenseCheck = await licenseService.canCreateSession(m.orgId)
                        if (!licenseCheck.valid) {
                            console.warn(`${this.logPrefix} License check failed for ${m.id.slice(0, 8)}, skipping`)
                            continue
                        }
                    } catch { /* LicenseService not initialized */ }
                }

                const homeDir = (m.metadata as Record<string, unknown>)?.homeDir as string || '/tmp'
                const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`
                const brainPreferences = buildBrainSessionPreferences({
                    machineSelectionMode: 'auto',
                    machineId: m.id,
                    childClaudeModels: childModelDefaults.childClaudeModels,
                    childCodexModels: childModelDefaults.childCodexModels,
                })
                const spawnOptions: Record<string, unknown> = {
                    source: 'brain',
                    permissionMode: 'bypassPermissions',
                    caller: this.adapter.platform,
                    brainPreferences,
                }
                if (agent === 'claude') {
                    spawnOptions.modelMode = brainConfig?.claudeModelMode ?? 'opus'
                } else if (agent === 'codex') {
                    spawnOptions.codexModel = brainConfig?.codexModel ?? 'gpt-5.4'
                }
                console.log(`${this.logPrefix} Trying ${m.id.slice(0, 8)}: agent=${agent}`)
                const r = await this.syncEngine.spawnSession(m.id, brainDirectory, agent, true, spawnOptions as any)

                if (r.type === 'success') {
                    spawnResult = r
                    selectedMachine = m
                    break
                }
                if (r.message?.includes('AGENT_NOT_AVAILABLE')) {
                    console.warn(`${this.logPrefix} Agent "${agent}" not available on ${m.id.slice(0, 8)}, trying next`)
                    continue
                }
                console.error(`${this.logPrefix} Spawn failed on ${m.id.slice(0, 8)}: ${r.message}`)
                return null
            }

            if (!spawnResult || spawnResult.type !== 'success' || !selectedMachine) {
                console.error(`${this.logPrefix} No machine could spawn agent "${agent}"`)
                return null
            }
            if (selectedMachine.id !== BrainBridge.NCU_MACHINE_ID) {
                console.warn(`${this.logPrefix} ncu not available, used ${selectedMachine.id.slice(0, 8)}`)
            }

            const sessionId = spawnResult.sessionId
            console.log(`${this.logPrefix} Created Brain session ${sessionId.slice(0, 8)} for chat ${chatId.slice(0, 12)}`)

            // Inherit orgId from machine so vault MCP gets correct org isolation
            if (selectedMachine.orgId) {
                await this.store.setSessionOrgId(sessionId, selectedMachine.orgId, namespace)
            }

            // Save mapping
            await this.store.createFeishuChatSession({
                feishuChatId: chatId,
                feishuChatType: chatType,
                sessionId,
                namespace,
                feishuChatName: chatName,
            })

            // Update in-memory cache
            this.sessionToChatId.set(sessionId, chatId)
            this.chatIdToSessionId.set(chatId, sessionId)
            this.chatIdToChatType.set(chatId, chatType)
            this.lastSeenSeq.set(chatId, 0)
            this.lastDeliveredSeq.set(chatId, 0)

            // Create initReady promise
            const initStartMs = Date.now()
            this.initStartTimes.set(chatId, initStartMs)
            const initPromise = new Promise<void>((resolve) => {
                this.initReadyResolvers.set(chatId, resolve)
                const timeoutId = setTimeout(() => {
                    this.initTimeouts.delete(chatId)
                    if (this.initReadyResolvers.has(chatId)) {
                        const elapsed = Date.now() - (this.initStartTimes.get(chatId) ?? initStartMs)
                        slog('warn', 'init.timeout', { chatId: chatId.slice(0, 12), elapsedMs: elapsed })
                        this.initStartTimes.delete(chatId)
                        this.initReadyResolvers.get(chatId)?.()
                        this.initReadyResolvers.delete(chatId)
                    }
                }, 120_000)
                this.initTimeouts.set(chatId, timeoutId)
            })
            this.initReady.set(chatId, initPromise)

            // Send initPrompt (fire-and-forget)
            this.initializeSession(sessionId, chatId, chatType, chatName, senderName).catch(err => {
                console.error(`${this.logPrefix} initializeSession failed for ${sessionId.slice(0, 8)}:`, err)
                const resolver = this.initReadyResolvers.get(chatId)
                if (resolver) {
                    resolver()
                    this.initReadyResolvers.delete(chatId)
                }
            })

            return sessionId
        } catch (error) {
            console.error(`${this.logPrefix} createBrainSession failed:`, error)
            return null
        }
    }

    private async initializeSession(sessionId: string, chatId: string, chatType: string, chatName?: string, senderName?: string): Promise<void> {
        try {
            const isOnline = await this.waitForSessionOnline(sessionId, 60_000)
            if (!isOnline) {
                console.warn(`${this.logPrefix} Session ${sessionId.slice(0, 8)} did not come online within 60s`)
                return
            }

            // Set session title (delegated to adapter)
            const title = this.adapter.buildSessionTitle(chatType, chatName, senderName)
            await this.syncEngine.patchSessionMetadata(sessionId, {
                summary: { text: title, updatedAt: Date.now() }
            })

            await this.syncEngine.waitForSocketInRoom(sessionId, 5000)

            // Build init prompt (delegated to adapter)
            const session = this.syncEngine.getSession(sessionId)
            const brainPreferences = extractBrainSessionPreferencesFromMetadata(
                (session?.metadata as Record<string, unknown> | null | undefined) ?? null
            )
            const prompt = await this.adapter.buildInitPrompt(chatType, chatName, senderName, brainPreferences)

            await this.syncEngine.sendMessage(sessionId, {
                text: prompt,
                sentFrom: this.adapter.platform as any,
            })
            console.log(`${this.logPrefix} Sent initPrompt to session ${sessionId.slice(0, 8)}`)
        } catch (err) {
            console.error(`${this.logPrefix} initializeSession failed for ${sessionId.slice(0, 8)}:`, err)
        }
    }

    private async waitForSessionOnline(sessionId: string, timeoutMs: number): Promise<boolean> {
        const existing = this.syncEngine.getSession(sessionId)
        if (existing?.active) return true

        return new Promise((resolve) => {
            let resolved = false
            let unsubscribe = () => {}

            const finalize = (result: boolean) => {
                if (resolved) return
                resolved = true
                clearTimeout(timer)
                unsubscribe()
                resolve(result)
            }

            const timer = setTimeout(() => finalize(false), timeoutMs)

            unsubscribe = this.syncEngine.subscribe((event) => {
                if (event.sessionId !== sessionId) return
                if (event.type !== 'session-added' && event.type !== 'session-updated') return
                const session = this.syncEngine.getSession(sessionId)
                if (session?.active) finalize(true)
            })

            const current = this.syncEngine.getSession(sessionId)
            if (current?.active) finalize(true)
        })
    }

    /**
     * Strip thinking blocks from a Claude session JSONL file before resume.
     */
    private stripThinkingBlocksFromJsonl(sessionId: string, homeDir: string): void {
        try {
            const claudeProjectsDir = `${homeDir}/.claude/projects`
            let jsonlPath: string
            try {
                // Use spawnSync with an args array to avoid shell injection
                const result = spawnSync(
                    'find',
                    [claudeProjectsDir, '-maxdepth', '3', '-name', `${sessionId}.jsonl`],
                    { encoding: 'utf-8' }
                )
                if (result.error) throw result.error
                jsonlPath = (result.stdout || '').split('\n').find(l => l.trim()) || ''
            } catch {
                return
            }
            if (!jsonlPath) return

            const raw = readFileSync(jsonlPath, 'utf-8')
            const lines = raw.split('\n')
            let modified = false

            const newLines = lines.map(line => {
                if (!line.trim()) return line
                let record: Record<string, unknown>
                try {
                    record = JSON.parse(line) as Record<string, unknown>
                } catch {
                    return line
                }

                const msg = record.message as Record<string, unknown> | undefined
                if (!msg) return line
                const content = msg.content as Array<Record<string, unknown>> | undefined
                if (!Array.isArray(content)) return line

                const hasThinking = content.some(c => c.type === 'thinking' && c.signature)
                if (!hasThinking) return line

                modified = true
                msg.content = content.map(c =>
                    (c.type === 'thinking' && c.signature)
                        ? { type: 'text', text: '[thinking]' }
                        : c
                )
                return JSON.stringify(record)
            })

            if (modified) {
                writeFileSync(jsonlPath, newLines.join('\n'))
                console.log(`${this.logPrefix} Stripped thinking blocks from JSONL for session ${sessionId.slice(0, 8)}`)
            }
        } catch (err) {
            console.error(`${this.logPrefix} stripThinkingBlocksFromJsonl failed for session ${sessionId.slice(0, 8)}:`, err)
        }
    }

    private async resumeBrainSession(oldSessionId: string, underlyingSessionId: string): Promise<boolean> {
        try {
            const namespace = 'default'
            // Load Brain config to know which agent we need
            const brainConfig = await this.store.getBrainConfig(namespace)
            const agent = brainConfig?.agent ?? 'claude'
            const childModelDefaults = extractBrainChildModelDefaults(brainConfig?.extra)
            const existingSession = this.syncEngine.getSession(oldSessionId)
            const existingPreferences = extractBrainSessionPreferencesFromMetadata(
                (existingSession?.metadata as Record<string, unknown> | null | undefined) ?? null
            )

            const machines = this.syncEngine.getOnlineMachinesByNamespace(namespace)
            if (machines.length === 0) return false

            // Filter by supportedAgents (DB-configured) — primary filter
            const compatibleMachines = machines.filter(m =>
                !m.supportedAgents || m.supportedAgents.includes(agent)
            )
            if (compatibleMachines.length === 0) {
                console.error(`${this.logPrefix} No online machines support agent "${agent}" for resume`)
                return false
            }

            const orderedMachines = [
                ...compatibleMachines.filter(m => m.id === BrainBridge.NCU_MACHINE_ID),
                ...compatibleMachines.filter(m => m.id !== BrainBridge.NCU_MACHINE_ID),
            ]

            // Try each compatible machine in order
            for (const m of orderedMachines) {
                if (m.orgId) {
                    try {
                        const licenseService = getLicenseService()
                        const licenseCheck = await licenseService.canCreateSession(m.orgId)
                        if (!licenseCheck.valid) {
                            console.warn(`${this.logPrefix} License check failed for ${m.id.slice(0, 8)}, skipping`)
                            continue
                        }
                    } catch { /* LicenseService not initialized */ }
                }

                const homeDir = (m.metadata as Record<string, unknown>)?.homeDir as string || '/tmp'
                const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`
                const brainPreferences = buildBrainSessionPreferences({
                    machineSelectionMode: existingPreferences?.machineSelection.mode ?? 'auto',
                    machineId: m.id,
                    childClaudeModels: existingPreferences?.childModels.claude.allowed ?? childModelDefaults.childClaudeModels,
                    childCodexModels: existingPreferences?.childModels.codex.allowed ?? childModelDefaults.childCodexModels,
                })
                const spawnOptions: Record<string, unknown> = {
                    sessionId: oldSessionId,
                    resumeSessionId: underlyingSessionId,
                    source: 'brain',
                    permissionMode: 'bypassPermissions',
                    caller: this.adapter.platform,
                    brainPreferences,
                }
                if (agent === 'claude') {
                    spawnOptions.modelMode = brainConfig?.claudeModelMode ?? 'opus'
                } else if (agent === 'codex') {
                    spawnOptions.codexModel = brainConfig?.codexModel ?? 'gpt-5.4'
                }

                // Only strip thinking blocks for Claude sessions
                if (agent === 'claude') {
                    this.stripThinkingBlocksFromJsonl(underlyingSessionId, homeDir)
                }

                console.log(`${this.logPrefix} Resume: trying ${m.id.slice(0, 8)}: agent=${agent}`)
                const r = await this.syncEngine.spawnSession(m.id, brainDirectory, agent, true, spawnOptions as any)

                if (r.type === 'success') {
                    // Backfill orgId for sessions created before the fix
                    if (m.orgId) {
                        await this.store.setSessionOrgId(oldSessionId, m.orgId, namespace).catch(() => {})
                    }
                    const online = await this.waitForSessionOnline(oldSessionId, 30_000)
                    return online
                }
                if (r.message?.includes('AGENT_NOT_AVAILABLE')) {
                    console.warn(`${this.logPrefix} Agent "${agent}" not available on ${m.id.slice(0, 8)}, trying next`)
                    continue
                }
                console.warn(`${this.logPrefix} resumeBrainSession spawn failed on ${m.id.slice(0, 8)}: ${r.message}`)
                return false
            }

            console.error(`${this.logPrefix} No machine could resume agent "${agent}"`)
            return false
        } catch (err) {
            console.error(`${this.logPrefix} resumeBrainSession failed:`, err)
            return false
        }
    }

    private async rebuildSession(chatId: string, chatType: string, senderName?: string): Promise<string | null> {
        const lastRebuild = this.lastRebuildAt.get(chatId) || 0
        const elapsed = Date.now() - lastRebuild
        if (elapsed < this.REBUILD_COOLDOWN_MS) {
            const remainSec = Math.ceil((this.REBUILD_COOLDOWN_MS - elapsed) / 1000)
            console.warn(`${this.logPrefix} Rebuild cooldown for chat ${chatId.slice(0, 12)}, ${remainSec}s remaining`)
            slog('warn', 'session.rebuild_cooldown', { chatId: chatId.slice(0, 12), remainSec })
            // Notify user so message isn't silently dropped
            this.adapter.sendText(chatId, `⚠️ 会话正在恢复中，请稍候约 ${remainSec} 秒后重试。`).catch(() => {})
            return null
        }
        this.lastRebuildAt.set(chatId, Date.now())

        const oldSessionId = this.chatIdToSessionId.get(chatId)

        // Try to resume first (preserves conversation context)
        if (oldSessionId) {
            const oldSession = this.syncEngine.getSession(oldSessionId)
            const oldMeta = oldSession?.metadata as Record<string, unknown> | undefined
            // Read the right underlying session ID based on agent flavor
            const underlyingSessionId = ((oldMeta?.claudeSessionId ?? oldMeta?.codexSessionId) as string | undefined)?.trim() || undefined

            if (underlyingSessionId) {
                console.log(`${this.logPrefix} Attempting resume for chat ${chatId.slice(0, 12)}, session ${oldSessionId.slice(0, 8)}`)
                await this.store.updateFeishuChatSessionStatus(chatId, 'resuming')

                const resumed = await this.resumeBrainSession(oldSessionId, underlyingSessionId)
                if (resumed) {
                    console.log(`${this.logPrefix} Resumed session ${oldSessionId.slice(0, 8)} for chat ${chatId.slice(0, 12)}`)
                    await this.store.updateFeishuChatSessionStatus(chatId, 'active')
                    return oldSessionId
                }
                console.warn(`${this.logPrefix} Resume failed for chat ${chatId.slice(0, 12)}, falling back to new session`)
            }
        }

        // Fall back to new session
        console.log(`${this.logPrefix} Rebuilding session for chat ${chatId.slice(0, 12)}`)
        await this.store.updateFeishuChatSessionStatus(chatId, 'rebuilding')

        if (oldSessionId) {
            this.sessionToChatId.delete(oldSessionId)
            // Clear stale timers so they don't fire against the dead session
            const thinkTimer = this.thinkingTimers.get(chatId)
            if (thinkTimer) { clearInterval(thinkTimer); this.thinkingTimers.delete(chatId) }
            const streamTimer = this.streamingTimers.get(chatId)
            if (streamTimer) { clearTimeout(streamTimer); this.streamingTimers.delete(chatId) }
            this.streamingUpdateCount.delete(chatId)
            this.thinkingEditFailures.delete(chatId)
        }

        let chatName: string | undefined
        if (chatType === 'group') {
            chatName = await this.adapter.fetchChatName(chatId) || undefined
        }
        const newSessionId = await this.createBrainSession(chatId, chatType, chatName, senderName)
        if (!newSessionId) {
            await this.store.updateFeishuChatSessionStatus(chatId, 'dead')
        }

        return newSessionId
    }

    // ========== SyncEngine event handling (Brain → IM) ==========

    private handleSyncEvent(event: SyncEvent): void {
        // Accumulate agent messages
        if (event.type === 'message-received' && event.sessionId && event.message) {
            const chatId = this.sessionToChatId.get(event.sessionId)
            if (!chatId) return
            this.lastSeenSeq.set(chatId, Math.max(this.lastSeenSeq.get(chatId) ?? 0, event.message.seq))

            // Check for tool_use — remove "thinking" text from same message ID
            const meta = extractAgentMessageMeta(event.message.content)
            if (meta?.hasToolUse) {
                const msgs = this.agentMessages.get(chatId)
                if (msgs) {
                    const filtered = msgs.filter(m => m.messageId !== meta.messageId)
                    if (filtered.length !== msgs.length) {
                        this.agentMessages.set(chatId, filtered)
                    }
                }
                return
            }

            const text = extractAgentText(event.message.content)
            if (!text) return
            if (isInternalBrainMessage(text)) return

            const msgs = this.agentMessages.get(chatId) || []
            msgs.push({ text, messageId: meta?.messageId ?? null, seq: event.message.seq })
            this.agentMessages.set(chatId, msgs)

            this.persistChatState(chatId)
        }

        // Detect task complete: thinking becomes false
        if (event.type === 'session-updated' && event.sessionId && event.data) {
            const data = event.data as Record<string, unknown>
            const chatId = this.sessionToChatId.get(event.sessionId)
            if (!chatId) return

            const isTaskComplete = data.wasThinking === true && data.thinking === false
            const state = this.chatStates.get(chatId)
            const isAborted = !isTaskComplete && data.thinking === false && state?.busy === true

            if (isTaskComplete || isAborted) {
                if (isAborted) {
                    console.log(`${this.logPrefix} Session aborted for ${chatId.slice(0, 12)}, clearing busy state`)
                    // Clean up thinking indicator on abort (no reply coming)
                    this.clearThinkingIndicator(chatId).catch(() => {})
                }

                // If initPrompt just finished, resolve initReady
                const initResolver = this.initReadyResolvers.get(chatId)
                if (initResolver) {
                    const elapsed = Date.now() - (this.initStartTimes.get(chatId) ?? Date.now())
                    slog('info', 'init.ready', { chatId: chatId.slice(0, 12), elapsedMs: elapsed })
                    this.initStartTimes.delete(chatId)
                    initResolver()
                    this.initReadyResolvers.delete(chatId)
                    const initTimeout = this.initTimeouts.get(chatId)
                    if (initTimeout) {
                        clearTimeout(initTimeout)
                        this.initTimeouts.delete(chatId)
                    }
                    this.lastDeliveredSeq.set(chatId, this.lastSeenSeq.get(chatId) ?? 0)
                    this.agentMessages.delete(chatId)
                    this.clearPersistedState(chatId)
                    return
                }

                // Brain finished — send accumulated messages
                this.sendSummary(chatId).catch(err => {
                    console.error(`${this.logPrefix} sendSummary error for ${chatId.slice(0, 12)}:`, err)
                })

                if (!state) return

                state.busy = false
                this.busySinceAt.delete(chatId)
                if (state.incoming.length > 0) {
                    console.log(`${this.logPrefix} Brain done for ${chatId.slice(0, 12)}, flushing ${state.incoming.length} pending message(s)`)
                    this.flushIncomingMessages(chatId).catch(err => {
                        console.error(`${this.logPrefix} flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
                    })
                }
            }
        }

        // Clean up Feishu mapping when a Brain session is deleted
        if (event.type === 'session-removed' && event.sessionId) {
            const chatId = this.sessionToChatId.get(event.sessionId)
            if (chatId) {
                console.log(`${this.logPrefix} Session ${event.sessionId.slice(0, 8)} removed — clearing Feishu mapping for ${chatId.slice(0, 12)}`)

                // Clear DB mapping
                this.store.deleteFeishuChatSession(chatId).catch(err => {
                    console.error(`${this.logPrefix} deleteFeishuChatSession failed for ${chatId.slice(0, 12)}:`, err)
                })

                // Clear all in-memory state
                this.sessionToChatId.delete(event.sessionId)
                this.chatIdToSessionId.delete(chatId)
                this.chatIdToChatType.delete(chatId)
                this.chatStates.delete(chatId)
                this.agentMessages.delete(chatId)
                this.lastSenderIds.delete(chatId)
                this.lastBatchPassive.delete(chatId)
                this.lastUserMessageId.delete(chatId)
                this.traceIds.delete(chatId)
                this.traceStartTimes.delete(chatId)
                this.busySinceAt.delete(chatId)
                this.lastRebuildAt.delete(chatId)
                this.initReady.delete(chatId)
                this.initReadyResolvers.delete(chatId)
                this.initStartTimes.delete(chatId)
                this.lastSeenSeq.delete(chatId)
                this.lastDeliveredSeq.delete(chatId)
                const initTimeout = this.initTimeouts.get(chatId)
                if (initTimeout) { clearTimeout(initTimeout); this.initTimeouts.delete(chatId) }
                this.clearThinkingIndicator(chatId).catch(() => {})
            }
        }
    }

    // ========== Thinking indicator ==========

    private thinkingStartTime: Map<string, number> = new Map()

    // ========== Streaming partial content ==========

    private streamingMessageId: Map<string, string> = new Map()
    private streamingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

    /**
     * Send a lightweight "thinking" indicator to let the user know K1 is processing.
     * Uses a small text message that gets recalled when the real reply arrives.
     * Auto-updates every 10s after first 15s to show elapsed time.
     */
    private async sendThinkingIndicator(chatId: string, replyToMessageId?: string): Promise<void> {
        try {
            // Don't stack thinking indicators
            if (this.thinkingMessageId.has(chatId)) return

            const thinkingText = '🤔'
            const token = await (this.adapter as any).getToken?.()
            if (!token) return

            // Send a minimal text message as thinking indicator
            const url = replyToMessageId
                ? `https://open.feishu.cn/open-apis/im/v1/messages/${replyToMessageId}/reply`
                : 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'
            const body = replyToMessageId
                ? { msg_type: 'text', content: JSON.stringify({ text: thinkingText }) }
                : { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: thinkingText }) }

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(body),
            })
            const data = await resp.json() as { code?: number; data?: { message_id?: string } }
            const msgId = data?.data?.message_id
            if (msgId) {
                this.thinkingMessageId.set(chatId, msgId)
                this.thinkingStartTime.set(chatId, Date.now())

                // Every 10s: update elapsed time indicator; stop after 3 consecutive failures
                const timer = setInterval(() => {
                    if (!this.thinkingMessageId.has(chatId)) return
                    const startTime = this.thinkingStartTime.get(chatId)
                    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
                    const text = elapsed >= 60
                        ? `🤔 正在处理（${Math.floor(elapsed / 60)}分${elapsed % 60}秒）...`
                        : `🤔 正在处理（${elapsed}秒）...`
                    this.adapter.editMessage?.(msgId, 'text', JSON.stringify({ text }))
                        .then(() => { this.thinkingEditFailures.delete(chatId) })
                        .catch((err) => {
                            const failures = (this.thinkingEditFailures.get(chatId) ?? 0) + 1
                            this.thinkingEditFailures.set(chatId, failures)
                            slog('warn', 'thinking.edit_failed', { chatId: chatId.slice(0, 12), failures, err: String(err) })
                            if (failures >= 3) {
                                slog('warn', 'thinking.edit_failures', { chatId: chatId.slice(0, 12), failures })
                                const t = this.thinkingTimers.get(chatId)
                                if (t) { clearInterval(t); this.thinkingTimers.delete(chatId) }
                                this.thinkingEditFailures.delete(chatId)
                            }
                        })
                }, 10_000)
                this.thinkingTimers.set(chatId, timer)

                // After 8s, if Brain has generated text, switch to streaming mode
                const streamTimer = setTimeout(() => {
                    this.flushStreamingContent(chatId).catch(() => {})
                }, 8_000)
                this.streamingTimers.set(chatId, streamTimer)
            }
        } catch {
            // Non-critical — don't let this block the flow
        }
    }

    /**
     * Remove the thinking indicator before sending the real reply.
     */
    private async clearThinkingIndicator(chatId: string): Promise<void> {
        // Cancel streaming timer
        const streamTimer = this.streamingTimers.get(chatId)
        if (streamTimer) {
            clearTimeout(streamTimer)
            this.streamingTimers.delete(chatId)
        }

        const thinkTimer = this.thinkingTimers.get(chatId)
        if (thinkTimer) {
            clearInterval(thinkTimer)
            this.thinkingTimers.delete(chatId)
        }
        this.thinkingStartTime.delete(chatId)
        this.thinkingEditFailures.delete(chatId)

        const msgId = this.thinkingMessageId.get(chatId)
        if (msgId) {
            this.thinkingMessageId.delete(chatId)
            this.adapter.recallMessage?.(msgId).catch(() => {})
        }
    }

    // Max streaming updates per response (prevent unbounded timer chain)
    private streamingUpdateCount: Map<string, number> = new Map()
    private static readonly STREAM_THRESHOLD = 600   // min chars to start streaming
    private static readonly STREAM_MAX_UPDATES = 5   // max partial edits before giving up
    private static readonly SUMMARY_SETTLE_POLL_MS = 50
    private static readonly SUMMARY_SETTLE_WINDOW_MS = 200
    private static readonly SUMMARY_SETTLE_MAX_WAIT_MS = 3_000

    /**
     * If Brain has been thinking for 8s and has generated ≥600 chars of content,
     * recall the 🤔 indicator and show partial content as a streaming post.
     * Reschedules itself every 10s, up to STREAM_MAX_UPDATES times.
     * If an edit fails, stops updating and lets sendSummary handle the final reply.
     */
    private async flushStreamingContent(chatId: string): Promise<void> {
        try {
            // Guard: chat may have been removed (session rebuild, restart recovery)
            if (!this.chatStates.has(chatId)) return

            const msgs = this.agentMessages.get(chatId)
            if (!msgs || msgs.length === 0) return

            const partialText = msgs.map(m => m.text).join('\n').trim()
            if (partialText.length < BrainBridge.STREAM_THRESHOLD) return

            const updateCount = (this.streamingUpdateCount.get(chatId) ?? 0) + 1
            if (updateCount > BrainBridge.STREAM_MAX_UPDATES) {
                slog('warn', 'streaming.cap_reached', { chatId: chatId.slice(0, 12), updates: updateCount })
                return
            }
            this.streamingUpdateCount.set(chatId, updateCount)

            // Recall the 🤔 indicator if still showing
            const thinkingMsgId = this.thinkingMessageId.get(chatId)
            if (thinkingMsgId) {
                const thinkTimer = this.thinkingTimers.get(chatId)
                if (thinkTimer) { clearInterval(thinkTimer); this.thinkingTimers.delete(chatId) }
                this.thinkingMessageId.delete(chatId)
                this.thinkingStartTime.delete(chatId)
                this.adapter.recallMessage?.(thinkingMsgId).catch(() => {})
            }

            const displayText = partialText + '\n\n_⏳ 正在生成..._'
            const existingStreamId = this.streamingMessageId.get(chatId)

            if (existingStreamId) {
                // Edit existing streaming post; stop on failure (conflict avoidance)
                const { buildFeishuMessageForEdit } = await import('./feishu/formatter')
                const formatted = buildFeishuMessageForEdit(displayText)
                const ok = await this.adapter.editMessage?.(existingStreamId, formatted.msgType, formatted.content)
                    .catch(() => false)
                if (!ok) {
                    slog('warn', 'streaming.edit_failed', { chatId: chatId.slice(0, 12), msgId: existingStreamId.slice(0, 12) })
                    // Stop streaming and clean up the dangling streaming message immediately.
                    // Clearing streamingMessageId prevents sendSummary from recalling it again.
                    this.streamingUpdateCount.delete(chatId)
                    this.streamingMessageId.delete(chatId)
                    this.adapter.recallMessage?.(existingStreamId).catch(() => {})
                    return
                }
            } else {
                // Send the first streaming post
                const msgId = await this.adapter.sendPostAndGetId?.(chatId, displayText)
                if (msgId) {
                    this.streamingMessageId.set(chatId, msgId)
                }
            }

            slog('info', 'streaming.update', { chatId: chatId.slice(0, 12), update: updateCount, textLen: partialText.length })

            // Reschedule next update in 10s (clear old timer first to prevent stacking)
            const prev = this.streamingTimers.get(chatId)
            if (prev) clearTimeout(prev)
            const nextTimer = setTimeout(() => {
                this.flushStreamingContent(chatId).catch(() => {})
            }, 10_000)
            this.streamingTimers.set(chatId, nextTimer)
        } catch {
            // Non-critical
        }
    }

    // ========== Summary sending ==========

    private async getPendingReplyFingerprint(chatId: string): Promise<string> {
        const msgs = this.agentMessages.get(chatId) ?? []
        const inMemory = msgs.slice(-5).map(msg => `${msg.seq ?? ''}:${msg.messageId ?? ''}:${msg.text}`).join('\n---\n')

        const sessionId = this.chatIdToSessionId.get(chatId)
        if (!sessionId) return inMemory

        try {
            const afterSeq = this.lastDeliveredSeq.get(chatId) ?? 0
            const pending = await this.store.getMessagesAfter(sessionId, afterSeq, 20)
            const fromStore = pending.slice(-5).map(msg => {
                const text = extractAgentText(msg.content)
                return `${msg.seq}:${text ?? ''}`
            }).join('\n---\n')
            return `${inMemory}\n===\n${fromStore}`
        } catch {
            return inMemory
        }
    }

    private async waitForAgentMessagesToSettle(chatId: string): Promise<void> {
        const start = Date.now()
        let lastFingerprint: string | null = null
        let stableSince = 0

        while (Date.now() - start < BrainBridge.SUMMARY_SETTLE_MAX_WAIT_MS) {
            const fingerprint = await this.getPendingReplyFingerprint(chatId)
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint
                stableSince = Date.now()
            } else if (stableSince !== 0 && Date.now() - stableSince >= BrainBridge.SUMMARY_SETTLE_WINDOW_MS) {
                return
            }
            await new Promise(resolve => setTimeout(resolve, BrainBridge.SUMMARY_SETTLE_POLL_MS))
        }
    }

    private extractBufferedAgentMessage(message: StoredMessage): BufferedAgentMessage | null {
        const text = extractAgentText(message.content)
        if (!text || isInternalBrainMessage(text)) return null
        const meta = extractAgentMessageMeta(message.content)
        return {
            text,
            messageId: meta?.messageId ?? null,
            seq: message.seq,
        }
    }

    private async collectPendingAgentMessages(chatId: string): Promise<{
        messages: BufferedAgentMessage[]
        maxSeq: number
        inMemoryCount: number
        dbTailCount: number
        recoveredCount: number
        afterSeq: number
    }> {
        const inMemory = [...(this.agentMessages.get(chatId) ?? [])]
        const maxBufferedSeq = inMemory.reduce((max, msg) => Math.max(max, msg.seq ?? 0), 0)

        const sessionId = this.chatIdToSessionId.get(chatId)
        const afterSeq = this.lastDeliveredSeq.get(chatId) ?? 0
        if (!sessionId) {
            return {
                messages: inMemory,
                maxSeq: maxBufferedSeq,
                inMemoryCount: inMemory.length,
                dbTailCount: 0,
                recoveredCount: 0,
                afterSeq,
            }
        }

        let pendingFromStore: StoredMessage[] = []
        try {
            pendingFromStore = await this.store.getMessagesAfter(sessionId, afterSeq, 200)
        } catch (err) {
            console.error(`${this.logPrefix} getMessagesAfter failed for ${chatId.slice(0, 12)}:`, err)
        }

        const seenSeq = new Set<number>()
        const combined: BufferedAgentMessage[] = []

        for (const msg of inMemory) {
            if (msg.seq !== null) {
                seenSeq.add(msg.seq)
            }
            combined.push(msg)
        }

        for (const msg of pendingFromStore) {
            if (seenSeq.has(msg.seq)) continue
            const extracted = this.extractBufferedAgentMessage(msg)
            if (!extracted) continue
            combined.push(extracted)
            seenSeq.add(msg.seq)
        }

        const maxStoreSeq = pendingFromStore.reduce((max, msg) => Math.max(max, msg.seq), afterSeq)
        return {
            messages: combined,
            maxSeq: Math.max(maxBufferedSeq, maxStoreSeq),
            inMemoryCount: inMemory.length,
            dbTailCount: pendingFromStore.length,
            recoveredCount: Math.max(0, combined.length - inMemory.length),
            afterSeq,
        }
    }

    /**
     * Process accumulated agent messages and send reply via adapter.
     */
    private async sendSummary(chatId: string): Promise<void> {
        // Task-complete may race with the final assistant/result message flush.
        await this.waitForAgentMessagesToSettle(chatId)

        // Clear thinking indicator and any streaming timer before sending the real reply
        await this.clearThinkingIndicator(chatId)

        // Recall streaming partial post (if any) before sending final
        const streamMsgId = this.streamingMessageId.get(chatId)
        if (streamMsgId) {
            this.streamingMessageId.delete(chatId)
            this.adapter.recallMessage?.(streamMsgId).catch(() => {})
        }
        this.streamingUpdateCount.delete(chatId)

        const {
            messages: raw,
            maxSeq,
            inMemoryCount,
            dbTailCount,
            recoveredCount,
            afterSeq,
        } = await this.collectPendingAgentMessages(chatId)
        slog('info', 'summary.collect', {
            chatId: chatId.slice(0, 12),
            sessionId: this.chatIdToSessionId.get(chatId)?.slice(0, 8),
            afterSeq,
            inMemoryCount,
            dbTailCount,
            recoveredCount,
            rawCount: raw.length,
            maxSeq,
        })
        if (!raw || raw.length === 0) {
            if (maxSeq > 0) {
                this.lastDeliveredSeq.set(chatId, maxSeq)
            }
            slog('info', 'summary.empty', {
                chatId: chatId.slice(0, 12),
                sessionId: this.chatIdToSessionId.get(chatId)?.slice(0, 8),
                afterSeq,
                maxSeq,
            })
            this.agentMessages.delete(chatId)
            await this.persistChatState(chatId)
            return
        }
        this.agentMessages.delete(chatId)

        const texts = raw.map(m => m.text)

        // Claude/Codex may emit cumulative assistant text snapshots plus a final
        // result text. Keep only the most complete adjacent variant.
        const deduped = mergeStreamingAgentTexts(texts)

        // Drop short narration fragments if a longer reply follows
        // BUT always keep messages containing structured action/card blocks
        const SHORT_NARRATION_LIMIT = 80
        const HAS_STRUCTURED_BLOCK = /<feishu-(actions|card)>/
        const substantive = deduped.filter((m, i) => {
            if (i === deduped.length - 1) return true
            if (m.trim().length <= SHORT_NARRATION_LIMIT && !HAS_STRUCTURED_BLOCK.test(m)) return false
            return true
        })

        const allText = substantive.join('\n')

        // ── Extract structured actions (or fall back to legacy bracket tags) ──
        const { actions, cards, cleanText: textReply } = extractActions(allText)
        slog('info', 'summary.compose', {
            chatId: chatId.slice(0, 12),
            sessionId: this.chatIdToSessionId.get(chatId)?.slice(0, 8),
            rawCount: raw.length,
            dedupedCount: deduped.length,
            substantiveCount: substantive.length,
            textLen: textReply.length,
            preview: textReply.slice(0, 120),
            maxSeq,
        })

        // Detect silent
        const isPassiveBatch = this.lastBatchPassive.get(chatId) ?? false
        this.lastBatchPassive.delete(chatId)
        if (actions.silent) {
            if (isPassiveBatch) {
                console.log(`${this.logPrefix} K1 chose [silent] for ${chatId.slice(0, 12)}, skipping reply`)
                this.lastUserMessageId.delete(chatId)
                this.lastSenderIds.delete(chatId)
                if (maxSeq > 0) {
                    this.lastDeliveredSeq.set(chatId, maxSeq)
                }
                await this.clearPersistedState(chatId)
                return
            }
            console.warn(`${this.logPrefix} K1 used [silent] in addressed mode for ${chatId.slice(0, 12)}, ignoring marker`)
            slog('warn', 'brain.silent_addressed', { chatId: chatId.slice(0, 12) })
        }

        // ── Execute immediate actions ──

        if (actions.edit) {
            for (const { id, text } of actions.edit) {
                console.log(`${this.logPrefix} Editing message ${id.slice(0, 12)}`)
                const richCheck = buildFeishuMessage(text)
                if (richCheck.msgType === 'interactive') {
                    // Feishu edit API doesn't support card format — recall and resend as new message
                    console.log(`${this.logPrefix} Edit needs card format, recalling ${id.slice(0, 12)} and resending`)
                    const recalled = await this.adapter.recallMessage?.(id).catch(() => false) ?? false
                    if (!recalled) {
                        slog('warn', 'edit.recall_failed', { chatId: chatId.slice(0, 12), msgId: id.slice(0, 12) })
                    }
                    const chatType = this.chatIdToChatType.get(chatId)
                    await this.adapter.sendReply(chatId, { text, chatType })
                        .catch(err => console.error(`${this.logPrefix} edit-as-resend failed:`, err))
                } else {
                    const editFormatted = buildFeishuMessageForEdit(text)
                    this.adapter.editMessage?.(id, editFormatted.msgType, editFormatted.content)
                        .catch(err => console.error(`${this.logPrefix} editMessage failed:`, err))
                }
            }
        }

        if (actions.recall) {
            for (const target of actions.recall) {
                if (target === 'last') {
                    console.log(`${this.logPrefix} Recalling last bot message for ${chatId.slice(0, 12)}`)
                    this.adapter.recallLastMessage?.(chatId)
                        .catch(err => console.error(`${this.logPrefix} recallLastMessage failed:`, err))
                } else {
                    console.log(`${this.logPrefix} Recalling message ${target.slice(0, 12)}`)
                    this.adapter.recallMessage?.(target)
                        .catch(err => console.error(`${this.logPrefix} recallMessage failed:`, err))
                }
            }
        }

        if (actions.forward) {
            for (const { id, to } of actions.forward) {
                console.log(`${this.logPrefix} Forwarding ${id.slice(0, 12)} to ${to.slice(0, 12)}`)
                this.adapter.forwardMessage?.(id, to)
                    .catch(err => console.error(`${this.logPrefix} forwardMessage failed:`, err))
            }
        }

        if (actions.pin) {
            for (const id of actions.pin) {
                console.log(`${this.logPrefix} Pinning message ${id.slice(0, 12)}`)
                this.adapter.pinMessage?.(id)
                    .catch(err => console.error(`${this.logPrefix} pinMessage failed:`, err))
            }
        }

        if (actions.unpin) {
            for (const id of actions.unpin) {
                console.log(`${this.logPrefix} Unpinning message ${id.slice(0, 12)}`)
                this.adapter.unpinMessage?.(id)
                    .catch(err => console.error(`${this.logPrefix} unpinMessage failed:`, err))
            }
        }

        if (actions.urgent) {
            for (const { id, type, users } of actions.urgent) {
                console.log(`${this.logPrefix} Urgent(${type}) message ${id.slice(0, 12)} to ${users.length} users`)
                this.adapter.urgentMessage?.(id, type as 'app' | 'sms' | 'phone', users)
                    .catch((err: unknown) => console.error(`${this.logPrefix} urgentMessage failed:`, err))
            }
        }

        if (actions.ephemeral) {
            for (const { userId, text } of actions.ephemeral) {
                console.log(`${this.logPrefix} Sending ephemeral card to ${userId.slice(0, 12)} in ${chatId.slice(0, 12)}`)
                // Route text through formatter so markdown → proper card/post JSON
                const formatted = buildFeishuMessage(text)
                const cardJson = formatted.msgType === 'interactive'
                    ? formatted.content
                    : JSON.stringify({
                        schema: '2.0',
                        config: { wide_screen_mode: true },
                        elements: [{ tag: 'markdown', content: text }],
                    })
                this.adapter.sendEphemeralCard?.(chatId, userId, cardJson)
                    .catch((err: unknown) => console.error(`${this.logPrefix} sendEphemeralCard failed:`, err))
            }
        }

        // ── Build reply payload ──

        const replyToMessageId = this.lastUserMessageId.get(chatId)
        this.lastUserMessageId.delete(chatId)

        const senderIds = this.lastSenderIds.get(chatId)
        this.lastSenderIds.delete(chatId)

        // Compute @mention IDs: "all" wins; else explicit; else fallback to senders
        const explicitAtIds = actions.at || []
        const hasAtAll = explicitAtIds.includes('all')
        const atIds = hasAtAll
            ? ['all']
            : (explicitAtIds.length > 0 ? explicitAtIds : senderIds ? [...senderIds] : [])

        let mediaRefs = actions.files || []
        // Download remote files from brain's machine to server local /tmp if needed
        if (mediaRefs.length > 0) {
            const sessionId = this.chatIdToSessionId.get(chatId)
            const session = sessionId ? this.syncEngine.getSession(sessionId) : null
            const brainMachineId = (session?.metadata as Record<string, unknown>)?.machineId as string | undefined
            if (brainMachineId) {
                const localRefs: string[] = []
                for (const ref of mediaRefs) {
                    if (existsSync(ref)) {
                        localRefs.push(ref)
                        continue
                    }
                    // File not local — fetch from brain's machine via RPC
                    try {
                        const result = await this.syncEngine.machineRpcPublic(brainMachineId, 'readAbsoluteFile', { path: ref }) as { success?: boolean; content?: string; error?: string }
                        if (result?.success && result.content) {
                            const tmpDir = '/tmp/yr-media-downloads'
                            mkdirSync(tmpDir, { recursive: true })
                            const localPath = join(tmpDir, `${Date.now()}-${basename(ref)}`)
                            const buffer = Buffer.from(result.content, 'base64')
                            await new Promise<void>((resolve, reject) => writeFile(localPath, buffer, (err) => err ? reject(err) : resolve()))
                            console.log(`${this.logPrefix} Downloaded remote file ${ref} → ${localPath} (${buffer.length} bytes)`)
                            localRefs.push(localPath)
                        } else {
                            console.warn(`${this.logPrefix} Failed to download ${ref} from machine ${brainMachineId.slice(0, 8)}: ${result?.error || 'unknown'}`)
                            localRefs.push(ref) // keep original ref, FeishuAdapter will report "not found"
                        }
                    } catch (err) {
                        console.error(`${this.logPrefix} RPC readAbsoluteFile failed for ${ref}:`, err)
                        localRefs.push(ref)
                    }
                }
                mediaRefs = localRefs
            }
        }
        const extras = actionsToExtras(actions)
        const reactions = actions.reactions || []
        const chatType = this.chatIdToChatType.get(chatId)
        const hasReplyPayload = textReply || mediaRefs.length > 0 || extras.length > 0 || cards.length > 0 || reactions.length > 0
        let delivered = !hasReplyPayload

        if (hasReplyPayload) {
            console.log(`${this.logPrefix} Sending summary to ${chatId.slice(0, 12)} (${textReply.length} chars, ${deduped.length} messages${replyToMessageId ? ', reply' : ''}${atIds.length ? `, @${atIds.length}` : ''}${mediaRefs.length ? `, +${mediaRefs.length} media` : ''}${extras.length ? `, +${extras.length} extras` : ''}${cards.length ? `, +${cards.length} cards` : ''}${reactions.length ? `, +${reactions.length} reactions` : ''})`)
            const replyStart = Date.now()
            const replyPayload = {
                text: textReply,
                replyTo: replyToMessageId,
                atIds: atIds.length > 0 ? atIds : undefined,
                mediaRefs: mediaRefs.length > 0 ? mediaRefs : undefined,
                extras: extras.length > 0 ? extras : undefined,
                cards: cards.length > 0 ? cards : undefined,
                reactions: reactions.length > 0 ? reactions : undefined,
                chatType,
            }
            let sendErr: unknown = null
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await this.adapter.sendReply(chatId, replyPayload)
                    sendErr = null
                    break
                } catch (err) {
                    sendErr = err
                    if (attempt < 2) {
                        slog('warn', 'reply.send_retry', { chatId: chatId.slice(0, 12), attempt: attempt + 1 })
                        await new Promise(r => setTimeout(r, 2000))
                    }
                }
            }
            if (sendErr) {
                slog('error', 'reply.send_failed', { chatId: chatId.slice(0, 12) })
                this.adapter.sendText(chatId, '⚠️ 回复发送失败，请重试。').catch(() => {})
            } else {
                delivered = true
            }
            const traceId = this.traceIds.get(chatId)
            const totalMs = Date.now() - (this.traceStartTimes.get(chatId) ?? replyStart)
            slog('info', 'brain.reply', {
                traceId,
                chatId: chatId.slice(0, 12),
                textLen: textReply.length,
                cards: cards.length,
                extras: extras.length,
                reactions: reactions.length,
                hadStreaming: !!streamMsgId,
                replyMs: Date.now() - replyStart,
                totalMs,
            })
        }

        if (delivered && maxSeq > 0) {
            this.lastDeliveredSeq.set(chatId, maxSeq)
        }

        // Clear trace for this round
        this.traceIds.delete(chatId)
        this.traceStartTimes.delete(chatId)

        await this.clearPersistedState(chatId)
    }

    // ========== User profile (yoho-memory) ==========

    private async buildUserProfilePrompt(messages: IMMessage[], chatType: string): Promise<string | undefined> {
        const senders = new Map<string, IMMessage>()
        for (const m of messages) {
            senders.set(m.senderId, m)
        }

        const entries = await Promise.all(
            [...senders.entries()].map(async ([userId, msg]) => {
                const profile = await this.fetchUserProfile(msg.senderName, userId)

                const hasKeycloakLink = profile?.includes('keycloakId:')
                let keycloakSection = ''

                if (!hasKeycloakLink && msg.senderEmail) {
                    const kcUser = await lookupKeycloakUserByEmail(msg.senderEmail)
                    if (kcUser) {
                        keycloakSection = this.formatKeycloakInfo(kcUser)
                        this.persistKeycloakLink(msg.senderName, userId, msg.senderEmail, kcUser).catch(() => {})
                    }
                }

                const fullProfile = [profile, keycloakSection].filter(Boolean).join('\n\n')
                if (!fullProfile) return null
                const emailAttr = msg.senderEmail ? ` email="${msg.senderEmail}"` : ''
                return `<user-profile sender="${msg.senderName}" openId="${userId}"${emailAttr}>\n${fullProfile}\n</user-profile>`
            })
        )

        const profiles = entries.filter(Boolean) as string[]
        return profiles.length > 0 ? profiles.join('\n\n') : undefined
    }

    private async fetchUserProfile(senderName: string, senderId: string): Promise<string | null> {
        try {
            const ctrl = new AbortController()
            const timeout = setTimeout(() => ctrl.abort(), 5_000)
            const resp = await fetch(`${this.YOHO_MEMORY_URL}/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: `飞书用户 ${senderName} ${senderId}`,
                    keywords: [senderName, senderId],
                    maxFiles: 2,
                }),
                signal: ctrl.signal,
            }).finally(() => clearTimeout(timeout))
            if (!resp.ok) return null
            const result = await resp.json() as { answer?: string; filesSearched?: number }
            if (!result.answer || result.filesSearched === undefined) return null
            return result.answer
        } catch {
            return null
        }
    }

    private formatKeycloakInfo(kcUser: KeycloakUserInfo): string {
        const lines = ['## Keycloak 账户信息']
        lines.push(`- keycloakId: ${kcUser.keycloakId}`)
        lines.push(`- email: ${kcUser.email}`)
        if (kcUser.firstName || kcUser.lastName) {
            lines.push(`- 姓名: ${[kcUser.firstName, kcUser.lastName].filter(Boolean).join(' ')}`)
        }
        if (kcUser.attributes.jobTitle) {
            lines.push(`- 职位: ${kcUser.attributes.jobTitle}`)
        }
        if (kcUser.attributes.nickname) {
            lines.push(`- 昵称: ${kcUser.attributes.nickname}`)
        }
        return lines.join('\n')
    }

    private async persistKeycloakLink(
        senderName: string,
        senderId: string,
        email: string,
        kcUser: KeycloakUserInfo,
    ): Promise<void> {
        try {
            const parts = [
                `飞书用户画像更新 - ${senderName} (${senderId}):`,
                `Keycloak 账户已关联:`,
                `- keycloakId: ${kcUser.keycloakId}`,
                `- email: ${email}`,
            ]
            if (kcUser.attributes.jobTitle) parts.push(`- 职位: ${kcUser.attributes.jobTitle}`)
            if (kcUser.attributes.nickname) parts.push(`- 昵称: ${kcUser.attributes.nickname}`)

            await fetch(`${this.YOHO_MEMORY_URL}/remember`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: parts.join('\n') }),
            })
            console.log(`${this.logPrefix} Persisted Keycloak link for ${senderName} (${email})`)
        } catch {
            // Silent fail
        }
    }
}
