import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { configuration, createConfiguration } from '../../configuration'
import type { WebAppEnv } from '../middleware/auth'
import { createDownloadApiRoutes, createDownloadCliRoutes } from './downloads'

describe('createDownloadApiRoutes', () => {
    beforeAll(async () => {
        await createConfiguration()
    })

    it('denies list, cleanup, and file download when the session is not shared', async () => {
        let getSessionCalls = 0
        let shareCheckCalls = 0
        let ownerShareAllCalls = 0

        const fakeStore = {
            getSession: async (sessionId: string) => {
                getSessionCalls += 1
                expect(sessionId).toBe('session-1')
                return {
                    id: 'session-1',
                    namespace: 'default',
                    createdBy: 'owner@example.com',
                    orgId: 'org-a',
                }
            },
            isSessionSharedWith: async (sessionId: string, email: string) => {
                shareCheckCalls += 1
                expect(sessionId).toBe('session-1')
                expect(email).toBe('viewer@example.com')
                return false
            },
            getShareAllSessions: async (email: string) => {
                ownerShareAllCalls += 1
                expect(email).toBe('owner@example.com')
                return false
            },
            listDownloadFiles: async () => {
                throw new Error('listDownloadFiles should not be called when access is denied')
            },
            clearDownloadFiles: async () => {
                throw new Error('clearDownloadFiles should not be called when access is denied')
            },
            getDownloadFile: async () => ({
                meta: {
                    id: 'file-1',
                    sessionId: 'session-1',
                    orgId: 'org-a',
                    filename: 'report.txt',
                    mimeType: 'text/plain',
                    size: 4,
                    createdAt: 1
                },
                content: Buffer.from('test')
            })
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('email', 'viewer@example.com')
            c.set('role', 'developer')
            c.set('orgs', [{ id: 'org-a', name: 'Org A', role: 'member' }])
            await next()
        })
        app.route('/api', createDownloadApiRoutes(fakeStore as any))

        const listResponse = await app.request('/api/sessions/session-1/downloads')
        const clearResponse = await app.request('/api/sessions/session-1/downloads', {
            method: 'DELETE'
        })
        const fileResponse = await app.request('/api/downloads/file-1')

        expect(listResponse.status).toBe(403)
        expect(clearResponse.status).toBe(403)
        expect(fileResponse.status).toBe(403)
        expect(getSessionCalls).toBe(3)
        expect(shareCheckCalls).toBe(3)
        expect(ownerShareAllCalls).toBe(3)
    })
})

describe('createDownloadCliRoutes', () => {
    beforeAll(async () => {
        await createConfiguration()
    })

    it('denies CLI uploads when the session belongs to another org', async () => {
        let addDownloadFileCalls = 0

        const fakeStore = {
            getSession: async (sessionId: string) => {
                expect(sessionId).toBe('session-1')
                return {
                    id: 'session-1',
                    namespace: 'default',
                    createdBy: 'owner@example.com',
                    orgId: 'org-a'
                }
            },
            addDownloadFile: async () => {
                addDownloadFileCalls += 1
                throw new Error('addDownloadFile should not be called when access is denied')
            }
        }

        const app = new Hono()
        app.route('/cli', createDownloadCliRoutes(() => null, fakeStore as any))

        const response = await app.request('/cli/files', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${configuration.cliApiToken}`,
                'content-type': 'application/json',
                'x-org-id': 'org-b',
            },
            body: JSON.stringify({
                sessionId: 'session-1',
                filename: 'report.txt',
                content: Buffer.from('test').toString('base64'),
                mimeType: 'text/plain'
            })
        })

        expect(response.status).toBe(403)
        expect(addDownloadFileCalls).toBe(0)
    })

    it('allows Web users in the session org to list downloads for their own session', async () => {
        let listCalls = 0
        const fakeStore = {
            getSession: async () => ({
                id: 'session-1',
                namespace: 'default',
                createdBy: 'owner@example.com',
                orgId: 'org-a',
            }),
            listDownloadFiles: async () => {
                listCalls += 1
                return [{
                    id: 'file-1',
                    sessionId: 'session-1',
                    orgId: 'org-a',
                    filename: 'report.txt',
                    mimeType: 'text/plain',
                    size: 4,
                    createdAt: 1,
                }]
            },
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('email', 'owner@example.com')
            c.set('role', 'developer')
            c.set('orgs', [{ id: 'org-a', name: 'Org A', role: 'member' }])
            await next()
        })
        app.route('/api', createDownloadApiRoutes(fakeStore as any))

        const response = await app.request('/api/sessions/session-1/downloads')

        expect(response.status).toBe(200)
        expect(listCalls).toBe(1)
    })
})
