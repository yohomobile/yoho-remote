import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { MessagesResponse, Session, SessionResponse, SessionsResponse, SessionSummary, SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { upsertMessagesInCache } from '@/lib/messages'
import { getClientId, getDeviceType } from '@/lib/client-identity'
import {
    hasSessionStatusFields,
    isFullSessionPayload,
    isSidOnlySessionRefreshHint,
    type SessionStatusUpdateData,
    toSessionFromSsePayload,
} from './useSSE.utils'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

type SSESubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

function buildEventsUrl(baseUrl: string, token: string, subscription: SSESubscription): string {
    const params = new URLSearchParams()
    params.set('token', token)
    // Add client identity for tracking online users
    params.set('clientId', getClientId())
    params.set('deviceType', getDeviceType())
    if (subscription.all) {
        params.set('all', 'true')
    }
    if (subscription.sessionId) {
        params.set('sessionId', subscription.sessionId)
    }
    if (subscription.machineId) {
        params.set('machineId', subscription.machineId)
    }

    const path = `/api/events?${params.toString()}`
    try {
        return new URL(path, baseUrl).toString()
    } catch {
        return path
    }
}

export function useSSE(options: {
    enabled: boolean
    token: string
    baseUrl: string
    subscription?: SSESubscription
    onEvent: (event: SyncEvent) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: unknown) => void
}): void {
    const queryClient = useQueryClient()
    const onEventRef = useRef(options.onEvent)
    const onConnectRef = useRef(options.onConnect)
    const onDisconnectRef = useRef(options.onDisconnect)
    const onErrorRef = useRef(options.onError)
    const eventSourceRef = useRef<EventSource | null>(null)
    // 防止快速重连时的重复 onConnect 调用
    const lastConnectTimeRef = useRef(0)
    const connectDebounceMs = 1500  // 1.5 秒内的重连不触发 onConnect

    useEffect(() => {
        onEventRef.current = options.onEvent
    }, [options.onEvent])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        onConnectRef.current = options.onConnect
    }, [options.onConnect])

    useEffect(() => {
        onDisconnectRef.current = options.onDisconnect
    }, [options.onDisconnect])

    const subscription = options.subscription ?? {}
    const subscriptionKey = useMemo(() => {
        return `${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
    }, [subscription.all, subscription.sessionId, subscription.machineId])

    useEffect(() => {
        if (!options.enabled) {
            eventSourceRef.current?.close()
            eventSourceRef.current = null
            return
        }

        const url = buildEventsUrl(options.baseUrl, options.token, subscription)
        const eventSource = new EventSource(url)
        eventSourceRef.current = eventSource

        const handleSyncEvent = (event: SyncEvent) => {
            if (import.meta.env.DEV) {
                const sessionId = 'sessionId' in event ? event.sessionId : undefined
                console.log('[sse] event', event.type, sessionId)
            }
            if (event.type === 'message-received') {
                queryClient.setQueryData<InfiniteData<MessagesResponse>>(
                    queryKeys.messages(event.sessionId),
                    (data) => upsertMessagesInCache(data, [event.message])
                )
                // Mark stale so the initial query still fetches history when it mounts.
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.messages(event.sessionId),
                    refetchType: 'none'
                })
            }

            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                if ('sessionId' in event) {
                    if (event.type === 'session-removed') {
                        if (import.meta.env.DEV) {
                            console.log('[sse] remove session queries', event.sessionId)
                        }
                        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                        void queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
                        void queryClient.removeQueries({ queryKey: queryKeys.messages(event.sessionId) })
                    } else if (event.type === 'session-added') {
                        // New session added - invalidate to fetch fresh data
                        if (import.meta.env.DEV) {
                            console.log('[sse] invalidate sessions (new session)', event.sessionId)
                        }
                        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                        void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                    } else if (event.type === 'session-updated') {
                        const rawData = ('data' in event ? event.data : null)
                        const statusData = (rawData && typeof rawData === 'object'
                            ? rawData
                            : null) as SessionStatusUpdateData | null
                        const isFullSessionUpdate = isFullSessionPayload(rawData, event.sessionId)
                        const hasStatusUpdate = hasSessionStatusFields(statusData)
                        const isSidOnlyUpdate = isSidOnlySessionRefreshHint(rawData)

                        if (import.meta.env.DEV) {
                            console.log('[sse] session-updated event', {
                                sessionId: event.sessionId,
                                hasData: !!statusData,
                                isFullSessionUpdate,
                                isSidOnlyUpdate,
                                modelMode: statusData?.modelMode,
                                modelReasoningEffort: statusData?.modelReasoningEffort,
                                permissionMode: statusData?.permissionMode,
                                active: statusData?.active,
                                thinking: statusData?.thinking
                            })
                        }

                        if (isFullSessionUpdate) {
                            if (import.meta.env.DEV) {
                                console.log('[sse] full session update, refreshing detail + list cache', event.sessionId)
                            }
                            queryClient.setQueryData<SessionResponse>(
                                queryKeys.session(event.sessionId),
                                { session: toSessionFromSsePayload(rawData) }
                            )
                            // 列表项里还有 pendingRequestsCount / todoProgress 等派生字段，只能从服务端重新拉。
                            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                        } else if (hasStatusUpdate && statusData) {
                            if (import.meta.env.DEV) {
                                console.log('[sse] update session cache directly', event.sessionId, statusData)
                            }
                            // Update individual session cache
                            queryClient.setQueryData<SessionResponse>(
                                queryKeys.session(event.sessionId),
                                (prev) => {
                                    if (!prev?.session) return prev
                                    return {
                                        ...prev,
                                        session: {
                                            ...prev.session,
                                            ...(statusData.active !== undefined && { active: statusData.active }),
                                            ...(statusData.thinking !== undefined && { thinking: statusData.thinking }),
                                            ...(statusData.permissionMode !== undefined && { permissionMode: statusData.permissionMode as Session['permissionMode'] }),
                                            ...(statusData.modelMode !== undefined && { modelMode: statusData.modelMode as Session['modelMode'] }),
                                            ...(statusData.modelReasoningEffort !== undefined && { modelReasoningEffort: statusData.modelReasoningEffort as Session['modelReasoningEffort'] }),
                                            ...(statusData.fastMode !== undefined && { fastMode: statusData.fastMode }),
                                            ...(statusData.terminationReason !== undefined && { terminationReason: statusData.terminationReason }),
                                        }
                                    }
                                }
                            )
                            // Update sessions list cache (only fields that exist in SessionSummary)
                            // Only update if values actually changed to avoid unnecessary re-renders
                            queryClient.setQueriesData<SessionsResponse>(
                                { queryKey: queryKeys.sessions },
                                (prev) => {
                                    if (!prev?.sessions) return prev
                                    const target = prev.sessions.find(s => s.id === event.sessionId)
                                    if (!target) return prev
                                    // Check if any value actually changed
                                    const hasChange =
                                        (statusData.active !== undefined && statusData.active !== target.active) ||
                                        (statusData.activeAt !== undefined && statusData.activeAt !== target.activeAt) ||
                                        (statusData.thinking !== undefined && statusData.thinking !== target.thinking) ||
                                        (statusData.modelMode !== undefined && statusData.modelMode !== target.modelMode) ||
                                        (statusData.modelReasoningEffort !== undefined && statusData.modelReasoningEffort !== target.modelReasoningEffort) ||
                                        (statusData.fastMode !== undefined && statusData.fastMode !== target.fastMode) ||
                                        (statusData.terminationReason !== undefined && statusData.terminationReason !== target.terminationReason)
                                    if (!hasChange) return prev
                                    return {
                                        ...prev,
                                        sessions: prev.sessions.map((s) =>
                                            s.id === event.sessionId
                                                ? {
                                                    ...s,
                                                    ...(statusData.active !== undefined && { active: statusData.active }),
                                                    ...(statusData.activeAt !== undefined && { activeAt: statusData.activeAt }),
                                                    ...(statusData.thinking !== undefined && { thinking: statusData.thinking }),
                                                    ...(statusData.modelMode !== undefined && { modelMode: statusData.modelMode as SessionSummary['modelMode'] }),
                                                    ...(statusData.modelReasoningEffort !== undefined && { modelReasoningEffort: statusData.modelReasoningEffort as SessionSummary['modelReasoningEffort'] }),
                                                    ...(statusData.fastMode !== undefined && { fastMode: statusData.fastMode }),
                                                    ...(statusData.terminationReason !== undefined && { terminationReason: statusData.terminationReason }),
                                                }
                                                : s
                                        )
                                    }
                                }
                            )
                        } else if (isSidOnlyUpdate) {
                            // metadata/todos/agentState 更新：不刷新 session 列表，但必须刷新单个 session 详情
                            // 否则 agentState.requests 不会更新，AskUserQuestion 等权限组件会卡在 loading
                            if (import.meta.env.DEV) {
                                console.log('[sse] metadata-only update, invalidating session detail', event.sessionId)
                            }
                            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                        } else {
                            // No status fields and no sid in event, fallback to invalidation
                            if (import.meta.env.DEV) {
                                console.log('[sse] invalidate session (unknown update type)', event.sessionId, rawData)
                            }
                            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                        }
                    }
                } else {
                    // No sessionId in event, invalidate all
                    if (import.meta.env.DEV) {
                        console.log('[sse] invalidate sessions (no sessionId)')
                    }
                    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                }
            }

            if (event.type === 'machine-updated') {
                void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
            }

            if (event.type === 'file-ready' && 'sessionId' in event) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessionDownloads(event.sessionId) })
            }

            // 处理 typing-changed 事件，更新其他用户输入状态
            if (event.type === 'typing-changed' && 'sessionId' in event && 'typing' in event && event.sessionId && event.typing) {
                queryClient.setQueryData(
                    queryKeys.typing(event.sessionId),
                    { typing: event.typing, updatedAt: Date.now() }
                )
            }

            onEventRef.current(event)
        }

        const handleMessage = (message: MessageEvent<string>) => {
            if (typeof message.data !== 'string') {
                return
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(message.data)
            } catch {
                return
            }

            if (!isObject(parsed)) {
                return
            }
            if (typeof parsed.type !== 'string') {
                return
            }

            handleSyncEvent(parsed as SyncEvent)
        }

        eventSource.onmessage = handleMessage
        eventSource.onopen = () => {
            const now = Date.now()
            const timeSinceLastConnect = now - lastConnectTimeRef.current

            // 防止快速重连导致的重复 onConnect 回调
            // 这在移动端网络波动时尤其重要
            if (timeSinceLastConnect < connectDebounceMs && lastConnectTimeRef.current > 0) {
                if (import.meta.env.DEV) {
                    console.log('[sse] onopen debounced - reconnected too quickly', {
                        timeSinceLastConnect,
                        debounceMs: connectDebounceMs
                    })
                }
                return
            }

            lastConnectTimeRef.current = now
            onConnectRef.current?.()
        }
        eventSource.onerror = (error) => {
            onErrorRef.current?.(error)
            const reason = eventSource.readyState === EventSource.CLOSED ? 'closed' : 'error'
            onDisconnectRef.current?.(reason)
        }

        return () => {
            eventSource.close()
            if (eventSourceRef.current === eventSource) {
                eventSourceRef.current = null
            }
        }
    }, [options.baseUrl, options.enabled, options.token, subscriptionKey, queryClient])
}
