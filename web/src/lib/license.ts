import type { OrgLicense } from '@/types/api'

const DAY_MS = 1000 * 60 * 60 * 24

export type LicenseDisplayStatus = 'active' | 'expired' | 'suspended' | 'pending'

export type DerivedLicenseState = {
    daysSinceExpiry: number
    daysUntilExpiry: number
    daysUntilStart: number
    displayStatus: LicenseDisplayStatus
    isBlocked: boolean
    isExpired: boolean
    isNotStarted: boolean
    isSuspended: boolean
    isWarningSoon: boolean
}

export function deriveLicenseState(license: OrgLicense): DerivedLicenseState {
    const now = Date.now()
    const isSuspended = license.status === 'suspended'
    const isNotStarted = now < license.startsAt
    const daysUntilStart = Math.ceil((license.startsAt - now) / DAY_MS)
    const daysUntilExpiry = Math.ceil((license.expiresAt - now) / DAY_MS)
    const daysSinceExpiry = Math.floor((now - license.expiresAt) / DAY_MS)
    const isExpired = !isSuspended && (license.status === 'expired' || daysUntilExpiry <= 0)
    const isBlocked = isSuspended || isNotStarted || isExpired
    const isWarningSoon = !isBlocked && license.status === 'active' && daysUntilExpiry <= 7

    const displayStatus: LicenseDisplayStatus = isSuspended
        ? 'suspended'
        : isNotStarted
            ? 'pending'
            : isExpired
                ? 'expired'
                : 'active'

    return {
        daysSinceExpiry,
        daysUntilExpiry,
        daysUntilStart,
        displayStatus,
        isBlocked,
        isExpired,
        isNotStarted,
        isSuspended,
        isWarningSoon,
    }
}
