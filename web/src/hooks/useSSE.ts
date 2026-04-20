import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { MessagesResponse, Session, SessionResponse, SessionsResponse, SessionSummary, SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { upsertMessagesInCache } from '@/lib/messages'
import { getClientId, getDeviceType } from '@/lib/client-identity'
import {
    applySessionSummaryStatusUpdate,
    hasSessionStatusFields,
    isFullSessionPayload,
    isSidOnlySessionRefreshHint,
    type SessionStatusUpdateData,
    toSessionFromSsePayload,
    toSessionSummaryFromSsePayload,
    upsertSessionSummary,
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

            if (event.type === 'messages-cleared') {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.messages(event.sessionId)
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
                        const rawData = ('data' in event ? event.data : null)
                        const isFullSessionAdd = isFullSessionPayload(rawData, event.sessionId)

                        if (isFullSessionAdd) {
                            const nextSession = toSessionFromSsePayload(rawData)
                            const nextSummary = toSessionSummaryFromSsePayload(rawData)

                            queryClient.setQueryData<SessionResponse>(
                                queryKeys.session(event.sessionId),
                                { session: nextSession }
                            )
                            queryClient.setQueriesData<SessionsResponse>(
                                { queryKey: queryKeys.sessions },
                                (prev) => upsertSessionSummary(prev, nextSummary)
                            )
                        }

                        // New session added - still invalidate in background to refresh server-derived fields.
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
                                thinking: statusData?.thinking,
                                activeMonitorCount: statusData?.activeMonitorCount
                            })
                        }

                        if (isFullSessionUpdate) {
                            const nextSession = toSessionFromSsePayload(rawData)
                            const nextSummary = toSessionSummaryFromSsePayload(rawData)

                            if (import.meta.env.DEV) {
                                console.log('[sse] full session update, refreshing detail + list cache', event.sessionId)
                            }
                            queryClient.setQueryData<SessionResponse>(
                                queryKeys.session(event.sessionId),
                                (prev) => {
                                    if (nextSession.activeMonitors === undefined && prev?.session?.activeMonitors !== undefined) {
                                        nextSession.activeMonitors = prev.session.activeMonitors
                                    }
                                    return { session: nextSession }
                                }
                            )
                            queryClient.setQueriesData<SessionsResponse>(
                                { queryKey: queryKeys.sessions },
                                (prev) => upsertSessionSummary(prev, nextSummary)
                            )
                            // viewers / ownerEmail 等服务端衍生字段仍然走后台刷新。
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
                                            ...(statusData.lastMessageAt !== undefined && { lastMessageAt: statusData.lastMessageAt ?? null }),
                                            ...(statusData.permissionMode !== undefined && { permissionMode: statusData.permissionMode as Session['permissionMode'] }),
                                            ...(statusData.modelMode !== undefined && { modelMode: statusData.modelMode as Session['modelMode'] }),
                                            ...(statusData.modelReasoningEffort !== undefined && { modelReasoningEffort: statusData.modelReasoningEffort as Session['modelReasoningEffort'] }),
                                            ...(statusData.fastMode !== undefined && { fastMode: statusData.fastMode }),
                                            ...(statusData.activeMonitors !== undefined && { activeMonitors: statusData.activeMonitors }),
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
                                    return applySessionSummaryStatusUpdate(prev, event.sessionId, statusData)
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
