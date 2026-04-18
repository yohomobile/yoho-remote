import { useCallback, useRef } from 'react'

const STORAGE_KEY = 'yr:sessionDrafts'
const MAX_DRAFTS = 50

type DraftEntry = {
    content: string
    updatedAt: number
}

type DraftsData = Map<string, DraftEntry>

function loadDrafts(): DraftsData {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (!stored) {
            return new Map()
        }

        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) {
            const entries = parsed
                .map((entry, index): [string, DraftEntry] | null => {
                    if (!Array.isArray(entry) || entry.length < 2) return null
                    const [sessionId, value] = entry
                    if (typeof sessionId !== 'string') return null
                    if (!value || typeof value !== 'object') return null
                    const content = typeof (value as { content?: unknown }).content === 'string'
                        ? (value as { content: string }).content
                        : null
                    if (!content) return null
                    const updatedAt = typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
                        ? (value as { updatedAt: number }).updatedAt
                        : index
                    return [sessionId, { content, updatedAt }]
                })
                .filter((entry): entry is [string, DraftEntry] => entry !== null)
            return new Map(entries)
        }

        if (parsed && typeof parsed === 'object') {
            const entries = Object.entries(parsed as Record<string, unknown>)
                .map(([sessionId, value], index): [string, DraftEntry] | null => {
                    if (typeof value === 'string') {
                        return [sessionId, { content: value, updatedAt: index }]
                    }
                    if (!value || typeof value !== 'object') return null
                    const content = typeof (value as { content?: unknown }).content === 'string'
                        ? (value as { content: string }).content
                        : null
                    if (!content) return null
                    const updatedAt = typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
                        ? (value as { updatedAt: number }).updatedAt
                        : index
                    return [sessionId, { content, updatedAt }]
                })
                .filter((entry): entry is [string, DraftEntry] => entry !== null)
            return new Map(entries)
        }

        return new Map()
    } catch {
        return new Map()
    }
}

function trimDrafts(data: DraftsData): DraftsData {
    if (data.size <= MAX_DRAFTS) {
        return data
    }

    const trimmed = Array.from(data.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(-MAX_DRAFTS)
    return new Map(trimmed)
}

function saveDrafts(data: DraftsData): DraftsData {
    const trimmed = trimDrafts(data)
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(trimmed.entries())))
    } catch {
        // Ignore storage errors
    }
    return trimmed
}

/**
 * Hook 用于管理每个 session 的输入草稿
 * 当用户切换 session 时保留输入内容
 */
export function useSessionDraft(sessionId: string | null) {
    const draftsRef = useRef<DraftsData>(loadDrafts())

    // 获取当前 session 的草稿
    const getDraft = useCallback((): string => {
        if (!sessionId) return ''
        return draftsRef.current.get(sessionId)?.content ?? ''
    }, [sessionId])

    // 保存当前 session 的草稿
    const setDraft = useCallback((text: string): void => {
        if (!sessionId) return

        const trimmed = text.trim()
        if (trimmed) {
            draftsRef.current.set(sessionId, {
                content: text,
                updatedAt: Date.now()
            })
        } else {
            // 空文本时删除草稿
            draftsRef.current.delete(sessionId)
        }
        draftsRef.current = saveDrafts(draftsRef.current)
    }, [sessionId])

    // 清除当前 session 的草稿（发送消息后调用）
    const clearDraft = useCallback((): void => {
        if (!sessionId) return
        draftsRef.current.delete(sessionId)
        draftsRef.current = saveDrafts(draftsRef.current)
    }, [sessionId])

    return { getDraft, setDraft, clearDraft }
}
