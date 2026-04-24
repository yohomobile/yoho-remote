import { Link, useLocation } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { usePendingInvitations } from '@/hooks/queries/useOrgs'
import { useAcceptInvitation } from '@/hooks/mutations/useOrgMutations'

export function PendingInvitationsBanner() {
    const { api, setCurrentOrgId } = useAppContext()
    const pathname = useLocation({ select: (location) => location.pathname })
    const { invitations } = usePendingInvitations(api)
    const { acceptInvitation, isPending, error } = useAcceptInvitation(api)

    if (pathname === '/settings' || pathname.startsWith('/invitations/accept/')) {
        return null
    }

    if (invitations.length === 0) {
        return null
    }

    const primaryInvitation = invitations[0]
    const primaryOrgName = primaryInvitation.orgName ?? primaryInvitation.orgId
    const extraCount = invitations.length - 1

    const handleJoin = async () => {
        const result = await acceptInvitation(primaryInvitation.id)
        if (result.ok) {
            setCurrentOrgId(result.orgId)
        }
    }

    return (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] font-medium text-white z-40 bg-emerald-600/95">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M19 8v6"/>
                <path d="M22 11h-6"/>
            </svg>
            <span className="flex-1 min-w-[220px]">
                {extraCount > 0
                    ? `你有 ${invitations.length} 个待加入组织邀请，先加入 ${primaryOrgName} 即可看到对应组织的数据。`
                    : `你有 1 个待加入组织邀请：${primaryOrgName}。加入后即可看到该组织的数据。`}
            </span>
            <button
                type="button"
                onClick={() => { void handleJoin() }}
                disabled={isPending}
                className="shrink-0 rounded-md bg-white/16 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/24 disabled:cursor-not-allowed disabled:opacity-60"
            >
                {isPending ? 'Joining...' : `Join ${primaryOrgName}`}
            </button>
            <Link
                to="/settings"
                className="shrink-0 rounded-md border border-white/30 px-3 py-1.5 text-xs font-semibold text-white/95 transition-colors hover:bg-white/12"
            >
                查看全部邀请
            </Link>
            {error && (
                <div className="basis-full text-[11px] text-white/90">
                    加入邀请失败：{error}
                </div>
            )}
        </div>
    )
}
