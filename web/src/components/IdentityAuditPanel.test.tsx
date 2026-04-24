import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredPersonIdentityAudit } from '@/types/api'
import { IdentityAuditContent } from './IdentityAuditPanel'

function createAudit(overrides: Partial<StoredPersonIdentityAudit> = {}): StoredPersonIdentityAudit {
    return {
        id: 'audit-1',
        namespace: 'default',
        orgId: 'org-1',
        action: 'merge_persons',
        personId: 'person-1',
        targetPersonId: 'person-2',
        identityId: null,
        linkId: null,
        actorEmail: 'admin@example.com',
        reason: 'duplicate',
        payload: {},
        createdAt: 1_700_000_000_000,
        ...overrides,
    }
}

describe('IdentityAuditPanel', () => {
    test('renders audit rows with actor, person mapping, and reason', () => {
        const audit = createAudit()
        const html = renderToStaticMarkup(
            <IdentityAuditContent
                action="all"
                audits={[audit]}
                isLoading={false}
                isFetching={false}
                error={null}
                onActionChange={() => {}}
            />
        )
        expect(html).toContain('Identity Audit Log')
        expect(html).toContain('merge_persons')
        expect(html).toContain('admin@example.com')
        expect(html).toContain('person-1')
        expect(html).toContain('person-2')
        expect(html).toContain('duplicate')
    })

    test('shows empty state when action=all yields no audits', () => {
        const html = renderToStaticMarkup(
            <IdentityAuditContent
                action="all"
                audits={[]}
                isLoading={false}
                isFetching={false}
                error={null}
                onActionChange={() => {}}
            />
        )
        expect(html).toContain('No audit events yet.')
    })

    test('shows action-specific empty message when filter has no matches', () => {
        const html = renderToStaticMarkup(
            <IdentityAuditContent
                action="detach_identity_link"
                audits={[]}
                isLoading={false}
                isFetching={false}
                error={null}
                onActionChange={() => {}}
            />
        )
        expect(html).toContain('No detach_identity_link events.')
    })

    test('renders error banner when error is present', () => {
        const html = renderToStaticMarkup(
            <IdentityAuditContent
                action="all"
                audits={[]}
                isLoading={false}
                isFetching={false}
                error="network down"
                onActionChange={() => {}}
            />
        )
        expect(html).toContain('network down')
    })

    test('includes identity and link IDs when present in an audit row', () => {
        const audit = createAudit({ identityId: 'identity-99', linkId: 'link-42', action: 'detach_identity_link' })
        const html = renderToStaticMarkup(
            <IdentityAuditContent
                action="all"
                audits={[audit]}
                isLoading={false}
                isFetching={false}
                error={null}
                onActionChange={() => {}}
            />
        )
        expect(html).toContain('identity-99')
        expect(html).toContain('link-42')
    })
})
