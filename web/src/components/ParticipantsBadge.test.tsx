import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IdentityActorMeta } from '@/types/api'
import { ParticipantsBadge } from './ParticipantsBadge'

function actor(overrides: Partial<IdentityActorMeta>): IdentityActorMeta {
    return {
        identityId: overrides.identityId ?? 'id-default',
        personId: overrides.personId ?? null,
        channel: overrides.channel ?? 'feishu',
        resolution: overrides.resolution ?? 'admin_verified',
        displayName: overrides.displayName ?? null,
        email: overrides.email ?? null,
        externalId: overrides.externalId ?? 'ext-default',
        accountType: overrides.accountType ?? 'human',
    }
}

describe('ParticipantsBadge', () => {
    test('renders nothing when actors list is empty', () => {
        const html = renderToStaticMarkup(<ParticipantsBadge actors={[]} />)
        expect(html).toBe('')
    })

    test('shows initials for visible actors and overflow counter', () => {
        const actors = [
            actor({ identityId: 'a1', displayName: 'Alice' }),
            actor({ identityId: 'a2', displayName: 'Bob' }),
            actor({ identityId: 'a3', displayName: 'Carol' }),
            actor({ identityId: 'a4', displayName: 'Dan' }),
            actor({ identityId: 'a5', displayName: 'Eve' }),
        ]
        const html = renderToStaticMarkup(<ParticipantsBadge actors={actors} maxVisible={3} />)
        expect(html).toContain('>A<')
        expect(html).toContain('>B<')
        expect(html).toContain('>C<')
        expect(html).not.toContain('>D<')
        expect(html).toContain('+2')
    })

    test('falls back to externalId when name is missing', () => {
        const html = renderToStaticMarkup(
            <ParticipantsBadge actors={[actor({ identityId: 'cli-1', externalId: 'cli-xyz' })]} />,
        )
        expect(html).toContain('>C<')
    })
})
