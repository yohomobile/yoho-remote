import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'
import type { Organization, OrgMember, OrgInvitation, OrgRole, OrgLicense } from '@/types/api'

export function useMyOrgs(api: ApiClient | null) {
    const query = useQuery({
        queryKey: queryKeys.orgs,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMyOrgs()
        },
        enabled: Boolean(api),
    })

    return {
        orgs: query.data?.orgs ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load organizations' : null,
        refetch: query.refetch,
    }
}

export function useOrg(api: ApiClient | null, orgId: string | null) {
    const query = useQuery({
        queryKey: queryKeys.org(orgId ?? ''),
        queryFn: async () => {
            if (!api || !orgId) throw new Error('API unavailable')
            return await api.getOrg(orgId)
        },
        enabled: Boolean(api && orgId),
    })

    return {
        org: query.data?.org ?? null,
        members: query.data?.members ?? [],
        myRole: query.data?.myRole as OrgRole | undefined,
        license: (query.data?.license ?? null) as OrgLicense | null,
        licenseExempt: query.data?.licenseExempt === true,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : null,
    }
}

export function useOrgMembers(api: ApiClient | null, orgId: string | null) {
    const query = useQuery({
        queryKey: queryKeys.orgMembers(orgId ?? ''),
        queryFn: async () => {
            if (!api || !orgId) throw new Error('API unavailable')
            return await api.getOrgMembers(orgId)
        },
        enabled: Boolean(api && orgId),
    })

    return {
        members: query.data?.members ?? [],
        isLoading: query.isLoading,
    }
}

export function usePendingInvitations(api: ApiClient | null) {
    const query = useQuery({
        queryKey: queryKeys.pendingInvitations,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getPendingInvitations()
        },
        enabled: Boolean(api),
    })

    return {
        invitations: query.data?.invitations ?? [],
        isLoading: query.isLoading,
        refetch: query.refetch,
    }
}
