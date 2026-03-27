import { useCallback, useRef } from 'react'

const STORAGE_KEY = 'yr:inputHistory'
const MAX_HISTORY = 50

type HistoryData = string[]

function loadHistory(): HistoryData {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        return stored ? JSON.parse(stored) : []
    } catch {
        return []
    }
}

function saveHistory(data: HistoryData): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
        // Ignore storage errors
    }
}

/**
 * Hook 用于管理输入历史记录
 * 支持上下键导航历史记录
 */
export function useInputHistory() {
    const historyRef = useRef<HistoryData>(loadHistory())
    const indexRef = useRef<number>(-1)
    const tempInputRef = useRef<string>('')

    // 添加到历史记录
    const addToHistory = useCallback((text: string): void => {
        const trimmed = text.trim()
        if (!trimmed) return

        // 移除重复项
        const filtered = historyRef.current.filter(item => item !== trimmed)
        // 添加到末尾
        filtered.push(trimmed)
        // 限制数量
        if (filtered.length > MAX_HISTORY) {
            filtered.shift()
        }

        historyRef.current = filtered
        saveHistory(filtered)
        // 重置索引
        indexRef.current = -1
        tempInputRef.current = ''
    }, [])

    // 向上导航（获取更旧的历史）
    const navigateUp = useCallback((currentInput: string): string | null => {
        const history = historyRef.current
        if (history.length === 0) return null

        // 如果是第一次按上键，保存当前输入
        if (indexRef.current === -1) {
            tempInputRef.current = currentInput
            indexRef.current = history.length - 1
            return history[indexRef.current] ?? null
        }

        // 继续向上
        if (indexRef.current > 0) {
            indexRef.current--
            return history[indexRef.current] ?? null
        }

        // 已经到顶部，返回当前项
        return history[indexRef.current] ?? null
    }, [])

    // 向下导航（获取更新的历史）
    const navigateDown = useCallback((): string | null => {
        const history = historyRef.current
        if (indexRef.current === -1) return null

        // 向下移动
        indexRef.current++

        // 如果超过历史末尾，返回临时保存的输入
        if (indexRef.current >= history.length) {
            indexRef.current = -1
            return tempInputRef.current
        }

        return history[indexRef.current] ?? null
    }, [])

    // 重置导航状态
    const resetNavigation = useCallback((): void => {
        indexRef.current = -1
        tempInputRef.current = ''
    }, [])

    // 检查是否正在导航历史
    const isNavigating = useCallback((): boolean => {
        return indexRef.current !== -1
    }, [])

    return {
        addToHistory,
        navigateUp,
        navigateDown,
        resetNavigation,
        isNavigating
    }
}
