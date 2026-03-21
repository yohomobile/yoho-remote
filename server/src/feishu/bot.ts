/**
 * Feishu Bot for HAPI
 *
 * Integrates Feishu (Lark) messaging with HAPI Brain sessions.
 * Each Feishu chat (DM or group) maps to a Brain session.
 * Brain replies are automatically pushed back to Feishu.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { IStore } from '../store/interface'
import { extractAgentText, isInternalBrainMessage, buildFeishuMessage } from './formatter'
import { enrichTextWithDocContent } from './docFetcher'
import { buildFeishuBrainInitPrompt } from '../web/prompts/initPrompt'
import { selectBestAccount } from '../claude-accounts/accountsService'
import { getClaudeAccessToken } from '../web/routes/usage'
import { lookupKeycloakUserByEmail, type KeycloakUserInfo } from './keycloakLookup'
import { getConfiguration } from '../configuration'

export interface FeishuBotConfig {
    syncEngine: SyncEngine
    store: IStore
    appId: string
    appSecret: string
}

interface IncomingMessage {
    text: string
    messageId: string
    senderName: string
    senderOpenId: string
    senderEmail: string | null
    chatType: string
    /** Whether this message explicitly addresses the bot (@bot or p2p) */
    addressed: boolean
}

interface ChatState {
    // Buffered incoming messages not yet sent to Brain
    incoming: IncomingMessage[]
    // Debounce timer for addressed messages (@bot / p2p) — 3s
    debounceTimer: ReturnType<typeof setTimeout> | null
    // Debounce timer for passive messages (group non-@bot) — 20s
    passiveDebounceTimer: ReturnType<typeof setTimeout> | null
    // Whether Brain is currently processing (thinking)
    busy: boolean
    // Whether session creation is in progress
    creating: boolean
}

export class FeishuBot {
    private syncEngine: SyncEngine
    private store: IStore
    private larkClient: lark.Client
    private wsClient: lark.WSClient | null = null
    private unsubscribeSyncEvents: (() => void) | null = null
    private isRunning = false

    // Bidirectional mapping cache (loaded from DB at startup)
    private sessionToChatId: Map<string, string> = new Map()
    private chatIdToSessionId: Map<string, string> = new Map()
    private chatIdToChatType: Map<string, string> = new Map()

    // Per-chat state for message buffering
    private chatStates: Map<string, ChatState> = new Map()

    // Accumulate agent messages per chatId, send summary when task completes
    private agentMessages: Map<string, string[]> = new Map()

    // Promise that resolves when session init (initPrompt) is fully processed (AI replied)
    private initReady: Map<string, Promise<void>> = new Map()
    // Resolvers for initReady — called when AI finishes processing initPrompt
    private initReadyResolvers: Map<string, () => void> = new Map()

    // Track the last user message ID per chat for reply threading
    private lastUserMessageId: Map<string, string> = new Map()

    // Track sender open_ids for the current round (group chats: @ them in reply)
    private lastSenderOpenIds: Map<string, Set<string>> = new Map()

    // Rebuild rate limiting: chatId -> last rebuild timestamp
    private lastRebuildAt: Map<string, number> = new Map()
    private readonly REBUILD_COOLDOWN_MS = 30_000
    private readonly INPUT_DEBOUNCE_MS = 3_000
    private readonly PASSIVE_DEBOUNCE_MS = 20_000

    // Bot's own open_id (resolved at start)
    private botOpenId: string | null = null

    // Independent token cache (separate from global STT token)
    private tokenCache: { value: string; expiresAt: number } | null = null

    private readonly appId: string
    private readonly appSecret: string
    private readonly YOHO_MEMORY_URL = 'http://localhost:3100/api'

    constructor(config: FeishuBotConfig) {
        this.syncEngine = config.syncEngine
        this.store = config.store
        this.appId = config.appId
        this.appSecret = config.appSecret

        this.larkClient = new lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: lark.Domain.Feishu,
        })
    }

    async start(): Promise<void> {
        if (this.isRunning) return
        this.isRunning = true

        // 1. Resolve bot's own open_id
        try {
            const token = await this.getToken()
            const resp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
                headers: { Authorization: `Bearer ${token}` }
            })
            const data = await resp.json() as { bot?: { open_id?: string } }
            this.botOpenId = data.bot?.open_id ?? null
            console.log(`[FeishuBot] Bot open_id: ${this.botOpenId}`)
        } catch (err) {
            console.error('[FeishuBot] Failed to get bot info:', err)
        }

        // 2. Load existing mappings from DB
        await this.loadMappings()

        // 3. Set up Feishu event dispatcher
        const eventDispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': (data: any) => {
                this.handleMessageEvent(data).catch(err => {
                    console.error('[FeishuBot] handleMessageEvent error:', err)
                })
                return {}
            }
        })

        // 4. Start WebSocket client
        this.wsClient = new lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: lark.LoggerLevel.warn,
        })
        await this.wsClient.start({ eventDispatcher })
        console.log('[FeishuBot] WebSocket client started')

        // 5. Subscribe to syncEngine events
        this.unsubscribeSyncEvents = this.syncEngine.subscribe((event) => {
            this.handleSyncEvent(event)
        })

        console.log(`[FeishuBot] Started with ${this.sessionToChatId.size} active mapping(s)`)
    }

    async stop(): Promise<void> {
        if (!this.isRunning) return
        this.isRunning = false

        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        this.agentMessages.clear()
        this.initReady.clear()
        this.initReadyResolvers.clear()

        // Clear all chat state timers
        for (const state of this.chatStates.values()) {
            if (state.debounceTimer) clearTimeout(state.debounceTimer)
            if (state.passiveDebounceTimer) clearTimeout(state.passiveDebounceTimer)
        }
        this.chatStates.clear()

        console.log('[FeishuBot] Stopped')
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
                    this.agentMessages.set(m.feishuChatId, s.agentMessages)
                }
                if (s.lastUserMessageId) {
                    this.lastUserMessageId.set(m.feishuChatId, s.lastUserMessageId)
                }
                if (s.busy) {
                    // Create a chatState so handleSyncEvent can find it
                    this.chatStates.set(m.feishuChatId, {
                        incoming: [], debounceTimer: null, passiveDebounceTimer: null, busy: true, creating: false,
                    })
                    chatsToRecover.push(m.feishuChatId)
                }
                console.log(`[FeishuBot] Restored state for chat ${m.feishuChatId.slice(0, 12)}: ${s.agentMessages?.length || 0} agentMsgs, busy=${s.busy}`)
            }
        }

        // For chats that were busy before restart, check if Brain already finished
        // (i.e. session is no longer thinking). If so, send the summary now.
        if (chatsToRecover.length > 0) {
            setTimeout(() => {
                for (const chatId of chatsToRecover) {
                    const sessionId = this.chatIdToSessionId.get(chatId)
                    if (!sessionId) continue
                    const session = this.syncEngine.getSession(sessionId)
                    // If session is no longer thinking, Brain finished during our downtime
                    if (session && !session.thinking) {
                        console.log(`[FeishuBot] Recovering: Brain already done for chat ${chatId.slice(0, 12)}, sending summary`)
                        this.sendFeishuSummary(chatId).catch(err => {
                            console.error(`[FeishuBot] Recovery sendFeishuSummary error for ${chatId.slice(0, 12)}:`, err)
                        })
                        const state = this.chatStates.get(chatId)
                        if (state) state.busy = false
                    }
                    // If still thinking, the normal handleSyncEvent flow will pick it up
                }
            }, 5000) // Wait 5s for sessions to reconnect
        }

        // Periodic cleanup: delete messages older than 7 days (run every hour)
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
        const cleanup = () => {
            this.store.cleanOldFeishuChatMessages(SEVEN_DAYS_MS)
                .then(n => { if (n > 0) console.log(`[FeishuBot] Cleaned ${n} old chat messages`) })
                .catch(err => console.error(`[FeishuBot] Chat message cleanup error:`, err))
        }
        cleanup() // Run once at startup
        setInterval(cleanup, 60 * 60 * 1000) // Then every hour
    }

    // ========== State persistence ==========

    /**
     * Persist current chat state to DB so it survives server restarts.
     * Stores agentMessages, lastUserMessageId, and busy flag.
     */
    private persistChatState(chatId: string): void {
        const state = this.chatStates.get(chatId)
        const agentMsgs = this.agentMessages.get(chatId) || []
        const lastMsgId = this.lastUserMessageId.get(chatId) || null
        const persisted = {
            agentMessages: agentMsgs,
            lastUserMessageId: lastMsgId,
            busy: state?.busy || false,
        }
        this.store.updateFeishuChatState(chatId, persisted).catch(err => {
            console.error(`[FeishuBot] persistChatState failed for ${chatId.slice(0, 12)}:`, err)
        })
    }

    /**
     * Clear persisted state (after summary sent or init processed).
     */
    private clearPersistedState(chatId: string): void {
        this.store.updateFeishuChatState(chatId, {}).catch(err => {
            console.error(`[FeishuBot] clearPersistedState failed for ${chatId.slice(0, 12)}:`, err)
        })
    }

    // ========== Feishu message handling ==========

    private async handleMessageEvent(data: any): Promise<void> {
        const message = data?.message
        const sender = data?.sender
        if (!message || !sender) return

        const chatId = message.chat_id as string
        const chatType = message.chat_type as string // 'p2p' or 'group'
        const messageId = message.message_id as string
        const senderOpenId = sender.sender_id?.open_id as string
        const messageType = message.message_type as string

        // Ignore bot's own messages
        if (senderOpenId === this.botOpenId) return

        // Check if bot is mentioned (for group chats)
        const mentions = message.mentions as Array<{ id: { open_id: string }; key: string }> | undefined
        const botMentioned = chatType === 'group' && (mentions?.some((m: any) => m.id?.open_id === this.botOpenId) ?? false)

        // Extract message text (needed for both persistence and processing)
        let text: string | null = null
        // Types that require downloading media (only when bot is being addressed)
        const addressed = chatType === 'p2p' || botMentioned
        if (messageType === 'image') {
            text = addressed
                ? await this.handleImageMessage(messageId, message.content, chatId)
                : '[图片]'
        } else if (messageType === 'file') {
            text = addressed
                ? await this.handleFileMessage(messageId, message.content, chatId)
                : '[文件]'
        } else if (messageType === 'audio') {
            text = addressed
                ? await this.handleAudioMessage(messageId, message.content)
                : '[语音]'
        } else if (messageType === 'media') {
            text = addressed
                ? await this.handleMediaMessage(messageId, message.content, chatId)
                : '[视频]'
        } else if (messageType === 'merge_forward') {
            text = await this.handleMergeForwardMessage(messageId)
        } else {
            text = this.extractMessageText(messageType, message.content)
        }

        // For addressed messages, detect feishu doc links and enrich with content
        if (text && addressed) {
            try {
                text = await enrichTextWithDocContent(text, () => this.getToken())
            } catch (err) {
                console.error('[FeishuBot] enrichTextWithDocContent failed:', err)
            }
        }

        // For non-text/audio types, append a guide so the AI proactively acts on the content
        const noGuideTypes = new Set(['text', 'audio'])
        if (text && !noGuideTypes.has(messageType)) {
            text = `${text}\n\n请根据以上内容，理解用户意图并推进。`
        }

        // Resolve sender name for persistence
        const { name: senderName, email: senderEmail } = await this.resolveSenderInfo(senderOpenId)

        // Persist message to DB (fire-and-forget, all chats)
        const contentForDb = text?.trim() || `[${messageType}]`
        this.store.saveFeishuChatMessage({
            chatId, messageId, senderOpenId, senderName, messageType, content: contentForDb,
        }).catch(err => console.error(`[FeishuBot] Failed to persist message:`, err))

        // Non-text messages that we can't process: hint and return
        if (!text || !text.trim()) {
            // Only hint for truly unknown types (most types are now handled above)
            if (addressed) {
                console.log(`[FeishuBot] Unhandled message type "${messageType}" from ${senderOpenId.slice(0, 8)} in ${chatId.slice(0, 12)}`)
            }
            return
        }

        // Group chat: resolve mention placeholders to real names
        if (chatType === 'group' && message.mentions) {
            for (const mention of message.mentions as Array<{ key: string; name?: string; id: { open_id: string } }>) {
                if (mention.id?.open_id === this.botOpenId) {
                    // Strip @bot placeholder
                    text = text.replace(mention.key, '').trim()
                } else if (mention.name) {
                    // Replace @_user_N placeholder with @RealName
                    text = text.replace(mention.key, `@${mention.name}`)
                }
            }
        }

        const mode = addressed ? '指令' : '旁听'
        console.log(`[FeishuBot] [${mode}] Message from ${senderName} in ${chatType} ${chatId.slice(0, 12)}...: ${text.slice(0, 100)}`)

        // React with emoji only for addressed messages (don't pollute passive listening)
        if (addressed && messageId) {
            this.addReaction(messageId, 'OnIt').catch(() => {})
        }

        // Get or create chat state
        let state = this.chatStates.get(chatId)
        if (!state) {
            state = { incoming: [], debounceTimer: null, passiveDebounceTimer: null, busy: false, creating: false }
            this.chatStates.set(chatId, state)
        }

        // Add message to buffer
        state.incoming.push({ text, messageId, senderName, senderOpenId, senderEmail, chatType, addressed })

        if (state.busy || state.creating) {
            // Brain is working or session is being created — just buffer, will flush when done
            console.log(`[FeishuBot] Chat ${chatId.slice(0, 12)} busy, buffered (${state.incoming.length} pending)`)
            return
        }

        if (addressed) {
            // Addressed message (@bot or p2p): 3s debounce, also cancels any pending passive timer
            if (state.passiveDebounceTimer) {
                clearTimeout(state.passiveDebounceTimer)
                state.passiveDebounceTimer = null
            }
            if (state.debounceTimer) clearTimeout(state.debounceTimer)
            state.debounceTimer = setTimeout(() => {
                this.flushIncomingMessages(chatId).catch(err => {
                    console.error(`[FeishuBot] flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
                })
            }, this.INPUT_DEBOUNCE_MS)
        } else {
            // Passive message (group non-@bot): 20s debounce
            // Don't reset addressed timer if one is pending (addressed takes priority)
            if (state.debounceTimer) return // addressed flush is coming, it will include this message
            if (state.passiveDebounceTimer) clearTimeout(state.passiveDebounceTimer)
            state.passiveDebounceTimer = setTimeout(() => {
                this.flushIncomingMessages(chatId).catch(err => {
                    console.error(`[FeishuBot] flushIncomingMessages (passive) error for ${chatId.slice(0, 12)}:`, err)
                })
            }, this.PASSIVE_DEBOUNCE_MS)
        }
    }

    /**
     * Merge all buffered incoming messages and send to Brain as one message.
     */
    private async flushIncomingMessages(chatId: string): Promise<void> {
        const state = this.chatStates.get(chatId)
        if (!state || state.incoming.length === 0) return

        // Guard: if session is being created, don't flush yet (messages stay in buffer)
        if (state.creating) return

        // Take all buffered messages and clear
        const messages = state.incoming.splice(0)
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
            await this.sendFeishuText(chatId, '抱歉，无法创建会话。请检查是否有在线机器。')
            return
        }

        // Wait for initPrompt to be sent first (if session was just created)
        const initPromise = this.initReady.get(chatId)
        if (initPromise) {
            await initPromise
            this.initReady.delete(chatId)
        }

        // Touch last message time
        await this.store.touchFeishuChatSession(chatId).catch(() => {})

        // Format: merge all messages into one text block
        // Group chat: include openId for user identity tracking
        const hasAddressed = messages.some(m => m.addressed)
        const hasPassive = messages.some(m => !m.addressed)
        const formattedParts = messages.map(m => {
            if (chatType === 'group') {
                const prefix = m.addressed ? '[指令] ' : ''
                return `${prefix}${m.senderName} (${m.senderOpenId}): ${m.text}`
            }
            return m.text
        })

        let combined = formattedParts.join('\n')

        // For pure passive messages (no @bot), add hint so K1 knows it can stay silent
        if (chatType === 'group' && hasPassive && !hasAddressed) {
            combined = `[旁听模式] 以下是群聊中的新消息，你可以选择回复或输出 [silent] 保持沉默：\n${combined}`
        }

        // Fetch user profiles from yoho-memory for appendSystemPrompt
        const appendSystemPrompt = await this.buildUserProfilePrompt(messages, chatType)

        // Remember the last user message ID for reply threading
        const lastMsgId = messages[messages.length - 1].messageId
        if (lastMsgId) {
            this.lastUserMessageId.set(chatId, lastMsgId)
        }

        // Remember sender openIds for @ mention in reply (group chats only)
        if (chatType === 'group') {
            const senderIds = new Set(messages.map(m => m.senderOpenId))
            this.lastSenderOpenIds.set(chatId, senderIds)
        }

        console.log(`[FeishuBot] Sending ${messages.length} merged message(s) to session ${sessionId.slice(0, 8)}${appendSystemPrompt ? ' (with user profiles)' : ''}`)

        // Mark busy before sending
        state.busy = true

        // Persist state: busy + lastUserMessageId (survives server restart)
        this.persistChatState(chatId)

        // Send to Brain session
        await this.syncEngine.sendMessage(sessionId, {
            text: combined,
            sentFrom: 'feishu',
            meta: {
                feishuChatId: chatId,
                feishuChatType: chatType,
                senderName: messages[messages.length - 1].senderName,
                senderOpenId: messages[messages.length - 1].senderOpenId,
                ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
            }
        })
    }

    private extractMessageText(messageType: string, contentStr: string): string | null {
        try {
            const content = JSON.parse(contentStr)
            switch (messageType) {
                case 'text':
                    return content.text as string || null

                case 'post': {
                    // Extract text from post (rich text) message, including image/media references
                    const locale = content.zh_cn || content.en_us || content
                    const title = locale.title as string | undefined
                    const paragraphs = locale.content
                    if (!Array.isArray(paragraphs)) return title || null
                    const parts: string[] = []
                    if (title) parts.push(title)
                    for (const paragraph of paragraphs) {
                        if (!Array.isArray(paragraph)) continue
                        const lineTexts: string[] = []
                        for (const el of paragraph) {
                            if (el.tag === 'text' && el.text) lineTexts.push(el.text)
                            else if (el.tag === 'a' && el.text) lineTexts.push(`${el.text}(${el.href || ''})`)
                            else if (el.tag === 'at' && el.user_name) lineTexts.push(`@${el.user_name}`)
                            else if (el.tag === 'img' && el.image_key) lineTexts.push(`[图片: ${el.image_key}]`)
                            else if (el.tag === 'media' && el.file_key) lineTexts.push(`[视频: ${el.file_key}]`)
                        }
                        if (lineTexts.length > 0) parts.push(lineTexts.join(''))
                    }
                    return parts.join('\n') || null
                }

                case 'interactive':
                    return this.extractCardText(content)

                case 'sticker':
                    return '[表情包]'

                case 'location': {
                    const name = content.name as string || ''
                    const addr = content.address as string || ''
                    const lat = content.latitude as string || ''
                    const lng = content.longitude as string || ''
                    const locParts = [name, addr].filter(Boolean).join(', ')
                    const coords = lat && lng ? ` (${lat}, ${lng})` : ''
                    return `[位置] ${locParts}${coords}` || '[位置]'
                }

                case 'share_chat': {
                    const chatId = content.chat_id as string || ''
                    return `[分享群聊: ${chatId}]`
                }

                case 'share_user': {
                    const userId = content.user_id as string || ''
                    return `[分享用户: ${userId}]`
                }

                case 'merge_forward': {
                    // Merge forward contains a list of sub-messages
                    // content structure: not standard JSON — the real messages are in message.body.messages
                    // At the extractMessageText level we just return a placeholder;
                    // actual handling is done in handleMergeForwardMessage
                    return null
                }

                case 'hongbao':
                    return '[红包]'

                case 'share_calendar_event':
                    return '[日程分享]'

                case 'video_chat': {
                    const topic = content.topic as string || ''
                    return topic ? `[视频会议: ${topic}]` : '[视频会议]'
                }

                case 'todo': {
                    const taskContent = content.task_content as string || content.content as string || ''
                    return taskContent ? `[任务] ${taskContent}` : '[任务]'
                }

                case 'vote':
                    return '[投票]'

                case 'system': {
                    // System messages (member join/leave, etc.)
                    const sysType = content.type as string || ''
                    const sysText = content.text as string || ''
                    return sysText ? `[系统消息] ${sysText}` : `[系统消息: ${sysType}]`
                }

                default:
                    return null
            }
        } catch {
            // If content is not JSON, treat as plain text
            return contentStr
        }
    }

    /**
     * Extract readable text from an interactive card message.
     *
     * NOTE: The received card structure differs from the send-side JSON.
     * Received format:
     *   { title: "...", elements: [[{tag:"text",text:"..."}, ...], ...] }
     * Elements is a 2D array (like post/rich-text), with {tag:"text",text} and {tag:"button",text} items.
     */
    private extractCardText(card: any): string | null {
        const texts: string[] = []

        // Title (top-level, not nested under header)
        if (card.title) {
            texts.push(card.title)
        }

        // Elements: 2D array (rows of elements)
        if (Array.isArray(card.elements)) {
            for (const row of card.elements) {
                if (Array.isArray(row)) {
                    const rowTexts: string[] = []
                    for (const el of row) {
                        // Skip buttons — they are actions, not content
                        if (el.tag === 'button') continue
                        if (el.tag === 'text' && el.text) {
                            rowTexts.push(el.text)
                        } else if (el.tag === 'a' && el.text) {
                            rowTexts.push(el.text)
                        }
                    }
                    if (rowTexts.length > 0) {
                        texts.push(rowTexts.join(''))
                    }
                }
            }
        }

        return texts.length > 0 ? texts.join('\n') : '[用户发送了一条卡片消息]'
    }

    /**
     * Download a Feishu image and save to server-uploads so CLI can read it via [Image: ...] reference.
     * Returns text like "[Image: server-uploads/{sessionId}/{filename}]" or null on failure.
     */
    private async handleImageMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const imageKey = content.image_key as string
            if (!imageKey) {
                console.error('[FeishuBot] Image message missing image_key')
                return null
            }

            // We need the sessionId to save the image under the right uploads directory.
            // Ensure session exists (or will be created) - use chatId to look up existing sessionId.
            const sessionId = this.chatIdToSessionId.get(chatId)

            // Download image from Feishu API
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuBot] Failed to download image: ${resp.status} ${resp.statusText}`)
                return null
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            // Determine file extension from content-type
            const contentType = resp.headers.get('content-type') || 'image/png'
            const extMap: Record<string, string> = {
                'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
                'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
            }
            const ext = extMap[contentType] || 'png'
            const filename = `feishu-${imageKey.slice(0, 16)}.${ext}`

            // Save to {dataDir}/uploads/{sessionId}/{filename}
            // Use a shared 'feishu-images' dir if no session yet (image arrives before session creation)
            const uploadSessionId = sessionId || 'feishu-images'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) {
                mkdirSync(uploadDir, { recursive: true })
            }
            writeFileSync(join(uploadDir, filename), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${filename}`
            console.log(`[FeishuBot] Downloaded image: ${serverPath} (${buffer.length} bytes, ${contentType})`)

            return `[Image: ${serverPath}]`
        } catch (err) {
            console.error('[FeishuBot] handleImageMessage failed:', err)
            return null
        }
    }

    /**
     * Download a Feishu file and save to server-uploads.
     * Returns text like "[File: server-uploads/{dir}/{filename}]" or null on failure.
     */
    private async handleFileMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            const fileName = content.file_name as string
            if (!fileKey) {
                console.error('[FeishuBot] File message missing file_key')
                return null
            }

            const sessionId = this.chatIdToSessionId.get(chatId)
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuBot] Failed to download file: ${resp.status} ${resp.statusText}`)
                return null
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const safeName = fileName || `feishu-${fileKey.slice(0, 16)}`
            const uploadSessionId = sessionId || 'feishu-files'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) {
                mkdirSync(uploadDir, { recursive: true })
            }
            writeFileSync(join(uploadDir, safeName), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${safeName}`
            console.log(`[FeishuBot] Downloaded file: ${serverPath} (${buffer.length} bytes)`)

            return `[File: ${serverPath}]`
        } catch (err) {
            console.error('[FeishuBot] handleFileMessage failed:', err)
            return null
        }
    }

    /**
     * Handle audio message: download opus from Feishu, convert to PCM via ffmpeg, call Feishu ASR API.
     */
    private async handleAudioMessage(messageId: string, contentStr: string): Promise<string | null> {
        let opusPath = ''
        let pcmPath = ''
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            if (!fileKey) {
                console.error('[FeishuBot] Audio message missing file_key')
                return null
            }

            // 1. Download audio file from Feishu
            const token = await this.getToken()
            const downloadResp = await fetch(
                `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
                { headers: { Authorization: `Bearer ${token}` } }
            )
            if (!downloadResp.ok) {
                console.error(`[FeishuBot] Failed to download audio: ${downloadResp.status} ${downloadResp.statusText}`)
                return null
            }

            const arrayBuffer = await downloadResp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)
            console.log(`[FeishuBot] Downloaded audio: ${buffer.length} bytes`)

            // 2. Convert opus to 16kHz mono PCM via ffmpeg
            const ts = Date.now()
            opusPath = join(tmpdir(), `feishu-audio-${ts}.opus`)
            pcmPath = join(tmpdir(), `feishu-audio-${ts}.pcm`)
            writeFileSync(opusPath, buffer)
            execSync(`ffmpeg -y -i "${opusPath}" -ar 16000 -ac 1 -f s16le "${pcmPath}"`, { timeout: 10000 })
            const pcmBuffer = readFileSync(pcmPath)
            const pcmBase64 = pcmBuffer.toString('base64')
            console.log(`[FeishuBot] Converted to PCM: ${pcmBuffer.length} bytes`)

            // 3. Call Feishu Speech-to-Text (ASR) API
            const fileId = `feishu${ts.toString().slice(-10)}`
            const asrResp = await fetch('https://open.feishu.cn/open-apis/speech_to_text/v1/speech/file_recognize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    speech: { speech: pcmBase64 },
                    config: {
                        file_id: fileId,
                        format: 'pcm',
                        engine_type: '16k_auto',
                    },
                }),
            })

            const asrData = await asrResp.json() as {
                code?: number
                msg?: string
                data?: { recognition_text?: string }
            }

            if (asrData.code !== 0) {
                console.error(`[FeishuBot] ASR failed: code=${asrData.code} msg=${asrData.msg}`)
                return null
            }

            const recognitionText = asrData.data?.recognition_text?.trim()
            if (!recognitionText) {
                console.log('[FeishuBot] ASR returned empty text')
                return null
            }

            console.log(`[FeishuBot] ASR result: ${recognitionText.slice(0, 100)}`)
            return `[语音] ${recognitionText}`
        } catch (err) {
            console.error('[FeishuBot] handleAudioMessage failed:', err)
            return null
        } finally {
            // Clean up temp files
            try { if (opusPath) unlinkSync(opusPath) } catch {}
            try { if (pcmPath) unlinkSync(pcmPath) } catch {}
        }
    }

    /**
     * Handle media (video) message: download and save to server-uploads.
     */
    private async handleMediaMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            const fileName = content.file_name as string || `video-${Date.now()}.mp4`
            if (!fileKey) {
                console.error('[FeishuBot] Media message missing file_key')
                return null
            }

            const sessionId = this.chatIdToSessionId.get(chatId)
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuBot] Failed to download media: ${resp.status} ${resp.statusText}`)
                return null
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const safeName = fileName || `feishu-video-${fileKey.slice(0, 16)}.mp4`
            const uploadSessionId = sessionId || 'feishu-media'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) {
                mkdirSync(uploadDir, { recursive: true })
            }
            writeFileSync(join(uploadDir, safeName), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${safeName}`
            console.log(`[FeishuBot] Downloaded media: ${serverPath} (${buffer.length} bytes)`)

            return `[视频: ${serverPath}]`
        } catch (err) {
            console.error('[FeishuBot] handleMediaMessage failed:', err)
            return null
        }
    }

    /**
     * Handle merge_forward: fetch sub-messages via Feishu GET message API.
     * The WebSocket event only has "Merged and Forwarded Message" as content;
     * the real sub-messages must be fetched via GET /im/v1/messages/{message_id}.
     */
    private async handleMergeForwardMessage(messageId: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuBot] Failed to fetch merge_forward: ${resp.status}`)
                return '[合并转发]'
            }

            const result = await resp.json() as {
                data?: {
                    items?: Array<{
                        msg_type?: string
                        body?: { content?: string }
                        sender_id?: string
                        upper_message_id?: string
                    }>
                }
            }

            const items = result.data?.items
            if (!items || items.length === 0) {
                return '[合并转发]'
            }

            // Filter to only sub-messages (those with upper_message_id)
            const subMessages = items.filter(item => item.upper_message_id)
            if (subMessages.length === 0) {
                return '[合并转发]'
            }

            const parts: string[] = []
            for (const msg of subMessages.slice(0, 20)) {
                const type = msg.msg_type || 'text'
                const contentStr = msg.body?.content || '{}'
                const text = this.extractMessageText(type, contentStr)
                if (text) parts.push(text)
            }

            console.log(`[FeishuBot] merge_forward: ${subMessages.length} sub-messages extracted`)
            return parts.join('\n') || '[合并转发]'
        } catch (err) {
            console.error('[FeishuBot] handleMergeForwardMessage failed:', err)
            return '[合并转发]'
        }
    }

    private async resolveSenderInfo(openId: string): Promise<{ name: string; email: string | null }> {
        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            const data = await resp.json() as { data?: { user?: { name?: string; enterprise_email?: string; email?: string } } }
            const user = data.data?.user
            return {
                name: user?.name || openId.slice(0, 8),
                email: user?.enterprise_email || user?.email || null,
            }
        } catch {
            return { name: openId.slice(0, 8), email: null }
        }
    }

    private async fetchChatName(chatId: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            const data = await resp.json() as { data?: { name?: string } }
            return data.data?.name || null
        } catch {
            return null
        }
    }

    // ========== Session management ==========

    private async ensureSession(chatId: string, chatType: string, senderName?: string): Promise<string | null> {
        const state = this.chatStates.get(chatId)
        if (state) state.creating = true

        try {
            // Check existing mapping
            const existingSessionId = this.chatIdToSessionId.get(chatId)
            if (existingSessionId) {
                const session = this.syncEngine.getSession(existingSessionId)
                if (session?.active) {
                    return existingSessionId
                }

                // Session is dead or missing, check offline duration
                const activeAt = session?.activeAt || 0
                const offlineDuration = Date.now() - activeAt

                if (session && offlineDuration < 120_000) {
                    // Recently went offline, might be restarting - wait briefly
                    console.log(`[FeishuBot] Session ${existingSessionId.slice(0, 8)} recently offline (${Math.round(offlineDuration / 1000)}s), waiting...`)
                    await new Promise(resolve => setTimeout(resolve, 10_000))
                    const retrySession = this.syncEngine.getSession(existingSessionId)
                    if (retrySession?.active) {
                        return existingSessionId
                    }
                }

                // Session is dead, rebuild
                return await this.rebuildSession(chatId, chatType, senderName)
            }

            // No mapping exists, create new session
            // For group chats, fetch the group name from Feishu API
            let chatName: string | undefined
            if (chatType === 'group') {
                chatName = await this.fetchChatName(chatId) || undefined
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
                console.error('[FeishuBot] No online machines available')
                return null
            }

            // Brain sessions must run on ncu — it has yoho-memory, yoho-credentials MCP deps
            const NCU_MACHINE_ID = 'e16b3653-ad9f-46a7-89fd-48a3d576cccb'
            const machine = machines.find(m => m.id === NCU_MACHINE_ID) || machines[0]
            if (machine.id !== NCU_MACHINE_ID) {
                console.warn(`[FeishuBot] ncu not online, falling back to ${machine.id}`)
            }
            const homeDir = (machine.metadata as Record<string, unknown>)?.homeDir as string || '/tmp'
            const brainDirectory = `${homeDir}/.hapi/brain-workspace`

            // Get Claude OAuth token from best available account
            let claudeToken: string | undefined
            try {
                const selection = await selectBestAccount()
                if (selection?.account?.configDir) {
                    const token = await getClaudeAccessToken(selection.account.configDir)
                    if (token) {
                        claudeToken = token
                        console.log(`[FeishuBot] Using Claude account: ${selection.account.name}`)
                    }
                }
            } catch (err) {
                console.error('[FeishuBot] Failed to get Claude token:', err)
            }

            if (!claudeToken) {
                console.error('[FeishuBot] No valid Claude token available')
                return null
            }

            const result = await this.syncEngine.spawnSession(
                machine.id,
                brainDirectory,
                'claude',
                true,  // yolo
                'simple',
                undefined,
                {
                    source: 'brain',
                    permissionMode: 'bypassPermissions',
                    token: claudeToken,
                    caller: 'feishu',
                }
            )

            if (result.type !== 'success') {
                console.error(`[FeishuBot] Failed to create session: ${result.message}`)
                return null
            }

            const sessionId = result.sessionId
            console.log(`[FeishuBot] Created Brain session ${sessionId.slice(0, 8)} for chat ${chatId.slice(0, 12)}`)

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

            // Create initReady promise — resolved when AI finishes processing initPrompt
            const initPromise = new Promise<void>((resolve) => {
                this.initReadyResolvers.set(chatId, resolve)
                // Safety timeout: resolve after 120s to avoid stuck user messages
                setTimeout(() => {
                    if (this.initReadyResolvers.has(chatId)) {
                        console.warn(`[FeishuBot] initReady timeout for chat ${chatId.slice(0, 12)}, force resolving`)
                        this.initReadyResolvers.get(chatId)?.()
                        this.initReadyResolvers.delete(chatId)
                    }
                }, 120_000)
            })
            this.initReady.set(chatId, initPromise)

            // Send initPrompt (fire-and-forget, initReady resolved by handleSyncEvent)
            this.initializeSession(sessionId, chatId, chatType, chatName, senderName).catch(err => {
                console.error(`[FeishuBot] initializeSession failed for ${sessionId.slice(0, 8)}:`, err)
                // Resolve anyway so user messages aren't stuck
                const resolver = this.initReadyResolvers.get(chatId)
                if (resolver) {
                    resolver()
                    this.initReadyResolvers.delete(chatId)
                }
            })

            return sessionId
        } catch (error) {
            console.error('[FeishuBot] createBrainSession failed:', error)
            return null
        }
    }

    private async initializeSession(sessionId: string, chatId: string, chatType: string, chatName?: string, senderName?: string): Promise<void> {
        try {
            // Wait for session to come online (up to 60s)
            const isOnline = await this.waitForSessionOnline(sessionId, 60_000)
            if (!isOnline) {
                console.warn(`[FeishuBot] Session ${sessionId.slice(0, 8)} did not come online within 60s`)
                return
            }

            // Set session title
            const now = new Date()
            const timeStr = now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
            const title = chatType === 'group' && chatName
                ? `飞书群: ${chatName} · ${timeStr}`
                : `飞书: 与${senderName || chatName || '未知'}的对话 · ${timeStr}`
            await this.syncEngine.patchSessionMetadata(sessionId, {
                summary: { text: title, updatedAt: Date.now() }
            })

            // Wait a bit for socket to join room
            await this.syncEngine.waitForSocketInRoom(sessionId, 5000)

            // Send feishu-specific Brain initPrompt
            // Only set userName for p2p chats (group chats have multiple users)
            const prompt = await buildFeishuBrainInitPrompt('developer', {
                feishuChatType: chatType as 'p2p' | 'group',
                feishuChatName: chatName,
                ...(chatType === 'p2p' && senderName ? { userName: senderName } : {}),
            })

            await this.syncEngine.sendMessage(sessionId, {
                text: prompt,
                sentFrom: 'feishu',
            })
            console.log(`[FeishuBot] Sent initPrompt to session ${sessionId.slice(0, 8)}`)
        } catch (err) {
            console.error(`[FeishuBot] initializeSession failed for ${sessionId.slice(0, 8)}:`, err)
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

            // Re-check after subscribing
            const current = this.syncEngine.getSession(sessionId)
            if (current?.active) finalize(true)
        })
    }

    private async rebuildSession(chatId: string, chatType: string, senderName?: string): Promise<string | null> {
        // Rate limiting
        const lastRebuild = this.lastRebuildAt.get(chatId) || 0
        if (Date.now() - lastRebuild < this.REBUILD_COOLDOWN_MS) {
            console.warn(`[FeishuBot] Rebuild cooldown for chat ${chatId.slice(0, 12)}, skipping`)
            return null
        }
        this.lastRebuildAt.set(chatId, Date.now())

        console.log(`[FeishuBot] Rebuilding session for chat ${chatId.slice(0, 12)}`)
        await this.store.updateFeishuChatSessionStatus(chatId, 'rebuilding')

        // Remove old mapping from memory
        const oldSessionId = this.chatIdToSessionId.get(chatId)
        if (oldSessionId) {
            this.sessionToChatId.delete(oldSessionId)
        }

        // For group chats, fetch the group name
        let chatName: string | undefined
        if (chatType === 'group') {
            chatName = await this.fetchChatName(chatId) || undefined
        }
        const newSessionId = await this.createBrainSession(chatId, chatType, chatName, senderName)
        if (newSessionId) {
            await this.sendFeishuText(chatId, '会话已重置，请继续。')
        } else {
            await this.store.updateFeishuChatSessionStatus(chatId, 'dead')
        }

        return newSessionId
    }

    // ========== SyncEngine event handling (Brain -> Feishu) ==========

    private handleSyncEvent(event: SyncEvent): void {
        // Accumulate agent messages (don't send to Feishu yet)
        if (event.type === 'message-received' && event.sessionId && event.message) {
            const chatId = this.sessionToChatId.get(event.sessionId)
            if (!chatId) return

            const text = extractAgentText(event.message.content)
            if (!text) return
            if (isInternalBrainMessage(text)) return

            const msgs = this.agentMessages.get(chatId) || []
            msgs.push(text)
            this.agentMessages.set(chatId, msgs)

            // Persist agentMessages so they survive server restart
            this.persistChatState(chatId)
        }

        // Detect "task complete" or "session aborted": thinking becomes false
        if (event.type === 'session-updated' && event.sessionId && event.data) {
            const data = event.data as Record<string, unknown>
            const chatId = this.sessionToChatId.get(event.sessionId)
            if (!chatId) return

            const isTaskComplete = data.wasThinking === true && data.thinking === false
            // Abort sends { thinking: false } without wasThinking — detect it when chat is busy
            const state = this.chatStates.get(chatId)
            const isAborted = !isTaskComplete && data.thinking === false && state?.busy === true

            if (isTaskComplete || isAborted) {
                if (isAborted) {
                    console.log(`[FeishuBot] Session aborted for ${chatId.slice(0, 12)}, clearing busy state`)
                }

                // If initPrompt just finished processing, resolve initReady
                const initResolver = this.initReadyResolvers.get(chatId)
                if (initResolver) {
                    console.log(`[FeishuBot] initPrompt processed for chat ${chatId.slice(0, 12)}, resolving initReady`)
                    initResolver()
                    this.initReadyResolvers.delete(chatId)
                    // Clear any agent messages from initPrompt processing (don't send to Feishu)
                    this.agentMessages.delete(chatId)
                    this.clearPersistedState(chatId)
                    return
                }

                if (!state) return

                // Brain finished or was aborted — send accumulated messages if any
                this.sendFeishuSummary(chatId).catch(err => {
                    console.error(`[FeishuBot] sendFeishuSummary error for ${chatId.slice(0, 12)}:`, err)
                })

                // Mark not busy and flush pending user messages
                state.busy = false
                if (state.incoming.length > 0) {
                    console.log(`[FeishuBot] Brain done for ${chatId.slice(0, 12)}, flushing ${state.incoming.length} pending message(s)`)
                    this.flushIncomingMessages(chatId).catch(err => {
                        console.error(`[FeishuBot] flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
                    })
                }
            }
        }
    }

    /**
     * Extract <feishu-reply> from accumulated agent messages and send to Feishu.
     * Falls back to the last agent message if no tag found.
     */
    private async sendFeishuSummary(chatId: string): Promise<void> {
        const msgs = this.agentMessages.get(chatId)
        if (!msgs || msgs.length === 0) return
        this.agentMessages.delete(chatId)

        // Use all agent messages as the reply (raw output)
        const allText = msgs.join('\n')

        // Detect [silent] — K1 decided not to reply (passive listening mode)
        if (allText.trim() === '[silent]' || allText.includes('[silent]')) {
            const cleanText = allText.replace(/\[silent\]/g, '').trim()
            if (!cleanText) {
                console.log(`[FeishuBot] K1 chose [silent] for ${chatId.slice(0, 12)}, skipping reply`)
                this.lastUserMessageId.delete(chatId)
                this.lastSenderOpenIds.delete(chatId)
                this.clearPersistedState(chatId)
                return
            }
            // If there's text alongside [silent], send the text part (K1 might have mixed output)
        }

        // Extract [feishu-file: path] references from anywhere in the text
        const mediaRefs: string[] = []
        const FEISHU_FILE_RE = /\[feishu-file:\s*(.+?)\]/g
        let fm: RegExpExecArray | null
        while ((fm = FEISHU_FILE_RE.exec(allText)) !== null) {
            mediaRefs.push(fm[1].trim())
        }

        // Extract [at: openId] references from K1's output
        const explicitAtIds: string[] = []
        const AT_RE = /\[at:\s*(ou_[a-zA-Z0-9]+)\]/g
        let atMatch: RegExpExecArray | null
        while ((atMatch = AT_RE.exec(allText)) !== null) {
            explicitAtIds.push(atMatch[1])
        }

        // Strip file references, at references, <feishu-reply> tags, and [silent] markers from text
        const textReply = allText
            .replace(/\[feishu-file:\s*.+?\]/g, '')
            .replace(/\[at:\s*ou_[a-zA-Z0-9]+\]/g, '')
            .replace(/<\/?feishu-reply>/g, '')
            .replace(/\[silent\]/g, '')
            .trim()

        // Reply to the last user message in this round (if available)
        const replyToMessageId = this.lastUserMessageId.get(chatId)
        this.lastUserMessageId.delete(chatId)

        // Get sender openIds for @ mention fallback (group chats)
        const senderOpenIds = this.lastSenderOpenIds.get(chatId)
        this.lastSenderOpenIds.delete(chatId)

        // 1. Send text part
        if (textReply) {
            console.log(`[FeishuBot] Sending summary to ${chatId.slice(0, 12)} (${textReply.length} chars, from ${msgs.length} messages${replyToMessageId ? ', reply' : ''}${mediaRefs.length ? `, +${mediaRefs.length} media` : ''})`)
            await this.sendFeishuPost(chatId, textReply, replyToMessageId)

            // Group chat: send @ notification
            // Priority: K1's explicit [at: openId] > fallback to all senders
            const atIds = explicitAtIds.length > 0
                ? explicitAtIds
                : senderOpenIds ? [...senderOpenIds] : []
            const atTags = atIds
                .filter(id => id !== this.botOpenId)
                .map(id => `<at user_id="${id}"></at>`)
                .join(' ')
            if (atTags) {
                await this.sendFeishuText(chatId, atTags)
            }
        }

        // 2. Send media attachments
        for (const ref of mediaRefs) {
            try {
                const filePath = this.resolveFilePath(ref)
                if (!filePath || !existsSync(filePath)) {
                    console.warn(`[FeishuBot] Media file not found: ${ref}`)
                    await this.sendFeishuText(chatId, `[文件未找到: ${basename(ref)}]`)
                    continue
                }

                const fileClass = this.classifyFile(filePath)

                if (fileClass === 'image') {
                    const imageKey = await this.uploadImageToFeishu(filePath)
                    if (imageKey) {
                        await this.sendFeishuMedia(chatId, 'image', JSON.stringify({ image_key: imageKey }))
                    } else {
                        await this.sendFeishuText(chatId, `[图片上传失败: ${basename(filePath)}]`)
                    }
                } else {
                    const fileType = fileClass === 'video' ? 'mp4' : this.getFeishuFileType(filePath)
                    const fileKey = await this.uploadFileToFeishu(filePath, fileType)
                    if (fileKey) {
                        const msgType = fileClass === 'video' ? 'media' : 'file'
                        await this.sendFeishuMedia(chatId, msgType, JSON.stringify({ file_key: fileKey, file_name: basename(filePath) }))
                    } else {
                        await this.sendFeishuText(chatId, `[文件上传失败: ${basename(filePath)}]`)
                    }
                }
            } catch (err) {
                console.error(`[FeishuBot] Failed to send media ${ref}:`, err)
                await this.sendFeishuText(chatId, `[媒体发送失败: ${basename(ref)}]`).catch(() => {})
            }
        }

        // Clear persisted state after successful send
        this.clearPersistedState(chatId)
    }

    // ========== Feishu API helpers ==========

    private async addReaction(messageId: string, emojiType: string): Promise<void> {
        try {
            const token = await this.getToken()
            await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    reaction_type: { emoji_type: emojiType },
                }),
            })
        } catch (err) {
            console.error(`[FeishuBot] addReaction failed for ${messageId.slice(0, 12)}:`, err)
        }
    }

    private async sendFeishuText(chatId: string, text: string): Promise<void> {
        try {
            const token = await this.getToken()
            await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                }),
            })
        } catch (err) {
            console.error(`[FeishuBot] sendFeishuText failed for chat ${chatId.slice(0, 12)}:`, err)
        }
    }

    private async sendFeishuPost(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
        try {
            const { msgType, content } = buildFeishuMessage(text)
            const token = await this.getToken()

            if (replyToMessageId) {
                // Reply to a specific message
                await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${replyToMessageId}/reply`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        msg_type: msgType,
                        content,
                    }),
                })
            } else {
                // Send as a new message
                await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        receive_id: chatId,
                        msg_type: msgType,
                        content,
                    }),
                })
            }
        } catch (err) {
            console.error(`[FeishuBot] sendFeishuPost failed for chat ${chatId.slice(0, 12)}:`, err)
        }
    }

    // ========== Feishu media upload helpers ==========

    private static readonly IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
    private static readonly VIDEO_EXTS = new Set(['mp4'])
    private static readonly FILE_TYPE_MAP: Record<string, string> = {
        mp4: 'mp4', pdf: 'pdf', doc: 'doc', docx: 'doc',
        xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt',
    }

    private classifyFile(filePath: string): 'image' | 'video' | 'file' {
        const ext = extname(filePath).toLowerCase().slice(1)
        if (FeishuBot.IMAGE_EXTS.has(ext)) return 'image'
        if (FeishuBot.VIDEO_EXTS.has(ext)) return 'video'
        return 'file'
    }

    private getFeishuFileType(filePath: string): string {
        const ext = extname(filePath).toLowerCase().slice(1)
        return FeishuBot.FILE_TYPE_MAP[ext] || 'stream'
    }

    private resolveFilePath(ref: string): string | null {
        if (ref.startsWith('server-uploads/')) {
            const config = getConfiguration()
            const relativePath = ref.replace('server-uploads/', '')
            return join(config.dataDir, 'uploads', relativePath)
        }
        // Handle absolute paths that contain server-uploads/ (agent may prepend working dir)
        const suIdx = ref.indexOf('server-uploads/')
        if (suIdx > 0) {
            const config = getConfiguration()
            const relativePath = ref.slice(suIdx + 'server-uploads/'.length)
            return join(config.dataDir, 'uploads', relativePath)
        }
        if (ref.startsWith('/')) return ref
        return null
    }

    private async uploadImageToFeishu(filePath: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const buffer = readFileSync(filePath)
            const fileName = basename(filePath)

            const formData = new FormData()
            formData.append('image_type', 'message')
            formData.append('image', new Blob([buffer]), fileName)

            const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            })
            const data = await resp.json() as { data?: { image_key?: string } }
            const imageKey = data?.data?.image_key ?? null
            if (imageKey) {
                console.log(`[FeishuBot] Uploaded image ${fileName} → ${imageKey}`)
            } else {
                console.error(`[FeishuBot] Upload image failed for ${fileName}:`, data)
            }
            return imageKey
        } catch (err) {
            console.error(`[FeishuBot] uploadImageToFeishu error:`, err)
            return null
        }
    }

    private async uploadFileToFeishu(filePath: string, fileType: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const buffer = readFileSync(filePath)
            const fileName = basename(filePath)

            const formData = new FormData()
            formData.append('file_type', fileType)
            formData.append('file_name', fileName)
            formData.append('file', new Blob([buffer]), fileName)

            const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            })
            const data = await resp.json() as { data?: { file_key?: string } }
            const fileKey = data?.data?.file_key ?? null
            if (fileKey) {
                console.log(`[FeishuBot] Uploaded file ${fileName} (${fileType}) → ${fileKey}`)
            } else {
                console.error(`[FeishuBot] Upload file failed for ${fileName}:`, data)
            }
            return fileKey
        } catch (err) {
            console.error(`[FeishuBot] uploadFileToFeishu error:`, err)
            return null
        }
    }

    private async sendFeishuMedia(chatId: string, msgType: string, content: string): Promise<void> {
        try {
            const token = await this.getToken()
            await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    receive_id: chatId,
                    msg_type: msgType,
                    content,
                }),
            })
        } catch (err) {
            console.error(`[FeishuBot] sendFeishuMedia failed for chat ${chatId.slice(0, 12)}:`, err)
        }
    }

    // ========== User profile (yoho-memory) ==========

    /**
     * Build appendSystemPrompt with user profiles for all unique senders.
     */
    private async buildUserProfilePrompt(messages: IncomingMessage[], chatType: string): Promise<string | undefined> {
        // Deduplicate senders
        const senders = new Map<string, IncomingMessage>()
        for (const m of messages) {
            senders.set(m.senderOpenId, m)
        }

        const profiles: string[] = []
        for (const [openId, msg] of senders) {
            const profile = await this.fetchUserProfile(msg.senderName, openId)

            // If profile doesn't have Keycloak link yet, try to look up and persist
            const hasKeycloakLink = profile?.includes('keycloakId:')
            let keycloakSection = ''

            if (!hasKeycloakLink && msg.senderEmail) {
                const kcUser = await lookupKeycloakUserByEmail(msg.senderEmail)
                if (kcUser) {
                    keycloakSection = this.formatKeycloakInfo(kcUser)
                    this.persistKeycloakLink(msg.senderName, openId, msg.senderEmail, kcUser).catch(() => {})
                }
            }

            const fullProfile = [profile, keycloakSection].filter(Boolean).join('\n\n')
            if (fullProfile) {
                const emailAttr = msg.senderEmail ? ` email="${msg.senderEmail}"` : ''
                profiles.push(`<user-profile sender="${msg.senderName}" openId="${openId}"${emailAttr}>\n${fullProfile}\n</user-profile>`)
            }
        }

        return profiles.length > 0 ? profiles.join('\n\n') : undefined
    }

    /**
     * Fetch user profile from yoho-memory via HTTP recall API (~150ms, no AI token cost).
     * Returns null silently if yoho-memory is unavailable.
     */
    private async fetchUserProfile(senderName: string, senderOpenId: string): Promise<string | null> {
        try {
            const resp = await fetch(`${this.YOHO_MEMORY_URL}/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: `飞书用户 ${senderName} ${senderOpenId}`,
                    keywords: [senderName, senderOpenId],
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
        openId: string,
        email: string,
        kcUser: KeycloakUserInfo,
    ): Promise<void> {
        try {
            const parts = [
                `飞书用户画像更新 - ${senderName} (${openId}):`,
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
            console.log(`[FeishuBot] Persisted Keycloak link for ${senderName} (${email})`)
        } catch {
            // Silent fail — next message will retry
        }
    }

    // ========== Token management ==========

    private async getToken(): Promise<string> {
        if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
            return this.tokenCache.value
        }

        const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        })
        const data = await resp.json() as { code?: number; tenant_access_token?: string; expire?: number }
        if (data.code !== 0 || !data.tenant_access_token) {
            throw new Error(`Feishu auth failed: code=${data.code}`)
        }

        const expireSeconds = typeof data.expire === 'number' ? data.expire : 0
        this.tokenCache = {
            value: data.tenant_access_token,
            expiresAt: Date.now() + Math.max(0, expireSeconds - 60) * 1000,
        }
        return data.tenant_access_token
    }
}
