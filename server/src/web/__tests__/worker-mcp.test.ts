import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { createWorkerMcpRoutes } from '../routes/worker-mcp'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockPool = {
    query: ReturnType<typeof mock>
    _responses: Array<{ rows: unknown[] }>
}

function makePool(responses: Array<{ rows: unknown[] }>): MockPool {
    const iter = [...responses]
    let idx = 0
    const queryFn = mock(async (_sql: string, _params?: unknown[]) => {
        return iter[idx++] ?? { rows: [] }
    })
    return { query: queryFn, _responses: responses }
}

const DEFAULT_PROJECTS = [{ id: 'proj-1', path: '/test/dir', machineId: 'machine-1', name: 'Test' }]

function makeStore(overrides?: {
    projects?: typeof DEFAULT_PROJECTS
    getMachineFn?: (id: string) => Promise<{ namespace: string } | null>
    pool?: MockPool
}) {
    const pool = overrides?.pool ?? makePool([])
    return {
        getProjects: mock(async (_machineId: string | null) => overrides?.projects ?? DEFAULT_PROJECTS),
        getMachine: mock(overrides?.getMachineFn ?? (async (_id: string) => null)),
        getPool: mock(() => pool),
        _pool: pool,
    }
}

const DEFAULT_MACHINE = { id: 'machine-1', namespace: 'ns-1', active: true }

type FakeSession = {
    id: string
    namespace: string
    active: boolean
    thinking: boolean
    metadata?: { machineId?: string; path?: string; runtimeAgent?: string } | null
}

function makeEngine(overrides?: {
    machines?: Array<{ id: string; namespace: string; active: boolean }>
    sessions?: FakeSession[]
    spawnResult?: { type: 'success'; sessionId: string } | { type: 'error'; message: string }
}) {
    const machines = overrides?.machines ?? [DEFAULT_MACHINE]
    const sessions = overrides?.sessions ?? []
    return {
        getMachines: mock(() => machines),
        getSession: mock((id: string) => sessions.find(s => s.id === id) ?? null),
        getSessionsByNamespace: mock((ns: string) => sessions.filter(s => s.namespace === ns)),
        spawnSession: mock(async () => overrides?.spawnResult ?? { type: 'success', sessionId: 'new-sess-1' }),
        sendMessage: mock(async () => ({ status: 'delivered' })),
        terminateSessionProcess: mock(async () => { }),
    }
}

function buildApp(getSyncEngine: () => ReturnType<typeof makeEngine> | null, store: ReturnType<typeof makeStore>) {
    const app = new Hono()
    app.route('/', createWorkerMcpRoutes(getSyncEngine as any, store as any))
    return app
}

function json(body: unknown) {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

// ---------------------------------------------------------------------------
// /worker/schedule-task
// ---------------------------------------------------------------------------

describe('/worker/schedule-task', () => {
    it('valid cron "0 9 * * 1" → 200 with scheduleId + nextFireAt', async () => {
        const pool = makePool([{ rows: [{ count: '0' }] }, { rows: [] }])
        const store = makeStore({ pool })
        const engine = makeEngine()
        const app = buildApp(() => engine, store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: true,
            agent: 'claude',
        }))

        expect(res.status).toBe(200)
        const body = await res.json() as Record<string, unknown>
        expect(typeof body.scheduleId).toBe('string')
        expect(typeof body.nextFireAt).toBe('string')
        expect(body.status).toBe('registered')
    })

    it('invalid cron "garbage" → 400', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: 'garbage',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: false,
            agent: 'claude',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('invalid_cron')
    })

    it('ISO duration "PT30M" → 200', async () => {
        const pool = makePool([{ rows: [{ count: '0' }] }, { rows: [] }])
        const store = makeStore({ pool })
        const engine = makeEngine()
        const app = buildApp(() => engine, store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: 'PT30M',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: false,
            agent: 'claude',
        }))

        expect(res.status).toBe(200)
        const body = await res.json() as Record<string, unknown>
        expect(typeof body.scheduleId).toBe('string')
    })

    it('directory not in projects → 400 directory_not_registered', async () => {
        const store = makeStore({ projects: [] })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'do something',
            directory: '/not/registered',
            recurring: false,
            agent: 'claude',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('directory_not_registered')
    })

    it('prompt > 4000 chars → 400 (zod validation)', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'x'.repeat(4001),
            directory: '/test/dir',
            recurring: false,
            agent: 'claude',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('invalid_body')
    })

    it('agent="codex" is valid → 200', async () => {
        const pool = makePool([{ rows: [{ count: '0' }] }, { rows: [] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'codex task',
            directory: '/test/dir',
            recurring: true,
            agent: 'codex',
        }))

        expect(res.status).toBe(200)
    })

    it('agent="bash" is invalid → 400 (zod enum)', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: false,
            agent: 'bash',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('invalid_body')
    })

    it('quota: COUNT = 20 → 429 quota_exceeded', async () => {
        // Simulate 20 existing enabled schedules
        const pool = makePool([{ rows: [{ count: '20' }] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'the 21st task',
            directory: '/test/dir',
            recurring: true,
            agent: 'claude',
        }))

        expect(res.status).toBe(429)
        expect((await res.json() as any).error).toBe('quota_exceeded')
    })
})

// ---------------------------------------------------------------------------
// /worker/list-schedules
// ---------------------------------------------------------------------------

describe('/worker/list-schedules', () => {
    const enabledRow = {
        id: 'sched-1', label: 'my task', cron_expr: '0 9 * * 1',
        recurring: true, directory: '/test/dir', agent: 'claude',
        enabled: true, created_at: '1700000000000', next_fire_at: null,
        last_fire_at: null, last_run_status: null,
    }
    const disabledRow = {
        id: 'sched-2', label: null, cron_expr: '0 10 * * 1',
        recurring: false, directory: '/test/dir', agent: 'claude',
        enabled: false, created_at: '1700000001000', next_fire_at: null,
        last_fire_at: null, last_run_status: null,
    }

    it('includeDisabled=false → SQL includes "enabled = true"', async () => {
        const pool = makePool([{ rows: [enabledRow] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({ includeDisabled: false }))

        expect(res.status).toBe(200)
        const sql = (pool.query.mock.calls[0] as [string])[0]
        expect(sql).toContain('enabled = true')
        const body = await res.json() as { schedules: unknown[] }
        expect(body.schedules).toHaveLength(1)
    })

    it('includeDisabled=true → SQL does NOT include "enabled = true"', async () => {
        const pool = makePool([{ rows: [enabledRow, disabledRow] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({ includeDisabled: true }))

        expect(res.status).toBe(200)
        const sql = (pool.query.mock.calls[0] as [string])[0]
        expect(sql).not.toContain('enabled = true')
        const body = await res.json() as { schedules: unknown[] }
        expect(body.schedules).toHaveLength(2)
    })

    it('machineId filter → SQL uses machine_id = $1 and passes correct param', async () => {
        const pool = makePool([{ rows: [enabledRow] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({ machineId: 'machine-1' }))

        expect(res.status).toBe(200)
        const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('machine_id = $1')
        expect(params).toEqual(['machine-1'])
    })
})

// ---------------------------------------------------------------------------
// /worker/cancel-schedule
// ---------------------------------------------------------------------------

describe('/worker/cancel-schedule', () => {
    it('valid scheduleId → 200, UPDATE called', async () => {
        const pool = makePool([{ rows: [{ id: 'sched-1', enabled: false }] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/cancel-schedule', json({ scheduleId: 'sched-1' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(pool.query.mock.calls).toHaveLength(1)
        const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('UPDATE ai_task_schedules')
        expect(params).toContain('sched-1')
    })

    it('non-existent scheduleId → 404 schedule_not_found', async () => {
        const pool = makePool([{ rows: [] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/cancel-schedule', json({ scheduleId: 'does-not-exist' }))

        expect(res.status).toBe(404)
        expect((await res.json() as any).error).toBe('schedule_not_found')
    })
})

// ---------------------------------------------------------------------------
// /session/find-or-create
// ---------------------------------------------------------------------------

describe('/session/find-or-create', () => {
    it('no engine → 503 not_connected', async () => {
        const store = makeStore()
        const app = buildApp(() => null, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude',
        }))

        expect(res.status).toBe(503)
    })

    it('existing active session matching dir+agent → returns its sessionId without spawning', async () => {
        const existingSession: FakeSession = {
            id: 'existing-sess',
            namespace: 'ns-1',
            active: true,
            thinking: false,
            metadata: { machineId: 'machine-1', path: '/test/dir', runtimeAgent: 'claude' },
        }
        const engine = makeEngine({ sessions: [existingSession] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'machine-1',
        }))

        expect(res.status).toBe(200)
        expect((await res.json() as any).sessionId).toBe('existing-sess')
        expect(engine.spawnSession.mock.calls).toHaveLength(0)
    })

    it('no existing session → spawnSession called, returns new sessionId', async () => {
        const engine = makeEngine({ spawnResult: { type: 'success', sessionId: 'spawned-1' } })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'machine-1',
        }))

        expect(res.status).toBe(200)
        expect((await res.json() as any).sessionId).toBe('spawned-1')
        expect(engine.spawnSession.mock.calls).toHaveLength(1)
    })

    it('agent="codex" with codexModel → codexModel forwarded to spawnSession options', async () => {
        const engine = makeEngine()
        const store = makeStore()
        const app = buildApp(() => engine, store)

        await app.request('/session/find-or-create', json({
            directory: '/test/dir',
            agent: 'codex',
            machineId: 'machine-1',
            codexModel: 'codex-mini',
        }))

        expect(engine.spawnSession.mock.calls).toHaveLength(1)
        const spawnOpts = (engine.spawnSession.mock.calls[0] as unknown[])[4] as Record<string, unknown>
        expect(spawnOpts.codexModel).toBe('codex-mini')
    })

    it('machineId not found → 404 machine_not_found', async () => {
        const engine = makeEngine({ machines: [] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'no-such-machine',
        }))

        expect(res.status).toBe(404)
        expect((await res.json() as any).error).toBe('machine_not_found')
    })
})

// ---------------------------------------------------------------------------
// /session/send
// ---------------------------------------------------------------------------

describe('/session/send', () => {
    it('valid sessionId → sendMessage called, returns { ok: true }', async () => {
        const session: FakeSession = { id: 'sess-1', namespace: 'ns-1', active: true, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/send', json({
            sessionId: 'sess-1', message: 'hello',
        }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(engine.sendMessage.mock.calls).toHaveLength(1)
        const [sid, payload] = engine.sendMessage.mock.calls[0] as unknown as [string, { text: string }]
        expect(sid).toBe('sess-1')
        expect(payload.text).toBe('hello')
    })

    it('unknown sessionId → 404 session_not_found', async () => {
        const engine = makeEngine({ sessions: [] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/send', json({
            sessionId: 'ghost', message: 'hello',
        }))

        expect(res.status).toBe(404)
    })
})

// ---------------------------------------------------------------------------
// /session/status
// ---------------------------------------------------------------------------

describe('/session/status', () => {
    it('thinking=true session → executing: true', async () => {
        const session: FakeSession = { id: 'sess-run', namespace: 'ns-1', active: true, thinking: true }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/status', json({ sessionId: 'sess-run' }))

        expect(res.status).toBe(200)
        const body = await res.json() as { status: string; executing: boolean }
        expect(body.executing).toBe(true)
        expect(body.status).toBe('active')
    })

    it('thinking=false session → executing: false, status: active', async () => {
        const session: FakeSession = { id: 'sess-idle', namespace: 'ns-1', active: true, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/status', json({ sessionId: 'sess-idle' }))

        expect(res.status).toBe(200)
        const body = await res.json() as { status: string; executing: boolean }
        expect(body.executing).toBe(false)
        expect(body.status).toBe('active')
    })

    it('inactive session → status: inactive', async () => {
        const session: FakeSession = { id: 'sess-done', namespace: 'ns-1', active: false, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/status', json({ sessionId: 'sess-done' }))

        expect(res.status).toBe(200)
        const body = await res.json() as { status: string }
        expect(body.status).toBe('inactive')
    })

    it('unknown sessionId → 404', async () => {
        const engine = makeEngine({ sessions: [] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/status', json({ sessionId: 'ghost' }))

        expect(res.status).toBe(404)
    })
})

// ---------------------------------------------------------------------------
// /session/stop
// ---------------------------------------------------------------------------

describe('/session/stop', () => {
    it('valid sessionId → terminateSessionProcess called, returns { ok: true }', async () => {
        const session: FakeSession = { id: 'sess-1', namespace: 'ns-1', active: true, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/stop', json({ sessionId: 'sess-1' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(engine.terminateSessionProcess.mock.calls).toHaveLength(1)
        expect((engine.terminateSessionProcess.mock.calls[0] as unknown as [string])[0]).toBe('sess-1')
    })

    it('unknown sessionId → 404', async () => {
        const engine = makeEngine({ sessions: [] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/stop', json({ sessionId: 'ghost' }))

        expect(res.status).toBe(404)
    })
})
