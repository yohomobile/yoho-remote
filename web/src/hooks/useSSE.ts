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
    orgId?: string | null
}

type SessionCacheInvalidator = {
    invalidateQueries: (filters: { queryKey: readonly unknown[] }) => Promise<unknown>
}

export function buildSseSubscriptionKey(subscription: SSESubscription): string {
    return `${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}|${subscription.orgId ?? ''}`
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
    if (subscription.orgId) {
        params.set('orgId', subscription.orgId)
    }

    const path = `/api/events?${params.toString()}`
    try {
        return new URL(path, baseUrl).toString()
    } catch {
        return path
    }
}

export function invalidateSessionCachesForSidOnlyUpdate(
    queryClient: SessionCacheInvalidator,
    sessionId: string
): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
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
        return buildSseSubscriptionKey(subscription)
    }, [subscription.all, subscription.sessionId, subscription.machineId, subscription.orgId])

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
                        // 增量从 list cache 中移除该 session,不再 fallback 到整列表 refetch
                        // (4MB,在 25+ active session 稳态下流量爆炸)。2026-04-25
                        const removedId = event.sessionId
                        queryClient.setQueriesData<SessionsResponse>(
                            { queryKey: queryKeys.sessions },
                            (prev) => {
                                if (!prev?.sessions) return prev
                                const filtered = prev.sessions.filter(s => s.id !== removedId)
                                if (filtered.length === prev.sessions.length) return prev
                                return { ...prev, sessions: filtered }
                            }
                        )
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

                        // session-added: 不再 schedule list refetch。
                        // viewers/participants 等服务端衍生字段会通过专门的 SSE 事件(viewer-changed/participants-changed)推送。
                        // 仅 invalidate 该 session 详情,确保进入 detail 页面时拿到完整数据。2026-04-25
                        if (import.meta.env.DEV) {
                            console.log('[sse] session-added (no list refetch)', event.sessionId)
                        }
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
                                reconnecting: statusData?.reconnecting,
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
                            // 不再 schedule list refetch:setQueriesData 已经把最新 summary 写进 cache。
                            // viewers/participants 通过 viewer-changed / participants-changed 单独 SSE 推送;
                            // ownerEmail 在用户改 sharing 设置时由 mutation 路径显式 invalidate。2026-04-25
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
                                            ...(statusData.reconnecting !== undefined && { reconnecting: statusData.reconnecting }),
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
                            // sid-only update:metadata 改了(lifecycleState/source/mainSessionId 等),
                            // SSE 没带具体字段,只能拉 detail 走 query 兜底,不再触发整列表 refetch。
                            // 列表 cache 里 metadata 暂时滞后;若用户进入该 session detail 查看,
                            // detail invalidate 会拿到最新 metadata。2026-04-25
                            if (import.meta.env.DEV) {
                                console.log('[sse] sid-only update (no list refetch)', event.sessionId)
                            }
                            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                        } else {
                            // 不识别的 session-updated payload:仅 invalidate 详情,不动 list cache。
                            if (import.meta.env.DEV) {
                                console.log('[sse] unknown session-updated payload (no list refetch)', event.sessionId, rawData)
                            }
                            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                        }
                    }
                } else {
                    // session-updated without sessionId: 极少见,跳过(原来会兜底 invalidate 整列表)。
                    if (import.meta.env.DEV) {
                        console.log('[sse] session-updated without sessionId, ignored')
                    }
                }
            }

            // viewer-changed:某 session 的查看者变化(SSE 客户端 join/leave 时由 server 推)。
            // 只更新 list cache 中该 session 的 viewers 字段,不触发 refetch。2026-04-25
            if (event.type === 'viewer-changed' && 'sessionId' in event && Array.isArray((event as unknown as { viewers?: unknown }).viewers)) {
                const viewers = (event as unknown as { viewers: SessionSummary['viewers'] }).viewers
                queryClient.setQueriesData<SessionsResponse>(
                    { queryKey: queryKeys.sessions },
                    (prev) => applySessionSummaryStatusUpdate(prev, event.sessionId, { viewers } as SessionStatusUpdateData)
                )
            }

            // participants-changed:message authors 聚合,同上,只走增量。2026-04-25
            if (event.type === 'participants-changed' && 'sessionId' in event && Array.isArray((event as unknown as { participants?: unknown }).participants)) {
                const participants = (event as unknown as { participants: SessionSummary['participants'] }).participants
                queryClient.setQueriesData<SessionsResponse>(
                    { queryKey: queryKeys.sessions },
                    (prev) => applySessionSummaryStatusUpdate(prev, event.sessionId, { participants } as SessionStatusUpdateData)
                )
            }

            if (event.type === 'machine-updated') {
                void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
            }

            // identity-candidate-updated SSE removed with the legacy
            // /api/identity/candidates surface — approval candidates flow
            // through /api/approvals now (no SSE invalidation wired yet).

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
