import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredPerson } from '@/types/api'
import { IdentityPersonsContent } from './IdentityPersonsPanel'

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

describe('IdentityPersonsPanel', () => {
    test('renders person rows with title, subtitle, and status badge', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonsContent
                query=""
                persons={[createPerson()]}
                isLoading={false}
                isFetching={false}
                error={null}
                onQueryChange={() => {}}
                onSelectPerson={() => {}}
            />
        )
        expect(html).toContain('Identity Persons')
        expect(html).toContain('Guang Yang')
        expect(html).toContain('guang@example.com')
        expect(html).toContain('human')
        expect(html).toContain('active')
    })

    test('shows empty state when query is blank', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonsContent
                query=""
                persons={[]}
                isLoading={false}
                isFetching={false}
                error={null}
                onQueryChange={() => {}}
                onSelectPerson={() => {}}
            />
        )
        expect(html).toContain('No persons in this org yet.')
    })

    test('shows search-specific empty state when query is set', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonsContent
                query="foo"
                persons={[]}
                isLoading={false}
                isFetching={false}
                error={null}
                onQueryChange={() => {}}
                onSelectPerson={() => {}}
            />
        )
        expect(html).toContain('No matching persons.')
    })

    test('renders error banner when error present', () => {
        const html = renderToStaticMarkup(
            <IdentityPersonsContent
                query=""
                persons={[]}
                isLoading={false}
                isFetching={false}
                error="network down"
                onQueryChange={() => {}}
                onSelectPerson={() => {}}
            />
        )
        expect(html).toContain('network down')
    })

    test('renders multiple persons with distinct row testids', () => {
        const p1 = createPerson({ id: 'p1', canonicalName: 'Alice' })
        const p2 = createPerson({ id: 'p2', canonicalName: 'Bob', status: 'merged', mergedIntoPersonId: 'p1' })
        const html = renderToStaticMarkup(
            <IdentityPersonsContent
                query=""
                persons={[p1, p2]}
                isLoading={false}
                isFetching={false}
                error={null}
                onQueryChange={() => {}}
                onSelectPerson={() => {}}
            />
        )
        expect(html).toContain('identity-person-row-p1')
        expect(html).toContain('identity-person-row-p2')
        expect(html).toContain('Alice')
        expect(html).toContain('Bob')
        expect(html).toContain('merged')
    })
})
