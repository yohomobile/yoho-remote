import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ModelMode, ModelReasoningEffort, RefreshAccountResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type ModelConfig = { model: ModelMode; reasoningEffort?: ModelReasoningEffort | null }

export function useSessionActions(api: ApiClient | null, sessionId: string | null): {
    abortSession: () => Promise<void>
    switchSession: () => Promise<void>
    setModelMode: (config: ModelConfig) => Promise<void>
    setFastMode: (fastMode: boolean) => Promise<void>
    deleteSession: () => Promise<void>
    refreshAccount: () => Promise<RefreshAccountResponse>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const switchMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.switchSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const modelMutation = useMutation({
        mutationFn: async (config: ModelConfig) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModelMode(sessionId, {
                model: config.model,
                reasoningEffort: config.reasoningEffort ?? undefined
            })
        },
        // Note: No onSuccess callback here - we rely on SSE session-updated events to update the cache
        // This avoids race conditions between invalidation and SSE cache updates
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.deleteSession(sessionId)
        },
        onSuccess: async () => {
            if (!sessionId) return
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) })
            await queryClient.removeQueries({ queryKey: queryKeys.messages(sessionId) })
        },
    })

    const fastModeMutation = useMutation({
        mutationFn: async (fastMode: boolean) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setFastMode(sessionId, fastMode)
        },
    })

    const refreshAccountMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.refreshAccount(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    return {
        abortSession: abortMutation.mutateAsync,
        switchSession: switchMutation.mutateAsync,
        setModelMode: modelMutation.mutateAsync,
        setFastMode: fastModeMutation.mutateAsync,
        deleteSession: deleteMutation.mutateAsync,
        refreshAccount: refreshAccountMutation.mutateAsync,
        isPending: abortMutation.isPending
            || switchMutation.isPending
            || modelMutation.isPending
            || fastModeMutation.isPending
            || deleteMutation.isPending
            || refreshAccountMutation.isPending,
    }
}
