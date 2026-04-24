import { describe, expect, test } from 'bun:test'
import { messageMatchesActor } from './useActorFilter'

describe('messageMatchesActor', () => {
    test('matches when primary actor identityId is the target', () => {
        const meta = {
            actor: {
                identityId: 'id-1',
                channel: 'feishu',
                resolution: 'admin_verified',
                externalId: 'ou_1',
                accountType: 'human',
                personId: null,
                displayName: null,
                email: null,
            },
        }
        expect(messageMatchesActor(meta, 'id-1')).toBe(true)
        expect(messageMatchesActor(meta, 'id-2')).toBe(false)
    })

    test('matches when target is in the actors array', () => {
        const meta = {
            actor: {
                identityId: 'id-1',
                channel: 'feishu',
                resolution: 'admin_verified',
                externalId: 'ou_1',
                accountType: 'human',
                personId: null,
                displayName: null,
                email: null,
            },
            actors: [
                {
                    identityId: 'id-1',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    externalId: 'ou_1',
                    accountType: 'human',
                    personId: null,
                    displayName: null,
                    email: null,
                },
                {
                    identityId: 'id-2',
                    channel: 'feishu',
                    resolution: 'admin_verified',
                    externalId: 'ou_2',
                    accountType: 'human',
                    personId: null,
                    displayName: null,
                    email: null,
                },
            ],
        }
        expect(messageMatchesActor(meta, 'id-2')).toBe(true)
    })

    test('returns false for malformed meta', () => {
        expect(messageMatchesActor(null, 'id-1')).toBe(false)
        expect(messageMatchesActor({}, 'id-1')).toBe(false)
        expect(messageMatchesActor({ actor: null }, 'id-1')).toBe(false)
    })
})
