import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IdentityCandidate, StoredPerson } from '@/types/api'
import { formatIdentityScore, IdentityReviewContent } from './IdentityReviewPanel'

function createPerson(overrides: Partial<StoredPerson> = {}): StoredPerson {
    return {
        id: 'person-1',
        namespace: 'default',
        orgId: 'org-1',
        personType: 'human',
        status: 'active',
        canonicalName: 'Dev User',
        primaryEmail: 'dev@example.com',
        employeeCode: null,
        avatarUrl: null,
        attributes: {},
        createdAt: 1,
        updatedAt: 2,
        createdBy: 'admin@example.com',
        mergedIntoPersonId: null,
        ...overrides,
    }
}

function createCandidate(overrides: Partial<IdentityCandidate> = {}): IdentityCandidate {
    const candidatePerson = createPerson()
    return {
        id: 'cand-1',
        namespace: 'default',
        orgId: 'org-1',
        identityId: 'identity-1',
        candidatePersonId: candidatePerson.id,
        score: 0.95,
        autoAction: 'review',
        status: 'open',
        riskFlags: [],
        evidence: ['email_exact'],
        matcherVersion: 'identity-graph-v1',
        suppressUntil: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        createdAt: 1,
        updatedAt: 2,
        identity: {
            id: 'identity-1',
            namespace: 'default',
            orgId: 'org-1',
            channel: 'keycloak',
            providerTenantId: null,
            externalId: 'keycloak-user-1',
            secondaryId: null,
            accountType: 'human',
            assurance: 'high',
            canonicalEmail: 'dev@example.com',
            displayName: 'Dev User',
            loginName: null,
            employeeCode: null,
            status: 'active',
            attributes: {},
            firstSeenAt: 1,
            lastSeenAt: 1_700_000_000_000,
            createdAt: 1,
            updatedAt: 2,
        },
        candidatePerson,
        ...overrides,
    }
}

describe('IdentityReviewPanel', () => {
    test('formats identity scores as percentages', () => {
        expect(formatIdentityScore(0.954)).toBe('95%')
    })

    test('renders candidate evidence and decision actions', () => {
        const candidate = createCandidate()
        const html = renderToStaticMarkup(
            <IdentityReviewContent
                candidates={[candidate]}
                selectedCandidate={candidate}
                persons={[createPerson({ id: 'person-2', canonicalName: 'Other User', primaryEmail: 'other@example.com' })]}
                personQuery="other"
                reason=""
                isLoading={false}
                isSearching={false}
                isDeciding={false}
                error={null}
                onSelectCandidate={() => {}}
                onPersonQueryChange={() => {}}
                onReasonChange={() => {}}
                onConfirmSuggested={() => {}}
                onConfirmPerson={() => {}}
                onCreatePerson={() => {}}
                onMarkShared={() => {}}
                onReject={() => {}}
            />
        )

        expect(html).toContain('Identity Review')
        expect(html).toContain('Dev User')
        expect(html).toContain('keycloak')
        expect(html).toContain('email_exact')
        expect(html).toContain('Confirm suggested')
        expect(html).toContain('Other User')
        expect(html).toContain('Create person')
        expect(html).toContain('Reject')
    })

    test('renders an empty state when there are no candidates', () => {
        const html = renderToStaticMarkup(
            <IdentityReviewContent
                candidates={[]}
                selectedCandidate={null}
                persons={[]}
                personQuery=""
                reason=""
                isLoading={false}
                isSearching={false}
                isDeciding={false}
                error={null}
                onSelectCandidate={() => {}}
                onPersonQueryChange={() => {}}
                onReasonChange={() => {}}
                onConfirmSuggested={() => {}}
                onConfirmPerson={() => {}}
                onCreatePerson={() => {}}
                onMarkShared={() => {}}
                onReject={() => {}}
            />
        )

        expect(html).toContain('No open candidates.')
    })
})
