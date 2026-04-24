import { describe, expect, it } from 'bun:test'
import { authorizeEventsSocketOrg } from './server'

describe('authorizeEventsSocketOrg', () => {
    it('rejects missing orgId', async () => {
        await expect(authorizeEventsSocketOrg({
            getOrganizationsForUser: async () => [],
        } as any, {
            email: 'dev@example.com',
            role: 'developer',
        }, null)).rejects.toThrow('Missing orgId')
    })

    it('rejects organizations outside the user membership', async () => {
        await expect(authorizeEventsSocketOrg({
            getOrganizationsForUser: async () => [{
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
                myRole: 'member',
            }],
        } as any, {
            email: 'dev@example.com',
            role: 'developer',
        }, 'org-b')).rejects.toThrow('Organization access denied')
    })

    it('allows operators to target any org', async () => {
        await expect(authorizeEventsSocketOrg({
            getOrganizationsForUser: async () => [],
        } as any, {
            email: 'operator@example.com',
            role: 'operator',
        }, 'org-b')).resolves.toBe('org-b')
    })
})
