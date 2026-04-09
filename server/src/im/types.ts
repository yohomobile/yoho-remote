/**
 * IM Bridge + Adapter types.
 * Platform-independent interfaces for connecting IM platforms to Brain sessions.
 */

import type { SyncEngine } from '../sync/syncEngine'
import type { IStore } from '../store/interface'

/**
 * Incoming message from an IM platform, normalized to a common format.
 */
export interface IMMessage {
    text: string
    messageId: string
    senderName: string
    senderId: string           // platform-specific user ID (e.g. open_id for Feishu)
    senderEmail: string | null
    chatType: string           // 'p2p' | 'group'
    /** Whether this message explicitly addresses the bot (@bot or DM) */
    addressed: boolean
}

/**
 * Extra content items that Brain can include in a reply.
 * Each item maps to a specific Feishu message type sent as a separate message.
 */
export type IMReplyExtra =
    | { type: 'sticker'; stickerId: string }
    | { type: 'share_chat'; chatId: string }
    | { type: 'share_user'; userId: string }
    | { type: 'image_url'; url: string }

/**
 * Reply payload prepared by the Bridge for the Adapter to send.
 */
export interface IMReply {
    text: string               // cleaned text (tags stripped)
    replyTo?: string           // message ID to reply to (threading)
    atIds?: string[]           // user IDs to @mention in the reply
    mediaRefs?: string[]       // file paths to send as attachments
    chatType?: string          // helps adapter decide voice vs text
    extras?: IMReplyExtra[]    // platform-specific content (stickers, share cards, image URLs)
    cards?: string[]           // Feishu interactive card JSON strings (one message per card)
    reactions?: string[]       // Emoji reactions to add to the triggering user message
}

/**
 * Callbacks the Adapter uses to communicate with the Bridge.
 */
export interface IMBridgeCallbacks {
    /** Called when an incoming message is received from the IM platform */
    onMessage(chatId: string, chatType: string, message: IMMessage): void
    /** Get the Brain session ID mapped to a chat (for media upload paths, etc.) */
    getSessionIdForChat(chatId: string): string | null
    /** Called when a user reacts to a message with an emoji (optional) */
    onReaction?(chatId: string, messageId: string, emoji: string, userId: string): void
    /** Called when a user clicks a button/action in an interactive card (optional) */
    onCardAction?(chatId: string, actionTag: string, actionValue: unknown, userId: string): void
}

/**
 * Platform-specific IM adapter interface.
 * Implementations handle receiving/sending messages for a specific IM platform.
 */
export interface IMAdapter {
    /** Platform identifier (e.g. 'feishu', 'dingtalk', 'wecom') */
    readonly platform: string

    /** Start the adapter (connect to IM platform, set up event handlers) */
    start(bridge: IMBridgeCallbacks): Promise<void>

    /** Stop the adapter (disconnect, cleanup) */
    stop(): Promise<void>

    /** Send a simple text message (for error messages, status updates) */
    sendText(chatId: string, text: string): Promise<void>

    /** Send a full reply (rich text, optional voice, media attachments) */
    sendReply(chatId: string, reply: IMReply): Promise<void>

    /** Add reaction/emoji to a message */
    addReaction(messageId: string, emoji: string): Promise<void>

    /** Resolve platform user info from user ID */
    resolveSenderInfo(userId: string): Promise<{ name: string; email: string | null }>

    /** Fetch chat/group name */
    fetchChatName(chatId: string): Promise<string | null>

    /** Build a session title for display */
    buildSessionTitle(chatType: string, chatName?: string, senderName?: string): string

    /** Build the init prompt for a new Brain session */
    buildInitPrompt(chatType: string, chatName?: string, senderName?: string): Promise<string>

    /** Edit a previously sent message (optional) */
    editMessage?(messageId: string, msgType: string, content: string): Promise<boolean>

    /** Recall/delete a previously sent message (optional) */
    recallMessage?(messageId: string): Promise<boolean>

    /** Recall the last message the bot sent in a chat (optional) */
    recallLastMessage?(chatId: string): Promise<boolean>

    /** Forward a message to another chat (optional) */
    forwardMessage?(messageId: string, targetChatId: string): Promise<boolean>

    /** Pin a message in a chat (optional) */
    pinMessage?(messageId: string): Promise<boolean>

    /** Unpin a message (optional) */
    unpinMessage?(messageId: string): Promise<boolean>

    /** Send urgent notification for a bot message (optional) */
    urgentMessage?(messageId: string, type: 'app' | 'sms' | 'phone', userIds: string[]): Promise<boolean>

    /** Query who has read a message (optional) */
    getReadUsers?(messageId: string): Promise<string[]>
}

/**
 * Configuration for creating a BrainBridge.
 */
export interface BrainBridgeConfig {
    syncEngine: SyncEngine
    store: IStore
    adapter: IMAdapter
}
