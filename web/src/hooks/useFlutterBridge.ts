import { useEffect, useRef } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { isFlutterApp, callNativeHandler } from '@/hooks/useFlutterApp'
import { useAppContext } from '@/lib/app-context'
import type { Session, SessionViewer, Project } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

declare global {
  interface Window {
    YohoApp?: {
      on(event: string, cb: (data?: unknown) => void): void
      off(event: string): void
      _dispatch(event: string, data?: unknown): void
      onPushNotificationTapped(data: unknown): void
      onTokensRestored(tokens: unknown): void
      onAppResumed(): void
      navigate?(path: string): void
      sendMessage?(data: { text: string; localId: string }): void
      uploadImages?(images: string[]): void
      uploadFiles?(files: { name: string; data: string }[]): void
      abortGeneration?(): void
      resumeGeneration?(): void
      togglePrivacy?(): void
      shareSession?(): void
      refreshAccount?(): void
      deleteSession?(): void
      setModel?(model: string): void
      setFastMode?(enabled: boolean): void
      setReasoningLevel?(level: string): void
      requestAutocomplete?(prefix: string): void
      typing?(): void
      createSession?(): void
      createBrainSession?(): void
      refreshSessions?(): void
      logout?(): void
    }
  }
}

// Simple throttled push helper
function throttledPush<T>(name: string, delay = 100) {
  let lastData: string | null = null
  let timer: number | null = null
  return (data: T) => {
    const json = JSON.stringify(data)
    if (lastData === json) return
    lastData = json
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void callNativeHandler(name, data)
    }, delay)
  }
}

export const pushRouteChanged = throttledPush<{ path: string }>('routeChanged', 50)
export const pushSessionsHeader = throttledPush<{
  orgName?: string
  onlineUsers: { name: string; color: string }[]
  activeCount: number
  gitHash: string
}>('updateSessionsHeader', 200)

export const pushSessionHeader = throttledPush<{
  id: string
  title: string
  agentMeta?: { label?: string; model?: string; agent?: string; machine?: string; project?: string; branch?: string }
  viewers: { name: string; color: string }[]
  isPrivate: boolean
  isGenerating: boolean
}>('updateSessionHeader', 200)

export const pushComposerState = throttledPush<{
  isConnected: boolean
  contextUsage: { used: number; total: number }
  rateLimit: { remaining: number; reset?: number }
  isTyping: boolean
  selectedModel: string
  fastMode: boolean
  reasoningLevel: string
  canSend: boolean
  isGenerating: boolean
  availableModels: { id: string; label: string }[]
}>('updateComposerState', 200)

export const pushAutocompleteSuggestions = throttledPush<
  { type: string; label: string; value: string; description?: string }[]
>('autocompleteSuggestions', 50)

export const pushComposerReset = (sessionId: string) => {
  void callNativeHandler('composerReset', { sessionId })
}

function generateColor(seed: string): string {
  const colors = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#22c55e', '#14b8a6',
    '#06b6d4', '#3b82f6', '#a855f7', '#d946ef',
  ]
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

export function useFlutterBridge() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { api } = useAppContext()
  const handlersRegistered = useRef(false)

  // Push route changes to Flutter
  useEffect(() => {
    if (!isFlutterApp()) return
    pushRouteChanged({ path: location.pathname })
  }, [location.pathname])

  // Register global action handlers
  useEffect(() => {
    if (!isFlutterApp()) return
    if (handlersRegistered.current) return
    handlersRegistered.current = true

    if (!window.YohoApp) {
      const listeners: Record<string, (data?: unknown) => void> = {}
      const yohoBase = {
        on(event: string, cb: (data?: unknown) => void) { listeners[event] = cb },
        off(event: string) { delete listeners[event] },
        _dispatch(event: string, data?: unknown) {
          const cb = listeners[event]
          if (cb) cb(data)
        },
        onPushNotificationTapped(data: unknown) { window.YohoApp!._dispatch('pushNotificationTapped', data) },
        onTokensRestored(tokens: unknown) { window.YohoApp!._dispatch('tokensRestored', tokens) },
        onAppResumed() { window.YohoApp!._dispatch('appResumed') },
      } as Window['YohoApp']
      window.YohoApp = yohoBase
    }

    const yoho = window.YohoApp!

    yoho.navigate = (path) => {
      navigate({ to: path as never })
    }

    yoho.sendMessage = async ({ text, localId }) => {
      // Find current session chat and send
      // This is handled by pushing a custom event that SessionChat listens to
      window.dispatchEvent(new CustomEvent('yoho-bridge-send-message', { detail: { text, localId } }))
    }

    yoho.uploadImages = (images) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-upload-images', { detail: images }))
    }

    yoho.uploadFiles = (files) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-upload-files', { detail: files }))
    }

    yoho.abortGeneration = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-abort'))
    }

    yoho.resumeGeneration = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-resume'))
    }

    yoho.togglePrivacy = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-toggle-privacy'))
    }

    yoho.shareSession = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-share'))
    }

    yoho.refreshAccount = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-refresh-account'))
    }

    yoho.deleteSession = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-delete'))
    }

    yoho.setModel = (model) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-set-model', { detail: model }))
    }

    yoho.setFastMode = (enabled) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-set-fast-mode', { detail: enabled }))
    }

    yoho.setReasoningLevel = (level) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-set-reasoning-level', { detail: level }))
    }

    yoho.requestAutocomplete = (prefix) => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-request-autocomplete', { detail: prefix }))
    }

    yoho.typing = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-typing'))
    }

    yoho.createSession = () => {
      navigate({ to: '/sessions/new' })
    }

    yoho.createBrainSession = () => {
      navigate({ to: '/sessions/new', search: { kind: 'brain' } as never })
    }

    yoho.refreshSessions = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    yoho.logout = () => {
      window.dispatchEvent(new CustomEvent('yoho-bridge-logout'))
    }
  }, [navigate])
}

// Hook for SessionChat to listen to bridge actions
export function useFlutterBridgeSessionActions(props: {
  sessionId: string
  onSend: (text: string) => void
  onAbort: () => void
  onTogglePrivacy?: () => void
  onShare: () => void
  onRefreshAccount: () => void
  onDelete: () => void
  onSetModel: (model: string) => void
  onSetFastMode: (enabled: boolean) => void
  onSetReasoningLevel: (level: string) => void
  onRequestAutocomplete?: (prefix: string) => void
  onTyping?: () => void
  onUploadImages?: (images: string[]) => void
  onUploadFiles?: (files: { name: string; data: string }[]) => void
}) {
  useEffect(() => {
    if (!isFlutterApp()) return

    const handleSend = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.text) props.onSend(detail.text)
    }
    const handleAbort = () => props.onAbort()
    const handleTogglePrivacy = () => props.onTogglePrivacy?.()
    const handleShare = () => props.onShare()
    const handleRefreshAccount = () => props.onRefreshAccount()
    const handleDelete = () => props.onDelete()
    const handleSetModel = (e: Event) => props.onSetModel((e as CustomEvent).detail)
    const handleSetFastMode = (e: Event) => props.onSetFastMode((e as CustomEvent).detail)
    const handleSetReasoningLevel = (e: Event) => props.onSetReasoningLevel((e as CustomEvent).detail)
    const handleRequestAutocomplete = (e: Event) => {
      if (props.onRequestAutocomplete) props.onRequestAutocomplete((e as CustomEvent).detail)
    }
    const handleTyping = () => {
      if (props.onTyping) props.onTyping()
    }
    const handleUploadImages = (e: Event) => {
      if (props.onUploadImages) props.onUploadImages((e as CustomEvent).detail)
    }
    const handleUploadFiles = (e: Event) => {
      if (props.onUploadFiles) props.onUploadFiles((e as CustomEvent).detail)
    }

    window.addEventListener('yoho-bridge-send-message', handleSend)
    window.addEventListener('yoho-bridge-abort', handleAbort)
    if (props.onTogglePrivacy) window.addEventListener('yoho-bridge-toggle-privacy', handleTogglePrivacy)
    window.addEventListener('yoho-bridge-share', handleShare)
    window.addEventListener('yoho-bridge-refresh-account', handleRefreshAccount)
    window.addEventListener('yoho-bridge-delete', handleDelete)
    window.addEventListener('yoho-bridge-set-model', handleSetModel)
    window.addEventListener('yoho-bridge-set-fast-mode', handleSetFastMode)
    window.addEventListener('yoho-bridge-set-reasoning-level', handleSetReasoningLevel)
    window.addEventListener('yoho-bridge-request-autocomplete', handleRequestAutocomplete)
    window.addEventListener('yoho-bridge-typing', handleTyping)
    window.addEventListener('yoho-bridge-upload-images', handleUploadImages)
    window.addEventListener('yoho-bridge-upload-files', handleUploadFiles)

    return () => {
      window.removeEventListener('yoho-bridge-send-message', handleSend)
      window.removeEventListener('yoho-bridge-abort', handleAbort)
      if (props.onTogglePrivacy) window.removeEventListener('yoho-bridge-toggle-privacy', handleTogglePrivacy)
      window.removeEventListener('yoho-bridge-share', handleShare)
      window.removeEventListener('yoho-bridge-refresh-account', handleRefreshAccount)
      window.removeEventListener('yoho-bridge-delete', handleDelete)
      window.removeEventListener('yoho-bridge-set-model', handleSetModel)
      window.removeEventListener('yoho-bridge-set-fast-mode', handleSetFastMode)
      window.removeEventListener('yoho-bridge-set-reasoning-level', handleSetReasoningLevel)
      window.removeEventListener('yoho-bridge-request-autocomplete', handleRequestAutocomplete)
      window.removeEventListener('yoho-bridge-typing', handleTyping)
      window.removeEventListener('yoho-bridge-upload-images', handleUploadImages)
      window.removeEventListener('yoho-bridge-upload-files', handleUploadFiles)
    }
  }, [props])
}

export function getSessionTitle(session: Session): string {
  if (session.metadata?.name) return session.metadata.name
  if (session.metadata?.summary?.text) return session.metadata.summary.text
  if (session.metadata?.path) {
    const parts = session.metadata.path.split('/').filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
  }
  return session.id.slice(0, 8)
}

export function formatSessionModelLabelCompact(session: Session): string {
  const parts: string[] = []
  if (session.metadata?.runtimeModel) parts.push(session.metadata.runtimeModel)
  if (session.metadata?.runtimeAgent) parts.push(session.metadata.runtimeAgent)
  return parts.join(' · ')
}

export function viewersToBadgeUsers(viewers?: SessionViewer[]): { name: string; color: string }[] {
  if (!viewers) return []
  return viewers.map(v => ({
    name: v.email.split('@')[0] || v.email,
    color: generateColor(v.clientId || v.email),
  }))
}

export function getOnlineUsersForBadge(users?: { email: string }[]): { name: string; color: string }[] {
  if (!users) return []
  return users.map(u => ({
    name: u.email.split('@')[0] || u.email,
    color: generateColor(u.email),
  }))
}

export function matchSessionToProjectFlutter(session: Session, projects: Project[]): Project | null {
  if (!session.metadata?.path) return null
  return projects.find(p => session.metadata!.path!.startsWith(p.path)) ?? null
}
