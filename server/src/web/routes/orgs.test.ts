import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createOrgsRoutes } from './orgs'
import { emailService } from '../../services/emailService'

describe('createOrgsRoutes invitations', () => {
    function createAuthedApp(store: Record<string, unknown>, email = 'owner@example.com') {
        const app = new Hono<any>()
        app.use('/api/*', async (c, next) => {
            c.set('email', email)
            c.set('userId', 'user-1')
            await next()
        })
        app.route('/api', createOrgsRoutes(store as any))
        return app
    }

    it('returns acceptUrl and emailSent when creating an invitation successfully', async () => {
        const originalSendOrgInvitation = emailService.sendOrgInvitation
        emailService.sendOrgInvitation = async () => {}

        try {
            const invitation = {
                id: 'invite-1',
                orgId: 'org-123',
                email: 'invitee@example.com',
                role: 'member',
                invitedBy: 'owner@example.com',
                createdAt: 1,
                expiresAt: 2,
                acceptedAt: null,
            }

            const store = {
                getUserOrgRole: async () => 'owner',
                getOrgMember: async () => null,
                createOrgInvitation: async () => invitation,
                getOrganization: async () => ({
                    id: 'org-123',
                    name: 'Org 123',
                    slug: 'org-123',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: 1,
                    settings: {},
                }),
            }

            const app = createAuthedApp(store)
            const response = await app.request('/api/orgs/org-123/members', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    email: 'invitee@example.com',
                    role: 'member',
                }),
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                ok: true,
                invitation: {
                    ...invitation,
                    acceptUrl: 'https://remote.yohomobile.dev/invitations/accept/invite-1',
                },
                acceptUrl: 'https://remote.yohomobile.dev/invitations/accept/invite-1',
                emailSent: true,
                emailError: null,
            })
        } finally {
            emailService.sendOrgInvitation = originalSendOrgInvitation
        }
    })

    it('returns acceptUrl even when invitation email delivery fails', async () => {
        const originalSendOrgInvitation = emailService.sendOrgInvitation
        emailService.sendOrgInvitation = async () => {
            throw new Error('SMTP unavailable')
        }

        try {
            const invitation = {
                id: 'invite-2',
                orgId: 'org-123',
                email: 'invitee@example.com',
                role: 'member',
                invitedBy: 'owner@example.com',
                createdAt: 1,
                expiresAt: 2,
                acceptedAt: null,
            }

            const store = {
                getUserOrgRole: async () => 'owner',
                getOrgMember: async () => null,
                createOrgInvitation: async () => invitation,
                getOrganization: async () => ({
                    id: 'org-123',
                    name: 'Org 123',
                    slug: 'org-123',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: 1,
                    settings: {},
                }),
            }

            const app = createAuthedApp(store)
            const response = await app.request('/api/orgs/org-123/members', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    email: 'invitee@example.com',
                    role: 'member',
                }),
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                ok: true,
                invitation: {
                    ...invitation,
                    acceptUrl: 'https://remote.yohomobile.dev/invitations/accept/invite-2',
                },
                acceptUrl: 'https://remote.yohomobile.dev/invitations/accept/invite-2',
                emailSent: false,
                emailError: 'SMTP unavailable',
            })
        } finally {
            emailService.sendOrgInvitation = originalSendOrgInvitation
        }
    })

    it('returns orgId when accepting an invitation', async () => {
        const store = {
            getPendingInvitationsForUser: async () => [],
            acceptOrgInvitation: async () => 'org-123',
        }

        const app = createAuthedApp(store, 'user@example.com')

        const response = await app.request('/api/invitations/invite-123/accept', {
            method: 'POST',
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            orgId: 'org-123',
        })
    })

    it('returns 404 when invitation cannot be accepted', async () => {
        const store = {
            getPendingInvitationsForUser: async () => [],
            acceptOrgInvitation: async () => null,
        }

        const app = createAuthedApp(store, 'user@example.com')

        const response = await app.request('/api/invitations/invite-404/accept', {
            method: 'POST',
        })

        expect(response.status).toBe(404)
    })
})
