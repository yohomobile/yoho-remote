/**
 * Telegram Bot for Yoho Remote
 *
 * Simplified bot that only handles notifications (permission requests and ready events).
 * All interactive features are handled by the Telegram Mini App.
 */

import { Bot, Context, InlineKeyboard } from 'grammy'
import { SyncEngine, SyncEvent, Session } from '../sync/syncEngine'
import { handleCallback, CallbackContext } from './callbacks'
import { formatSessionNotification, createNotificationKeyboard } from './sessionView'
import type { IStore } from '../store'

export interface BotContext extends Context {
    // Extended context for future use
}

export interface YohoRemoteBotConfig {
    syncEngine: SyncEngine
    botToken: string
    miniAppUrl: string
    store: IStore
}

/**
 * Yoho Remote Telegram Bot - Notification-only mode
 */
export class YohoRemoteBot {
    private bot: Bot<BotContext>
    private syncEngine: SyncEngine | null = null
    private isRunning = false
    private readonly miniAppUrl: string
    private readonly store: IStore

    // Track last known permission requests per session to detect new ones
    private lastKnownRequests: Map<string, Set<string>> = new Map()

    // Debounce timers for notifications
    private notificationDebounce: Map<string, NodeJS.Timeout> = new Map()

    // Track ready notifications to avoid spam
    private lastReadyNotificationAt: Map<string, number> = new Map()

    // Unsubscribe function for sync events
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(config: YohoRemoteBotConfig) {
        this.syncEngine = config.syncEngine
        this.miniAppUrl = config.miniAppUrl
        this.store = config.store

        this.bot = new Bot<BotContext>(config.botToken)
        this.setupMiddleware()
        this.setupCommands()
        this.setupCallbacks()

        // Subscribe to sync events immediately if engine is available
        if (this.syncEngine) {
            this.setSyncEngine(this.syncEngine)
        }
    }

    /**
     * Update the sync engine reference (after auth)
     */
    setSyncEngine(engine: SyncEngine): void {
        // Unsubscribe from old engine
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        this.syncEngine = engine

        // Subscribe to events for notifications
        this.unsubscribeSyncEvents = engine.subscribe((event) => {
            this.handleSyncEvent(event)
        })
    }

    /**
     * Get the underlying bot instance
     */
    getBot(): Bot<BotContext> {
        return this.bot
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        if (this.isRunning) return

        console.log('[YRBot] Starting Telegram bot...')
        this.isRunning = true

        // Start polling
        this.bot.start({
            onStart: (botInfo) => {
                console.log(`[YRBot] Bot @${botInfo.username} started`)
            }
        })
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return

        console.log('[YRBot] Stopping Telegram bot...')

        // Unsubscribe from sync events
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        // Clear notification debounce timers
        for (const timer of this.notificationDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()

        await this.bot.stop()
        this.isRunning = false
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        // Error handling middleware
        this.bot.catch((err) => {
            console.error('[YRBot] Error:', err.message)
        })
    }

    /**
     * Setup command handlers
     */
    private setupCommands(): void {
        // /app - Open Telegram Mini App (primary entry point)
        this.bot.command('app', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply('Open Yoho Remote Mini App:', { reply_markup: keyboard })
        })

        // /start - Simple welcome with Mini App link
        this.bot.command('start', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply(
                'Welcome to Yoho Remote Bot!\n\n' +
                'Use the Mini App for full session management.',
                { reply_markup: keyboard }
            )
        })

    }

    /**
     * Setup callback query handlers for notification buttons
     */
    private setupCallbacks(): void {
        this.bot.on('callback_query:data', async (ctx) => {
            if (!this.syncEngine) {
                await ctx.answerCallbackQuery('Not connected')
                return
            }

            const namespace = await this.getNamespaceForChatId(ctx.from?.id ?? null)
            if (!namespace) {
                await ctx.answerCallbackQuery('Telegram account is not bound')
                return
            }

            const data = ctx.callbackQuery.data

            const callbackContext: CallbackContext = {
                syncEngine: this.syncEngine,
                namespace,
                answerCallback: async (text?: string) => {
                    await ctx.answerCallbackQuery(text)
                },
                editMessage: async (text, keyboard) => {
                    await ctx.editMessageText(text, {
                        reply_markup: keyboard
                    })
                }
            }

            await handleCallback(data, callbackContext)
        })
    }

    /**
     * Handle sync engine events for notifications
     */
    private handleSyncEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            const session = this.syncEngine?.getSession(event.sessionId)
            if (session) {
                this.checkForPermissionNotification(session)
            }
        }

        if (event.type === 'message-received' && event.sessionId) {
            const message = (event.message?.content ?? event.data) as any
            const messageContent = message?.content
            const eventType = messageContent?.type === 'event' ? messageContent?.data?.type : null

            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[YRBot] Failed to send ready notification:', error)
                })
            }
        }
    }

    private getNotifiableSession(sessionId: string): Session | null {
        const session = this.syncEngine?.getSession(sessionId)
        if (!session || !session.active) {
            return null
        }
        return session
    }

    private async getNamespaceForChatId(chatId: number | null | undefined): Promise<string | null> {
        if (!chatId) {
            return null
        }
        const stored = await this.store.getUser('telegram', String(chatId))
        return stored?.namespace ?? null
    }

    /**
     * Send a push notification when agent is ready for input.
     * 只通知 session 的 owner（创建者）和订阅者，不再广播给所有人
     */
    private async sendReadyNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < 5000) {
            return
        }
        this.lastReadyNotificationAt.set(sessionId, now)

        // Get agent name from flavor
        const flavor = session.metadata?.flavor
        const agentName = flavor === 'claude' ? 'Claude'
                        : flavor === 'codex' ? 'Codex'
                        : flavor === 'gemini' ? 'Gemini'
                        : 'Agent'

        // 获取 session 名字用于通知
        const sessionName = session.metadata?.name || 'Unknown session'

        const url = buildMiniAppDeepLink(this.miniAppUrl, `session_${sessionId}`)
        const keyboard = new InlineKeyboard()
            .webApp('Open Session', url)

        // 只通知 owner 和订阅者，不再广播给所有人
        const recipientChatIds = await this.store.getSessionNotificationRecipients(sessionId)
        if (recipientChatIds.length === 0) {
            return
        }

        for (const chatIdStr of recipientChatIds) {
            const chatId = Number(chatIdStr)
            if (!Number.isFinite(chatId)) continue

            try {
                await this.bot.api.sendMessage(
                    chatId,
                    `✅ <b>${this.escapeHtml(sessionName)}</b>\n\n${agentName} is ready for your command`,
                    { reply_markup: keyboard, parse_mode: 'HTML' }
                )
            } catch (error) {
                console.error(`[YRBot] Failed to send ready notification to chat ${chatId}:`, error)
            }
        }
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
    }

    /**
     * Check if session has new permission requests and auto-approve them
     *
     * 修改说明：
     * - 自动批准所有权限请求，不再发送通知等待用户审批
     * - 只发送 Telegram 通知告知已自动批准
     */
    private checkForPermissionNotification(session: Session): void {
        const currentSession = this.getNotifiableSession(session.id)
        if (!currentSession) {
            return
        }

        const requests = currentSession.agentState?.requests

        // If requests field is undefined/null, skip - don't clear tracked state on partial updates
        if (requests == null) {
            return
        }

        const newRequestIds = new Set(Object.keys(requests))

        // Get previously known requests for this session
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        // Find NEW requests (in new but not in old)
        const newRequests: string[] = []
        for (const requestId of newRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                newRequests.push(requestId)
            }
        }

        // Update tracked state for this session
        this.lastKnownRequests.set(session.id, newRequestIds)

        if (newRequests.length === 0) {
            return
        }

        // 自动批准所有新的权限请求
        this.autoApprovePermissions(currentSession.id, newRequests, requests).catch(err => {
            console.error('[YRBot] Failed to auto-approve permissions:', err)
        })
    }

    /**
     * 自动批准权限请求
     *
     * 注意：AskUserQuestion 不会被自动批准，需要用户手动选择答案
     */
    private async autoApprovePermissions(
        sessionId: string,
        requestIds: string[],
        requests: Record<string, { tool: string; arguments: unknown }>
    ): Promise<void> {
        if (!this.syncEngine) return

        const session = this.getNotifiableSession(sessionId)
        if (!session) return

        const sessionName = session.metadata?.name || 'Unknown session'

        // 分离需要用户交互的工具和可以自动批准的工具
        const needsUserInteraction: string[] = []
        const canAutoApprove: string[] = []

        for (const requestId of requestIds) {
            const request = requests[requestId]
            if (!request) continue

            // AskUserQuestion 需要用户手动选择，不能自动批准
            if (request.tool === 'AskUserQuestion') {
                needsUserInteraction.push(requestId)
            } else {
                canAutoApprove.push(requestId)
            }
        }

        // 自动批准非交互式权限请求
        for (const requestId of canAutoApprove) {
            const request = requests[requestId]
            if (!request) continue

            try {
                await this.syncEngine.approvePermission(sessionId, requestId, undefined, undefined, 'approved')
                console.log(`[YRBot] Auto-approved permission request ${requestId} for tool ${request.tool}`)
            } catch (error) {
                console.error(`[YRBot] Failed to auto-approve permission ${requestId}:`, error)
            }
        }

        // 如果有需要用户交互的请求，发送通知让用户去Web界面处理
        if (needsUserInteraction.length > 0) {
            const recipientChatIds = await this.store.getSessionNotificationRecipients(sessionId)
            if (recipientChatIds.length > 0) {
                const toolNames = needsUserInteraction.map(id => requests[id]?.tool).filter(Boolean).join(', ')
                const text = `❓ <b>${this.escapeHtml(sessionName)}</b>\n\n` +
                    `有 ${needsUserInteraction.length} 个权限请求需要您处理\n` +
                    `工具: ${this.escapeHtml(toolNames)}\n\n` +
                    `请在 Web 界面上选择答案`

                for (const chatIdStr of recipientChatIds) {
                    const chatId = Number(chatIdStr)
                    if (!Number.isFinite(chatId)) continue

                    try {
                        await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
                    } catch (error) {
                        console.error(`[YRBot] Failed to send notification to chat ${chatId}:`, error)
                    }
                }
            }
        }

        // 如果有自动批准的请求，也发送通知
        if (canAutoApprove.length > 0) {
            const recipientChatIds = await this.store.getSessionNotificationRecipients(sessionId)
            if (recipientChatIds.length === 0) return

            const toolNames = canAutoApprove.map(id => requests[id]?.tool).filter(Boolean).join(', ')
            const text = `🤖 <b>${this.escapeHtml(sessionName)}</b>\n\n` +
                `已自动批准 ${canAutoApprove.length} 个权限请求\n` +
                `工具: ${this.escapeHtml(toolNames)}`

            for (const chatIdStr of recipientChatIds) {
                const chatId = Number(chatIdStr)
                if (!Number.isFinite(chatId)) continue

                try {
                    await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
                } catch (error) {
                    console.error(`[YRBot] Failed to send auto-approve notification to chat ${chatId}:`, error)
                }
            }
        }
    }

    // ========== Public API ==========

    /**
     * Check if bot is enabled and running
     */
    isEnabled(): boolean {
        return this.isRunning
    }

    /**
     * Get bound chat IDs for a namespace
     */
    async getBoundChatIds(namespace: string): Promise<number[]> {
        return await this.getBoundChatIdsInternal(namespace)
    }

    /**
     * Get internal bound chat IDs
     */
    private async getBoundChatIdsInternal(namespace: string): Promise<number[]> {
        const users = await this.store.getUsersByPlatformAndNamespace('telegram', namespace)
        const ids = new Set<number>()
        for (const user of users) {
            const chatId = Number(user.platformUserId)
            if (Number.isFinite(chatId)) {
                ids.add(chatId)
            }
        }
        return Array.from(ids)
    }

    /**
     * Send a message to a chat
     */
    async sendMessageToChat(chatId: number, text: string, options?: { parse_mode?: string; reply_markup?: unknown }): Promise<void> {
        await this.bot.api.sendMessage(chatId, text, options as Parameters<typeof this.bot.api.sendMessage>[2])
    }

    /**
     * Build Mini App deep link
     */
    buildMiniAppDeepLink(startParam: string): string {
        return buildMiniAppDeepLink(this.miniAppUrl, startParam)
    }

    /**
     * Get session name by session ID
     */
    getSessionName(sessionId: string): string | null {
        const session = this.syncEngine?.getSession(sessionId)
        return session?.metadata?.name ?? null
    }

    /**
     * Send permission notification to session owner and subscribers
     * 只通知 owner 和订阅者，不再广播给所有人
     */
    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const text = formatSessionNotification(session)
        const keyboard = createNotificationKeyboard(session, this.miniAppUrl)

        // 只通知 owner 和订阅者
        const recipientChatIds = await this.store.getSessionNotificationRecipients(sessionId)
        if (recipientChatIds.length === 0) {
            return
        }

        for (const chatIdStr of recipientChatIds) {
            const chatId = Number(chatIdStr)
            if (!Number.isFinite(chatId)) continue

            try {
                await this.bot.api.sendMessage(chatId, text, {
                    reply_markup: keyboard
                })
            } catch (error) {
                console.error(`[YRBot] Failed to send notification to chat ${chatId}:`, error)
            }
        }
    }
}

function buildMiniAppDeepLink(baseUrl: string, startParam: string): string {
    try {
        const url = new URL(baseUrl)
        url.searchParams.set('startapp', startParam)
        return url.toString()
    } catch {
        const separator = baseUrl.includes('?') ? '&' : '?'
        return `${baseUrl}${separator}startapp=${encodeURIComponent(startParam)}`
    }
}
