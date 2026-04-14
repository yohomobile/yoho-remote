import { describe, expect, test } from 'bun:test'
import type { OrgLicense } from '@/types/api'
import { deriveEffectiveLicenseState } from './license'

function createLicense(overrides: Partial<OrgLicense> = {}): OrgLicense {
    const now = Date.now()
    return {
        id: 'license-1',
        orgId: 'org-1',
        startsAt: now - 2 * 24 * 60 * 60 * 1000,
        expiresAt: now - 60 * 60 * 1000,
        maxMembers: 5,
        maxConcurrentSessions: 2,
        status: 'expired',
        issuedBy: 'tester@yohomobile.dev',
        note: null,
        createdAt: now - 10 * 24 * 60 * 60 * 1000,
        updatedAt: now,
        ...overrides,
    }
}

describe('deriveEffectiveLicenseState', () => {
    test('keeps expired licenses blocked for regular orgs', () => {
        const state = deriveEffectiveLicenseState(createLicense())

        expect(state.isExempt).toBe(false)
        expect(state.isBlocked).toBe(true)
        expect(state.isExpired).toBe(true)
        expect(state.displayStatus).toBe('expired')
    })

    test('treats exempt orgs as non-blocking even when a stored license is expired', () => {
        const state = deriveEffectiveLicenseState(createLicense(), { licenseExempt: true })

        expect(state.isExempt).toBe(true)
        expect(state.isBlocked).toBe(false)
        expect(state.isExpired).toBe(false)
        expect(state.isWarningSoon).toBe(false)
        expect(state.displayStatus).toBe('active')
    })
})
