import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { configuration, createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

function authHeaders() {
    return {
        authorization: `Bearer ${configuration.cliApiToken}`,
        'content-type': 'application/json',
        'x-org-id': 'org-a',
    }
}

type MockPool = {
    query: ReturnType<typeof mock>
}

function makePool(responses: Array<{ rows: Record<string, unknown>[] }>): MockPool {
    const queue = [...responses]
    return {
        query: mock(async () => queue.shift() ?? { rows: [] }),
    }
}

describe('createCliRoutes ai task schedules', () => {
    beforeAll(async () => {
        await createConfiguration()
    })

    it('creates a schedule for the current session machine', async () => {
        const pool = makePool([
            { rows: [{ count: 0 }] },
            { rows: [] },
        ])
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getProjects: async () => [{
                id: 'project-1',
                path: '/test/dir',
                machineId: 'machine-a',
                orgId: 'org-a',
            }],
            getPool: () => pool,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/worker/schedules?sessionId=session-1', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                cronOrDelay: '0 9 * * 1',
                prompt: 'run report',
                directory: '/test/dir',
                recurring: true,
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(200)
        const body = await response.json() as Record<string, unknown>
        expect(typeof body.scheduleId).toBe('string')
        expect(body.status).toBe('registered')
        const insertParams = (pool.query.mock.calls[1] as [string, unknown[]])[1]
        expect(insertParams).toContain('machine-a')
    })

    it('rejects ISO delay when recurring=true', async () => {
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getProjects: async () => [{
                id: 'project-1',
                path: '/test/dir',
                machineId: 'machine-a',
                orgId: 'org-a',
            }],
            getPool: () => makePool([]),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/worker/schedules?sessionId=session-1', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                cronOrDelay: 'PT30M',
                prompt: 'run report',
                directory: '/test/dir',
                recurring: true,
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'delay_requires_non_recurring',
        })
    })

    it('lists schedules for the current session machine only', async () => {
        const pool = makePool([{
            rows: [{
                id: 'sched-1',
                machine_id: 'machine-a',
                label: 'Weekly report',
                cron_expr: '0 9 * * 1',
                payload_prompt: 'run weekly report',
                recurring: true,
                directory: '/test/dir',
                agent: 'claude',
                mode: 'sonnet',
                enabled: true,
                created_at: 1_700_000_000_000,
                next_fire_at: 1_700_000_360_000,
                last_fire_at: null,
                last_run_status: null,
            }],
        }])
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getPool: () => pool,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/worker/schedules?sessionId=session-1', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        const body = await response.json() as { schedules: Array<Record<string, unknown>> }
        expect(body.schedules).toHaveLength(1)
        expect(body.schedules[0]?.machineId).toBe('machine-a')
        const params = (pool.query.mock.calls[0] as [string, unknown[]])[1]
        expect(params).toEqual(['machine-a'])
    })

    it('cancels schedules only on the current session machine', async () => {
        const pool = makePool([{ rows: [] }])
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getPool: () => pool,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/worker/schedules/sched-1/cancel?sessionId=session-1', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })

        expect(response.status).toBe(404)
        const params = (pool.query.mock.calls[0] as [string, unknown[]])[1]
        expect(params).toEqual(['sched-1', 'machine-a'])
    })
})
