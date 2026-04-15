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

export type EffectiveLicenseState = DerivedLicenseState & {
    isExempt: boolean
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

const LICENSE_TERMINATION_REASONS = new Set([
    'NO_LICENSE',
    'LICENSE_EXPIRED',
    'LICENSE_SUSPENDED',
    'LICENSE_NOT_STARTED',
    'MEMBER_LIMIT',
    'SESSION_LIMIT',
])

export function isLicenseTermination(reason: string | null | undefined): boolean {
    return typeof reason === 'string' && LICENSE_TERMINATION_REASONS.has(reason)
}

export function getLicenseTerminationLabel(reason: string): string {
    switch (reason) {
        case 'LICENSE_SUSPENDED': return 'License suspended'
        case 'LICENSE_NOT_STARTED': return 'License not active yet'
        case 'MEMBER_LIMIT': return 'Member limit reached'
        case 'SESSION_LIMIT': return 'Session limit reached'
        case 'NO_LICENSE':
        case 'LICENSE_EXPIRED':
        default: return 'License expired'
    }
}

export function deriveEffectiveLicenseState(
    license: OrgLicense,
    options?: { licenseExempt?: boolean }
): EffectiveLicenseState {
    const state = deriveLicenseState(license)
    if (options?.licenseExempt) {
        return {
            ...state,
            displayStatus: 'active',
            isBlocked: false,
            isExpired: false,
            isExempt: true,
            isNotStarted: false,
            isSuspended: false,
            isWarningSoon: false,
        }
    }
    return {
        ...state,
        isExempt: false,
    }
}
