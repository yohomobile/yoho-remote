import { describe, expect, test } from 'bun:test'
import { BrainBridge } from './BrainBridge'

function buildBridge(store: Record<string, unknown>) {
    return new BrainBridge({
        syncEngine: {
            subscribe: () => () => {},
        } as any,
        store: store as any,
        adapter: {
            platform: 'feishu',
            start: async () => {},
            stop: async () => {},
            sendReply: async () => {},
            resolveSenderInfo: async () => ({ email: null, name: null, externalId: null, accountType: 'human' }),
        } as any,
    })
}

function messageWithEmail(email: string | null) {
    return {
        text: 'ping',
        messageId: 'm-1',
        senderName: 'Dev',
        senderId: 'u-1',
        senderEmail: email,
        chatType: 'p2p' as const,
        addressed: true,
    }
}

describe('BrainBridge.resolveRequiredOrgId', () => {
    test('returns missing_sender_email when no email is available anywhere', async () => {
        const bridge = buildBridge({
            getOrganizationsForUser: async () => [],
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail(null))
        expect(result).toEqual({ orgId: null, reason: 'missing_sender_email' })
    })

    test('returns missing_message when no message is passed at all', async () => {
        const bridge = buildBridge({})
        const result = await (bridge as any).resolveRequiredOrgId()
        expect(result).toEqual({ orgId: null, reason: 'missing_message' })
    })

    test('returns org_lookup_unavailable when store lacks getOrganizationsForUser', async () => {
        const bridge = buildBridge({})
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail('dev@example.com'))
        expect(result).toEqual({ orgId: null, reason: 'org_lookup_unavailable' })
    })

    test('resolves the single-membership case with reason=resolved', async () => {
        const seen: string[] = []
        const bridge = buildBridge({
            getOrganizationsForUser: async (email: string) => {
                seen.push(email)
                return [{ id: 'org-only', name: 'Only', slug: 'only', createdBy: '', createdAt: 0, updatedAt: 0, settings: {}, myRole: 'member' }]
            },
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail('dev@example.com'))
        expect(result).toEqual({ orgId: 'org-only', reason: 'resolved' })
        expect(seen).toEqual(['dev@example.com'])
    })

    test('returns no_membership when email has no org', async () => {
        const bridge = buildBridge({
            getOrganizationsForUser: async () => [],
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail('lonely@example.com'))
        expect(result).toEqual({ orgId: null, reason: 'no_membership' })
    })

    test('returns ambiguous_membership when email belongs to multiple orgs', async () => {
        const bridge = buildBridge({
            getOrganizationsForUser: async () => [
                { id: 'org-1', name: 'A', slug: 'a', createdBy: '', createdAt: 0, updatedAt: 0, settings: {}, myRole: 'member' },
                { id: 'org-2', name: 'B', slug: 'b', createdBy: '', createdAt: 0, updatedAt: 0, settings: {}, myRole: 'member' },
            ],
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail('multi@example.com'))
        expect(result).toEqual({ orgId: null, reason: 'ambiguous_membership' })
    })

    test('returns org_lookup_failed when lookup throws', async () => {
        const bridge = buildBridge({
            getOrganizationsForUser: async () => { throw new Error('db down') },
        })
        const originalWarn = console.warn
        console.warn = () => {}
        try {
            const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail('boom@example.com'))
            expect(result).toEqual({ orgId: null, reason: 'org_lookup_failed' })
        } finally {
            console.warn = originalWarn
        }
    })

    test('falls back to adapter-provided email when message.senderEmail is empty', async () => {
        let captured: string | null = null
        const bridge = new BrainBridge({
            syncEngine: { subscribe: () => () => {} } as any,
            store: {
                getOrganizationsForUser: async (email: string) => {
                    captured = email
                    return [{ id: 'org-adapter', name: 'A', slug: 'a', createdBy: '', createdAt: 0, updatedAt: 0, settings: {}, myRole: 'member' }]
                },
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                resolveSenderInfo: async () => ({ email: 'adapter@example.com', name: 'Dev', externalId: 'u-1', accountType: 'human' }),
            } as any,
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail(null))
        expect(result).toEqual({ orgId: 'org-adapter', reason: 'resolved' })
        expect(captured).toBe('adapter@example.com')
    })

    test('falls back to identity-provided email when neither message nor adapter has one', async () => {
        let captured: string | null = null
        const bridge = new BrainBridge({
            syncEngine: { subscribe: () => () => {} } as any,
            store: {
                findResolvedActorByChannelExternalId: async () => ({ email: 'identity@example.com' }),
                getOrganizationsForUser: async (email: string) => {
                    captured = email
                    return [{ id: 'org-identity', name: 'I', slug: 'i', createdBy: '', createdAt: 0, updatedAt: 0, settings: {}, myRole: 'member' }]
                },
            } as any,
            adapter: {
                platform: 'feishu',
                start: async () => {},
                stop: async () => {},
                sendReply: async () => {},
                resolveSenderInfo: async () => ({ email: null, name: null, externalId: null, accountType: 'human' }),
            } as any,
        })
        const result = await (bridge as any).resolveRequiredOrgId(messageWithEmail(null))
        expect(result).toEqual({ orgId: 'org-identity', reason: 'resolved' })
        expect(captured).toBe('identity@example.com')
    })
})
