import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { extractBrainChildTailPreview, type BrainChildTailPreviewItem } from '@/lib/brainChildActions'

type TailDialogState = {
    open: boolean
    loading: boolean
    error: string | null
    items: BrainChildTailPreviewItem[]
}

function formatTailTime(createdAt: number): string {
    return new Date(createdAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    })
}

function useTailDialog(
    api: ApiClient,
    sessionId: string,
    initialMessages?: DecryptedMessage[],
) {
    const initialItems = useMemo(
        () => extractBrainChildTailPreview(initialMessages ?? [], 8),
        [initialMessages]
    )
    const [state, setState] = useState<TailDialogState>({
        open: false,
        loading: false,
        error: null,
        items: initialItems,
    })

    const load = useCallback(async () => {
        setState((current) => ({
            ...current,
            open: true,
            loading: true,
            error: null,
        }))

        try {
            const response = await api.getMessages(sessionId, { limit: 80 })
            setState({
                open: true,
                loading: false,
                error: null,
                items: extractBrainChildTailPreview(response.messages, 8),
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : '加载最近片段失败'
            setState((current) => ({
                ...current,
                open: true,
                loading: false,
                error: message,
            }))
        }
    }, [api, sessionId])

    return {
        state,
        open: () => {
            void load()
        },
        onOpenChange: (open: boolean) => {
            setState((current) => ({ ...current, open }))
        },
    }
}

function TailDialog(props: {
    state: TailDialogState
    onOpenChange: (open: boolean) => void
}) {
    return (
        <Dialog open={props.state.open} onOpenChange={props.onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>最近片段</DialogTitle>
                    <DialogDescription>
                        基于已同步消息生成的最近输入、输出和关键事件片段，仅用于观察和定位，不等同于 runtime tail。
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-4">
                    {props.state.loading ? (
                        <div className="text-sm text-[var(--app-hint)]">正在加载最近片段…</div>
                    ) : props.state.error ? (
                        <div className="text-sm text-red-600">{props.state.error}</div>
                    ) : props.state.items.length === 0 ? (
                        <div className="text-sm text-[var(--app-hint)]">暂无可展示的最近片段。</div>
                    ) : (
                        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                            {props.state.items.map((item) => (
                                <div
                                    key={item.id}
                                    className="rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
                                >
                                    <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--app-hint)]">
                                        <span>{item.label}</span>
                                        <span>{formatTailTime(item.createdAt)}</span>
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">
                                        {item.snippet}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function ActionButton(props: React.ComponentProps<typeof Button>) {
    return (
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" {...props} />
    )
}

export function BrainChildPageActionBar(props: {
    api: ApiClient
    sessionId: string
    mainSessionId: string | null
    canStop: boolean
    canResume: boolean
    onStop: () => Promise<void> | void
    onResume: () => Promise<void> | void
    initialMessages?: DecryptedMessage[]
}) {
    const navigate = useNavigate()
    const [stopPending, setStopPending] = useState(false)
    const [resumePending, setResumePending] = useState(false)
    const tailDialog = useTailDialog(props.api, props.sessionId, props.initialMessages)

    const handleStop = useCallback(async () => {
        setStopPending(true)
        try {
            await props.onStop()
        } catch (error) {
            console.error('Failed to stop brain child session:', error)
        } finally {
            setStopPending(false)
        }
    }, [props])

    const handleResume = useCallback(async () => {
        setResumePending(true)
        try {
            await props.onResume()
        } catch (error) {
            console.error('Failed to resume brain child session:', error)
        } finally {
            setResumePending(false)
        }
    }, [props])

    return (
        <>
            <div className="sticky top-0 z-10 border-b border-[var(--app-divider)] bg-[var(--app-bg)]/95 backdrop-blur">
                <div className="mx-auto flex w-full max-w-content flex-wrap items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1 text-sm text-[var(--app-hint)]">
                        <span className="font-medium text-[var(--app-fg)]">仅观察页</span>
                        <span className="ml-2">子任务仍由主 Brain 编排，这里不开放手工发消息。</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <ActionButton
                            disabled={!props.mainSessionId}
                            onClick={() => {
                                if (!props.mainSessionId) return
                                void navigate({
                                    to: '/sessions/$sessionId',
                                    params: { sessionId: props.mainSessionId }
                                })
                            }}
                        >
                            返回主 Brain
                        </ActionButton>
                        <ActionButton onClick={tailDialog.open}>
                            查看最近片段
                        </ActionButton>
                        <ActionButton
                            disabled={!props.canStop || stopPending}
                            onClick={() => {
                                void handleStop()
                            }}
                        >
                            {stopPending ? '停止中…' : '停止当前任务'}
                        </ActionButton>
                        <ActionButton
                            disabled={!props.canResume || resumePending}
                            onClick={() => {
                                void handleResume()
                            }}
                        >
                            {resumePending ? '恢复中…' : '恢复 session'}
                        </ActionButton>
                    </div>
                </div>
            </div>
            <TailDialog state={tailDialog.state} onOpenChange={tailDialog.onOpenChange} />
        </>
    )
}

export function BrainChildCallbackActions(props: {
    api: ApiClient
    sessionId: string
}) {
    const navigate = useNavigate()
    const tailDialog = useTailDialog(props.api, props.sessionId)

    return (
        <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                <ActionButton
                    onClick={() => {
                        void navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: props.sessionId }
                        })
                    }}
                >
                    打开子任务
                </ActionButton>
                <ActionButton onClick={tailDialog.open}>
                    查看最近片段
                </ActionButton>
            </div>
            <TailDialog state={tailDialog.state} onOpenChange={tailDialog.onOpenChange} />
        </>
    )
}
