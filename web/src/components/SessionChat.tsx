import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type {
    DecryptedMessage,
    ModelMode,
    ModelReasoningEffort,
    Session,
    SessionViewer,
    TypingUser,
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { collectActiveMonitors } from '@/chat/activeMonitors'
import { YohoRemoteComposer } from '@/components/AssistantChat/YohoRemoteComposer'
import { YohoRemoteThread } from '@/components/AssistantChat/YohoRemoteThread'
import { BrainChildPageActionBar } from '@/components/BrainChildActions'
import { useYohoRemoteRuntime } from '@/lib/assistant-runtime'
import { SessionHeader } from '@/components/SessionHeader'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import {
    deriveBrainChildPageActionState,
    getBrainChildPageInactiveHint,
} from '@/lib/brainChildActions'
import {
    canQueueMessagesWhenInactive,
    shouldShowSessionComposer,
} from '@/lib/sessionActivity'
import {
    getSessionOrchestrationInactiveQueueCopy,
    getSessionOrchestrationReadyPhaseCopy,
    isSessionOrchestrationChildSource,
} from '@/lib/sessionOrchestration'
import {
    clearBrainSessionReadyMarker,
    deriveBrainCreationReadyPhase,
    getBrainSessionReadyMarker,
    hasBrainReadyFollowUpActivity,
} from '@/lib/brainReadyState'
import { queryKeys } from '@/lib/query-keys'
import { isLicenseTermination, getLicenseTerminationLabel } from '@/lib/license'
import { isFlutterApp } from '@/hooks/useFlutterApp'
import {
    useFlutterBridgeSessionActions,
    pushSessionHeader,
    pushComposerState,
    pushComposerReset,
    pushAutocompleteSuggestions,
    getSessionTitle,
    formatSessionModelLabelCompact,
    viewersToBadgeUsers,
} from '@/hooks/useFlutterBridge'
import {
    MODEL_MODES,
    MODEL_MODE_LABELS,
    CODEX_MODELS,
    GROK_MODELS,
    OPENROUTER_MODELS,
    isCodexModel,
} from '@/components/AssistantChat/YohoRemoteComposer'

export const MODEL_MODE_VALUES = new Set<string>([
    'default',
    'sonnet',
    'opus',
    'opus-4-7',
    'glm-5.1',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2',
])

export function coerceModelMode(
    value: string | null | undefined
): ModelMode | undefined {
    if (!value) {
        return undefined
    }
    if (MODEL_MODE_VALUES.has(value)) {
        return value as ModelMode
    }
    const normalized = value.toLowerCase()
    if (normalized.includes('opus-4-7')) {
        return 'opus-4-7'
    }
    if (normalized.includes('sonnet')) {
        return 'sonnet'
    }
    if (normalized.includes('opus')) {
        return 'opus'
    }
    return undefined
}

function getAvailableModels(session: Session): { id: string; label: string }[] {
    const flavor = session.metadata?.flavor ?? 'claude'
    if (flavor === 'claude') {
        return MODEL_MODES.map((m) => ({
            id: m,
            label: MODEL_MODE_LABELS[m] ?? m,
        }))
    }
    if (flavor === 'codex') {
        return CODEX_MODELS.map((m) => ({ id: m.id, label: m.label }))
    }
    if (flavor === 'grok') {
        return GROK_MODELS.map((m) => ({ id: m.id, label: m.label }))
    }
    return OPENROUTER_MODELS.map((m) => ({ id: m.id, label: m.label }))
}

type ResumePhase = 'idle' | 'pending' | 'resolving'

export type SessionConnectionState = 'active' | 'reconnecting' | 'inactive'

export function getSessionConnectionState(
    session: Pick<Session, 'active' | 'reconnecting'>
): SessionConnectionState {
    if (session.reconnecting) {
        return 'reconnecting'
    }
    return session.active ? 'active' : 'inactive'
}

export function getSessionChatConnectionNotices(options: {
    connectionState: SessionConnectionState
    showComposer: boolean
    isResuming: boolean
    resumeError: string | null
    messageCount: number
    brainChildInactiveHint: string | null
    terminationReason?: string | null
    canQueueWhileInactive: boolean
}): {
    reconnectingText: string | null
    inactiveText: string | null
    licenseTerminationText: string | null
} {
    const {
        connectionState,
        showComposer,
        isResuming,
        resumeError,
        messageCount,
        brainChildInactiveHint,
        terminationReason,
        canQueueWhileInactive,
    } = options

    const reconnectingText =
        connectionState === 'reconnecting'
            ? showComposer
                ? 'Session is reconnecting. New messages will queue until it is ready.'
                : (brainChildInactiveHint ??
                  'Session is reconnecting. Orchestration child pages do not accept manual input.')
            : null

    const licenseTerminationText =
        !reconnectingText && isLicenseTermination(terminationReason)
            ? `Session terminated — ${getLicenseTerminationLabel(terminationReason!).toLowerCase()}. Contact your administrator.`
            : null

    const inactiveText =
        !reconnectingText &&
        connectionState === 'inactive' &&
        !canQueueWhileInactive
            ? isResuming
                ? 'Resuming session...'
                : resumeError
                  ? showComposer
                      ? 'Resume failed. Tap the composer to retry.'
                      : (brainChildInactiveHint ??
                        'Resume failed. Orchestration child pages do not accept manual input.')
                  : messageCount === 0
                    ? (brainChildInactiveHint ?? 'Starting session...')
                    : showComposer
                      ? 'Session is inactive. Tap the composer to resume.'
                      : (brainChildInactiveHint ??
                        'Session is inactive. Orchestration child pages do not accept manual input.')
            : null

    return {
        reconnectingText,
        inactiveText,
        licenseTerminationText,
    }
}

export function SessionChat(props: {
    api: ApiClient
    session: Session
    viewers?: SessionViewer[]
    messages: DecryptedMessage[]
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onSend: (text: string) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    otherUserTyping?: TypingUser | null
    currentUserEmail?: string | null
}) {
    const { haptic } = usePlatform()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const connectionState = getSessionConnectionState(props.session)
    const reconnecting = connectionState === 'reconnecting'
    const canQueueWhileInactive = canQueueMessagesWhenInactive(props.session)
    const controlsDisabled =
        connectionState !== 'active' && !canQueueWhileInactive
    const showComposer = shouldShowSessionComposer(props.session)
    const brainChildActionState = useMemo(
        () => deriveBrainChildPageActionState(props.session),
        [props.session]
    )
    const childSessionSource = props.session.metadata?.source ?? null
    const isOrchestrationChildSession =
        isSessionOrchestrationChildSource(childSessionSource)

    // Only the session owner can read privacy mode (backend returns 403 for
    // non-owners). Skip the query for viewers/sharers to avoid noisy 403s.
    const isSessionOwner = Boolean(
        props.currentUserEmail &&
        props.session.createdBy &&
        props.session.createdBy === props.currentUserEmail
    )
    const { data: privacyData } = useQuery({
        queryKey: ['session-privacy-mode', props.session.id],
        queryFn: async () => props.api.getSessionPrivacyMode(props.session.id),
        enabled: Boolean(props.session.id) && isSessionOwner,
    })
    const privacyMode = privacyData?.privacyMode ?? false
    const normalizedCacheRef = useRef<
        Map<
            string,
            {
                source: DecryptedMessage
                normalized: NormalizedMessage | NormalizedMessage[] | null
            }
        >
    >(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const {
        abortSession,
        switchSession,
        setModelMode,
        setFastMode,
        deleteSession,
        refreshAccount,
        isPending,
    } = useSessionActions(props.api, props.session.id)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [isResuming, setIsResuming] = useState(false)
    const [resumeError, setResumeError] = useState<string | null>(null)
    const [brainReadyMarker, setBrainReadyMarker] = useState(() =>
        getBrainSessionReadyMarker(props.session.id)
    )
    const brainChildInactiveHint = useMemo(
        () =>
            isOrchestrationChildSession
                ? getBrainChildPageInactiveHint({
                      childSource: childSessionSource,
                      resumeError: Boolean(resumeError),
                      hasMainSessionId: Boolean(
                          brainChildActionState.mainSessionId
                      ),
                      hasMessages: props.messages.length > 0,
                  })
                : null,
        [
            brainChildActionState.mainSessionId,
            childSessionSource,
            isOrchestrationChildSession,
            props.messages.length,
            resumeError,
        ]
    )
    const resumeQueueRef = useRef<string[]>([])
    const resumePhaseRef = useRef<ResumePhase>('idle')
    const resumeInFlightRef = useRef(false)
    const composerSetTextRef = useRef<((text: string) => void) | null>(null)

    const setResumePhase = useCallback((phase: ResumePhase) => {
        resumePhaseRef.current = phase
        setIsResuming(phase !== 'idle')
    }, [])

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
        resumeQueueRef.current = []
        resumePhaseRef.current = 'idle'
        resumeInFlightRef.current = false
        setIsResuming(false)
        setResumeError(null)
        setBrainReadyMarker(getBrainSessionReadyMarker(props.session.id))
    }, [props.session.id])

    // Update browser title with AI name
    useEffect(() => {
        const name = props.session.metadata?.name
        if (name) {
            document.title = name
        }
        return () => {
            document.title = 'Yoho Remote'
        }
    }, [props.session.metadata?.name])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) {
                    if (Array.isArray(cached.normalized)) {
                        normalized.push(...cached.normalized)
                    } else {
                        normalized.push(cached.normalized)
                    }
                }
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) {
                if (Array.isArray(next)) {
                    normalized.push(...next)
                } else {
                    normalized.push(next)
                }
            }
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [props.messages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    // Model mode change handler
    const handleModelModeChange = useCallback(
        async (config: {
            model: ModelMode
            reasoningEffort?: ModelReasoningEffort | null
        }) => {
            try {
                await setModelMode(config)
                haptic.notification('success')
                props.onRefresh()
            } catch (e) {
                haptic.notification('error')
                console.error('Failed to set model mode:', e)
            }
        },
        [setModelMode, props.onRefresh, haptic]
    )

    // Fast mode change handler
    const handleFastModeChange = useCallback(
        async (fastMode: boolean) => {
            try {
                await setFastMode(fastMode)
                haptic.notification('success')
            } catch (e) {
                haptic.notification('error')
                console.error('Failed to set fast mode:', e)
                throw e // Re-throw so optimistic UI can revert
            }
        },
        [setFastMode, haptic]
    )

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleDeleteClick = useCallback(() => {
        setDeleteDialogOpen(true)
    }, [])

    const handleDeleteConfirm = useCallback(async () => {
        setDeleteDialogOpen(false)
        try {
            await deleteSession()
            haptic.notification('success')
            props.onBack()
        } catch (error) {
            haptic.notification('error')
            console.error('Failed to delete session:', error)
        }
    }, [deleteSession, haptic, props])

    const handleRefreshAccount = useCallback(async () => {
        try {
            const result = await refreshAccount()
            if (result?.usedResume && result.resumeVerified === false) {
                console.warn(
                    '[session] refresh-account: resume failed, fallback context sent',
                    result
                )
            }
            haptic.notification('success')
        } catch (error) {
            haptic.notification('error')
            console.error('Failed to refresh account:', error)
        }
    }, [refreshAccount, haptic])

    const sendPendingMessage = useCallback(
        async (sessionId: string, text: string) => {
            const trimmed = text.trim()
            if (!trimmed) return
            if (sessionId === props.session.id) {
                props.onSend(trimmed)
                return
            }
            await props.api.sendMessage(sessionId, trimmed)
        },
        [props.api, props.onSend, props.session.id]
    )

    const enqueueResumeText = useCallback(
        (pendingText: string) => {
            const trimmed = pendingText.trim()
            if (!trimmed) {
                return false
            }

            resumeQueueRef.current.push(trimmed)
            if (resumePhaseRef.current === 'idle') {
                setResumePhase('pending')
            }
            return true
        },
        [setResumePhase]
    )

    const flushResumeQueue = useCallback(
        async (sessionId: string) => {
            while (resumeQueueRef.current.length > 0) {
                const next = resumeQueueRef.current.shift()
                if (!next) {
                    continue
                }

                try {
                    await sendPendingMessage(sessionId, next)
                } catch (error) {
                    resumeQueueRef.current.unshift(next)
                    throw error
                }
            }
        },
        [sendPendingMessage]
    )

    const resumeSession = useCallback(
        async (pendingText?: string) => {
            if (pendingText) {
                enqueueResumeText(pendingText)
            }
            if (resumeInFlightRef.current) {
                return
            }

            if (
                connectionState === 'active' &&
                resumeQueueRef.current.length === 0
            ) {
                setResumePhase('idle')
                return
            }

            resumeInFlightRef.current = true
            if (
                resumeQueueRef.current.length > 0 ||
                connectionState !== 'active'
            ) {
                setResumePhase('resolving')
            }
            setResumeError(null)
            let completedNormally = false
            try {
                let targetSessionId = props.session.id

                if (connectionState !== 'active') {
                    const result = await props.api.resumeSession(
                        props.session.id
                    )
                    targetSessionId = result.sessionId
                    await queryClient.invalidateQueries({
                        queryKey: queryKeys.sessions,
                    })
                    props.onRefresh()

                    if (
                        result.type === 'created' &&
                        result.sessionId !== props.session.id
                    ) {
                        await flushResumeQueue(targetSessionId)
                        navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: result.sessionId },
                        })
                        return
                    }
                }

                await flushResumeQueue(targetSessionId)
                completedNormally = true
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : 'Failed to resume session'
                setResumeError(message)
                haptic.notification('error')
                console.error('Failed to resume session:', error)
            } finally {
                resumeInFlightRef.current = false
                if (
                    completedNormally &&
                    connectionState === 'active' &&
                    resumeQueueRef.current.length > 0
                ) {
                    setResumePhase('pending')
                    void resumeSession()
                } else if (resumeQueueRef.current.length > 0) {
                    setResumePhase('pending')
                } else {
                    setResumePhase('idle')
                }
            }
        },
        [
            enqueueResumeText,
            haptic,
            navigate,
            props.api,
            props.onRefresh,
            connectionState,
            props.session.id,
            queryClient,
            flushResumeQueue,
            setResumePhase,
        ]
    )

    const handleResumeRequest = useCallback(() => {
        void resumeSession()
    }, [resumeSession])

    const handleSendMessage = useCallback(
        (text: string) => {
            if (connectionState === 'active') {
                props.onSend(text)
                return
            }
            void resumeSession(text)
        },
        [connectionState, props.onSend, resumeSession]
    )

    const runtime = useYohoRemoteRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSendMessage,
        onAbort: handleAbort,
    })
    const activeMonitors = useMemo(
        () =>
            props.session.activeMonitors ??
            collectActiveMonitors(reconciled.blocks),
        [props.session.activeMonitors, reconciled.blocks]
    )
    const brainCreationReadyPhase = useMemo(
        () =>
            deriveBrainCreationReadyPhase({
                source: props.session.metadata?.source,
                active: props.session.active,
                thinking: props.session.thinking,
                marker: brainReadyMarker,
            }),
        [
            brainReadyMarker,
            props.session.active,
            props.session.metadata?.source,
            props.session.thinking,
        ]
    )
    const resolvedModelMode = useMemo(() => {
        const fallbackMode = coerceModelMode(
            props.session.metadata?.runtimeModel
        )
        if (props.session.modelMode && props.session.modelMode !== 'default') {
            return props.session.modelMode
        }
        return fallbackMode ?? props.session.modelMode
    }, [props.session.modelMode, props.session.metadata?.runtimeModel])
    const resolvedReasoningEffort =
        props.session.modelReasoningEffort ??
        props.session.metadata?.runtimeModelReasoningEffort

    useEffect(() => {
        if (!brainReadyMarker || brainCreationReadyPhase !== 'ready') {
            return
        }
        if (!hasBrainReadyFollowUpActivity(props.messages)) {
            return
        }
        clearBrainSessionReadyMarker(props.session.id)
        setBrainReadyMarker(null)
    }, [
        brainCreationReadyPhase,
        brainReadyMarker,
        props.messages,
        props.session.id,
    ])

    const availableModels = useMemo(
        () => getAvailableModels(props.session),
        [props.session]
    )

    const handleBridgeSendMessage = useCallback(
        (text: string) => {
            if (!showComposer) {
                pushComposerReset(props.session.id)
                return
            }
            handleSendMessage(text)
            pushComposerReset(props.session.id)
        },
        [handleSendMessage, props.session.id, showComposer]
    )

    const handleBridgeSetModel = useCallback(
        (model: string) => {
            const coerced = coerceModelMode(model) ?? 'default'
            void handleModelModeChange({
                model: coerced,
                reasoningEffort: resolvedReasoningEffort ?? null,
            })
        },
        [handleModelModeChange, resolvedReasoningEffort]
    )

    const handleBridgeSetReasoningLevel = useCallback(
        (level: string) => {
            const effort = ['low', 'medium', 'high', 'xhigh'].includes(level)
                ? (level as ModelReasoningEffort)
                : undefined
            void handleModelModeChange({
                model: resolvedModelMode ?? 'default',
                reasoningEffort: effort ?? null,
            })
        },
        [handleModelModeChange, resolvedModelMode]
    )

    const handleBridgeShare = useCallback(() => {
        const url = `${window.location.origin}/sessions/${props.session.id}`
        void navigator.clipboard.writeText(url)
    }, [props.session.id])

    const handleBridgeTogglePrivacy = useCallback(async () => {
        try {
            const result = await props.api.setSessionPrivacyMode(
                props.session.id,
                !privacyMode
            )
            queryClient.setQueryData(
                ['session-privacy-mode', props.session.id],
                {
                    privacyMode: result.privacyMode,
                }
            )
        } catch (e) {
            console.error('Failed to toggle privacy:', e)
        }
    }, [props.api, props.session.id, privacyMode, queryClient])

    const handleBridgeUploadImages = useCallback(
        async (images: string[]) => {
            if (!showComposer) return
            for (const image of images) {
                try {
                    const mimeType = image.startsWith('data:image/png')
                        ? 'image/png'
                        : 'image/jpeg'
                    const base64Content = image.split(',')[1] ?? image
                    const filename = `upload-${Date.now()}.jpg`
                    await props.api.uploadImage(
                        props.session.id,
                        filename,
                        base64Content,
                        mimeType
                    )
                } catch (e) {
                    console.error('Failed to upload image:', e)
                }
            }
        },
        [props.api, props.session.id, showComposer]
    )

    const handleBridgeUploadFiles = useCallback(
        async (files: { name: string; data: string }[]) => {
            if (!showComposer) return
            for (const file of files) {
                try {
                    const mimeType = 'application/octet-stream'
                    const base64Content = file.data.split(',')[1] ?? file.data
                    await props.api.uploadFile(
                        props.session.id,
                        file.name,
                        base64Content,
                        mimeType
                    )
                } catch (e) {
                    console.error('Failed to upload file:', e)
                }
            }
        },
        [props.api, props.session.id, showComposer]
    )

    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleBridgeTyping = useCallback(() => {
        if (!showComposer) return
        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current)
        }
        typingTimeoutRef.current = setTimeout(() => {
            props.api.sendTyping(props.session.id, '').catch(() => {})
        }, 300)
    }, [props.api, props.session.id, showComposer])

    const handleBridgeRequestAutocomplete = useCallback(
        async (prefix: string) => {
            if (!showComposer || !props.autocompleteSuggestions) return
            const suggestions = await props.autocompleteSuggestions(prefix)
            pushAutocompleteSuggestions(
                suggestions.map((s) => ({
                    type: s.text.startsWith('@') ? 'file' : 'command',
                    label: s.label,
                    value: s.text,
                    description: s.description,
                }))
            )
        },
        [props.autocompleteSuggestions, showComposer]
    )

    useEffect(() => {
        if (!showComposer) {
            pushComposerReset(props.session.id)
        }
    }, [props.session.id, showComposer])

    useEffect(() => {
        return () => {
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current)
            }
        }
    }, [])

    useFlutterBridgeSessionActions({
        sessionId: props.session.id,
        onSend: handleBridgeSendMessage,
        onAbort: handleAbort,
        onTogglePrivacy: handleBridgeTogglePrivacy,
        onShare: handleBridgeShare,
        onRefreshAccount: handleRefreshAccount,
        onDelete: handleDeleteConfirm,
        onSetModel: handleBridgeSetModel,
        onSetFastMode: handleFastModeChange,
        onSetReasoningLevel: handleBridgeSetReasoningLevel,
        onRequestAutocomplete: handleBridgeRequestAutocomplete,
        onTyping: handleBridgeTyping,
        onUploadImages: handleBridgeUploadImages,
        onUploadFiles: handleBridgeUploadFiles,
    })
    const connectionNotices = getSessionChatConnectionNotices({
        connectionState,
        showComposer,
        isResuming,
        resumeError,
        messageCount: props.messages.length,
        brainChildInactiveHint,
        terminationReason: props.session.terminationReason,
        canQueueWhileInactive,
    })

    // Push session header to Flutter
    useEffect(() => {
        if (!isFlutterApp()) return
        pushSessionHeader({
            id: props.session.id,
            title: getSessionTitle(props.session),
            agentMeta: {
                label: formatSessionModelLabelCompact(props.session),
                model: props.session.metadata?.runtimeModel ?? undefined,
                agent: props.session.metadata?.runtimeAgent ?? undefined,
                machine: props.session.metadata?.machineId ?? undefined,
                project: props.session.metadata?.path ?? undefined,
                branch: props.session.metadata?.worktree?.branch ?? undefined,
            },
            viewers: viewersToBadgeUsers(props.viewers),
            isPrivate: privacyMode,
            isGenerating: props.session.thinking ?? false,
        })
    }, [props.session, props.viewers, privacyMode])

    // Push composer state to Flutter
    useEffect(() => {
        if (!isFlutterApp()) return
        const contextSizeNum = reduced.latestUsage?.contextSize ?? 0
        const modelContextWindowNum =
            reduced.latestUsage?.modelContextWindow ?? 0
        pushComposerState({
            isConnected: true,
            contextUsage: {
                used: contextSizeNum,
                total: modelContextWindowNum,
            },
            rateLimit: {
                remaining: Math.max(
                    0,
                    100 -
                        Math.round(
                            reduced.latestUsage?.rateLimitUsedPercent ?? 0
                        )
                ),
            },
            isTyping: Boolean(props.otherUserTyping),
            selectedModel: resolvedModelMode ?? 'default',
            fastMode: props.session.fastMode ?? false,
            reasoningLevel: resolvedReasoningEffort ?? 'medium',
            canSend:
                showComposer &&
                !props.isSending &&
                !isResuming &&
                (props.session.active || reconnecting || canQueueWhileInactive),
            isGenerating: props.session.thinking ?? false,
            availableModels,
        })
    }, [
        props.session,
        props.isSending,
        props.otherUserTyping,
        isResuming,
        reconnecting,
        canQueueWhileInactive,
        resolvedModelMode,
        resolvedReasoningEffort,
        showComposer,
        availableModels,
        reduced.latestUsage?.contextSize,
        reduced.latestUsage?.modelContextWindow,
        reduced.latestUsage?.rateLimitUsedPercent,
    ])

    return (
        <div className="flex h-full">
            {/* 主聊天区域 */}
            <div className="flex h-full flex-1 flex-col min-w-0">
                <SessionHeader
                    session={props.session}
                    viewers={props.viewers}
                    onBack={props.onBack}
                    onDelete={handleDeleteClick}
                    onRefreshAccount={
                        props.session.metadata?.flavor === 'claude'
                            ? handleRefreshAccount
                            : undefined
                    }
                    deleteDisabled={isPending}
                    refreshAccountDisabled={isPending}
                    modelMode={resolvedModelMode}
                    modelReasoningEffort={resolvedReasoningEffort}
                />

                <Dialog
                    open={deleteDialogOpen}
                    onOpenChange={setDeleteDialogOpen}
                >
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Delete Session</DialogTitle>
                            <DialogDescription>
                                {props.session.active
                                    ? 'This session is still active. Delete it and remove all messages? This will stop the session.'
                                    : 'Delete this session and all messages? This cannot be undone.'}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setDeleteDialogOpen(false)}
                                className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteConfirm}
                                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
                            >
                                Delete
                            </button>
                        </div>
                    </DialogContent>
                </Dialog>

                {isOrchestrationChildSession ? (
                    <BrainChildPageActionBar
                        api={props.api}
                        sessionId={props.session.id}
                        mainSessionId={brainChildActionState.mainSessionId}
                        childSource={childSessionSource}
                        canStop={brainChildActionState.canStop}
                        canResume={brainChildActionState.canResume}
                        onStop={handleAbort}
                        onResume={async () => {
                            await resumeSession()
                        }}
                        initialMessages={props.messages}
                    />
                ) : null}

                {connectionNotices.reconnectingText ? (
                    <div className="px-3 pt-3">
                        <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                            {connectionNotices.reconnectingText}
                        </div>
                    </div>
                ) : null}

                {connectionNotices.licenseTerminationText ? (
                    <div className="px-3 pt-3">
                        <div className="mx-auto w-full max-w-content rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-600 dark:text-red-400">
                            {connectionNotices.licenseTerminationText}
                        </div>
                    </div>
                ) : null}

                {connectionNotices.inactiveText ? (
                    <div className="px-3 pt-3">
                        <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                            {connectionNotices.inactiveText}
                        </div>
                    </div>
                ) : null}

                {brainCreationReadyPhase ? (
                    <div className="px-3 pt-3">
                        <div
                            className={`mx-auto w-full max-w-content rounded-md border p-3 text-sm ${
                                brainCreationReadyPhase === 'created'
                                    ? 'border-sky-500/20 bg-sky-500/10 text-sky-700'
                                    : brainCreationReadyPhase === 'initializing'
                                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-700'
                                      : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700'
                            }`}
                        >
                            {getSessionOrchestrationReadyPhaseCopy(
                                props.session.metadata?.source,
                                brainCreationReadyPhase
                            ) ??
                                '可开始使用：Brain 已准备就绪，现在可以开始派发任务。'}
                        </div>
                    </div>
                ) : null}

                {!brainCreationReadyPhase &&
                connectionState === 'inactive' &&
                canQueueWhileInactive ? (
                    <div className="px-3 pt-3">
                        <div className="mx-auto flex w-full max-w-content items-center justify-between gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700">
                            <span>
                                {getSessionOrchestrationInactiveQueueCopy(
                                    props.session.metadata?.source
                                ) ??
                                    'Session 当前未运行。新消息会先入队，等恢复后再消费。'}
                            </span>
                            <button
                                type="button"
                                onClick={handleResumeRequest}
                                className="shrink-0 rounded-md border border-amber-500/30 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/10"
                            >
                                立即恢复
                            </button>
                        </div>
                    </div>
                ) : null}

                <AssistantRuntimeProvider runtime={runtime}>
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        <YohoRemoteThread
                            key={props.session.id}
                            api={props.api}
                            sessionId={props.session.id}
                            metadata={props.session.metadata}
                            disabled={controlsDisabled}
                            onRefresh={props.onRefresh}
                            onRetryMessage={props.onRetryMessage}
                            isLoadingMessages={props.isLoadingMessages}
                            hasMoreMessages={props.hasMoreMessages}
                            isLoadingMoreMessages={props.isLoadingMoreMessages}
                            onLoadMore={props.onLoadMore}
                            rawMessagesCount={props.messages.length}
                            normalizedMessagesCount={normalizedMessages.length}
                            renderedMessagesCount={reconciled.blocks.length}
                        />

                        {showComposer ? (
                            <YohoRemoteComposer
                                apiClient={props.api}
                                sessionId={props.session.id}
                                disabled={
                                    props.isSending ||
                                    isResuming ||
                                    controlsDisabled
                                }
                                modelMode={resolvedModelMode}
                                modelReasoningEffort={resolvedReasoningEffort}
                                fastMode={props.session.fastMode}
                                agentFlavor={
                                    props.session.metadata?.flavor ?? 'claude'
                                }
                                active={props.session.active}
                                allowInactiveQueueing={canQueueWhileInactive}
                                thinking={props.session.thinking}
                                agentState={props.session.agentState}
                                contextSize={reduced.latestUsage?.contextSize}
                                outputTokens={reduced.latestUsage?.outputTokens}
                                modelContextWindow={
                                    reduced.latestUsage?.modelContextWindow
                                }
                                rateLimitUsedPercent={
                                    reduced.latestUsage?.rateLimitUsedPercent
                                }
                                runtimeModel={
                                    props.session.metadata?.runtimeModel
                                }
                                controlledByUser={
                                    props.session.agentState
                                        ?.controlledByUser === true
                                }
                                onRequestResume={handleResumeRequest}
                                resumePending={isResuming}
                                resumeError={resumeError}
                                reconnecting={reconnecting}
                                onModelModeChange={handleModelModeChange}
                                onFastModeChange={handleFastModeChange}
                                onSwitchToRemote={handleSwitchToRemote}
                                autocompleteSuggestions={
                                    props.autocompleteSuggestions
                                }
                                otherUserTyping={props.otherUserTyping}
                                setTextRef={composerSetTextRef}
                                activeMonitors={activeMonitors}
                            />
                        ) : null}
                    </div>
                </AssistantRuntimeProvider>
            </div>
        </div>
    )
}
