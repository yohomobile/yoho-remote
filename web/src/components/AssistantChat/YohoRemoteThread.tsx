import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { YohoRemoteChatProvider } from '@/components/AssistantChat/context'
import { YohoRemoteAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { YohoRemoteUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { YohoRemoteSystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {props.count} new message{props.count > 1 ? 's' : ''} &#8595;
        </button>
    )
}

function MessageSkeleton() {
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">Loading messages…</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: YohoRemoteUserMessage,
    AssistantMessage: YohoRemoteAssistantMessage,
    SystemMessage: YohoRemoteSystemMessage
} as const

export function YohoRemoteThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    isLoadingMessages: boolean
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    rawMessagesCount: number
    normalizedMessagesCount: number
    renderedMessagesCount: number
    trailing?: ReactNode
}) {
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const anchorRestoreRef = useRef<{ messageId: string; offsetTop: number } | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)

    // Smart scroll state: autoScroll enabled when user is near bottom
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
    const [newMessageCount, setNewMessageCount] = useState(0)
    const prevRenderedCountRef = useRef(props.renderedMessagesCount)
    const autoScrollEnabledRef = useRef(autoScrollEnabled)
    const newMessageCountRef = useRef(newMessageCount)
    const hasBootstrappedRef = useRef(false)

    // Keep refs in sync with state
    useEffect(() => {
        autoScrollEnabledRef.current = autoScrollEnabled
    }, [autoScrollEnabled])
    useEffect(() => {
        newMessageCountRef.current = newMessageCount
    }, [newMessageCount])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const THRESHOLD_PX = 120

        const handleScroll = () => {
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const isNearBottom = distanceFromBottom < THRESHOLD_PX

            if (isNearBottom) {
                if (!autoScrollEnabledRef.current) setAutoScrollEnabled(true)
                if (newMessageCountRef.current > 0) setNewMessageCount(0)
            } else {
                if (autoScrollEnabledRef.current) setAutoScrollEnabled(false)
            }
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        return () => viewport.removeEventListener('scroll', handleScroll)
    }, []) // Stable: no dependencies, reads from refs

    // Track new messages when autoScroll is disabled
    const wasLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    useEffect(() => {
        const prevCount = prevRenderedCountRef.current
        const currentCount = props.renderedMessagesCount
        const wasLoadingMore = wasLoadingMoreRef.current
        wasLoadingMoreRef.current = props.isLoadingMoreMessages

        if (props.isLoadingMessages) {
            prevRenderedCountRef.current = currentCount
            return
        }

        if (!hasBootstrappedRef.current) {
            hasBootstrappedRef.current = true
            prevRenderedCountRef.current = currentCount
            return
        }

        prevRenderedCountRef.current = currentCount

        // Skip during loading states
        if (props.isLoadingMoreMessages) {
            return
        }

        // Skip if load-more just finished (older messages, not new ones)
        if (wasLoadingMore) {
            return
        }

        const newCount = currentCount - prevCount
        if (newCount > 0 && !autoScrollEnabled) {
            setNewMessageCount((prev) => prev + newCount)
        }
    }, [props.renderedMessagesCount, props.isLoadingMoreMessages, props.isLoadingMessages, autoScrollEnabled])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
        setAutoScrollEnabled(true)
        setNewMessageCount(0)
    }, [])

    const captureScrollAnchor = useCallback(() => {
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport || !content) {
            return false
        }

        const viewportRect = viewport.getBoundingClientRect()
        const nodes = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
        for (const node of nodes) {
            const messageId = node.dataset.messageId
            if (!messageId) {
                continue
            }

            const rect = node.getBoundingClientRect()
            if (rect.bottom > viewportRect.top + 1 && rect.top < viewportRect.bottom - 1) {
                anchorRestoreRef.current = {
                    messageId,
                    offsetTop: rect.top - viewportRect.top
                }
                return true
            }
        }

        const firstNode = nodes[0]
        const firstId = firstNode?.dataset.messageId
        if (!firstNode || !firstId) {
            return false
        }

        const rect = firstNode.getBoundingClientRect()
        anchorRestoreRef.current = {
            messageId: firstId,
            offsetTop: rect.top - viewportRect.top
        }
        return true
    }, [])

    const restoreScrollAnchor = useCallback((alignToStart: boolean) => {
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport || !content) {
            return false
        }

        if (!anchorRestoreRef.current) {
            if (autoScrollEnabledRef.current) {
                viewport.scrollTop = viewport.scrollHeight
            }
            return false
        }

        const anchor = anchorRestoreRef.current
        const nodes = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
        const target = nodes.find((node) => node.dataset.messageId === anchor.messageId) ?? null
        if (!target) {
            anchorRestoreRef.current = null
            return false
        }

        if (alignToStart) {
            target.scrollIntoView({ block: 'start', behavior: 'auto' })
        }

        const viewportRect = viewport.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const drift = targetRect.top - viewportRect.top - anchor.offsetTop
        if (Math.abs(drift) > 1) {
            viewport.scrollTop += drift
        }

        return true
    }, [])

    // Reset state when session changes
    useEffect(() => {
        setAutoScrollEnabled(true)
        setNewMessageCount(0)
        prevRenderedCountRef.current = 0
        hasBootstrappedRef.current = false
        anchorRestoreRef.current = null
        loadLockRef.current = false
        loadStartedRef.current = false
        isLoadingMoreRef.current = false
        prevLoadingMoreRef.current = false
    }, [props.sessionId])

    const handleLoadMore = useCallback(() => {
        if (props.isLoadingMessages || !props.hasMoreMessages || props.isLoadingMoreMessages || loadLockRef.current) {
            return
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        captureScrollAnchor()
        loadLockRef.current = true
        loadStartedRef.current = false
        let loadPromise: Promise<unknown>
        try {
            loadPromise = props.onLoadMore()
        } catch (error) {
            anchorRestoreRef.current = null
            loadLockRef.current = false
            throw error
        }
        void loadPromise.catch((error) => {
            anchorRestoreRef.current = null
            loadLockRef.current = false
            console.error('Failed to load older messages:', error)
        }).finally(() => {
            if (!loadStartedRef.current && !isLoadingMoreRef.current) {
                loadLockRef.current = false
            }
        })
    }, [captureScrollAnchor, props.hasMoreMessages, props.isLoadingMoreMessages, props.isLoadingMessages, props.onLoadMore])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        handleLoadMore()
                    }
                }
            },
            {
                root: viewport,
                rootMargin: '200px 0px 0px 0px'
            }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [handleLoadMore, props.hasMoreMessages, props.isLoadingMessages])

    // 复现：先停在中间位置，再加载更早消息；如果图片或工具卡稍后撑高，锚点消息应仍停在原位。
    useLayoutEffect(() => {
        if (anchorRestoreRef.current) {
            restoreScrollAnchor(true)
            loadLockRef.current = false
            return
        }

        if (autoScrollEnabledRef.current) {
            const viewport = viewportRef.current
            if (viewport) {
                viewport.scrollTop = viewport.scrollHeight
            }
        }
    }, [props.rawMessagesCount, restoreScrollAnchor])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            if (anchorRestoreRef.current) {
                restoreScrollAnchor(false)
                return
            }

            if (autoScrollEnabledRef.current) {
                const viewport = viewportRef.current
                if (viewport) {
                    viewport.scrollTop = viewport.scrollHeight
                }
            }
        })

        observer.observe(content)
        return () => observer.disconnect()
    }, [restoreScrollAnchor])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (props.isLoadingMoreMessages) {
            loadStartedRef.current = true
        }
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages) {
            loadLockRef.current = false
            loadStartedRef.current = false
            if (anchorRestoreRef.current) {
                restoreScrollAnchor(true)
            }
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages, restoreScrollAnchor])

    return (
        <YohoRemoteChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                <ThreadPrimitive.Viewport asChild autoScroll={autoScrollEnabled}>
                    <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                        <div ref={contentRef} className="mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {props.isLoadingMessages ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.hasMoreMessages && !props.isLoadingMessages ? (
                                        <div className="py-1 mb-2">
                                            <div className="mx-auto w-fit">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleLoadMore}
                                                    disabled={props.isLoadingMoreMessages || props.isLoadingMessages}
                                                    aria-busy={props.isLoadingMoreMessages}
                                                    className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                                >
                                                    {props.isLoadingMoreMessages ? (
                                                        <>
                                                            <Spinner size="sm" label={null} className="text-current" />
                                                            Loading…
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span aria-hidden="true">↑</span>
                                                            Load older
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="flex flex-col gap-3">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                            {props.trailing}
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={newMessageCount} onClick={scrollToBottom} />
            </ThreadPrimitive.Root>
        </YohoRemoteChatProvider>
    )
}
