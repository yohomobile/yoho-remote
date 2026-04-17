import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

import type { WebAppEnv } from '../middleware/auth'
import { createPermissionsRoutes } from './permissions'

describe('createPermissionsRoutes', () => {
    test('buffers approval responses even when request state has not synced yet', async () => {
        const approvePermission = mock(async () => {})
        const fakeEngine = {
            getSession: () => ({
                id: 'session-1',
                namespace: 'ns-test',
                active: true,
                agentState: {
                    requests: {}
                }
            }),
            approvePermission
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createPermissionsRoutes(() => fakeEngine as any))

        const response = await app.request('/api/sessions/session-1/permissions/tool-1/approve', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({})
        })

        expect(response.status).toBe(200)
        expect(approvePermission).toHaveBeenCalledWith('session-1', 'tool-1', undefined, undefined, undefined, undefined)
    })

    test('buffers deny responses even when request state has not synced yet', async () => {
        const denyPermission = mock(async () => {})
        const fakeEngine = {
            getSession: () => ({
                id: 'session-1',
                namespace: 'ns-test',
                active: true,
                agentState: {
                    requests: {}
                }
            }),
            denyPermission
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createPermissionsRoutes(() => fakeEngine as any))

        const response = await app.request('/api/sessions/session-1/permissions/tool-1/deny', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({})
        })

        expect(response.status).toBe(200)
        expect(denyPermission).toHaveBeenCalledWith('session-1', 'tool-1', undefined)
    })
})
