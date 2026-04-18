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
                    createdBy: 'owner@example.com'
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
                    orgId: null,
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

    it('denies CLI uploads when the session belongs to another namespace', async () => {
        let addDownloadFileCalls = 0

        const fakeStore = {
            getSession: async (sessionId: string) => {
                expect(sessionId).toBe('session-1')
                return {
                    id: 'session-1',
                    namespace: 'default',
                    createdBy: 'owner@example.com',
                    orgId: null
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
                authorization: `Bearer ${configuration.cliApiToken}:other-namespace`,
                'content-type': 'application/json'
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
})
