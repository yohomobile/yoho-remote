import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useOrg } from '@/hooks/queries/useOrgs'

export function LicenseBanner() {
    const { api, currentOrgId } = useAppContext()
    const { license } = useOrg(api, currentOrgId)
    const [dismissedOrgId, setDismissedOrgId] = useState<string | null>(null)

    // Reset dismissed state when org changes
    useEffect(() => {
        setDismissedOrgId(null)
    }, [currentOrgId])

    if (!license || !currentOrgId) return null

    const days = Math.ceil((license.expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    const isBlocked = license.status === 'expired' || license.status === 'suspended' || days <= 0
    const isWarningSoon = !isBlocked && license.status === 'active' && days <= 7

    if (!isBlocked && !isWarningSoon) return null
    if (!isBlocked && dismissedOrgId === currentOrgId) return null

    const message = isBlocked
        ? license.status === 'suspended'
            ? 'License suspended — new sessions are blocked.'
            : 'License expired — new sessions are blocked.'
        : days === 1
            ? 'License expires tomorrow. Renew to avoid interruption.'
            : `License expires in ${days} days. Renew to avoid interruption.`

    return (
        <div className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium z-40 ${
            isBlocked ? 'bg-red-500/90 text-white' : 'bg-amber-500/90 text-white'
        }`}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span className="flex-1">{message}</span>
            <Link
                to="/settings"
                className="shrink-0 underline underline-offset-2 opacity-90 hover:opacity-100"
            >
                Settings
            </Link>
            {!isBlocked && (
                <button
                    type="button"
                    onClick={() => setDismissedOrgId(currentOrgId)}
                    className="shrink-0 flex h-5 w-5 items-center justify-center rounded hover:bg-white/20 transition-colors"
                    aria-label="Dismiss"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            )}
        </div>
    )
}
