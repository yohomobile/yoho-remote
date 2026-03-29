import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'

export type YohoRemoteChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
}

const YohoRemoteChatContext = createContext<YohoRemoteChatContextValue | null>(null)

export function YohoRemoteChatProvider(props: { value: YohoRemoteChatContextValue; children: ReactNode }) {
    return (
        <YohoRemoteChatContext.Provider value={props.value}>
            {props.children}
        </YohoRemoteChatContext.Provider>
    )
}

export function useYohoRemoteChatContext(): YohoRemoteChatContextValue {
    const ctx = useContext(YohoRemoteChatContext)
    if (!ctx) {
        throw new Error('YohoRemoteChatContext is missing')
    }
    return ctx
}

// Safe version that returns null instead of throwing
export function useYohoRemoteChatContextSafe(): YohoRemoteChatContextValue | null {
    return useContext(YohoRemoteChatContext)
}
