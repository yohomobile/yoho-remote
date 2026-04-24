import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
    IdentityPersonDetail,
    StoredPerson,
    StoredPersonIdentity,
    StoredPersonIdentityAudit,
    StoredPersonIdentityLink,
} from '@/types/api'
import { IdentityPersonDrawerPanel } from './IdentityPersonDrawer'

function createPerson(overrides: Partial<StoredPerson> = {}): StoredPerson {
    return {
        id: 'person-1',
        namespace: 'default',
        orgId: 'org-1',
        personType: 'human',
        status: 'active',
        canonicalName: 'Guang Yang',
        primaryEmail: 'guang@example.com',
        employeeCode: null,
        avatarUrl: null,
        attributes: {},
        createdAt: 1,
        updatedAt: 2,
        createdBy: null,
        mergedIntoPersonId: null,
        ...overrides,
    }
}

function createIdentity(overrides: Partial<StoredPersonIdentity> = {}): StoredPersonIdentity {
    return {
        id: 'identity-1',
        namespace: 'default',
        orgId: 'org-1',
        channel: 'keycloak',
        providerTenantId: null,
        externalId: 'keycloak-sub-1',
        secondaryId: null,
        accountType: 'human',
        assurance: 'high',
        canonicalEmail: 'guang@example.com',
        displayName: 'Guang',
        loginName: null,
        employeeCode: null,
        status: 'active',
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 2,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    }
}

function createLink(overrides: Partial<StoredPersonIdentityLink> = {}): StoredPersonIdentityLink {
    return {
        id: 'link-1',
        personId: 'person-1',
        identityId: 'identity-1',
        relationType: 'primary',
        state: 'auto_verified',
        confidence: 0.95,
        source: 'auto',
        evidence: [],
        decisionReason: null,
        validFrom: 1,
        validTo: null,
        decidedBy: null,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    }
}

function createDetail(person: StoredPerson = createPerson()): IdentityPersonDetail {
    return {
        person,
        identities: [{ identity: createIdentity(), link: createLink() }],
    }
}

const noop = () => {}

const baseProps = {
    audits: [] as StoredPersonIdentityAudit[],
    isDetailLoading: false,
    detailError: null,
    isAuditsLoading: false,
    mergeQuery: '',
    mergeCandidates: [] as StoredPerson[],
    isMergeSearching: false,
    reason: '',
    confirm: null,
    errorMsg: null,
    busy: false,
    onMergeQueryChange: noop,
    onReasonChange: noop,
    onRequestDetach: noop,
    onRequestMerge: noop,
    onRequestUnmerge: noop,
    onConfirm: noop,
    onCancelConfirm: noop,
}

describe('IdentityPersonDrawerPanel', () => {
    test('renders identities list with Detach button for active person', () => {
        const detail = createDetail()
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel {...baseProps} detail={detail} />
        )
        expect(html).toContain('Identities (1)')
        expect(html).toContain('keycloak')
        expect(html).toContain('keycloak-sub-1')
        expect(html).toContain('95%')
        expect(html).toContain('Detach')
        expect(html).toContain('Merge into another person')
    })

    test('shows Unmerge section when person status is merged', () => {
        const detail = createDetail(createPerson({ status: 'merged', mergedIntoPersonId: 'person-target' }))
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel {...baseProps} detail={detail} />
        )
        expect(html).toContain('Unmerge this person')
        expect(html).toContain('person-target')
        expect(html).not.toContain('Merge into another person')
    })

    test('renders merge candidate list and Merge into buttons', () => {
        const detail = createDetail()
        const target = createPerson({ id: 'person-2', canonicalName: 'Other' })
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={detail}
                mergeQuery="other"
                mergeCandidates={[target]}
            />
        )
        expect(html).toContain('Other')
        expect(html).toContain('Merge into')
    })

    test('shows empty search message when mergeQuery is set and no candidates', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={createDetail()}
                mergeQuery="nobody"
            />
        )
        expect(html).toContain('No matching persons.')
    })

    test('renders confirm dialog with detach prompt', () => {
        const detail = createDetail()
        const identity = detail.identities[0]!.identity
        const link = detail.identities[0]!.link
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={detail}
                confirm={{ kind: 'detach', identity, link }}
            />
        )
        expect(html).toContain(`Detach Guang?`)
        expect(html).toContain('Confirm')
        expect(html).toContain('Cancel')
    })

    test('renders confirm dialog with merge prompt', () => {
        const detail = createDetail()
        const target = createPerson({ id: 'person-2', canonicalName: 'Other' })
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={detail}
                confirm={{ kind: 'merge', target }}
            />
        )
        expect(html).toContain('Merge Guang Yang into Other?')
    })

    test('renders confirm dialog with unmerge prompt', () => {
        const detail = createDetail(createPerson({ status: 'merged', mergedIntoPersonId: 'person-target' }))
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={detail}
                confirm={{ kind: 'unmerge' }}
            />
        )
        expect(html).toContain('Unmerge this person?')
    })

    test('renders audits list when provided', () => {
        const detail = createDetail()
        const audit: StoredPersonIdentityAudit = {
            id: 'audit-1',
            namespace: 'default',
            orgId: 'org-1',
            action: 'merge_persons',
            personId: 'person-1',
            targetPersonId: 'person-2',
            identityId: null,
            linkId: null,
            actorEmail: 'admin@example.com',
            reason: 'dup',
            payload: {},
            createdAt: 1_700_000_000_000,
        }
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel {...baseProps} detail={detail} audits={[audit]} />
        )
        expect(html).toContain('merge_persons')
        expect(html).toContain('admin@example.com')
        expect(html).toContain('dup')
    })

    test('renders detail error', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={undefined}
                detailError="not found"
            />
        )
        expect(html).toContain('not found')
    })

    test('renders loading state', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonDrawerPanel
                {...baseProps}
                detail={undefined}
                isDetailLoading={true}
            />
        )
        expect(html).toContain('Loading person detail')
    })
})
