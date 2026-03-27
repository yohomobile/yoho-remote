import { useCallback, useEffect, useRef } from 'react'

const STORAGE_KEY = 'yr:sessionDrafts'
const MAX_DRAFTS = 50

type DraftsData = Record<string, string>

function loadDrafts(): DraftsData {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        return stored ? JSON.parse(stored) : {}
    } catch {
        return {}
    }
}

function saveDrafts(data: DraftsData): void {
    try {
        // 只保留最新的 MAX_DRAFTS 个草稿
        const entries = Object.entries(data)
        if (entries.length > MAX_DRAFTS) {
            const toKeep = entries.slice(-MAX_DRAFTS)
            data = Object.fromEntries(toKeep)
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
        // Ignore storage errors
    }
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
        return draftsRef.current[sessionId] ?? ''
    }, [sessionId])

    // 保存当前 session 的草稿
    const setDraft = useCallback((text: string): void => {
        if (!sessionId) return

        const trimmed = text.trim()
        if (trimmed) {
            draftsRef.current[sessionId] = text
        } else {
            // 空文本时删除草稿
            delete draftsRef.current[sessionId]
        }
        saveDrafts(draftsRef.current)
    }, [sessionId])

    // 清除当前 session 的草稿（发送消息后调用）
    const clearDraft = useCallback((): void => {
        if (!sessionId) return
        delete draftsRef.current[sessionId]
        saveDrafts(draftsRef.current)
    }, [sessionId])

    return { getDraft, setDraft, clearDraft }
}
