import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageActorAttribution } from '@/chat/identityAttribution'
import { MessageAttributionLine } from './UserMessage'

describe('MessageAttributionLine', () => {
    test('renders compact multi-actor attribution details', () => {
        const attribution: MessageActorAttribution = {
            primaryActor: null,
            actors: [
                {
                    identityId: 'identity-feishu-1',
                    personId: 'person-1',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    displayName: 'Dev User',
                    email: 'dev@example.com',
                    externalId: 'ou_user_1',
                    accountType: 'human',
                },
                {
                    identityId: 'identity-feishu-2',
                    personId: 'person-2',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    displayName: 'PM User',
                    email: 'pm@example.com',
                    externalId: 'ou_user_2',
                    accountType: 'human',
                },
            ],
            label: 'Dev User, PM User',
            detail: '2 speakers · Feishu',
            title: 'Dev User · Feishu · admin_verified\nPM User · Feishu · admin_verified',
        }

        const html = renderToStaticMarkup(<MessageAttributionLine attribution={attribution} />)

        expect(html).toContain('Dev User, PM User')
        expect(html).toContain('2 speakers · Feishu')
        expect(html).toContain('aria-label="Dev User · Feishu · admin_verified')
    })
})
