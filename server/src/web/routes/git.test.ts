import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

describe('createGitRoutes', () => {
    it('denies git access when the session is not shared with the current user', async () => {
        let shareChecks = 0
        let ownerShareAllChecks = 0

        const fakeEngine = {
            getOrRefreshSession: async () => ({
                id: 'session-1',
                namespace: 'default',
                orgId: 'test-org',
                createdBy: 'owner@example.com',
                active: true,
                metadata: {
                    path: '/repo'
                }
            })
        }

        const fakeStore = {
            isSessionSharedWith: async (sessionId: string, email: string) => {
                shareChecks += 1
                expect(sessionId).toBe('session-1')
                expect(email).toBe('viewer@example.com')
                return false
            },
            getShareAllSessions: async (email: string) => {
                ownerShareAllChecks += 1
                expect(email).toBe('owner@example.com')
                return false
            }
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('email', 'viewer@example.com')
            c.set('orgs', [{ id: 'test-org' }])
            await next()
        })
        app.route('/api', createGitRoutes(() => fakeEngine as any, fakeStore as any))

        const responses = await Promise.all([
            app.request('/api/sessions/session-1/git-status'),
            app.request('/api/sessions/session-1/git-diff-numstat'),
            app.request('/api/sessions/session-1/git-diff-file?path=README.md'),
            app.request('/api/sessions/session-1/file?path=README.md')
        ])

        expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403])
        expect(shareChecks).toBe(4)
        expect(ownerShareAllChecks).toBe(4)
    })
})
