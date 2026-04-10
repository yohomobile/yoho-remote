/**
 * Feishu action extractor.
 *
 * Extracts structured actions from Brain output text.
 *
 * Brain outputs actions in a `<feishu-actions>` JSON block at the end of its reply:
 *
 *   正常 markdown 文本回复...
 *
 *   <feishu-actions>
 *   {"at": ["ou_xxx"], "reactions": ["Thumbsup"]}
 *   </feishu-actions>
 *
 * For backward compatibility, also supports legacy bracket tags:
 *   [at: ou_xxx], [feishu-file: path], [feishu-reaction: emoji], etc.
 *
 * The structured format is preferred — single JSON parse replaces 17 scattered regexes.
 */

import type { IMReplyExtra } from '../types'

// ========== Action schema ==========

export interface FeishuActions {
    /** @mention user IDs: ["ou_xxx"] or ["all"] */
    at?: string[]
    /** Emoji reactions to add to the triggering message */
    reactions?: string[]
    /** File paths to send as attachments */
    files?: string[]
    /** Image URLs to download and send */
    images?: string[]
    /** Sticker file keys */
    stickers?: string[]
    /** Chat IDs to share as cards */
    shareChats?: string[]
    /** User IDs to share as cards */
    shareUsers?: string[]
    /** Edit existing messages */
    edit?: Array<{ id: string; text: string }>
    /** Recall/delete messages; "last" = recall last bot message */
    recall?: string[]
    /** Forward messages to other chats */
    forward?: Array<{ id: string; to: string }>
    /** Pin messages */
    pin?: string[]
    /** Unpin messages */
    unpin?: string[]
    /** Send urgent notifications */
    urgent?: Array<{ id: string; type: string; users: string[] }>
    /** Send ephemeral (private) card to specific users in group chat */
    ephemeral?: Array<{ userId: string; text: string }>
    /** Suppress reply (passive/listen mode) */
    silent?: boolean
}

export interface ExtractResult {
    actions: FeishuActions
    cards: string[]
    cleanText: string
}

// ========== ID validation ==========

const MESSAGE_ID_RE = /^om_[a-zA-Z0-9]+$/
const USER_ID_RE = /^ou_[a-zA-Z0-9]+$/
const CHAT_ID_RE = /^oc_[a-zA-Z0-9]+$/

function isValidMessageId(id: string): boolean { return MESSAGE_ID_RE.test(id) }
function isValidUserId(id: string): boolean { return USER_ID_RE.test(id) }
function isValidChatId(id: string): boolean { return CHAT_ID_RE.test(id) }
function isValidUrl(url: string): boolean {
    return /^https?:\/\//.test(url)
}

// ========== Structured extraction ==========

const ACTIONS_BLOCK_RE = /<feishu-actions>\s*([\s\S]*?)\s*<\/feishu-actions>/g
const CARD_BLOCK_RE = /<feishu-card>([\s\S]*?)<\/feishu-card>/g

/**
 * Parse and validate a <feishu-actions> JSON block.
 * Returns validated actions, dropping any malformed values.
 */
function parseActionsJson(json: string): FeishuActions | null {
    try {
        const raw = JSON.parse(json)
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

        const actions: FeishuActions = {}

        // at: string[]
        if (Array.isArray(raw.at)) {
            actions.at = raw.at.filter((id: unknown) =>
                typeof id === 'string' && (id === 'all' || isValidUserId(id))
            )
        }

        // reactions: string[]
        if (Array.isArray(raw.reactions)) {
            actions.reactions = raw.reactions.filter((r: unknown) =>
                typeof r === 'string' && /^\w+$/.test(r)
            )
        }

        // files: string[]
        if (Array.isArray(raw.files)) {
            actions.files = raw.files.filter((f: unknown) =>
                typeof f === 'string' && f.startsWith('/')
            )
        }

        // images: string[]
        if (Array.isArray(raw.images)) {
            actions.images = raw.images.filter((u: unknown) =>
                typeof u === 'string' && isValidUrl(u)
            )
        }

        // stickers: string[]
        if (Array.isArray(raw.stickers)) {
            actions.stickers = raw.stickers.filter((s: unknown) => typeof s === 'string' && s)
        }

        // shareChats: string[]
        if (Array.isArray(raw.shareChats)) {
            actions.shareChats = raw.shareChats.filter((c: unknown) =>
                typeof c === 'string' && isValidChatId(c)
            )
        }

        // shareUsers: string[]
        if (Array.isArray(raw.shareUsers)) {
            actions.shareUsers = raw.shareUsers.filter((u: unknown) =>
                typeof u === 'string' && isValidUserId(u)
            )
        }

        // edit: Array<{id, text}>
        if (Array.isArray(raw.edit)) {
            actions.edit = raw.edit.filter((e: unknown) =>
                typeof e === 'object' && e !== null
                && typeof (e as any).id === 'string' && isValidMessageId((e as any).id)
                && typeof (e as any).text === 'string' && (e as any).text.trim()
            ).map((e: any) => ({ id: e.id, text: e.text.trim() }))
        }

        // recall: string[] — "last" for recalling last bot message, or message IDs
        if (Array.isArray(raw.recall)) {
            actions.recall = raw.recall.filter((r: unknown) =>
                typeof r === 'string' && (r === 'last' || isValidMessageId(r))
            )
        }

        // forward: Array<{id, to}>
        if (Array.isArray(raw.forward)) {
            actions.forward = raw.forward.filter((f: unknown) =>
                typeof f === 'object' && f !== null
                && typeof (f as any).id === 'string' && isValidMessageId((f as any).id)
                && typeof (f as any).to === 'string' && isValidChatId((f as any).to)
            ).map((f: any) => ({ id: f.id, to: f.to }))
        }

        // pin: string[]
        if (Array.isArray(raw.pin)) {
            actions.pin = raw.pin.filter((p: unknown) =>
                typeof p === 'string' && isValidMessageId(p)
            )
        }

        // unpin: string[]
        if (Array.isArray(raw.unpin)) {
            actions.unpin = raw.unpin.filter((p: unknown) =>
                typeof p === 'string' && isValidMessageId(p)
            )
        }

        // urgent: Array<{id, type, users}>
        if (Array.isArray(raw.urgent)) {
            actions.urgent = raw.urgent.filter((u: unknown) =>
                typeof u === 'object' && u !== null
                && typeof (u as any).id === 'string' && isValidMessageId((u as any).id)
                && typeof (u as any).type === 'string' && ['app', 'sms', 'phone'].includes((u as any).type)
                && Array.isArray((u as any).users)
            ).map((u: any) => ({
                id: u.id,
                type: u.type,
                users: u.users.filter((uid: unknown) => typeof uid === 'string' && isValidUserId(uid)),
            }))
        }

        // ephemeral: Array<{userId, text}> — private card to specific users
        if (Array.isArray(raw.ephemeral)) {
            actions.ephemeral = raw.ephemeral.filter((e: unknown) =>
                typeof e === 'object' && e !== null
                && typeof (e as any).userId === 'string' && isValidUserId((e as any).userId)
                && typeof (e as any).text === 'string' && (e as any).text.trim()
            ).map((e: any) => ({ userId: e.userId, text: e.text.trim() }))
        }

        // silent: boolean
        if (raw.silent === true) {
            actions.silent = true
        }

        return actions
    } catch {
        console.warn('[actionExtractor] Failed to parse <feishu-actions> JSON')
        return null
    }
}

// ========== Legacy bracket-tag extraction (backward compatibility) ==========

function extractLegacyActions(text: string): FeishuActions {
    const actions: FeishuActions = {}

    // [at: all]
    if (/\[at:\s*all\]/i.test(text)) {
        actions.at = ['all']
    } else {
        const atIds: string[] = []
        const AT_RE = /\[at:\s*(ou_[a-zA-Z0-9]+)\]/g
        let m: RegExpExecArray | null
        while ((m = AT_RE.exec(text)) !== null) atIds.push(m[1])
        if (atIds.length > 0) actions.at = [...new Set(atIds)]
    }

    // [feishu-reaction: emoji]
    const reactions: string[] = []
    const REACTION_RE = /\[feishu-reaction:\s*(\w+)\]/g
    let m: RegExpExecArray | null
    while ((m = REACTION_RE.exec(text)) !== null) reactions.push(m[1].trim())
    if (reactions.length > 0) actions.reactions = reactions

    // [feishu-file: path]
    const files: string[] = []
    const FILE_RE = /\[feishu-file:\s*(.+?)\]/g
    while ((m = FILE_RE.exec(text)) !== null) files.push(m[1].trim())
    if (files.length > 0) actions.files = files

    // [feishu-image-url: url]
    const images: string[] = []
    const IMG_RE = /\[feishu-image-url:\s*(.+?)\]/g
    while ((m = IMG_RE.exec(text)) !== null) images.push(m[1].trim())
    if (images.length > 0) actions.images = images

    // [feishu-sticker: id]
    const stickers: string[] = []
    const STICKER_RE = /\[feishu-sticker:\s*(.+?)\]/g
    while ((m = STICKER_RE.exec(text)) !== null) stickers.push(m[1].trim())
    if (stickers.length > 0) actions.stickers = stickers

    // [feishu-share-chat: id]
    const shareChats: string[] = []
    const SHARE_CHAT_RE = /\[feishu-share-chat:\s*(.+?)\]/g
    while ((m = SHARE_CHAT_RE.exec(text)) !== null) shareChats.push(m[1].trim())
    if (shareChats.length > 0) actions.shareChats = shareChats

    // [feishu-share-user: id]
    const shareUsers: string[] = []
    const SHARE_USER_RE = /\[feishu-share-user:\s*(.+?)\]/g
    while ((m = SHARE_USER_RE.exec(text)) !== null) shareUsers.push(m[1].trim())
    if (shareUsers.length > 0) actions.shareUsers = shareUsers

    // [feishu-edit: om_xxx new text]
    const edits: Array<{ id: string; text: string }> = []
    const EDIT_RE = /\[feishu-edit:\s*(om_[a-zA-Z0-9]+)\s+([\s\S]+?)\]/g
    while ((m = EDIT_RE.exec(text)) !== null) {
        edits.push({ id: m[1], text: m[2].trim() })
    }
    if (edits.length > 0) actions.edit = edits

    // [feishu-recall: om_xxx] and [feishu-recall]
    const recalls: string[] = []
    const RECALL_ID_RE = /\[feishu-recall:\s*(om_[a-zA-Z0-9]+)\]/g
    while ((m = RECALL_ID_RE.exec(text)) !== null) recalls.push(m[1])
    if (/\[feishu-recall\]/.test(text)) recalls.push('last')
    if (recalls.length > 0) actions.recall = recalls

    // [feishu-forward: om_xxx oc_yyy]
    const forwards: Array<{ id: string; to: string }> = []
    const FWD_RE = /\[feishu-forward:\s*(om_[a-zA-Z0-9]+)\s+(oc_[a-zA-Z0-9]+)\]/g
    while ((m = FWD_RE.exec(text)) !== null) {
        forwards.push({ id: m[1], to: m[2] })
    }
    if (forwards.length > 0) actions.forward = forwards

    // [feishu-pin: om_xxx] / [feishu-unpin: om_xxx]
    const pins: string[] = []
    const unpins: string[] = []
    const PIN_RE = /\[feishu-pin:\s*(om_[a-zA-Z0-9]+)\]/g
    const UNPIN_RE = /\[feishu-unpin:\s*(om_[a-zA-Z0-9]+)\]/g
    while ((m = PIN_RE.exec(text)) !== null) pins.push(m[1])
    while ((m = UNPIN_RE.exec(text)) !== null) unpins.push(m[1])
    if (pins.length > 0) actions.pin = pins
    if (unpins.length > 0) actions.unpin = unpins

    // [feishu-urgent: om_xxx app|sms|phone ou_a,ou_b]
    const urgents: Array<{ id: string; type: string; users: string[] }> = []
    const URGENT_RE = /\[feishu-urgent:\s*(om_[a-zA-Z0-9]+)\s+(app|sms|phone)\s+([\w,]+)\]/g
    while ((m = URGENT_RE.exec(text)) !== null) {
        urgents.push({
            id: m[1],
            type: m[2],
            users: m[3].split(',').map(s => s.trim()).filter(Boolean),
        })
    }
    if (urgents.length > 0) actions.urgent = urgents

    // [silent]
    if (/\[silent\]/.test(text)) actions.silent = true

    return actions
}

// ========== Text cleaning ==========

/** Strip all action markers and tags from text, leaving clean markdown. */
function stripMarkers(text: string): string {
    return text
        // Structured block
        .replace(ACTIONS_BLOCK_RE, '')
        // Card blocks (stripped here; content extracted separately)
        .replace(CARD_BLOCK_RE, '')
        // Legacy bracket tags
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
        .replace(/<\/?feishu-reply>/g, '')
        .replace(/\[silent\]/g, '')
        .trim()
}

// ========== Public API ==========

/**
 * Extract actions and clean text from Brain output.
 *
 * Tries structured `<feishu-actions>` JSON first.
 * Falls back to legacy bracket-tag regex for backward compatibility.
 */
export function extractActions(text: string): ExtractResult {
    // 1. Extract <feishu-card> blocks (always regex, these are content not actions)
    const cards: string[] = []
    let cm: RegExpExecArray | null
    const cardRe = new RegExp(CARD_BLOCK_RE.source, 'g')
    while ((cm = cardRe.exec(text)) !== null) {
        const content = cm[1].trim()
        if (content) cards.push(content)
    }

    // 2. Try structured <feishu-actions> extraction
    let actions: FeishuActions | null = null
    const actionsRe = new RegExp(ACTIONS_BLOCK_RE.source, 'g')
    const actionsMatch = actionsRe.exec(text)
    if (actionsMatch) {
        actions = parseActionsJson(actionsMatch[1])
        if (actions) {
            // Merge multiple action blocks (unlikely but handle gracefully)
            let more: RegExpExecArray | null
            while ((more = actionsRe.exec(text)) !== null) {
                const extra = parseActionsJson(more[1])
                if (extra) actions = mergeActions(actions, extra)
            }
        }
    }

    // 3. Fallback to legacy if no valid structured block found
    if (!actions) {
        actions = extractLegacyActions(text)
    }

    // 4. Clean text
    const cleanText = stripMarkers(text)

    return { actions, cards, cleanText }
}

/**
 * Convert extracted actions to IMReplyExtra array for the adapter.
 */
export function actionsToExtras(actions: FeishuActions): IMReplyExtra[] {
    const extras: IMReplyExtra[] = []
    if (actions.stickers) {
        for (const id of actions.stickers) extras.push({ type: 'sticker', stickerId: id })
    }
    if (actions.shareChats) {
        for (const id of actions.shareChats) extras.push({ type: 'share_chat', chatId: id })
    }
    if (actions.shareUsers) {
        for (const id of actions.shareUsers) extras.push({ type: 'share_user', userId: id })
    }
    if (actions.images) {
        for (const url of actions.images) extras.push({ type: 'image_url', url })
    }
    return extras
}

/** Merge two action objects (append arrays, prefer later booleans). */
function mergeActions(a: FeishuActions, b: FeishuActions): FeishuActions {
    const result: FeishuActions = { ...a }
    for (const key of Object.keys(b) as (keyof FeishuActions)[]) {
        const bVal = b[key]
        if (bVal === undefined) continue
        const aVal = a[key]
        if (Array.isArray(bVal) && Array.isArray(aVal)) {
            (result as any)[key] = [...aVal, ...bVal]
        } else {
            (result as any)[key] = bVal
        }
    }
    return result
}
