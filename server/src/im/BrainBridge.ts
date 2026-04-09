/**
 * BrainBridge — Platform-independent orchestration layer.
 *
 * Manages the bidirectional bridge between IM chats and Brain sessions:
 * - IM → Brain: message buffering, debouncing, session lifecycle
 * - Brain → IM: agent message accumulation, summary sending
 *
 * Platform-specific behavior is delegated to an IMAdapter.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { IStore } from '../store/interface'
import type { IMAdapter, IMMessage, IMBridgeCallbacks, BrainBridgeConfig, IMReplyExtra } from './types'
import { extractAgentText, extractAgentMessageMeta, isInternalBrainMessage } from './agentMessage'
import { lookupKeycloakUserByEmail, type KeycloakUserInfo } from './keycloakLookup'

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
    private agentMessages: Map<string, { text: string; messageId: string | null }[]> = new Map()

    // Promise that resolves when session init (initPrompt) is fully processed
    private initReady: Map<string, Promise<void>> = new Map()
    private initReadyResolvers: Map<string, () => void> = new Map()

    // Track the last user message ID per chat for reply threading
    private lastUserMessageId: Map<string, string> = new Map()

    // Track sender IDs for the current round (group chats: @ them in reply)
    private lastSenderIds: Map<string, Set<string>> = new Map()

    // Track whether the last batch was passive-only (no @bot)
    private lastBatchPassive: Map<string, boolean> = new Map()

    // Tracked timers (cleared on stop)
    private cleanupInterval: ReturnType<typeof setInterval> | null = null
    private recoveryTimeout: ReturnType<typeof setTimeout> | null = null
    private initTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()

    // Rebuild rate limiting
    private lastRebuildAt: Map<string, number> = new Map()
    private readonly REBUILD_COOLDOWN_MS = 30_000
    private readonly INPUT_DEBOUNCE_MS = 3_000
    private readonly PASSIVE_DEBOUNCE_MS = 20_000

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
        if (this.recoveryTimeout) {
            clearTimeout(this.recoveryTimeout)
            this.recoveryTimeout = null
        }
        for (const t of this.initTimeouts.values()) clearTimeout(t)
        this.initTimeouts.clear()

        this.agentMessages.clear()
        this.initReady.clear()
        this.initReadyResolvers.clear()
        this.chatStates.clear()
        this.lastUserMessageId.clear()
        this.lastSenderIds.clear()
        this.lastBatchPassive.clear()
        this.lastRebuildAt.clear()

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
        console.log(`${this.logPrefix} Card action "${actionTag}" in ${chatId.slice(0, 12)} by ${userId.slice(0, 8)}`)
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

        // Add message to buffer
        state.incoming.push(message)

        if (state.busy || state.creating) {
            console.log(`${this.logPrefix} Chat ${chatId.slice(0, 12)} busy, buffered (${state.incoming.length} pending)`)
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
            const s = m.state as { agentMessages?: string[]; lastUserMessageId?: string | null; busy?: boolean } | null
            if (s && (s.agentMessages?.length || s.lastUserMessageId || s.busy)) {
                if (s.agentMessages?.length) {
                    this.agentMessages.set(m.feishuChatId, s.agentMessages.map(t => ({ text: t, messageId: null })))
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
                        if (state) state.busy = false
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
        }
        try {
            await this.store.updateFeishuChatState(chatId, persisted)
        } catch (err) {
            console.error(`${this.logPrefix} persistChatState failed for ${chatId.slice(0, 12)}:`, err)
        }
    }

    private async clearPersistedState(chatId: string): Promise<void> {
        try {
            await this.store.updateFeishuChatState(chatId, {})
        } catch (err) {
            console.error(`${this.logPrefix} clearPersistedState failed for ${chatId.slice(0, 12)}:`, err)
        }
    }

    // ========== Message flushing ==========

    private async flushIncomingMessages(chatId: string): Promise<void> {
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
            await this.adapter.sendText(chatId, '抱歉，无法创建会话。请检查是否有在线机器。')
            return
        }

        // Wait for initPrompt to be sent first
        const initPromise = this.initReady.get(chatId)
        if (initPromise) {
            await initPromise
            this.initReady.delete(chatId)
        }

        await this.store.touchFeishuChatSession(chatId).catch(() => {})

        // Format merged messages
        const hasAddressed = messages.some(m => m.addressed)
        const hasPassive = messages.some(m => !m.addressed)
        const formattedParts = messages.map(m => {
            if (chatType === 'group') {
                const prefix = m.addressed ? '[指令] ' : ''
                return `${prefix}${m.senderName} (${m.senderId}): ${m.text}`
            }
            return m.text
        })

        let combined = formattedParts.join('\n')

        // For pure passive messages, add hint
        if (chatType === 'group' && hasPassive && !hasAddressed) {
            combined = `[旁听模式] 群里有新消息，有价值就踊跃参与，没必要插话就输出 [silent]：\n${combined}`
        }

        // Fetch user profiles for appendSystemPrompt
        const appendSystemPrompt = await this.buildUserProfilePrompt(messages, chatType)

        // Remember last user message ID for reply threading
        const lastMsgId = messages[messages.length - 1].messageId
        if (lastMsgId) {
            this.lastUserMessageId.set(chatId, lastMsgId)
        }

        // Remember addressed sender IDs for @ mention in reply (passive senders excluded)
        if (chatType === 'group') {
            const addressedSenderIds = new Set(messages.filter(m => m.addressed).map(m => m.senderId))
            this.lastSenderIds.set(chatId, addressedSenderIds)
        }

        // Track if this batch is passive-only
        this.lastBatchPassive.set(chatId, chatType === 'group' && hasPassive && !hasAddressed)

        console.log(`${this.logPrefix} Sending ${messages.length} merged message(s) to session ${sessionId.slice(0, 8)}${appendSystemPrompt ? ' (with user profiles)' : ''}`)

        state.busy = true
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
        } catch (err) {
            console.error(`${this.logPrefix} sendMessage failed for ${chatId.slice(0, 12)}, releasing busy:`, err)
            state.busy = false
            this.persistChatState(chatId)
            throw err
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
            const machines = this.syncEngine.getOnlineMachinesByNamespace(namespace)
            if (machines.length === 0) {
                console.error(`${this.logPrefix} No online machines available`)
                return null
            }

            const machine = machines.find(m => m.id === BrainBridge.NCU_MACHINE_ID) || machines[0]
            if (machine.id !== BrainBridge.NCU_MACHINE_ID) {
                console.warn(`${this.logPrefix} ncu not online, falling back to ${machine.id}`)
            }
            const homeDir = (machine.metadata as Record<string, unknown>)?.homeDir as string || '/tmp'
            const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`

            // Load Brain config from DB
            const brainConfig = await this.store.getBrainConfig(namespace)
            const agent = brainConfig?.agent ?? 'claude'
            const spawnOptions: Record<string, unknown> = {
                source: 'brain',
                permissionMode: 'bypassPermissions',
                caller: this.adapter.platform,
            }
            if (agent === 'claude') {
                spawnOptions.modelMode = brainConfig?.claudeModelMode ?? 'opus'
            } else if (agent === 'codex') {
                spawnOptions.codexModel = brainConfig?.codexModel ?? 'gpt-5.4'
            }

            console.log(`${this.logPrefix} Spawning Brain session: agent=${agent}, config=${JSON.stringify(spawnOptions)}`)

            const result = await this.syncEngine.spawnSession(
                machine.id,
                brainDirectory,
                agent,
                true,
                spawnOptions as any,
            )

            if (result.type !== 'success') {
                console.error(`${this.logPrefix} Failed to create session: ${result.message}`)
                return null
            }

            const sessionId = result.sessionId
            console.log(`${this.logPrefix} Created Brain session ${sessionId.slice(0, 8)} for chat ${chatId.slice(0, 12)}`)

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

            // Create initReady promise
            const initPromise = new Promise<void>((resolve) => {
                this.initReadyResolvers.set(chatId, resolve)
                const timeoutId = setTimeout(() => {
                    this.initTimeouts.delete(chatId)
                    if (this.initReadyResolvers.has(chatId)) {
                        console.warn(`${this.logPrefix} initReady timeout for chat ${chatId.slice(0, 12)}, force resolving`)
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
            const prompt = await this.adapter.buildInitPrompt(chatType, chatName, senderName)

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
    private stripThinkingBlocksFromJsonl(claudeSessionId: string, homeDir: string): void {
        try {
            const claudeProjectsDir = `${homeDir}/.claude/projects`
            let jsonlPath: string
            try {
                jsonlPath = execSync(
                    `find "${claudeProjectsDir}" -maxdepth 3 -name "${claudeSessionId}.jsonl" 2>/dev/null | head -1`,
                    { encoding: 'utf-8' }
                ).trim()
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
                console.log(`${this.logPrefix} Stripped thinking blocks from JSONL for session ${claudeSessionId.slice(0, 8)}`)
            }
        } catch (err) {
            console.error(`${this.logPrefix} stripThinkingBlocksFromJsonl failed:`, err)
        }
    }

    private async resumeBrainSession(oldSessionId: string, claudeSessionId: string): Promise<boolean> {
        try {
            const namespace = 'default'
            const machines = this.syncEngine.getOnlineMachinesByNamespace(namespace)
            if (machines.length === 0) return false

            const machine = machines.find(m => m.id === BrainBridge.NCU_MACHINE_ID) || machines[0]
            const homeDir = (machine.metadata as Record<string, unknown>)?.homeDir as string || '/tmp'
            const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`

            this.stripThinkingBlocksFromJsonl(claudeSessionId, homeDir)

            // Load Brain config
            const brainConfig = await this.store.getBrainConfig(namespace)
            const agent = brainConfig?.agent ?? 'claude'
            const spawnOptions: Record<string, unknown> = {
                sessionId: oldSessionId,
                resumeSessionId: claudeSessionId,
                source: 'brain',
                permissionMode: 'bypassPermissions',
                caller: this.adapter.platform,
            }
            if (agent === 'claude') {
                spawnOptions.modelMode = brainConfig?.claudeModelMode ?? 'opus'
            } else if (agent === 'codex') {
                spawnOptions.codexModel = brainConfig?.codexModel ?? 'gpt-5.4'
            }

            const result = await this.syncEngine.spawnSession(
                machine.id,
                brainDirectory,
                agent,
                true,
                spawnOptions as any,
            )

            if (result.type !== 'success') {
                console.warn(`${this.logPrefix} resumeBrainSession spawn failed: ${result.message}`)
                return false
            }

            const online = await this.waitForSessionOnline(oldSessionId, 30_000)
            return online
        } catch (err) {
            console.error(`${this.logPrefix} resumeBrainSession failed:`, err)
            return false
        }
    }

    private async rebuildSession(chatId: string, chatType: string, senderName?: string): Promise<string | null> {
        const lastRebuild = this.lastRebuildAt.get(chatId) || 0
        if (Date.now() - lastRebuild < this.REBUILD_COOLDOWN_MS) {
            console.warn(`${this.logPrefix} Rebuild cooldown for chat ${chatId.slice(0, 12)}, skipping`)
            return null
        }
        this.lastRebuildAt.set(chatId, Date.now())

        const oldSessionId = this.chatIdToSessionId.get(chatId)

        // Try to resume first (preserves conversation context)
        if (oldSessionId) {
            const oldSession = this.syncEngine.getSession(oldSessionId)
            const claudeSessionId = (oldSession?.metadata as Record<string, unknown>)?.claudeSessionId as string | undefined

            if (claudeSessionId) {
                console.log(`${this.logPrefix} Attempting resume for chat ${chatId.slice(0, 12)}, session ${oldSessionId.slice(0, 8)}`)
                await this.store.updateFeishuChatSessionStatus(chatId, 'resuming')

                const resumed = await this.resumeBrainSession(oldSessionId, claudeSessionId)
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
            msgs.push({ text, messageId: meta?.messageId ?? null })
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
                }

                // If initPrompt just finished, resolve initReady
                const initResolver = this.initReadyResolvers.get(chatId)
                if (initResolver) {
                    console.log(`${this.logPrefix} initPrompt processed for chat ${chatId.slice(0, 12)}, resolving initReady`)
                    initResolver()
                    this.initReadyResolvers.delete(chatId)
                    const initTimeout = this.initTimeouts.get(chatId)
                    if (initTimeout) {
                        clearTimeout(initTimeout)
                        this.initTimeouts.delete(chatId)
                    }
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
                if (state.incoming.length > 0) {
                    console.log(`${this.logPrefix} Brain done for ${chatId.slice(0, 12)}, flushing ${state.incoming.length} pending message(s)`)
                    this.flushIncomingMessages(chatId).catch(err => {
                        console.error(`${this.logPrefix} flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
                    })
                }
            }
        }
    }

    // ========== Summary sending ==========

    /**
     * Process accumulated agent messages and send reply via adapter.
     */
    private async sendSummary(chatId: string): Promise<void> {
        const raw = this.agentMessages.get(chatId)
        if (!raw || raw.length === 0) return
        this.agentMessages.delete(chatId)

        const texts = raw.map(m => m.text)

        // Deduplicate consecutive identical messages
        const deduped = texts.filter((m, i) => i === 0 || m !== texts[i - 1])

        // Drop short narration fragments if a longer reply follows
        const SHORT_NARRATION_LIMIT = 60
        const substantive = deduped.filter((m, i) => {
            if (m.trim().length > SHORT_NARRATION_LIMIT) return true
            if (i === deduped.length - 1) return true
            const nextLong = deduped.slice(i + 1).some(n => n.trim().length > SHORT_NARRATION_LIMIT)
            return !nextLong
        })

        const allText = substantive.join('\n')

        // Detect [silent]
        const isPassiveBatch = this.lastBatchPassive.get(chatId) ?? false
        this.lastBatchPassive.delete(chatId)
        if (allText.includes('[silent]')) {
            if (isPassiveBatch) {
                console.log(`${this.logPrefix} K1 chose [silent] for ${chatId.slice(0, 12)}, skipping reply`)
                this.lastUserMessageId.delete(chatId)
                this.lastSenderIds.delete(chatId)
                await this.clearPersistedState(chatId)
                return
            }
            console.warn(`${this.logPrefix} K1 used [silent] in addressed mode for ${chatId.slice(0, 12)}, ignoring marker`)
        }

        // Extract [feishu-file: path] references
        const mediaRefs: string[] = []
        const FEISHU_FILE_RE = /\[feishu-file:\s*(.+?)\]/g
        let fm: RegExpExecArray | null
        while ((fm = FEISHU_FILE_RE.exec(allText)) !== null) {
            mediaRefs.push(fm[1].trim())
        }

        // Extract [at:all] and [at: openId] references
        const hasAtAll = /\[at:\s*all\]/i.test(allText)
        const explicitAtSet = new Set<string>()
        const AT_RE = /\[at:\s*(ou_[a-zA-Z0-9]+)\]/g
        let atMatch: RegExpExecArray | null
        while ((atMatch = AT_RE.exec(allText)) !== null) {
            explicitAtSet.add(atMatch[1])
        }
        const explicitAtIds = [...explicitAtSet]

        // Extract platform-specific extras
        const extras: IMReplyExtra[] = []
        const STICKER_RE = /\[feishu-sticker:\s*(.+?)\]/g
        const SHARE_CHAT_RE = /\[feishu-share-chat:\s*(.+?)\]/g
        const SHARE_USER_RE = /\[feishu-share-user:\s*(.+?)\]/g
        const IMAGE_URL_RE = /\[feishu-image-url:\s*(.+?)\]/g
        let em: RegExpExecArray | null
        while ((em = STICKER_RE.exec(allText)) !== null) extras.push({ type: 'sticker', stickerId: em[1].trim() })
        while ((em = SHARE_CHAT_RE.exec(allText)) !== null) extras.push({ type: 'share_chat', chatId: em[1].trim() })
        while ((em = SHARE_USER_RE.exec(allText)) !== null) extras.push({ type: 'share_user', userId: em[1].trim() })
        while ((em = IMAGE_URL_RE.exec(allText)) !== null) extras.push({ type: 'image_url', url: em[1].trim() })

        // Extract [feishu-reaction: emoji] — Brain reacts to the user's triggering message
        const reactions: string[] = []
        const REACTION_RE = /\[feishu-reaction:\s*(\w+)\]/g
        let rm: RegExpExecArray | null
        while ((rm = REACTION_RE.exec(allText)) !== null) {
            reactions.push(rm[1].trim())
        }

        // Extract <feishu-card>{...JSON...}</feishu-card> blocks
        const cards: string[] = []
        const CARD_RE = /<feishu-card>([\s\S]*?)<\/feishu-card>/g
        let cm: RegExpExecArray | null
        while ((cm = CARD_RE.exec(allText)) !== null) {
            const json = cm[1].trim()
            if (json) cards.push(json)
        }

        // Execute [feishu-edit: messageId | new text] and [feishu-recall: messageId?] immediately
        const EDIT_RE = /\[feishu-edit:\s*(om_[a-zA-Z0-9]+)\s+([\s\S]+?)\]/g
        const RECALL_EXPLICIT_RE = /\[feishu-recall:\s*(om_[a-zA-Z0-9]+)\]/g
        const RECALL_LAST_RE = /\[feishu-recall\]/g
        let editMatch: RegExpExecArray | null
        while ((editMatch = EDIT_RE.exec(allText)) !== null) {
            const [, msgId, newContent] = editMatch
            console.log(`${this.logPrefix} Editing message ${msgId.slice(0, 12)}`)
            this.adapter.editMessage?.(msgId, 'text', JSON.stringify({ text: newContent.trim() }))
                .catch(err => console.error(`${this.logPrefix} editMessage failed:`, err))
        }
        let recallMatch: RegExpExecArray | null
        while ((recallMatch = RECALL_EXPLICIT_RE.exec(allText)) !== null) {
            const msgId = recallMatch[1]
            console.log(`${this.logPrefix} Recalling message ${msgId.slice(0, 12)}`)
            this.adapter.recallMessage?.(msgId)
                .catch(err => console.error(`${this.logPrefix} recallMessage failed:`, err))
        }
        // [feishu-recall] with no ID — recall the last bot message in this chat
        if (RECALL_LAST_RE.test(allText) && this.adapter.recallMessage) {
            console.log(`${this.logPrefix} Recalling last bot message for ${chatId.slice(0, 12)}`)
            this.adapter.recallLastMessage?.(chatId)
                .catch(err => console.error(`${this.logPrefix} recallLastMessage failed:`, err))
        }

        // Execute [feishu-forward: om_messageId oc_chatId] — forward a message to another chat
        const FORWARD_RE = /\[feishu-forward:\s*(om_[a-zA-Z0-9]+)\s+(oc_[a-zA-Z0-9]+)\]/g
        let fwdMatch: RegExpExecArray | null
        while ((fwdMatch = FORWARD_RE.exec(allText)) !== null) {
            const [, msgId, targetChat] = fwdMatch
            console.log(`${this.logPrefix} Forwarding ${msgId.slice(0, 12)} to ${targetChat.slice(0, 12)}`)
            this.adapter.forwardMessage?.(msgId, targetChat)
                .catch(err => console.error(`${this.logPrefix} forwardMessage failed:`, err))
        }

        // Execute [feishu-pin: om_messageId] and [feishu-unpin: om_messageId]
        const PIN_RE = /\[feishu-pin:\s*(om_[a-zA-Z0-9]+)\]/g
        const UNPIN_RE = /\[feishu-unpin:\s*(om_[a-zA-Z0-9]+)\]/g
        let pinMatch: RegExpExecArray | null
        while ((pinMatch = PIN_RE.exec(allText)) !== null) {
            console.log(`${this.logPrefix} Pinning message ${pinMatch[1].slice(0, 12)}`)
            this.adapter.pinMessage?.(pinMatch[1])
                .catch(err => console.error(`${this.logPrefix} pinMessage failed:`, err))
        }
        while ((pinMatch = UNPIN_RE.exec(allText)) !== null) {
            console.log(`${this.logPrefix} Unpinning message ${pinMatch[1].slice(0, 12)}`)
            this.adapter.unpinMessage?.(pinMatch[1])
                .catch(err => console.error(`${this.logPrefix} unpinMessage failed:`, err))
        }

        // Execute [feishu-urgent: om_messageId app|sms|phone ou_xxx,ou_yyy]
        const URGENT_RE = /\[feishu-urgent:\s*(om_[a-zA-Z0-9]+)\s+(app|sms|phone)\s+([\w,]+)\]/g
        let urgentMatch: RegExpExecArray | null
        while ((urgentMatch = URGENT_RE.exec(allText)) !== null) {
            const [, msgId, type, userList] = urgentMatch
            const userIds = userList.split(',').map(s => s.trim()).filter(Boolean)
            console.log(`${this.logPrefix} Urgent(${type}) message ${msgId.slice(0, 12)} to ${userIds.length} users`)
            this.adapter.urgentMessage?.(msgId, type as 'app' | 'sms' | 'phone', userIds)
                .catch(err => console.error(`${this.logPrefix} urgentMessage failed:`, err))
        }

        // Strip tags from text
        const textReply = allText
            .replace(/\[feishu-file:\s*.+?\]/g, '')
            .replace(/\[at:\s*ou_[a-zA-Z0-9]+\]/g, '')
            .replace(/\[at:\s*all\]/gi, '')
            .replace(/\[feishu-sticker:\s*.+?\]/g, '')
            .replace(/\[feishu-share-chat:\s*.+?\]/g, '')
            .replace(/\[feishu-share-user:\s*.+?\]/g, '')
            .replace(/\[feishu-image-url:\s*.+?\]/g, '')
            .replace(/\[feishu-reaction:\s*\w+\]/g, '')
            .replace(/\[feishu-edit:\s*om_[a-zA-Z0-9]+\s+[\s\S]+?\]/g, '')
            .replace(/\[feishu-recall:\s*om_[a-zA-Z0-9]+\]/g, '')
            .replace(/\[feishu-recall\]/g, '')
            .replace(/\[feishu-forward:\s*om_[a-zA-Z0-9]+\s+oc_[a-zA-Z0-9]+\]/g, '')
            .replace(/\[feishu-pin:\s*om_[a-zA-Z0-9]+\]/g, '')
            .replace(/\[feishu-unpin:\s*om_[a-zA-Z0-9]+\]/g, '')
            .replace(/\[feishu-urgent:\s*om_[a-zA-Z0-9]+\s+(?:app|sms|phone)\s+[\w,]+\]/g, '')
            .replace(/<feishu-card>[\s\S]*?<\/feishu-card>/g, '')
            .replace(/<\/?feishu-reply>/g, '')
            .replace(/\[silent\]/g, '')
            .trim()

        const replyToMessageId = this.lastUserMessageId.get(chatId)
        this.lastUserMessageId.delete(chatId)

        const senderIds = this.lastSenderIds.get(chatId)
        this.lastSenderIds.delete(chatId)

        // Compute @mention IDs: [at:all] wins; else explicit [at:ou_xxx]; else fallback to senders
        const atIds = hasAtAll
            ? ['all']
            : (explicitAtIds.length > 0 ? explicitAtIds : senderIds ? [...senderIds] : [])

        const chatType = this.chatIdToChatType.get(chatId)

        if (textReply || mediaRefs.length > 0 || extras.length > 0 || cards.length > 0 || reactions.length > 0) {
            console.log(`${this.logPrefix} Sending summary to ${chatId.slice(0, 12)} (${textReply.length} chars, ${deduped.length} messages${replyToMessageId ? ', reply' : ''}${atIds.length ? `, @${atIds.length}` : ''}${mediaRefs.length ? `, +${mediaRefs.length} media` : ''}${extras.length ? `, +${extras.length} extras` : ''}${cards.length ? `, +${cards.length} cards` : ''}${reactions.length ? `, +${reactions.length} reactions` : ''})`)
            await this.adapter.sendReply(chatId, {
                text: textReply,
                replyTo: replyToMessageId,
                atIds: atIds.length > 0 ? atIds : undefined,
                mediaRefs: mediaRefs.length > 0 ? mediaRefs : undefined,
                extras: extras.length > 0 ? extras : undefined,
                cards: cards.length > 0 ? cards : undefined,
                reactions: reactions.length > 0 ? reactions : undefined,
                chatType,
            })
        }

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
            const resp = await fetch(`${this.YOHO_MEMORY_URL}/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: `飞书用户 ${senderName} ${senderId}`,
                    keywords: [senderName, senderId],
                    maxFiles: 2,
                }),
            })
            if (!resp.ok) return null
            const result = await resp.json() as { answer?: string; filesSearched?: number }
            if (!result.answer || !result.filesSearched) return null
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
