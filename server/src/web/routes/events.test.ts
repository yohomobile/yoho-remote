import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'

describe('createEventsRoutes', () => {
    it('denies session subscriptions when share checks fail', async () => {
        let shareCheckCalls = 0
        let ownerShareAllCalls = 0

        const fakeEngine = {
            getOrRefreshSession: async (sessionId: string) => {
                expect(sessionId).toBe('session-1')
                return {
                    id: 'session-1',
                    namespace: 'default',
                    createdBy: 'owner@example.com',
                    active: true
                }
            }
        }

        const fakeStore = {
            isSessionSharedWith: async (sessionId: string, email: string) => {
                shareCheckCalls += 1
                expect(sessionId).toBe('session-1')
                expect(email).toBe('user@example.com')
                return false
            },
            getShareAllSessions: async (email: string) => {
                ownerShareAllCalls += 1
                expect(email).toBe('owner@example.com')
                return false
            }
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('email', 'user@example.com')
            await next()
        })
        app.route('/api', createEventsRoutes(() => ({ subscribe: () => {}, unsubscribe: () => {} }) as any, () => fakeEngine as any, fakeStore as any))

        const response = await app.request('/api/events?sessionId=session-1')

        expect(response.status).toBe(403)
        expect(shareCheckCalls).toBe(1)
        expect(ownerShareAllCalls).toBe(1)
    })
})
