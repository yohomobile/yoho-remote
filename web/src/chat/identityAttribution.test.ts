import { describe, expect, test } from 'bun:test'
import { getMessageActorAttribution, parseIdentityActorMeta } from './identityAttribution'

const feishuActor = {
    identityId: 'identity-feishu-1',
    personId: 'person-1',
    channel: 'feishu',
    resolution: 'admin_verified',
    displayName: 'Dev User',
    email: 'dev@example.com',
    externalId: 'ou_user_1',
    accountType: 'human',
}

describe('identityAttribution', () => {
    test('parses a valid message actor meta object', () => {
        expect(parseIdentityActorMeta(feishuActor)).toEqual(feishuActor)
    })

    test('builds a single actor attribution from message meta.actor', () => {
        const attribution = getMessageActorAttribution({
            actor: feishuActor,
        })

        expect(attribution).toMatchObject({
            label: 'Dev User',
            detail: 'Feishu',
            actors: [feishuActor],
            primaryActor: feishuActor,
        })
    })

    test('builds a multi-actor attribution from message meta.actors and de-duplicates meta.actor', () => {
        const secondActor = {
            ...feishuActor,
            identityId: 'identity-feishu-2',
            personId: 'person-2',
            displayName: 'PM User',
            email: 'pm@example.com',
            externalId: 'ou_user_2',
        }

        const attribution = getMessageActorAttribution({
            actors: [feishuActor, secondActor],
            actor: secondActor,
        })

        expect(attribution).toMatchObject({
            label: 'Dev User, PM User',
            detail: '2 speakers · Feishu',
            actors: [feishuActor, secondActor],
            primaryActor: secondActor,
        })
        expect(attribution?.title).toContain('Dev User · Feishu · admin_verified')
        expect(attribution?.title).toContain('PM User · Feishu · admin_verified')
    })
})
