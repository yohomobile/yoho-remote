/**
 * Feishu Bot for HAPI
 *
 * Integrates Feishu (Lark) messaging with HAPI Brain sessions.
 * Each Feishu chat (DM or group) maps to a Brain session.
 * Brain replies are automatically pushed back to Feishu.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { IStore } from '../store/interface'
import { extractAgentText, isInternalBrainMessage, buildFeishuMessage } from './formatter'
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
}

interface ChatState {
    // Buffered incoming messages not yet sent to Brain
    incoming: IncomingMessage[]
    // Debounce timer for initial 10s wait
    debounceTimer: ReturnType<typeof setTimeout> | null
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

    // Rebuild rate limiting: chatId -> last rebuild timestamp
    private lastRebuildAt: Map<string, number> = new Map()
    private readonly REBUILD_COOLDOWN_MS = 30_000
    private readonly INPUT_DEBOUNCE_MS = 3_000

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
                // Return empty object to acknowledge the event
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

        for (const m of mappings) {
            this.sessionToChatId.set(m.sessionId, m.feishuChatId)
            this.chatIdToSessionId.set(m.feishuChatId, m.sessionId)
            this.chatIdToChatType.set(m.feishuChatId, m.feishuChatType)
        }
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

        // Group chat: only respond to @bot messages
        if (chatType === 'group') {
            const mentions = message.mentions as Array<{ id: { open_id: string }; key: string }> | undefined
            const botMentioned = mentions?.some((m: any) => m.id?.open_id === this.botOpenId)
            if (!botMentioned) return
        }

        // Handle image messages: download from Feishu and embed as [Image: ...] reference
        let text: string | null = null
        if (messageType === 'image') {
            text = await this.handleImageMessage(messageId, message.content, chatId)
        } else {
            text = this.extractMessageText(messageType, message.content)
        }
        if (!text || !text.trim()) {
            // For known non-text types, send a friendly hint
            const typeLabels: Record<string, string> = {
                file: '文件', audio: '语音', video: '视频',
                sticker: '表情', media: '媒体', share_chat: '群名片', share_user: '个人名片',
            }
            if (typeLabels[messageType]) {
                console.log(`[FeishuBot] Unsupported message type "${messageType}" from ${senderOpenId.slice(0, 8)} in ${chatId.slice(0, 12)}`)
                await this.sendFeishuText(chatId, `暂不支持${typeLabels[messageType]}消息，请用文字描述你的问题。`)
            }
            return
        }

        // Group chat: strip @bot mention placeholder from text
        if (chatType === 'group' && message.mentions) {
            for (const mention of message.mentions as Array<{ key: string; id: { open_id: string } }>) {
                if (mention.id?.open_id === this.botOpenId) {
                    text = text.replace(mention.key, '').trim()
                }
            }
        }

        // Resolve sender info (name + email from Feishu Contact API)
        const { name: senderName, email: senderEmail } = await this.resolveSenderInfo(senderOpenId)

        console.log(`[FeishuBot] Message from ${senderName} in ${chatType} ${chatId.slice(0, 12)}...: ${text.slice(0, 100)}`)

        // React with emoji to acknowledge receipt
        if (messageId) {
            this.addReaction(messageId, 'OnIt').catch(() => {})
        }

        // Get or create chat state
        let state = this.chatStates.get(chatId)
        if (!state) {
            state = { incoming: [], debounceTimer: null, busy: false, creating: false }
            this.chatStates.set(chatId, state)
        }

        // Add message to buffer
        state.incoming.push({ text, messageId, senderName, senderOpenId, senderEmail, chatType })

        if (state.busy || state.creating) {
            // Brain is working or session is being created — just buffer, will flush when done
            console.log(`[FeishuBot] Chat ${chatId.slice(0, 12)} busy, buffered (${state.incoming.length} pending)`)
            return
        }

        // Reset debounce timer (10s)
        if (state.debounceTimer) clearTimeout(state.debounceTimer)
        state.debounceTimer = setTimeout(() => {
            this.flushIncomingMessages(chatId).catch(err => {
                console.error(`[FeishuBot] flushIncomingMessages error for ${chatId.slice(0, 12)}:`, err)
            })
        }, this.INPUT_DEBOUNCE_MS)
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
        const formattedParts = messages.map(m => {
            return chatType === 'group'
                ? `[${m.senderName} | ${m.senderOpenId}]: ${m.text}`
                : m.text
        })
        const combined = formattedParts.join('\n')

        // Fetch user profiles from yoho-memory for appendSystemPrompt
        const appendSystemPrompt = await this.buildUserProfilePrompt(messages, chatType)

        // Remember the last user message ID for reply threading
        const lastMsgId = messages[messages.length - 1].messageId
        if (lastMsgId) {
            this.lastUserMessageId.set(chatId, lastMsgId)
        }

        console.log(`[FeishuBot] Sending ${messages.length} merged message(s) to session ${sessionId.slice(0, 8)}${appendSystemPrompt ? ' (with user profiles)' : ''}`)

        // Mark busy before sending
        state.busy = true

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
            if (messageType === 'text') {
                return content.text as string || null
            }
            if (messageType === 'post') {
                // Extract text from post (rich text) message
                const zhContent = content.zh_cn?.content || content.en_us?.content || content.content
                if (Array.isArray(zhContent)) {
                    const texts: string[] = []
                    for (const paragraph of zhContent) {
                        if (Array.isArray(paragraph)) {
                            for (const element of paragraph) {
                                if (element.tag === 'text' && element.text) {
                                    texts.push(element.text)
                                } else if (element.tag === 'a' && element.text) {
                                    texts.push(element.text)
                                }
                            }
                        }
                    }
                    return texts.join('') || null
                }
            }
            if (messageType === 'interactive') {
                console.log(`[FeishuBot] Interactive card content: ${contentStr.slice(0, 1000)}`)
                return this.extractCardText(content)
            }
        } catch {
            // If content is not JSON, treat as plain text
            return contentStr
        }
        return null
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
            return await this.createBrainSession(chatId, chatType, undefined, senderName)
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

            // Set session title: "飞书: 与xxx的对话 · 03/20 18:55"
            const now = new Date()
            const timeStr = now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
            const who = senderName || chatName || '未知'
            const title = `飞书: 与${who}的对话 · ${timeStr}`
            await this.syncEngine.patchSessionMetadata(sessionId, {
                summary: { text: title, updatedAt: Date.now() }
            })

            // Wait a bit for socket to join room
            await this.syncEngine.waitForSocketInRoom(sessionId, 5000)

            // Send feishu-specific Brain initPrompt
            const prompt = await buildFeishuBrainInitPrompt('developer', {
                feishuChatType: chatType as 'p2p' | 'group',
                feishuChatName: chatName,
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

        const newSessionId = await this.createBrainSession(chatId, chatType, undefined, senderName)
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
        }

        // Detect "task complete": wasThinking=true + thinking=false
        if (event.type === 'session-updated' && event.sessionId && event.data) {
            const data = event.data as Record<string, unknown>
            if (data.wasThinking === true && data.thinking === false) {
                const chatId = this.sessionToChatId.get(event.sessionId)
                if (!chatId) return

                // If initPrompt just finished processing, resolve initReady
                const initResolver = this.initReadyResolvers.get(chatId)
                if (initResolver) {
                    console.log(`[FeishuBot] initPrompt processed for chat ${chatId.slice(0, 12)}, resolving initReady`)
                    initResolver()
                    this.initReadyResolvers.delete(chatId)
                    // Clear any agent messages from initPrompt processing (don't send to Feishu)
                    this.agentMessages.delete(chatId)
                    return
                }

                const state = this.chatStates.get(chatId)
                if (!state) return

                // Brain finished this round — extract <feishu-reply> and send
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

        // Search all messages (reverse) for <feishu-reply>
        const allText = msgs.join('\n')
        const match = allText.match(/<feishu-reply>([\s\S]*?)<\/feishu-reply>/g)

        let reply: string
        if (match) {
            // Take the last <feishu-reply> block
            const lastMatch = match[match.length - 1]
            reply = lastMatch.replace(/<\/?feishu-reply>/g, '').trim()
        } else {
            // Fallback: use the last agent message (truncated)
            reply = msgs[msgs.length - 1].slice(0, 2000)
        }

        if (!reply) return

        // Reply to the last user message in this round (if available)
        const replyToMessageId = this.lastUserMessageId.get(chatId)
        this.lastUserMessageId.delete(chatId)

        console.log(`[FeishuBot] Sending summary to ${chatId.slice(0, 12)} (${reply.length} chars, from ${msgs.length} messages${replyToMessageId ? ', reply' : ''})`)
        await this.sendFeishuPost(chatId, reply, replyToMessageId)
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
            })
        } catch (err) {
            console.error(`[FeishuBot] sendFeishuPost failed for chat ${chatId.slice(0, 12)}:`, err)
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
