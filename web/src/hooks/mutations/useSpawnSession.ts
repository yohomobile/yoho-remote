import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SpawnResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SpawnInput = {
    machineId: string
    directory: string
    agent?: 'claude' | 'codex' | 'codez' | 'droid'
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    claudeModel?: 'sonnet' | 'opus' | 'glm-5.1'
    codexModel?: string
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    droidModel?: string
    droidReasoningEffort?: string
    orgId?: string | null
}

export function useSpawnSession(api: ApiClient | null): {
    spawnSession: (input: SpawnInput) => Promise<SpawnResponse>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: SpawnInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.spawnSession(
                input.machineId,
                input.directory,
                input.agent,
                input.yolo,
                input.sessionType,
                input.worktreeName,
                input.claudeModel,
                input.codexModel,
                input.modelReasoningEffort,
                input.droidModel,
                input.droidReasoningEffort,
                input.orgId
            )
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        spawnSession: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : mutation.error ? 'Failed to spawn session' : null,
    }
}
