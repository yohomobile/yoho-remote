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
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { IStore } from '../../store/interface'
import type { IMAdapter, IMBridgeCallbacks, IMReply, IMReplyExtra } from '../types'
import { buildFeishuMessage } from './formatter'
import { textToSpeech } from './tts'
import { enrichTextWithDocContent } from './docFetcher'
import { extractFileContent } from './fileExtractor'
import { buildCardJson } from './cardBuilder'
import { buildFeishuBrainInitPrompt, buildFeishuVijnaptiInitPrompt } from '../../web/prompts/initPrompt'
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

            // Short text without markdown → try voice (p2p only)
            const isShortForVoice = chatType === 'p2p'
                && textReply.length <= 200
                && !/```|^\s*[-*+]\s|^\s*\d+\.\s|^\|.+\|/m.test(textReply)
                && (!mediaRefs || mediaRefs.length === 0)

            let sentAsVoice = false
            if (isShortForVoice) {
                console.log(`[FeishuAdapter] Sending voice to ${chatId.slice(0, 12)} (${textReply.length} chars)`)
                sentAsVoice = await this.sendVoice(chatId, textReply, replyToMessageId)
            }

            if (!sentAsVoice) {
                await this.sendPost(chatId, textReply, replyToMessageId, filteredAtIds.length > 0 ? filteredAtIds : undefined)
            } else if (filteredAtIds.length > 0) {
                // Voice sent — deliver @mentions via a lightweight notification message
                await this.sendPost(chatId, '', undefined, filteredAtIds)
            }
        }

        // 2. Send media attachments
        if (mediaRefs) {
            for (const ref of mediaRefs) {
                try {
                    const filePath = this.resolveFilePath(ref)
                    if (!filePath || !existsSync(filePath)) {
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
        const result = await this.callFeishuApi(
            'https://open.feishu.cn/open-apis/ephemeral/v1/send',
            'POST',
            { chat_id: chatId, user_id: userId, msg_type: 'interactive', card: JSON.parse(cardContent) },
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
        const isVijnaptiGroup = chatType === 'group' && chatName?.includes('唯识')
        const options = {
            feishuChatType: chatType as 'p2p' | 'group',
            feishuChatName: chatName,
            ...(chatType === 'p2p' && senderName ? { userName: senderName } : {}),
        }
        return isVijnaptiGroup
            ? await buildFeishuVijnaptiInitPrompt('developer', options)
            : await buildFeishuBrainInitPrompt('developer', options)
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
                const preview = parentText.length > 300 ? parentText.slice(0, 300) + '…' : parentText
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
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
                headers: { Authorization: `Bearer ${token}` }
            })
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
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!resp.ok) {
                console.error(`[FeishuAdapter] Failed to download file: ${resp.status} ${resp.statusText}`)
                return null
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

            return `[File: ${serverPath}]`
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
            const downloadResp = await fetch(
                `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
                { headers: { Authorization: `Bearer ${token}` } }
            )
            if (!downloadResp.ok) {
                console.error(`[FeishuAdapter] Failed to download audio: ${downloadResp.status} ${downloadResp.statusText}`)
                return null
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
                console.error(`[FeishuAdapter] ASR failed: code=${asrData.code} msg=${asrData.msg}`)
                return null
            }

            const recognitionText = asrData.data?.recognition_text?.trim()
            if (!recognitionText) {
                console.log('[FeishuAdapter] ASR returned empty text')
                return null
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
            const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
                headers: { Authorization: `Bearer ${token}` }
            })
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
                const text = this.extractMessageText(type, contentStr)
                if (text) parts.push(text)
            }

            console.log(`[FeishuAdapter] merge_forward: ${subMessages.length} sub-messages extracted`)
            return parts.join('\n') || '[合并转发]'
        } catch (err) {
            console.error('[FeishuAdapter] handleMergeForwardMessage failed:', err)
            return '[合并转发]'
        }
    }

    // ========== Feishu sending helpers ==========

    /**
     * Split text at paragraph (or line) boundaries so each chunk stays under maxLen.
     * Attempts to break at double-newlines first, then single newlines, then hard-cuts.
     */
    private splitTextIntoChunks(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text]
        const chunks: string[] = []
        let remaining = text

        while (remaining.length > maxLen) {
            let splitAt = remaining.lastIndexOf('\n\n', maxLen)
            if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf('\n', maxLen)
            if (splitAt < maxLen * 0.3) splitAt = maxLen
            chunks.push(remaining.slice(0, splitAt).trim())
            remaining = remaining.slice(splitAt).trim()
        }
        if (remaining) chunks.push(remaining)
        return chunks.filter(c => c.length > 0)
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

    private async downloadAndUploadImage(url: string): Promise<string | null> {
        try {
            const resp = await fetch(url)
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

    private async sendPost(chatId: string, text: string, replyToMessageId?: string, atIds?: string[]): Promise<void> {
        // Try building the message first — cards handle their own content splitting
        const probe = buildFeishuMessage(text, atIds)
        if (probe.msgType === 'interactive' || probe.msgType === 'text') {
            // Card or plain text — send as single message
            await this.sendFeishuMessage(chatId, probe.msgType, probe.content, replyToMessageId)
            return
        }

        // Post format — chunk if needed
        const CHUNK_LIMIT = 4000
        const chunks = this.splitTextIntoChunks(text, CHUNK_LIMIT)

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

    /**
     * Central Feishu API caller with 401 token refresh retry and 429 rate limit backoff.
     */
    private async callFeishuApi(url: string, method: string, body?: unknown, maxRetries = 2): Promise<Record<string, any> | null> {
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

                // 429 — rate limited, backoff and retry
                if (resp.status === 429 && attempt < maxRetries) {
                    const retryAfter = parseInt(resp.headers.get('retry-after') || '', 10)
                    const delay = (retryAfter > 0 ? retryAfter : (attempt + 1)) * 1000
                    console.warn(`[FeishuAdapter] 429 rate limited on ${url}, retrying in ${delay}ms`)
                    await new Promise(r => setTimeout(r, delay))
                    continue
                }

                return await resp.json() as Record<string, any>
            } catch (err) {
                if (attempt < maxRetries) {
                    console.warn(`[FeishuAdapter] API call failed (attempt ${attempt + 1}), retrying:`, (err as Error).message)
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
                    continue
                }
                console.error(`[FeishuAdapter] API call failed after ${maxRetries + 1} attempts:`, err)
                return null
            }
        }
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

    private async sendVoice(chatId: string, text: string, replyToMessageId?: string): Promise<boolean> {
        try {
            // Strip inline markdown for TTS
            const ttsText = text
                .replace(/\*\*(.+?)\*\*/g, '$1')
                .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
                .replace(/~~(.+?)~~/g, '$1')
                .replace(/`([^`]+)`/g, '$1')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/^#{1,6}\s+/gm, '')
            const ttsResult = await textToSpeech(ttsText)
            if (!ttsResult) return false

            const token = await this.getToken()
            const form = new FormData()
            form.append('file_type', 'opus')
            form.append('file_name', 'voice.opus')
            form.append('duration', String(ttsResult.durationMs))
            form.append('file', new Blob([ttsResult.opusBuffer], { type: 'audio/opus' }), 'voice.opus')

            const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: form,
            })
            const uploadResult = await uploadResp.json() as any
            if (uploadResult.code !== 0) {
                console.error(`[FeishuAdapter] Voice upload failed: code=${uploadResult.code}, msg=${uploadResult.msg}`)
                return false
            }
            const fileKey = uploadResult.data.file_key

            const content = JSON.stringify({ file_key: fileKey })
            let sendResp: Response
            if (replyToMessageId) {
                sendResp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${replyToMessageId}/reply`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({ msg_type: 'audio', content }),
                })
            } else {
                sendResp = await fetch(FeishuAdapter.SEND_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({ receive_id: chatId, msg_type: 'audio', content }),
                })
            }
            const sendResult = await sendResp.json() as { code?: number; msg?: string }
            if (sendResult.code !== 0) {
                console.error(`[FeishuAdapter] Voice send API error: code=${sendResult.code}, msg=${sendResult.msg}`)
                return false
            }

            console.log(`[FeishuAdapter] Voice sent to ${chatId.slice(0, 12)} (${ttsResult.durationMs}ms audio)`)
            return true
        } catch (err) {
            console.error(`[FeishuAdapter] sendVoice failed:`, err)
            return false
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

    private resolveFilePath(ref: string): string | null {
        const suIdx = ref.indexOf('server-uploads/')
        if (suIdx >= 0) {
            const config = getConfiguration()
            const relativePath = ref.slice(suIdx + 'server-uploads/'.length)
            return join(config.dataDir, 'uploads', relativePath)
        }
        if (ref.startsWith('/')) return ref
        return null
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
