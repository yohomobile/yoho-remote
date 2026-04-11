/**
 * FeishuAdapter — Feishu (Lark) platform adapter for BrainBridge.
 *
 * Handles all Feishu-specific logic:
 * - WebSocket connection to Feishu event API
 * - Message receiving, parsing, media download
 * - Message sending (text, rich text, voice, media)
 * - Feishu API calls (token, reactions, user info)
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { join, basename, extname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { IStore } from '../../store/interface'
import type { IMAdapter, IMBridgeCallbacks, IMReply, IMReplyExtra } from '../types'
import { buildFeishuMessage } from './formatter'
import { enrichTextWithDocContent } from './docFetcher'
import { extractFileContent } from './fileExtractor'
import { buildCardJson } from './cardBuilder'
import { buildFeishuBrainInitPrompt } from '../../web/prompts/initPrompt'
import { getConfiguration } from '../../configuration'

export interface FeishuAdapterConfig {
    store: IStore
    appId: string
    appSecret: string
}

export class FeishuAdapter implements IMAdapter {
    readonly platform = 'feishu'

    private store: IStore
    private appId: string
    private appSecret: string
    private larkClient: lark.Client
    private wsClient: lark.WSClient | null = null
    private bridge: IMBridgeCallbacks | null = null

    // Bot's own open_id (resolved at start)
    private botOpenId: string | null = null

    // Independent token cache
    private tokenCache: { value: string; expiresAt: number } | null = null

    // Per-session image URL→key dedup cache (LRU-style, capped at 100 entries)
    private imageKeyCache: Map<string, string> = new Map()

    // Incoming message dedup: prevent processing same messageId twice on Feishu webhook retry
    private recentMessageIds: Map<string, number> = new Map()
    private static readonly MSG_DEDUP_TTL_MS = 60_000

    // Card action dedup: ignore rapid double-clicks (2s window)
    private recentCardActions: Map<string, number> = new Map()
    private static readonly CARD_ACTION_DEDUP_MS = 2_000

    private static readonly IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
    private static readonly VIDEO_EXTS = new Set(['mp4'])
    // opus → Feishu audio message; others fall back to generic file
    private static readonly AUDIO_EXTS = new Set(['opus', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'])
    // Feishu upload API accepts these specific file_type strings; everything else → 'stream'
    private static readonly FILE_TYPE_MAP: Record<string, string> = {
        opus: 'opus', mp4: 'mp4', pdf: 'pdf',
        doc: 'doc', docx: 'doc',
        xls: 'xls', xlsx: 'xls',
        ppt: 'ppt', pptx: 'ppt',
    }
    // Text/code extensions whose content we read inline so Brain doesn't need file path resolution
    private static readonly TEXT_EXTS = new Set([
        'txt', 'md', 'markdown', 'rst', 'adoc',
        'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv',
        'ini', 'cfg', 'conf', 'env', 'properties',
        'html', 'htm', 'css',
        'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
        'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
        'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php', 'r',
        'sh', 'bash', 'zsh', 'fish', 'ps1',
        'sql', 'graphql', 'proto',
        'log', 'diff', 'patch',
    ])
    private static readonly SEND_URL = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'

    // Sender info cache: openId → { name, email, cachedAt }
    private readonly senderInfoCache = new Map<string, { name: string; email: string | null; cachedAt: number }>()

    // Track the last bot message sent per chat (for [feishu-recall] without explicit ID)
    private readonly lastBotMessageIdPerChat = new Map<string, string>()

    constructor(config: FeishuAdapterConfig) {
        this.store = config.store
        this.appId = config.appId
        this.appSecret = config.appSecret
        this.larkClient = new lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: lark.Domain.Feishu,
        })
    }

    // ========== IMAdapter lifecycle ==========

    async start(bridge: IMBridgeCallbacks): Promise<void> {
        this.bridge = bridge

        // Resolve bot's own open_id
        try {
            const token = await this.getToken()
            const resp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
                headers: { Authorization: `Bearer ${token}` }
            })
            const data = await resp.json() as { bot?: { open_id?: string } }
            this.botOpenId = data.bot?.open_id ?? null
            console.log(`[FeishuAdapter] Bot open_id: ${this.botOpenId}`)
        } catch (err) {
            console.error('[FeishuAdapter] Failed to get bot info:', err)
        }

        // Set up event dispatcher
        const eventDispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': (data: any) => {
                this.handleMessageEvent(data).catch(err => {
                    console.error('[FeishuAdapter] handleMessageEvent error:', err)
                })
                return {}
            },
            'im.message.reaction.created_v1': (data: any) => {
                this.handleReactionEvent(data)
                return {}
            },
            'card.action.trigger': (data: any) => {
                this.handleCardActionEvent(data)
                return {}
            },
        })

        // Start WebSocket client
        this.wsClient = new lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: lark.LoggerLevel.warn,
        })
        await this.wsClient.start({ eventDispatcher })
        console.log('[FeishuAdapter] WebSocket client started')
    }

    async stop(): Promise<void> {
        this.bridge = null
        if (this.wsClient) {
            try { this.wsClient.close({ force: true }) } catch {}
            this.wsClient = null
        }
        this.recentMessageIds.clear()
        this.recentCardActions.clear()
        console.log('[FeishuAdapter] Stopped')
    }

    // ========== IMAdapter sending ==========

    async sendText(chatId: string, text: string): Promise<void> {
        try {
            const token = await this.getToken()
            await fetch(FeishuAdapter.SEND_URL, {
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
            console.error(`[FeishuAdapter] sendText failed for chat ${chatId.slice(0, 12)}:`, err)
        }
    }

    async sendReply(chatId: string, reply: IMReply): Promise<void> {
        const { text: textReply, replyTo: replyToMessageId, atIds, mediaRefs, extras, chatType } = reply

        // 1. Send text part
        if (textReply) {
            // Filter out bot's own ID from @mentions; 'all' (@everyone) passes through
            const filteredAtIds = (atIds || []).filter(id => id === 'all' || id !== this.botOpenId)

            await this.sendPost(chatId, textReply, replyToMessageId, filteredAtIds.length > 0 ? filteredAtIds : undefined)
        }

        // 2. Send media attachments
        if (mediaRefs) {
            for (const ref of mediaRefs) {
                try {
                    const filePath = this.resolveFilePath(ref)
                    if (!filePath) {
                        // resolveFilePath returns null for path traversal attempts or oversized files
                        console.warn(`[FeishuAdapter] Media file rejected: ${ref}`)
                        await this.sendText(chatId, `[文件无法发送: ${basename(ref)}（路径无效或超过 20MB 限制）]`)
                        continue
                    }
                    if (!existsSync(filePath)) {
                        console.warn(`[FeishuAdapter] Media file not found: ${ref}`)
                        await this.sendText(chatId, `[文件未找到: ${basename(ref)}]`)
                        continue
                    }

                    const fileClass = this.classifyFile(filePath)

                    if (fileClass === 'image') {
                        const imageKey = await this.uploadImage(filePath)
                        if (imageKey) {
                            await this.sendFeishuMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }))
                        } else {
                            await this.sendText(chatId, `[图片上传失败: ${basename(filePath)}]`)
                        }
                    } else if (fileClass === 'audio') {
                        const ext = extname(filePath).toLowerCase().slice(1)
                        // Feishu audio messages require opus format; other audio → send as file
                        if (ext === 'opus') {
                            const fileKey = await this.uploadFile(filePath, 'opus')
                            if (fileKey) {
                                await this.sendFeishuMessage(chatId, 'audio', JSON.stringify({ file_key: fileKey }))
                            } else {
                                await this.sendText(chatId, `[音频上传失败: ${basename(filePath)}]`)
                            }
                        } else {
                            const fileKey = await this.uploadFile(filePath, 'stream')
                            if (fileKey) {
                                await this.sendFeishuMessage(chatId, 'file', JSON.stringify({ file_key: fileKey, file_name: basename(filePath) }))
                            } else {
                                await this.sendText(chatId, `[音频上传失败: ${basename(filePath)}]`)
                            }
                        }
                    } else {
                        const fileType = fileClass === 'video' ? 'mp4' : this.getFeishuFileType(filePath)
                        const fileKey = await this.uploadFile(filePath, fileType)
                        if (fileKey) {
                            const msgType = fileClass === 'video' ? 'media' : 'file'
                            await this.sendFeishuMessage(chatId, msgType, JSON.stringify({ file_key: fileKey, file_name: basename(filePath) }))
                        } else {
                            await this.sendText(chatId, `[文件上传失败: ${basename(filePath)}]`)
                        }
                    }
                } catch (err) {
                    console.error(`[FeishuAdapter] Failed to send media ${ref}:`, err)
                    await this.sendText(chatId, `[媒体发送失败: ${basename(ref)}]`).catch(() => {})
                }
            }
        }

        // 3. Send platform-specific extras (stickers, share cards, image URLs)
        if (extras) {
            for (const extra of extras) {
                try {
                    await this.sendExtra(chatId, extra)
                } catch (err) {
                    console.error(`[FeishuAdapter] Failed to send extra ${extra.type}:`, err)
                }
            }
        }

        // 4. Send interactive cards (DSL or raw JSON → Feishu card v2)
        if (reply.cards) {
            for (const cardContent of reply.cards) {
                try {
                    const cardJson = buildCardJson(cardContent)
                    if (!cardJson) {
                        console.warn(`[FeishuAdapter] Card content produced no output, skipping`)
                        continue
                    }
                    console.log(`[FeishuAdapter] Sending interactive card to ${chatId.slice(0, 12)}`)
                    await this.sendFeishuMessage(chatId, 'interactive', cardJson)
                } catch (err) {
                    console.error(`[FeishuAdapter] Failed to send card:`, err)
                    await this.sendText(chatId, '[卡片发送失败]').catch(() => {})
                }
            }
        }

        // 5. Add emoji reactions to the triggering user message
        if (reply.reactions && replyToMessageId) {
            for (const emoji of reply.reactions) {
                this.addReaction(replyToMessageId, emoji).catch(err => {
                    console.error(`[FeishuAdapter] Failed to add reaction ${emoji}:`, err)
                })
            }
        }
    }

    async addReaction(messageId: string, emojiType: string): Promise<void> {
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
            console.error(`[FeishuAdapter] addReaction failed for ${messageId.slice(0, 12)}:`, err)
        }
    }

    // ========== Message edit & recall ==========

    async editMessage(messageId: string, msgType: string, content: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
            'PATCH',
            { msg_type: msgType, content },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] editMessage failed for ${messageId.slice(0, 12)}: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    async recallMessage(messageId: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
            'DELETE',
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] recallMessage failed for ${messageId.slice(0, 12)}: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    async recallLastMessage(chatId: string): Promise<boolean> {
        const messageId = this.lastBotMessageIdPerChat.get(chatId)
        if (!messageId) {
            console.warn(`[FeishuAdapter] recallLastMessage: no tracked message for ${chatId.slice(0, 12)}`)
            return false
        }
        return this.recallMessage(messageId)
    }

    // ========== Forward, Pin, Urgent, Read status ==========

    async forwardMessage(messageId: string, targetChatId: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/forward?receive_id_type=chat_id`,
            'POST',
            { receive_id: targetChatId },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] forwardMessage failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    async pinMessage(messageId: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            'https://open.feishu.cn/open-apis/im/v1/pins',
            'POST',
            { message_id: messageId },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] pinMessage failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    async unpinMessage(messageId: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/pins/${messageId}`,
            'DELETE',
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] unpinMessage failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    /**
     * Send urgent notification for a message. Bot can only buzz its own messages.
     * @param type - 'app' | 'sms' | 'phone'
     */
    async urgentMessage(messageId: string, type: 'app' | 'sms' | 'phone', userIds: string[]): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/urgent_${type}?user_id_type=open_id`,
            'PATCH',
            { user_id_list: userIds },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] urgentMessage(${type}) failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    /**
     * Query who has read a message. Returns list of open_ids.
     */
    async getReadUsers(messageId: string): Promise<string[]> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/read_users?user_id_type=open_id`,
            'GET',
        )
        if (!result || result.code !== 0) return []
        const items = result.data?.items as Array<{ user_id_type: string; user_id: string }> | undefined
        return items?.map(i => i.user_id) || []
    }

    /**
     * Update a card message after it was sent (delayed card update).
     * Used for dynamically updating card content (e.g., progress bars, status changes).
     */
    async updateCard(token: string, cardContent: Record<string, unknown>): Promise<boolean> {
        const result = await this.callFeishuApi(
            'https://open.feishu.cn/open-apis/interactive/v1/card/update',
            'POST',
            { token, card: cardContent },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] updateCard failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    /**
     * Send an ephemeral (temporary) card visible only to a specific user.
     * Useful for private notifications in group chats.
     */
    async sendEphemeralCard(chatId: string, userId: string, cardContent: string): Promise<boolean> {
        let card: Record<string, unknown>
        try {
            card = JSON.parse(cardContent)
        } catch {
            console.error('[FeishuAdapter] sendEphemeralCard: invalid card JSON')
            return false
        }
        const result = await this.callFeishuApi(
            'https://open.feishu.cn/open-apis/ephemeral/v1/send',
            'POST',
            { chat_id: chatId, user_id: userId, msg_type: 'interactive', card },
        )
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] sendEphemeralCard failed: code=${result?.code}, msg=${result?.msg}`)
            return false
        }
        return true
    }

    /**
     * Delete a reaction from a message.
     */
    async removeReaction(messageId: string, reactionId: string): Promise<boolean> {
        const result = await this.callFeishuApi(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
            'DELETE',
        )
        return !!result && result.code === 0
    }

    // ========== IMAdapter info resolution ==========

    async resolveSenderInfo(openId: string): Promise<{ name: string; email: string | null }> {
        const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
        const cached = this.senderInfoCache.get(openId)
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            return { name: cached.name, email: cached.email }
        }

        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            const data = await resp.json() as { data?: { user?: { name?: string; enterprise_email?: string; email?: string } } }
            const user = data.data?.user
            const result = {
                name: user?.name || openId.slice(0, 8),
                email: user?.enterprise_email || user?.email || null,
            }
            this.senderInfoCache.set(openId, { ...result, cachedAt: Date.now() })
            return result
        } catch {
            return { name: openId.slice(0, 8), email: null }
        }
    }

    async fetchChatName(chatId: string): Promise<string | null> {
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

    buildSessionTitle(chatType: string, chatName?: string, senderName?: string): string {
        const now = new Date()
        const timeStr = now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
        return chatType === 'group' && chatName
            ? `飞书群: ${chatName} · ${timeStr}`
            : `飞书: 与${senderName || chatName || '未知'}的对话 · ${timeStr}`
    }

    async buildInitPrompt(chatType: string, chatName?: string, senderName?: string): Promise<string> {
        const options = {
            feishuChatType: chatType as 'p2p' | 'group',
            feishuChatName: chatName,
            ...(chatType === 'p2p' && senderName ? { userName: senderName } : {}),
        }
        return await buildFeishuBrainInitPrompt('developer', options)
    }

    // ========== Message receiving ==========

    private async handleMessageEvent(data: any): Promise<void> {
        if (!this.bridge) return

        const message = data?.message
        const sender = data?.sender
        if (!message || !sender) return

        const chatId = message.chat_id as string
        const chatType = message.chat_type as string
        const messageId = message.message_id as string
        const senderOpenId = sender.sender_id?.open_id as string
        const messageType = message.message_type as string

        // Dedup: Feishu may re-deliver the same message on webhook timeout/retry
        if (messageId) {
            const now = Date.now()
            const lastSeen = this.recentMessageIds.get(messageId)
            if (lastSeen !== undefined && now - lastSeen < FeishuAdapter.MSG_DEDUP_TTL_MS) {
                console.log(`[FeishuAdapter] Duplicate messageId ${messageId.slice(0, 12)}, skipping`)
                return
            }
            this.recentMessageIds.set(messageId, now)
            // Evict expired entries when cache grows large
            if (this.recentMessageIds.size > 1000) {
                for (const [id, ts] of this.recentMessageIds) {
                    if (now - ts > FeishuAdapter.MSG_DEDUP_TTL_MS) this.recentMessageIds.delete(id)
                }
            }
        }

        // Ignore bot's own messages
        if (senderOpenId === this.botOpenId) return

        // Check if bot is mentioned
        const mentions = message.mentions as Array<{ id: { open_id: string }; key: string }> | undefined
        const botMentioned = chatType === 'group' && (mentions?.some((m: any) => m.id?.open_id === this.botOpenId) ?? false)

        const addressed = chatType === 'p2p' || botMentioned

        // Extract message text
        let text: string | null = null
        if (messageType === 'image') {
            text = addressed
                ? await this.handleImageMessage(messageId, message.content, chatId)
                : '[图片]'
        } else if (messageType === 'file') {
            if (addressed) {
                text = await this.handleFileMessage(messageId, message.content, chatId)
            } else {
                // Passive: at least show the filename
                try {
                    const fileName = (JSON.parse(message.content) as { file_name?: string }).file_name
                    text = fileName ? `[文件: ${fileName}]` : '[文件]'
                } catch { text = '[文件]' }
            }
        } else if (messageType === 'audio') {
            text = addressed
                ? await this.handleAudioMessage(messageId, message.content)
                : '[语音]'
        } else if (messageType === 'media') {
            if (addressed) {
                text = await this.handleMediaMessage(messageId, message.content, chatId)
            } else {
                try {
                    const fileName = (JSON.parse(message.content) as { file_name?: string }).file_name
                    text = fileName ? `[视频: ${fileName}]` : '[视频]'
                } catch { text = '[视频]' }
            }
        } else if (messageType === 'merge_forward') {
            text = addressed
                ? await this.handleMergeForwardMessage(messageId)
                : '[合并转发]'
        } else {
            text = this.extractMessageText(messageType, message.content)
        }

        // Enrich addressed messages with doc content
        if (text && addressed) {
            try {
                text = await enrichTextWithDocContent(text, () => this.getToken())
            } catch (err) {
                console.error('[FeishuAdapter] enrichTextWithDocContent failed:', err)
            }
        }

        // Enrich share_chat with actual group name (addressed only)
        if (messageType === 'share_chat' && text && addressed) {
            try {
                const sharedChatId = (JSON.parse(message.content) as { chat_id?: string }).chat_id
                if (sharedChatId) {
                    const chatName = await this.fetchChatName(sharedChatId)
                    if (chatName) text = `[分享群聊: ${chatName}]\n群ID: ${sharedChatId}`
                }
            } catch {}
        }

        // Enrich share_user with user name (addressed only)
        if (messageType === 'share_user' && text && addressed) {
            try {
                const sharedUserId = (JSON.parse(message.content) as { user_id?: string }).user_id
                if (sharedUserId) {
                    const { name } = await this.resolveSenderInfo(sharedUserId)
                    if (name) text = `[分享用户: ${name}]\n用户ID: ${sharedUserId}`
                }
            } catch {}
        }

        // Include context when user replies to a specific message (addressed only)
        const parentId = message.parent_id as string | undefined
        if (parentId && addressed && text) {
            const parentText = await this.fetchParentMessage(parentId)
            if (parentText) {
                const isLong = parentText.length > 300
                const preview = isLong
                    ? parentText.slice(0, 300) + `…（原文共 ${parentText.length} 字）`
                    : parentText
                text = `[引用消息]\n${preview}\n---\n${text}`
            }
        }

        // For addressed non-text/audio messages, append an action guide
        const noGuideTypes = new Set(['text', 'audio'])
        if (addressed && text && !noGuideTypes.has(messageType)) {
            text = `${text}\n\n请根据以上内容，理解用户意图并推进。`
        }

        // Resolve sender info
        const { name: senderName, email: senderEmail } = await this.resolveSenderInfo(senderOpenId)

        // Persist message to DB
        const contentForDb = text?.trim() || `[${messageType}]`
        this.store.saveFeishuChatMessage({
            chatId, messageId, senderOpenId, senderName, messageType, content: contentForDb,
        }).catch(err => console.error(`[FeishuAdapter] Failed to persist message:`, err))

        if (!text || !text.trim()) {
            if (addressed) {
                console.log(`[FeishuAdapter] Unhandled message type "${messageType}" from ${senderOpenId.slice(0, 8)} in ${chatId.slice(0, 12)}`)
            }
            return
        }

        // Group chat: resolve mention placeholders
        if (chatType === 'group' && message.mentions) {
            for (const mention of message.mentions as Array<{ key: string; name?: string; id: { open_id: string } }>) {
                if (mention.id?.open_id === this.botOpenId) {
                    text = text.replace(mention.key, '').trim()
                } else if (mention.name) {
                    text = text.replace(mention.key, `@${mention.name}`)
                }
            }
        }

        const mode = addressed ? '指令' : '旁听'
        console.log(`[FeishuAdapter] [${mode}] Message from ${senderName} in ${chatType} ${chatId.slice(0, 12)}...: ${text.slice(0, 100)}`)

        // React with emoji for addressed messages
        if (addressed && messageId) {
            this.addReaction(messageId, 'OnIt').catch(() => {})
        }

        // Notify bridge
        this.bridge.onMessage(chatId, chatType, {
            text,
            messageId,
            senderName,
            senderId: senderOpenId,
            senderEmail,
            chatType,
            addressed,
        })
    }

    // ========== Reaction & card action events ==========

    private handleReactionEvent(data: any): void {
        if (!this.bridge?.onReaction) return
        try {
            const messageId = data.message_id as string
            const emojiType = data.reaction_type?.emoji_type as string
            const userId = data.user_id?.open_id as string
            // Resolve chat_id from message — Feishu reaction events include message_id but may not include chat_id
            // We pass the messageId and let the Bridge decide how to route it
            if (messageId && emojiType && userId) {
                const chatId = data.chat_id as string || ''
                console.log(`[FeishuAdapter] Reaction ${emojiType} on ${messageId.slice(0, 12)} by ${userId.slice(0, 8)}`)
                this.bridge.onReaction(chatId, messageId, emojiType, userId)
            }
        } catch (err) {
            console.error('[FeishuAdapter] handleReactionEvent error:', err)
        }
    }

    private handleCardActionEvent(data: any): void {
        if (!this.bridge?.onCardAction) return
        try {
            const action = data.action
            const tag = action?.tag as string || ''
            const value = action?.value
            const userId = data.operator?.open_id as string || ''
            const chatId = data.open_chat_id as string || ''
            if (tag && chatId) {
                // Dedup: ignore rapid double-clicks within 2s window
                const valueStr = value != null ? (typeof value === 'string' ? value : JSON.stringify(value)) : ''
                const dedupeKey = `${chatId}:${tag}:${valueStr}`
                const now = Date.now()
                const lastAt = this.recentCardActions.get(dedupeKey)
                if (lastAt !== undefined && now - lastAt < FeishuAdapter.CARD_ACTION_DEDUP_MS) {
                    console.log(`[FeishuAdapter] Duplicate card action "${tag}" (${now - lastAt}ms ago), ignoring`)
                    return
                }
                this.recentCardActions.set(dedupeKey, now)
                // Purge stale entries
                if (this.recentCardActions.size > 100) {
                    for (const [k, ts] of this.recentCardActions) {
                        if (now - ts > 30_000) this.recentCardActions.delete(k)
                    }
                }

                console.log(`[FeishuAdapter] Card action "${tag}" in ${chatId.slice(0, 12)} by ${userId.slice(0, 8)}`)
                this.bridge.onCardAction(chatId, tag, value, userId)
            }
        } catch (err) {
            console.error('[FeishuAdapter] handleCardActionEvent error:', err)
        }
    }

    // ========== Message text extraction ==========

    private extractMessageText(messageType: string, contentStr: string): string | null {
        try {
            const content = JSON.parse(contentStr)
            switch (messageType) {
                case 'text':
                    return content.text as string || null

                case 'post': {
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
                            switch (el.tag) {
                                case 'text':
                                    if (el.text) lineTexts.push(el.text)
                                    break
                                case 'a':
                                    if (el.text) lineTexts.push(`[${el.text}](${el.href || ''})`)
                                    break
                                case 'at':
                                    if (el.user_name) lineTexts.push(`@${el.user_name}`)
                                    else if (el.user_id) lineTexts.push(`@${el.user_id}`)
                                    break
                                case 'img':
                                    if (el.image_key) lineTexts.push(`[图片: ${el.image_key}]`)
                                    break
                                case 'media':
                                    if (el.file_key) lineTexts.push(`[视频: ${el.file_key}]`)
                                    break
                                case 'code':
                                    if (el.text) lineTexts.push(`\`${el.text}\``)
                                    break
                                case 'code_block':
                                    if (el.text) lineTexts.push(`\`\`\`${el.language || ''}\n${el.text}\n\`\`\``)
                                    break
                                case 'emotion':
                                case 'emoticon':
                                    lineTexts.push(`[${el.emoji_type || el.emoticon_type || '表情'}]`)
                                    break
                                case 'hr':
                                    lineTexts.push('---')
                                    break
                            }
                        }
                        if (lineTexts.length > 0) parts.push(lineTexts.join(''))
                    }
                    return parts.join('\n') || null
                }

                case 'interactive':
                    return this.extractCardText(content)

                case 'sticker': {
                    const stickerKey = content.file_key as string || content.sticker_id as string || ''
                    return stickerKey ? `[表情包: ${stickerKey}]` : '[表情包]'
                }

                case 'location': {
                    const name = content.name as string || ''
                    const addr = content.address as string || ''
                    const lat = content.latitude as string || ''
                    const lng = content.longitude as string || ''
                    const locParts = [name, addr].filter(Boolean).join(', ')
                    const coords = lat && lng ? ` (${lat}, ${lng})` : ''
                    return `[位置] ${locParts}${coords}` || '[位置]'
                }

                case 'share_chat':
                    return `[分享群聊: ${content.chat_id || ''}]`

                case 'share_user':
                    return `[分享用户: ${content.user_id || ''}]`

                case 'merge_forward':
                    return null

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

                case 'vote': {
                    const question = content.question as string || content.topic as string || ''
                    const options = content.options as Array<{ text?: string; option?: string; content?: string } | string> | undefined
                    if (!question && !options?.length) return '[投票]'
                    const parts = ['[投票]']
                    if (question) parts.push(question)
                    if (Array.isArray(options)) {
                        for (const [i, opt] of options.entries()) {
                            const optText = typeof opt === 'string'
                                ? opt
                                : (opt.text || opt.option || opt.content || '')
                            if (optText) parts.push(`${i + 1}. ${optText}`)
                        }
                    }
                    return parts.join('\n')
                }

                case 'system': {
                    const sysType = content.type as string || ''
                    const sysText = content.text as string || ''
                    const operatorName = content.operator?.name as string || content.user?.name as string || ''
                    switch (sysType) {
                        case 'group_member_add':
                            return operatorName ? `[${operatorName} 加入群聊]` : '[有成员加入群聊]'
                        case 'group_member_delete':
                        case 'group_member_remove':
                            return operatorName ? `[${operatorName} 离开群聊]` : '[有成员离开群聊]'
                        case 'group_create':
                            return '[群聊已创建]'
                        case 'group_update':
                        case 'group_name_update':
                            return '[群信息已更新]'
                        case 'group_owner_transfer':
                            return operatorName ? `[群主已转让给 ${operatorName}]` : '[群主已转让]'
                        default:
                            return sysText ? `[系统消息] ${sysText}` : `[系统消息: ${sysType}]`
                    }
                }

                default:
                    return null
            }
        } catch {
            return contentStr
        }
    }

    private extractCardText(card: any): string | null {
        const parts: string[] = []

        // Header title — card v2 format: card.header.title.content
        //                card v1 format: card.header.title (string) or card.title
        const header = card.header
        if (header) {
            const titleContent = header.title?.content ?? header.title
            if (typeof titleContent === 'string' && titleContent) {
                parts.push(`**${titleContent}**`)
            }
        } else if (typeof card.title === 'string' && card.title) {
            parts.push(`**${card.title}**`)
        }

        const extractElement = (el: any): string | null => {
            if (!el || typeof el !== 'object') return null
            const tag = el.tag as string

            switch (tag) {
                case 'div': {
                    const subParts: string[] = []
                    if (el.text) {
                        const c = typeof el.text === 'string' ? el.text : el.text.content
                        if (typeof c === 'string' && c) subParts.push(c)
                    }
                    if (Array.isArray(el.fields)) {
                        for (const f of el.fields) {
                            const c = typeof f.text === 'string' ? f.text : f.text?.content
                            if (typeof c === 'string' && c) subParts.push(c)
                        }
                    }
                    return subParts.join(' | ') || null
                }

                case 'markdown':
                    return typeof el.content === 'string' ? el.content : null

                case 'note': {
                    if (!Array.isArray(el.elements)) return null
                    const noteParts = el.elements
                        .map((e: any) => e.content ?? (typeof e === 'string' ? e : null))
                        .filter(Boolean)
                    return noteParts.length > 0 ? `[注] ${noteParts.join(' ')}` : null
                }

                case 'img': {
                    const alt = el.alt?.content ?? el.alt ?? ''
                    return typeof alt === 'string' && alt ? alt : '[图片]'
                }

                case 'column_set': {
                    if (!Array.isArray(el.columns)) return null
                    const colParts: string[] = []
                    for (const col of el.columns) {
                        if (!Array.isArray(col.elements)) continue
                        for (const colEl of col.elements) {
                            const text = extractElement(colEl)
                            if (text) colParts.push(text)
                        }
                    }
                    return colParts.join(' | ') || null
                }

                case 'panel':
                case 'form': {
                    if (!Array.isArray(el.elements)) return null
                    const inner = el.elements.map(extractElement).filter(Boolean).join('\n')
                    return inner || null
                }

                case 'action': {
                    if (!Array.isArray(el.actions)) return null
                    const actionParts: string[] = []
                    for (const a of el.actions) {
                        const label = a.text?.content ?? a.text ?? a.content
                        if (typeof label === 'string' && label) actionParts.push(`[${label}]`)
                    }
                    return actionParts.length > 0 ? `操作: ${actionParts.join(' ')}` : null
                }

                case 'hr':
                    return null

                default: {
                    // Fallback: try common text fields
                    const c = el.content ?? (typeof el.text === 'string' ? el.text : el.text?.content)
                    return typeof c === 'string' ? c : null
                }
            }
        }

        if (Array.isArray(card.elements)) {
            for (const el of card.elements) {
                if (Array.isArray(el)) {
                    // Old-style: element is an array of inline tags (matches post paragraph format)
                    const rowTexts: string[] = []
                    for (const item of el) {
                        if (!item || item.tag === 'button') continue
                        if (item.text) rowTexts.push(item.text)
                        else if (item.content) rowTexts.push(item.content)
                    }
                    if (rowTexts.length > 0) parts.push(rowTexts.join(''))
                } else {
                    const text = extractElement(el)
                    if (text) parts.push(text)
                }
            }
        }

        return parts.length > 0 ? parts.join('\n') : '[用户发送了一条卡片消息]'
    }

    // ========== Media handling ==========

    private async handleImageMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const imageKey = content.image_key as string
            if (!imageKey) {
                console.error('[FeishuAdapter] Image message missing image_key')
                return null
            }

            const sessionId = this.bridge?.getSessionIdForChat(chatId)

            const token = await this.getToken()
            const imgCtrl = new AbortController()
            const imgTimeout = setTimeout(() => imgCtrl.abort(), 30_000)
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: imgCtrl.signal,
            }).finally(() => clearTimeout(imgTimeout))
            if (!resp.ok) {
                console.error(`[FeishuAdapter] Failed to download image: ${resp.status} ${resp.statusText}`)
                return null
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const contentType = resp.headers.get('content-type') || 'image/png'
            const extMap: Record<string, string> = {
                'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
                'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
            }
            const ext = extMap[contentType] || 'png'
            const filename = `feishu-${imageKey.slice(0, 16)}.${ext}`

            const uploadSessionId = sessionId || 'feishu-images'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })
            writeFileSync(join(uploadDir, filename), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${filename}`
            console.log(`[FeishuAdapter] Downloaded image: ${serverPath} (${buffer.length} bytes, ${contentType})`)
            return `[Image: ${serverPath}]`
        } catch (err) {
            console.error('[FeishuAdapter] handleImageMessage failed:', err)
            return null
        }
    }

    private async handleFileMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            const fileName = content.file_name as string
            if (!fileKey) {
                console.error('[FeishuAdapter] File message missing file_key')
                return null
            }

            const sessionId = this.bridge?.getSessionIdForChat(chatId)
            const token = await this.getToken()
            const fileCtrl = new AbortController()
            const fileTimeout = setTimeout(() => fileCtrl.abort(), 30_000)
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: fileCtrl.signal,
            }).finally(() => clearTimeout(fileTimeout))
            if (!resp.ok) {
                console.error(`[FeishuAdapter] Failed to download file: ${resp.status} ${resp.statusText}`)
                return `[文件下载失败（${resp.status}）：${fileName || fileKey.slice(0, 16)}，请重新分享或检查权限]`
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const safeName = fileName || `feishu-${fileKey.slice(0, 16)}`
            const uploadSessionId = sessionId || 'feishu-files'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })
            writeFileSync(join(uploadDir, safeName), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${safeName}`
            console.log(`[FeishuAdapter] Downloaded file: ${serverPath} (${buffer.length} bytes)`)

            // Try to extract readable content from the file
            try {
                const extracted = await extractFileContent(safeName, buffer)
                if (extracted) {
                    console.log(`[FeishuAdapter] Extracted content from ${safeName} (${extracted.length} chars)`)
                    return extracted
                }
            } catch (err) {
                console.warn(`[FeishuAdapter] Content extraction failed for ${safeName}:`, err)
            }

            return `[文件: ${safeName}（内容提取失败，文件路径：${serverPath}）]`
        } catch (err) {
            console.error('[FeishuAdapter] handleFileMessage failed:', err)
            return null
        }
    }

    private async handleAudioMessage(messageId: string, contentStr: string): Promise<string | null> {
        let opusPath = ''
        let pcmPath = ''
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            if (!fileKey) {
                console.error('[FeishuAdapter] Audio message missing file_key')
                return null
            }

            const token = await this.getToken()
            const audioCtrl = new AbortController()
            const audioTimeout = setTimeout(() => audioCtrl.abort(), 30_000)
            const downloadResp = await fetch(
                `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
                { headers: { Authorization: `Bearer ${token}` }, signal: audioCtrl.signal }
            ).finally(() => clearTimeout(audioTimeout))
            if (!downloadResp.ok) {
                console.error(`[FeishuAdapter] Failed to download audio: ${downloadResp.status} ${downloadResp.statusText}`)
                return `[语音下载失败，请重新发送]`
            }

            const arrayBuffer = await downloadResp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)
            console.log(`[FeishuAdapter] Downloaded audio: ${buffer.length} bytes`)

            const ts = Date.now()
            opusPath = join(tmpdir(), `feishu-audio-${ts}.opus`)
            pcmPath = join(tmpdir(), `feishu-audio-${ts}.pcm`)
            writeFileSync(opusPath, buffer)
            execSync(`ffmpeg -y -i "${opusPath}" -ar 16000 -ac 1 -f s16le "${pcmPath}"`, { timeout: 10000 })
            const pcmBuffer = readFileSync(pcmPath)
            const pcmBase64 = pcmBuffer.toString('base64')
            console.log(`[FeishuAdapter] Converted to PCM: ${pcmBuffer.length} bytes`)

            const fileId = `feishu${ts.toString().slice(-10)}`
            const asrCtrl = new AbortController()
            const asrTimeout = setTimeout(() => asrCtrl.abort(), 30_000)
            const asrResp = await fetch('https://open.feishu.cn/open-apis/speech_to_text/v1/speech/file_recognize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                signal: asrCtrl.signal,
                body: JSON.stringify({
                    speech: { speech: pcmBase64 },
                    config: {
                        file_id: fileId,
                        format: 'pcm',
                        engine_type: '16k_auto',
                    },
                }),
            }).finally(() => clearTimeout(asrTimeout))

            const asrData = await asrResp.json() as {
                code?: number
                msg?: string
                data?: { recognition_text?: string }
            }

            if (asrData.code !== 0) {
                console.error(`[FeishuAdapter] ASR failed: code=${asrData.code} msg=${asrData.msg}`)
                return `[语音] （识别失败，请重新发送）`
            }

            const recognitionText = asrData.data?.recognition_text?.trim()
            if (!recognitionText) {
                console.log('[FeishuAdapter] ASR returned empty text')
                return `[语音] （音频过短或不清晰，无法识别）`
            }

            console.log(`[FeishuAdapter] ASR result: ${recognitionText.slice(0, 100)}`)
            return `[语音] ${recognitionText}`
        } catch (err) {
            console.error('[FeishuAdapter] handleAudioMessage failed:', err)
            return null
        } finally {
            try { if (opusPath) unlinkSync(opusPath) } catch {}
            try { if (pcmPath) unlinkSync(pcmPath) } catch {}
        }
    }

    private async handleMediaMessage(messageId: string, contentStr: string, chatId: string): Promise<string | null> {
        try {
            const content = JSON.parse(contentStr)
            const fileKey = content.file_key as string
            const fileName = content.file_name as string || `video-${Date.now()}.mp4`
            if (!fileKey) {
                console.error('[FeishuAdapter] Media message missing file_key')
                return null
            }

            const sessionId = this.bridge?.getSessionIdForChat(chatId)
            const token = await this.getToken()
            const mediaCtrl = new AbortController()
            const mediaTimeout = setTimeout(() => mediaCtrl.abort(), 30_000)
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: mediaCtrl.signal,
            }).finally(() => clearTimeout(mediaTimeout))
            if (!resp.ok) {
                console.error(`[FeishuAdapter] Failed to download media: ${resp.status} ${resp.statusText}`)
                return null
            }

            const arrayBuffer = await resp.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const safeName = fileName || `feishu-video-${fileKey.slice(0, 16)}.mp4`
            const uploadSessionId = sessionId || 'feishu-media'
            const config = getConfiguration()
            const uploadDir = join(config.dataDir, 'uploads', uploadSessionId)
            if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })
            writeFileSync(join(uploadDir, safeName), buffer)

            const serverPath = `server-uploads/${uploadSessionId}/${safeName}`
            console.log(`[FeishuAdapter] Downloaded media: ${serverPath} (${buffer.length} bytes)`)
            return `[视频: ${serverPath}]`
        } catch (err) {
            console.error('[FeishuAdapter] handleMediaMessage failed:', err)
            return null
        }
    }

    private async handleMergeForwardMessage(messageId: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuAdapter] Failed to fetch merge_forward: ${resp.status}`)
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
            if (!items || items.length === 0) return '[合并转发]'

            const subMessages = items.filter(item => item.upper_message_id)
            if (subMessages.length === 0) return '[合并转发]'

            const parts: string[] = []
            for (const msg of subMessages.slice(0, 20)) {
                const type = msg.msg_type || 'text'
                const contentStr = msg.body?.content || '{}'
                const msgText = this.extractMessageText(type, contentStr)
                if (msgText) {
                    const senderId = msg.sender_id || ''
                    let senderDisplay = ''
                    if (senderId) {
                        try {
                            const info = await this.resolveSenderInfo(senderId)
                            senderDisplay = info.name || senderId.slice(0, 8)
                        } catch {
                            senderDisplay = senderId.slice(0, 8)
                        }
                    }
                    parts.push(senderDisplay ? `${senderDisplay}: ${msgText}` : msgText)
                }
            }

            const total = subMessages.length
            const shown = parts.length
            const header = total > 20
                ? `[合并转发：共 ${total} 条，显示前 ${shown} 条]`
                : `[合并转发：共 ${total} 条]`
            console.log(`[FeishuAdapter] merge_forward: ${total} sub-messages, ${shown} with content`)
            return parts.length > 0 ? `${header}\n${parts.join('\n')}` : '[合并转发]'
        } catch (err) {
            console.error('[FeishuAdapter] handleMergeForwardMessage failed:', err)
            return '[合并转发]'
        }
    }

    // ========== Feishu sending helpers ==========

    /**
     * Split text at paragraph (or line) boundaries so each chunk stays under maxLen.
     *
     * Smart splitting rules:
     *   1. Never split inside a fenced code block (``` ... ```)
     *   2. Prefer splitting at double-newlines (paragraph breaks)
     *   3. Fall back to single newlines, but only between top-level lines
     *   4. Last resort: hard-cut at maxLen (only if a single block exceeds limit)
     *
     * A code block that exceeds maxLen on its own is kept whole in a dedicated chunk
     * (Feishu will scroll it), unless it's truly enormous (>2× maxLen) in which case
     * it gets a hard split at a newline inside the block.
     */
    private splitTextIntoChunks(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text]

        // Split text into segments: alternating prose and fenced code blocks.
        // Each segment is an atomic unit that we try not to break.
        const segments: string[] = []
        const codeBlockRe = /^```[^\n]*\n[\s\S]*?^```\s*$/gm
        let lastEnd = 0
        let match: RegExpExecArray | null
        while ((match = codeBlockRe.exec(text)) !== null) {
            if (match.index > lastEnd) {
                segments.push(text.slice(lastEnd, match.index))
            }
            segments.push(match[0])
            lastEnd = match.index + match[0].length
        }
        if (lastEnd < text.length) {
            segments.push(text.slice(lastEnd))
        }

        const chunks: string[] = []
        let current = ''

        for (const segment of segments) {
            // Would adding this segment overflow?
            if (current.length + segment.length <= maxLen) {
                current += segment
                continue
            }

            // If current buffer is non-trivial, flush it first
            if (current.trim()) {
                // current itself might be over maxLen (accumulated prose) — sub-split it
                this.splitProseIntoChunks(current, maxLen, chunks)
                current = ''
            }

            // Now handle the segment itself
            if (segment.length <= maxLen) {
                current = segment
            } else {
                // Oversized segment — if it's a code block, try to split at internal newlines
                this.splitOversizedSegment(segment, maxLen, chunks)
            }
        }

        if (current.trim()) {
            this.splitProseIntoChunks(current, maxLen, chunks)
        }

        const filtered = chunks.filter(c => c.length > 0)
        return this.mergeSmallChunks(filtered, maxLen)
    }

    /**
     * Merge adjacent small chunks to avoid sending many tiny messages.
     * A chunk under 25% of maxLen is considered "small" and gets merged with
     * its neighbor if the combined size fits.
     */
    private mergeSmallChunks(chunks: string[], maxLen: number): string[] {
        if (chunks.length <= 1) return chunks
        const smallThreshold = maxLen * 0.25
        const merged: string[] = [chunks[0]]
        for (let i = 1; i < chunks.length; i++) {
            const prev = merged[merged.length - 1]
            const cur = chunks[i]
            if ((cur.length < smallThreshold || prev.length < smallThreshold)
                && prev.length + cur.length + 2 <= maxLen) {
                merged[merged.length - 1] = prev + '\n\n' + cur
            } else {
                merged.push(cur)
            }
        }
        return merged
    }

    /** Split prose (non-code-block text) at paragraph/line boundaries. */
    private splitProseIntoChunks(text: string, maxLen: number, out: string[]): void {
        let remaining = text
        while (remaining.length > maxLen) {
            // Prefer double-newline (paragraph break)
            let splitAt = remaining.lastIndexOf('\n\n', maxLen)
            // Fall back to single newline, but only if reasonably deep into the chunk
            if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('\n', maxLen)
            // Last resort: hard-cut
            if (splitAt < maxLen * 0.3) splitAt = maxLen
            out.push(remaining.slice(0, splitAt).trim())
            remaining = remaining.slice(splitAt).trim()
        }
        if (remaining.trim()) out.push(remaining.trim())
    }

    /** Split an oversized segment (usually a huge code block) trying to keep it readable. */
    private splitOversizedSegment(segment: string, maxLen: number, out: string[]): void {
        const isCodeBlock = segment.trimStart().startsWith('```')
        if (!isCodeBlock) {
            // Plain prose — normal prose splitting
            this.splitProseIntoChunks(segment, maxLen, out)
            return
        }
        // Code block — split at internal newlines, wrapping each piece in fences
        const lines = segment.split('\n')
        // First line is the opening fence (e.g. ```typescript), last is closing ```
        const openFence = lines[0]
        const closeFence = lines[lines.length - 1].trim() === '```' ? '```' : ''
        const innerLines = closeFence ? lines.slice(1, -1) : lines.slice(1)

        let buf = openFence + '\n'
        for (const line of innerLines) {
            if (buf.length + line.length + 1 + 4 > maxLen) { // +4 for closing ```\n
                // Close this chunk and start a new one
                out.push((buf + '```').trim())
                buf = openFence + '\n'
            }
            buf += line + '\n'
        }
        // Final piece
        buf += closeFence || '```'
        if (buf.trim() !== openFence + '\n```') {
            out.push(buf.trim())
        }
    }

    /**
     * Send text as Feishu post message, automatically splitting into multiple messages
     * if the text exceeds CHUNK_LIMIT characters. First chunk uses replyTo + @mentions;
     * subsequent chunks are sent as standalone messages in the same chat.
     */
    private async sendExtra(chatId: string, extra: IMReplyExtra): Promise<void> {
        switch (extra.type) {
            case 'sticker':
                console.log(`[FeishuAdapter] Sending sticker ${extra.stickerId} to ${chatId.slice(0, 12)}`)
                await this.sendFeishuMessage(chatId, 'sticker', JSON.stringify({ file_key: extra.stickerId }))
                break
            case 'share_chat':
                console.log(`[FeishuAdapter] Sending share_chat ${extra.chatId.slice(0, 12)} to ${chatId.slice(0, 12)}`)
                await this.sendFeishuMessage(chatId, 'share_chat', JSON.stringify({ chat_id: extra.chatId }))
                break
            case 'share_user':
                console.log(`[FeishuAdapter] Sending share_user ${extra.userId.slice(0, 12)} to ${chatId.slice(0, 12)}`)
                await this.sendFeishuMessage(chatId, 'share_user', JSON.stringify({ user_id: extra.userId }))
                break
            case 'image_url': {
                console.log(`[FeishuAdapter] Downloading image from URL for ${chatId.slice(0, 12)}`)
                const imageKey = await this.downloadAndUploadImage(extra.url)
                if (imageKey) {
                    await this.sendFeishuMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }))
                } else {
                    await this.sendText(chatId, `[图片下载/上传失败]`)
                }
                break
            }
        }
    }

    /**
     * Resolve markdown image URLs in text: download remote images, upload to Feishu,
     * and replace URLs with image_keys for inline display. Failed uploads become links.
     * Inspired by larksuite/cli resolveMarkdownImageURLs().
     */
    private async resolveMarkdownImages(text: string): Promise<string> {
        const IMAGE_URL_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g
        const matches: Array<{ full: string; alt: string; url: string }> = []
        let m: RegExpExecArray | null
        while ((m = IMAGE_URL_RE.exec(text)) !== null) {
            matches.push({ full: m[0], alt: m[1], url: m[2] })
        }
        if (matches.length === 0) return text

        // Upload in parallel with dedup — same URL reuses cached key
        const results = await Promise.all(
            matches.map(async ({ full, alt, url }) => {
                // Check dedup cache first
                const cached = this.imageKeyCache.get(url)
                if (cached) {
                    return { full, replacement: `![${alt}](${cached})` }
                }
                const imageKey = await this.downloadAndUploadImage(url)
                if (imageKey) {
                    this.imageKeyCache.set(url, imageKey)
                    return { full, replacement: `![${alt}](${imageKey})` }
                }
                // Upload failed — degrade to clickable link
                return { full, replacement: `[${alt || '图片'}](${url})` }
            })
        )

        // Evict old cache entries (keep last 100)
        if (this.imageKeyCache.size > 100) {
            const keys = [...this.imageKeyCache.keys()]
            for (let i = 0; i < keys.length - 100; i++) {
                this.imageKeyCache.delete(keys[i])
            }
        }

        let resolved = text
        for (const { full, replacement } of results) {
            resolved = resolved.replace(full, replacement)
        }
        return resolved
    }

    private async downloadAndUploadImage(url: string): Promise<string | null> {
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 30_000)
            const resp = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout))
            if (!resp.ok) {
                console.warn(`[FeishuAdapter] Image download failed: ${resp.status} ${url}`)
                return null
            }
            const buffer = Buffer.from(await resp.arrayBuffer())
            const contentType = resp.headers.get('content-type') || 'image/png'
            const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
                : contentType.includes('gif') ? '.gif'
                : contentType.includes('webp') ? '.webp'
                : contentType.includes('bmp') ? '.bmp'
                : '.png'

            const token = await this.getToken()
            const formData = new FormData()
            formData.append('image_type', 'message')
            formData.append('image', new Blob([buffer]), `image${ext}`)

            const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            })
            const data = await uploadResp.json() as { data?: { image_key?: string } }
            return data?.data?.image_key ?? null
        } catch (err) {
            console.error(`[FeishuAdapter] downloadAndUploadImage failed:`, err)
            return null
        }
    }

    /**
     * Send a streaming card to a chat and return the message ID.
     * Used by BrainBridge for streaming partial-content updates.
     * Always sends as an interactive card so subsequent edits via PATCH /im/v1/messages work.
     */
    async sendPostAndGetId(chatId: string, text: string): Promise<string | null> {
        const { buildStreamingCard } = await import('./formatter')
        const { msgType, content } = buildStreamingCard(text)
        return this.sendFeishuMessage(chatId, msgType, content)
    }

    private async sendPost(chatId: string, text: string, replyToMessageId?: string, atIds?: string[]): Promise<void> {
        // Resolve markdown image URLs → upload to Feishu and replace with image_keys for inline display
        const resolvedText = await this.resolveMarkdownImages(text)

        // Try building the message first — cards handle their own content splitting
        const probe = buildFeishuMessage(resolvedText, atIds)
        if (probe.msgType === 'text') {
            // Plain text — send as single message
            await this.sendFeishuMessage(chatId, probe.msgType, probe.content, replyToMessageId)
            return
        }
        if (probe.msgType === 'interactive') {
            // Card — send and fall back to post/text if it fails (e.g. invalid card JSON)
            const msgId = await this.sendFeishuMessage(chatId, probe.msgType, probe.content, replyToMessageId)
            if (msgId) return
            // Card send failed — fall through to post format below
            console.warn(`[FeishuAdapter] Card send failed for ${chatId.slice(0, 12)}, falling back to post format`)
        }

        // Post format — chunk if needed
        const CHUNK_LIMIT = 4000
        const chunks = this.splitTextIntoChunks(resolvedText, CHUNK_LIMIT)

        for (let ci = 0; ci < chunks.length; ci++) {
            const isFirst = ci === 0
            const label = chunks.length > 1 ? `（${ci + 1}/${chunks.length}）\n` : ''
            const chunkText = label + chunks[ci]
            const { msgType, content } = buildFeishuMessage(chunkText, isFirst ? atIds : undefined)
            await this.sendFeishuMessage(chatId, msgType, content, isFirst ? replyToMessageId : undefined)
        }
    }

    private async sendFeishuMessage(chatId: string, msgType: string, content: string, replyToMessageId?: string): Promise<string | null> {
        const url = replyToMessageId
            ? `https://open.feishu.cn/open-apis/im/v1/messages/${replyToMessageId}/reply`
            : FeishuAdapter.SEND_URL
        const body = replyToMessageId
            ? { msg_type: msgType, content }
            : { receive_id: chatId, msg_type: msgType, content }

        const result = await this.callFeishuApi(url, 'POST', body)
        if (!result || result.code !== 0) {
            console.error(`[FeishuAdapter] sendFeishuMessage API error for ${chatId.slice(0, 12)}: code=${result?.code}, msg=${result?.msg}`)
            return null
        }
        const messageId = result.data?.message_id as string | undefined ?? null
        if (messageId) this.lastBotMessageIdPerChat.set(chatId, messageId)
        return messageId
    }

    // ========== Circuit breaker ==========

    private circuitFailures = 0
    private circuitOpenUntil = 0
    private static readonly CIRCUIT_THRESHOLD = 5     // consecutive failures to open circuit
    private static readonly CIRCUIT_COOLDOWN = 30_000 // ms to wait before retrying after circuit opens

    private isCircuitOpen(): boolean {
        if (this.circuitFailures < FeishuAdapter.CIRCUIT_THRESHOLD) return false
        if (Date.now() > this.circuitOpenUntil) {
            // Half-open: allow one attempt
            this.circuitFailures = FeishuAdapter.CIRCUIT_THRESHOLD - 1
            return false
        }
        return true
    }

    private recordSuccess(): void {
        this.circuitFailures = 0
    }

    private recordFailure(): void {
        this.circuitFailures++
        if (this.circuitFailures >= FeishuAdapter.CIRCUIT_THRESHOLD) {
            this.circuitOpenUntil = Date.now() + FeishuAdapter.CIRCUIT_COOLDOWN
            console.error(`[FeishuAdapter] Circuit breaker OPEN — ${this.circuitFailures} consecutive failures, pausing for ${FeishuAdapter.CIRCUIT_COOLDOWN / 1000}s`)
        }
    }

    /**
     * Central Feishu API caller with:
     *  - 401 token refresh retry
     *  - 429 exponential backoff with jitter
     *  - Circuit breaker (opens after 5 consecutive failures, cools down 30s)
     */
    private async callFeishuApi(url: string, method: string, body?: unknown, maxRetries = 2): Promise<Record<string, any> | null> {
        if (this.isCircuitOpen()) {
            console.warn(`[FeishuAdapter] Circuit breaker open, skipping API call to ${url}`)
            return null
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const token = await this.getToken()
                const resp = await fetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                })

                // 401 — token expired, clear cache and retry
                if (resp.status === 401 && attempt < maxRetries) {
                    console.warn(`[FeishuAdapter] 401 on ${url}, refreshing token (attempt ${attempt + 1})`)
                    this.tokenCache = null
                    continue
                }

                // 429 — rate limited, exponential backoff with jitter
                if (resp.status === 429 && attempt < maxRetries) {
                    const retryAfter = parseInt(resp.headers.get('retry-after') || '', 10)
                    const baseDelay = retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt)
                    const jitter = Math.random() * 1000
                    const delay = baseDelay + jitter
                    console.warn(`[FeishuAdapter] 429 rate limited on ${url}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`)
                    await new Promise(r => setTimeout(r, delay))
                    continue
                }

                const result = await resp.json() as Record<string, any>
                this.recordSuccess()
                return result
            } catch (err) {
                if (attempt < maxRetries) {
                    const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500
                    console.warn(`[FeishuAdapter] API call failed (attempt ${attempt + 1}), retrying in ${Math.round(delay)}ms:`, (err as Error).message)
                    await new Promise(r => setTimeout(r, delay))
                    continue
                }
                console.error(`[FeishuAdapter] API call failed after ${maxRetries + 1} attempts:`, err)
                this.recordFailure()
                return null
            }
        }
        this.recordFailure()
        return null
    }

    /**
     * Fetch the content of a parent message (for reply threading context).
     * Returns extracted plain text or null on failure.
     */
    private async fetchParentMessage(messageId: string): Promise<string | null> {
        try {
            const token = await this.getToken()
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) return null
            const result = await resp.json() as {
                data?: {
                    items?: Array<{ msg_type?: string; body?: { content?: string } }>
                }
            }
            const item = result.data?.items?.[0]
            if (!item?.body?.content) return null
            return this.extractMessageText(item.msg_type || 'text', item.body.content)
        } catch {
            return null
        }
    }

    // ========== File helpers ==========

    private classifyFile(filePath: string): 'image' | 'video' | 'audio' | 'file' {
        const ext = extname(filePath).toLowerCase().slice(1)
        if (FeishuAdapter.IMAGE_EXTS.has(ext)) return 'image'
        if (FeishuAdapter.VIDEO_EXTS.has(ext)) return 'video'
        if (FeishuAdapter.AUDIO_EXTS.has(ext)) return 'audio'
        return 'file'
    }

    private getFeishuFileType(filePath: string): string {
        const ext = extname(filePath).toLowerCase().slice(1)
        return FeishuAdapter.FILE_TYPE_MAP[ext] || 'stream'
    }

    private static readonly MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

    private resolveFilePath(ref: string): string | null {
        let filePath: string | null = null
        const suIdx = ref.indexOf('server-uploads/')
        if (suIdx >= 0) {
            const config = getConfiguration()
            const relativePath = ref.slice(suIdx + 'server-uploads/'.length)
            filePath = resolve(config.dataDir, 'uploads', relativePath)
            // Path traversal guard: must stay under uploads/
            const uploadsDir = resolve(config.dataDir, 'uploads')
            if (!filePath.startsWith(uploadsDir + '/')) {
                console.warn(`[FeishuAdapter] Path traversal blocked: ${ref} resolved to ${filePath}`)
                return null
            }
        } else if (ref.startsWith('/')) {
            filePath = resolve(ref)
        }

        if (!filePath) return null

        // Block suspicious patterns
        if (filePath.includes('/../') || filePath.includes('/./')) {
            console.warn(`[FeishuAdapter] Suspicious path blocked: ${ref}`)
            return null
        }

        // File size guard
        try {
            const stat = statSync(filePath)
            if (stat.size > FeishuAdapter.MAX_FILE_SIZE) {
                console.warn(`[FeishuAdapter] File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 20MB limit): ${ref}`)
                return null
            }
        } catch {
            // File doesn't exist — let the caller handle existsSync check
        }

        return filePath
    }

    private async uploadImage(filePath: string): Promise<string | null> {
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
                console.log(`[FeishuAdapter] Uploaded image ${fileName} → ${imageKey}`)
            } else {
                console.error(`[FeishuAdapter] Upload image failed for ${fileName}:`, data)
            }
            return imageKey
        } catch (err) {
            console.error(`[FeishuAdapter] uploadImage error:`, err)
            return null
        }
    }

    private async uploadFile(filePath: string, fileType: string): Promise<string | null> {
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
                console.log(`[FeishuAdapter] Uploaded file ${fileName} (${fileType}) → ${fileKey}`)
            } else {
                console.error(`[FeishuAdapter] Upload file failed for ${fileName}:`, data)
            }
            return fileKey
        } catch (err) {
            console.error(`[FeishuAdapter] uploadFile error:`, err)
            return null
        }
    }

    // ========== Token management ==========

    private async getToken(): Promise<string> {
        // Preemptive refresh: if token expires within 5 minutes, refresh early
        if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 5 * 60 * 1000) {
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
