import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageActorAttribution } from '@/chat/identityAttribution'
import { MessageAttributionPopover } from './MessageAttributionPopover'

function build(actors: MessageActorAttribution['actors']): MessageActorAttribution {
    return {
        primaryActor: actors[0] ?? null,
        actors,
        label: actors.map((a) => a.displayName ?? a.externalId).join(', '),
        detail: `${actors.length} speakers`,
        title: actors.map((a) => `${a.displayName ?? a.externalId} · ${a.channel} · ${a.resolution}`).join('\n'),
    }
}

describe('MessageAttributionPopover', () => {
    test('renders all actors with linked person deep-link', () => {
        const attribution = build([
            {
                identityId: 'id-1',
                personId: 'person-abc',
                channel: 'feishu',
                resolution: 'admin_verified',
                displayName: 'Dev User',
                email: 'dev@example.com',
                externalId: 'ou_1',
                accountType: 'human',
            },
            {
                identityId: 'id-2',
                personId: null,
                channel: 'cli',
                resolution: 'unresolved',
                displayName: null,
                email: null,
                externalId: 'cli-session-1',
                accountType: 'service',
            },
        ])

        const html = renderToStaticMarkup(<MessageAttributionPopover attribution={attribution} />)

        expect(html).toContain('Dev User')
        expect(html).toContain('dev@example.com')
        expect(html).toContain('cli-session-1')
        expect(html).toContain('href="/self-system?openPerson=person-abc"')
        expect(html).toContain('Not yet linked to a person')
        expect(html).toContain('2 speakers')
    })

    test('renders Speaker header for single-actor attribution', () => {
        const attribution = build([
            {
                identityId: 'id-3',
                personId: 'person-solo',
                channel: 'keycloak',
                resolution: 'auto_verified',
                displayName: 'Solo User',
                email: 'solo@example.com',
                externalId: 'kc-solo',
                accountType: 'human',
            },
        ])

        const html = renderToStaticMarkup(<MessageAttributionPopover attribution={attribution} />)

        expect(html).toContain('Speaker')
        expect(html).toContain('Solo User')
        expect(html).toContain('href="/self-system?openPerson=person-solo"')
    })
})
