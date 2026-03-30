import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'

export function useUpdateOrg(api: ApiClient | null, orgId: string) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: { name?: string; settings?: Record<string, unknown> }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateOrg(orgId, input)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgs })
            void queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) })
        },
    })

    return {
        updateOrg: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : null,
    }
}

export function useCreateOrg(api: ApiClient | null) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: { name: string; slug: string }) => {
            if (!api) throw new Error('API unavailable')
            return await api.createOrg(input.name, input.slug)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgs })
        },
    })

    return {
        createOrg: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : null,
    }
}

export function useInviteMember(api: ApiClient | null, orgId: string) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: { email: string; role?: string }) => {
            if (!api) throw new Error('API unavailable')
            return await api.inviteOrgMember(orgId, input.email, input.role)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgInvitations(orgId) })
        },
    })

    return {
        inviteMember: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : null,
    }
}

export function useUpdateMemberRole(api: ApiClient | null, orgId: string) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: { email: string; role: string }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateOrgMemberRole(orgId, input.email, input.role)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) })
        },
    })

    return {
        updateRole: mutation.mutateAsync,
        isPending: mutation.isPending,
    }
}

export function useRemoveMember(api: ApiClient | null, orgId: string) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (email: string) => {
            if (!api) throw new Error('API unavailable')
            return await api.removeOrgMember(orgId, email)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) })
        },
    })

    return {
        removeMember: mutation.mutateAsync,
        isPending: mutation.isPending,
    }
}

export function useAcceptInvitation(api: ApiClient | null) {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (invitationId: string) => {
            if (!api) throw new Error('API unavailable')
            return await api.acceptInvitation(invitationId)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.orgs })
            void queryClient.invalidateQueries({ queryKey: queryKeys.pendingInvitations })
        },
    })

    return {
        acceptInvitation: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : null,
    }
}
