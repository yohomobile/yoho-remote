import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Spinner } from '@/components/Spinner'
import { usePlatform } from '@/hooks/usePlatform'
import { isExitPlanModeToolName } from '@/components/ToolCard/planMode'

function ActionButton(props: {
    label: string
    tone: 'allow' | 'deny'
    disabled: boolean
    loading: boolean
    onClick: () => void
}) {
    const toneClass = props.tone === 'allow' ? 'text-emerald-600' : 'text-red-600'

    return (
        <button
            type="button"
            className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] disabled:pointer-events-none disabled:opacity-50 ${toneClass}`}
            disabled={props.disabled}
            aria-busy={props.loading}
            onClick={props.onClick}
        >
            <span className="flex-1">{props.label}</span>
            {props.loading ? (
                <span className="ml-2 shrink-0">
                    <Spinner size="sm" label={null} className="text-current" />
                </span>
            ) : null}
        </button>
    )
}

export function ExitPlanModeFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const [loading, setLoading] = useState<'approve' | 'deny' | null>(null)
    const [error, setError] = useState<string | null>(null)

    if (!isExitPlanModeToolName(props.tool.name)) return null

    const requestId = permission?.id ?? props.tool.id
    const isInteractive = permission?.status === 'pending'
        || (!permission && (props.tool.state === 'pending' || props.tool.state === 'running'))

    if (!isInteractive) {
        return null
    }

    const run = async (action: () => Promise<void>, type: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(type)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Request failed')
        }
    }

    const approve = async () => {
        if (loading) return
        setLoading('approve')
        await run(() => props.api.approvePermission(props.sessionId, requestId), 'success')
        setLoading(null)
    }

    const deny = async () => {
        if (loading) return
        setLoading('deny')
        await run(() => props.api.denyPermission(props.sessionId, requestId), 'success')
        setLoading(null)
    }

    return (
        <div className="mt-2">
            <div className="text-xs text-[var(--app-hint)]">
                {permission ? 'Waiting for plan approval…' : 'Syncing plan approval state…'}
            </div>

            {error ? (
                <div className="mt-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="mt-2 flex flex-col gap-1">
                <ActionButton
                    label="Approve plan"
                    tone="allow"
                    loading={loading === 'approve'}
                    disabled={props.disabled || loading !== null}
                    onClick={approve}
                />
                <ActionButton
                    label="Reject plan"
                    tone="deny"
                    loading={loading === 'deny'}
                    disabled={props.disabled || loading !== null}
                    onClick={deny}
                />
            </div>
        </div>
    )
}
