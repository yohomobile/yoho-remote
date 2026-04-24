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
    patchSessionMetadataFn?: (id: string, patch: Record<string, unknown>, orgId: string) => Promise<boolean>
}) {
    const pool = overrides?.pool ?? makePool([])
    return {
        getProjects: mock(async (_machineId: string | null) => overrides?.projects ?? DEFAULT_PROJECTS),
        getMachine: mock(overrides?.getMachineFn ?? (async (_id: string) => null)),
        getPool: mock(() => pool),
        patchSessionMetadata: mock(
            overrides?.patchSessionMetadataFn
                ?? (async (_id: string, _patch: Record<string, unknown>, _orgId: string) => true),
        ),
        _pool: pool,
    }
}

const DEFAULT_MACHINE = { id: 'machine-1', namespace: 'ns-1', orgId: 'org-1', active: true }

type FakeSession = {
    id: string
    namespace: string
    orgId?: string | null
    active: boolean
    thinking: boolean
    metadata?: { machineId?: string; path?: string; runtimeAgent?: string } | null
}

type SendOutcome = { status: 'delivered' | 'queued'; queue?: string; queueDepth?: number }

function makeEngine(overrides?: {
    machines?: Array<{ id: string; namespace: string; orgId?: string | null; active: boolean }>
    sessions?: FakeSession[]
    spawnResult?: { type: 'success'; sessionId: string } | { type: 'error'; message: string }
    triggerChildCallbackFn?: (sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
}) {
    const machines = overrides?.machines ?? [DEFAULT_MACHINE]
    const sessions = overrides?.sessions ?? []
    return {
        getMachines: mock(() => machines),
        getSession: mock((id: string) => sessions.find(s => s.id === id) ?? null),
        getSessionsByNamespace: mock((ns: string) => sessions.filter(s => s.namespace === ns)),
        getSessionsByOrg: mock((orgId: string) => sessions.filter(s => s.orgId === orgId)),
        getSendOutcomeForCachedLocalId: mock((_sessionId: string, _localId: string): SendOutcome | null => null),
        spawnSession: mock(async () => overrides?.spawnResult ?? { type: 'success', sessionId: 'new-sess-1' }),
        sendMessage: mock(async () => ({ status: 'delivered' })),
        terminateSessionProcess: mock(async () => { }),
        triggerChildCallback: mock(
            overrides?.triggerChildCallbackFn
                ?? (async (_sessionId: string) => ({ ok: true as const })),
        ),
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

    it('ISO duration with recurring=true → 400 delay_requires_non_recurring', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: 'PT30M',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: true,
            agent: 'claude',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('delay_requires_non_recurring')
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

    it('machine has no orgId (engine + store) → 400 org_not_resolved', async () => {
        const pool = makePool([])
        const store = makeStore({ pool })
        store.getMachine = mock(async (_id: string) => ({ orgId: null })) as any
        const engine = makeEngine({
            machines: [{ id: 'machine-1', namespace: 'ns-1', orgId: null, active: true }],
        })
        const app = buildApp(() => engine, store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: true,
            agent: 'claude',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('org_not_resolved')
    })

    it('stores orgId (not namespace string) into namespace column', async () => {
        const pool = makePool([{ rows: [{ count: '0' }] }, { rows: [] }])
        const store = makeStore({ pool })
        const engine = makeEngine({
            machines: [{ id: 'machine-1', namespace: 'ns-XYZ', orgId: 'org-9', active: true }],
        })
        const app = buildApp(() => engine, store)

        const res = await app.request('/worker/schedule-task', json({
            cronOrDelay: '0 9 * * 1',
            prompt: 'do something',
            directory: '/test/dir',
            recurring: true,
            agent: 'claude',
        }))

        expect(res.status).toBe(200)
        const insertCall = pool.query.mock.calls[1] as [string, unknown[]]
        expect(insertCall[0]).toContain('INSERT INTO ai_task_schedules')
        // params: [id, namespace, machine_id, ...] — index 1 is the namespace column,
        // which must carry orgId 'org-9', not the old namespace string 'ns-XYZ'.
        expect(insertCall[1][1]).toBe('org-9')
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

    it('includeDisabled=false → SQL includes "enabled = true" and machine_id filter', async () => {
        const pool = makePool([{ rows: [enabledRow] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({
            machineId: 'machine-1',
            includeDisabled: false,
        }))

        expect(res.status).toBe(200)
        const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('machine_id = $1')
        expect(sql).toContain('enabled = true')
        expect(params).toEqual(['machine-1'])
        const body = await res.json() as { schedules: unknown[] }
        expect(body.schedules).toHaveLength(1)
    })

    it('includeDisabled=true → SQL does NOT include "enabled = true"', async () => {
        const pool = makePool([{ rows: [enabledRow, disabledRow] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({
            machineId: 'machine-1',
            includeDisabled: true,
        }))

        expect(res.status).toBe(200)
        const sql = (pool.query.mock.calls[0] as [string])[0]
        expect(sql).not.toContain('enabled = true')
        const body = await res.json() as { schedules: unknown[] }
        expect(body.schedules).toHaveLength(2)
    })

    it('missing machineId → 400 invalid_body', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/list-schedules', json({}))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('invalid_body')
    })
})

// ---------------------------------------------------------------------------
// /worker/cancel-schedule
// ---------------------------------------------------------------------------

describe('/worker/cancel-schedule', () => {
    it('valid scheduleId + machineId → 200, UPDATE scoped to both', async () => {
        const pool = makePool([{ rows: [{ id: 'sched-1' }] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/cancel-schedule', json({
            scheduleId: 'sched-1',
            machineId: 'machine-1',
        }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(pool.query.mock.calls).toHaveLength(1)
        const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('UPDATE ai_task_schedules')
        expect(sql).toContain('machine_id = $2')
        expect(params).toEqual(['sched-1', 'machine-1'])
    })

    it('non-existent scheduleId → 404 schedule_not_found', async () => {
        const pool = makePool([{ rows: [] }])
        const store = makeStore({ pool })
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/cancel-schedule', json({
            scheduleId: 'does-not-exist',
            machineId: 'machine-1',
        }))

        expect(res.status).toBe(404)
        expect((await res.json() as any).error).toBe('schedule_not_found')
    })

    it('missing machineId → 400 invalid_body (cross-machine cancel blocked)', async () => {
        const store = makeStore()
        const app = buildApp(() => makeEngine(), store)

        const res = await app.request('/worker/cancel-schedule', json({ scheduleId: 'sched-1' }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('invalid_body')
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
            orgId: 'org-1',
            active: true,
            thinking: false,
            metadata: { machineId: 'machine-1', path: '/test/dir', runtimeAgent: 'claude', source: 'worker-ai-task' },
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

    it('machine has no orgId → 400 org_not_resolved', async () => {
        const engine = makeEngine({
            machines: [{ id: 'machine-1', namespace: 'ns-1', orgId: null, active: true }],
        })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'machine-1',
        }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('org_not_resolved')
    })

    it('mainSessionId + callbackOnFailureOnly=true → spawn called with source=orchestrator-child + patchSessionMetadata fires', async () => {
        const engine = makeEngine({ spawnResult: { type: 'success', sessionId: 'spawned-child' } })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir',
            agent: 'claude',
            machineId: 'machine-1',
            mainSessionId: 'brain-main-1',
            callbackOnFailureOnly: true,
        }))

        expect(res.status).toBe(200)
        expect((await res.json() as any).sessionId).toBe('spawned-child')
        // Spawn receives source + mainSessionId so runClaude writes the right metadata
        // at session creation.
        expect(engine.spawnSession.mock.calls).toHaveLength(1)
        const spawnOpts = (engine.spawnSession.mock.calls[0] as unknown[])[4] as Record<string, unknown>
        expect(spawnOpts.source).toBe('orchestrator-child')
        expect(spawnOpts.mainSessionId).toBe('brain-main-1')
        // Post-spawn patch puts the suppression flag on the new session.
        expect(store.patchSessionMetadata.mock.calls).toHaveLength(1)
        const [patchId, patch, orgId] = store.patchSessionMetadata.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
        expect(patchId).toBe('spawned-child')
        expect(patch).toEqual({ callbackOnFailureOnly: true })
        expect(orgId).toBe('org-1')
    })

    it('no mainSessionId → spawn options have no source/mainSessionId override and no metadata patch', async () => {
        const engine = makeEngine({ spawnResult: { type: 'success', sessionId: 'spawned-plain' } })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'machine-1',
        }))

        expect(res.status).toBe(200)
        const spawnOpts = (engine.spawnSession.mock.calls[0] as unknown[])[4] as Record<string, unknown>
        expect(spawnOpts.mainSessionId).toBeUndefined()
        // Legacy callers without mainSessionId default the source to 'worker-ai-task'.
        expect(spawnOpts.source).toBe('worker-ai-task')
        expect(store.patchSessionMetadata.mock.calls).toHaveLength(0)
    })

    it('mainSessionId mismatch on existing session → spawn new one instead of reusing', async () => {
        const plainSession: FakeSession = {
            id: 'plain-existing',
            namespace: 'ns-1',
            orgId: 'org-1',
            active: true,
            thinking: false,
            metadata: { machineId: 'machine-1', path: '/test/dir', runtimeAgent: 'claude' },
        }
        const engine = makeEngine({
            sessions: [plainSession],
            spawnResult: { type: 'success', sessionId: 'spawned-child' },
        })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir',
            agent: 'claude',
            machineId: 'machine-1',
            mainSessionId: 'brain-main-1',
        }))

        expect(res.status).toBe(200)
        // Plain session with no mainSessionId in metadata must NOT be hijacked as a
        // child of some brain — spawn a fresh one instead.
        expect((await res.json() as any).sessionId).toBe('spawned-child')
        expect(engine.spawnSession.mock.calls).toHaveLength(1)
    })

    it('reused session with matching mainSessionId → callbackOnFailureOnly patched on reuse', async () => {
        const childSession: FakeSession = {
            id: 'existing-child',
            namespace: 'ns-1',
            orgId: 'org-1',
            active: true,
            thinking: false,
            metadata: {
                machineId: 'machine-1',
                path: '/test/dir',
                runtimeAgent: 'claude',
                mainSessionId: 'brain-main-1',
                source: 'orchestrator-child',
            } as any,
        }
        const engine = makeEngine({ sessions: [childSession] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir',
            agent: 'claude',
            machineId: 'machine-1',
            mainSessionId: 'brain-main-1',
            callbackOnFailureOnly: false,
        }))

        expect(res.status).toBe(200)
        expect((await res.json() as any).sessionId).toBe('existing-child')
        expect(engine.spawnSession.mock.calls).toHaveLength(0)
        expect(store.patchSessionMetadata.mock.calls).toHaveLength(1)
        const [patchId, patch] = store.patchSessionMetadata.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(patchId).toBe('existing-child')
        expect(patch).toEqual({ callbackOnFailureOnly: false })
    })

    it('finds existing session scoped by orgId (getSessionsByOrg, not getSessionsByNamespace)', async () => {
        const mySession: FakeSession = {
            id: 'sess-mine', namespace: 'ns-1', orgId: 'org-1', active: true, thinking: false,
            metadata: { machineId: 'machine-1', path: '/test/dir', runtimeAgent: 'claude', source: 'worker-ai-task' },
        }
        const otherOrgSession: FakeSession = {
            id: 'sess-other', namespace: 'ns-1', orgId: 'org-2', active: true, thinking: false,
            metadata: { machineId: 'machine-1', path: '/test/dir', runtimeAgent: 'claude', source: 'worker-ai-task' },
        }
        const engine = makeEngine({ sessions: [otherOrgSession, mySession] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/find-or-create', json({
            directory: '/test/dir', agent: 'claude', machineId: 'machine-1',
        }))

        expect(res.status).toBe(200)
        expect((await res.json() as any).sessionId).toBe('sess-mine')
        expect(engine.getSessionsByOrg.mock.calls).toHaveLength(1)
        expect((engine.getSessionsByOrg.mock.calls[0] as unknown as [string])[0]).toBe('org-1')
    })
})

// ---------------------------------------------------------------------------
// /session/trigger-callback
// ---------------------------------------------------------------------------

describe('/session/trigger-callback', () => {
    it('no engine → 503 not_connected', async () => {
        const store = makeStore()
        const app = buildApp(() => null, store)

        const res = await app.request('/session/trigger-callback', json({ sessionId: 'sess-1' }))

        expect(res.status).toBe(503)
    })

    it('missing sessionId → 400 invalid_body', async () => {
        const engine = makeEngine()
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/trigger-callback', json({}))

        expect(res.status).toBe(400)
    })

    it('engine.triggerChildCallback reports session_not_found → 404', async () => {
        const engine = makeEngine({
            triggerChildCallbackFn: async (_sessionId: string) => ({ ok: false, reason: 'session_not_found' }),
        })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/trigger-callback', json({ sessionId: 'ghost' }))

        expect(res.status).toBe(404)
        expect((await res.json() as any).error).toBe('session_not_found')
    })

    it('engine reports not_child_session → 400', async () => {
        const engine = makeEngine({
            triggerChildCallbackFn: async (_sessionId: string) => ({ ok: false, reason: 'not_child_session' }),
        })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/trigger-callback', json({ sessionId: 'plain-session' }))

        expect(res.status).toBe(400)
        expect((await res.json() as any).error).toBe('not_child_session')
    })

    it('ok path → 200 and engine called with the right sessionId', async () => {
        const engine = makeEngine()
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/trigger-callback', json({ sessionId: 'child-sess' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(engine.triggerChildCallback.mock.calls).toHaveLength(1)
        expect((engine.triggerChildCallback.mock.calls[0] as unknown as [string])[0]).toBe('child-sess')
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
        const [sid, payload] = engine.sendMessage.mock.calls[0] as unknown as [string, { text: string; localId: string }]
        expect(sid).toBe('sess-1')
        expect(payload.text).toBe('hello')
        expect(payload.localId).toBeTruthy()
    })

    it('valid localId → passes stable idempotency key to sendMessage', async () => {
        const session: FakeSession = { id: 'sess-1', namespace: 'ns-1', active: true, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/send', json({
            sessionId: 'sess-1', message: 'hello', localId: 'worker-ai-task:run-1:prompt',
        }))

        expect(res.status).toBe(200)
        const [, payload] = engine.sendMessage.mock.calls[0] as unknown as [string, { localId: string }]
        expect(payload.localId).toBe('worker-ai-task:run-1:prompt')
    })

    it('duplicate localId in cache → does not resend message', async () => {
        const session: FakeSession = { id: 'sess-1', namespace: 'ns-1', active: true, thinking: false }
        const engine = makeEngine({ sessions: [session] })
        engine.getSendOutcomeForCachedLocalId = mock((_sessionId: string, _localId: string) => ({ status: 'delivered' }))
        const store = makeStore()
        const app = buildApp(() => engine, store)

        const res = await app.request('/session/send', json({
            sessionId: 'sess-1', message: 'hello', localId: 'worker-ai-task:run-1:prompt',
        }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, deduped: true, status: 'delivered' })
        expect(engine.sendMessage.mock.calls).toHaveLength(0)
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
