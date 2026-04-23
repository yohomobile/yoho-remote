import { afterEach, describe, expect, it } from 'bun:test'
import { handleAiTask, type AiTaskPayload } from './aiTask'
import type { WorkerContext } from '../types'

type PoolCall = { sql: string; params: unknown[] }
type FetchCall = { url: string; body: unknown }

function makePool() {
    const calls: PoolCall[] = []
    const pool = {
        query: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql: sql.trim(), params })
            return { rows: [], rowCount: 1 }
        },
    }
    return {
        pool,
        calls,
        // UPDATE ai_task_runs SET status = $1, started_at = $2 WHERE id = $3
        getUpdateRunStatusCalls: () =>
            calls.filter(c => c.sql.includes('started_at') && !c.sql.includes('finished_at')),
        // UPDATE ai_task_runs SET status = $1, finished_at = $2, subsession_id = $3, error = $4 WHERE id = $5
        getUpdateRunResultCalls: () =>
            calls.filter(c => c.sql.includes('finished_at')),
    }
}

function makeCtx(
    poolObj: ReturnType<typeof makePool>,
    configOverrides: Partial<{
        yohoRemoteInternalUrl: string
        workerInternalToken: string
        aiTaskTimeoutMs: number
    }> = {}
): WorkerContext {
    return {
        pool: poolObj.pool,
        boss: {},
        config: {
            bossSchema: 'yr_boss',
            yohoRemoteInternalUrl: 'http://test-server',
            workerInternalToken: 'secret-token',
            aiTaskTimeoutMs: 3_600_000,
            ...configOverrides,
        },
        worker: { host: 'test', version: '0.0.1' },
        sessionStore: {} as WorkerContext['sessionStore'],
        summaryStore: {} as WorkerContext['summaryStore'],
        runStore: {} as WorkerContext['runStore'],
        deepseekClient: {} as WorkerContext['deepseekClient'],
    } as unknown as WorkerContext
}

function makePayload(overrides?: Partial<AiTaskPayload>): AiTaskPayload {
    return {
        scheduleId: 'sched-1',
        runId: 'run-1',
        prompt: 'say hello',
        directory: '/tmp/test',
        agent: 'claude',
        mode: null,
        machineId: 'machine-1',
        ...overrides,
    }
}

type MockFetchResp = { ok: boolean; status?: number; body?: unknown; textBody?: string }

function makeFetchSequence(responses: MockFetchResp[]) {
    const calls: FetchCall[] = []
    let idx = 0

    const fetchImpl = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
        const urlStr =
            typeof url === 'string' ? url
            : url instanceof URL ? url.toString()
            : (url as Request).url
        let body: unknown
        try {
            body = JSON.parse((options?.body as string) ?? '{}')
        } catch {
            body = options?.body
        }
        calls.push({ url: urlStr, body })

        const resp = responses[idx++] ?? { ok: false, status: 500, textBody: 'no more mock responses' }
        const status = resp.status ?? (resp.ok ? 200 : 500)
        return {
            ok: resp.ok,
            status,
            json: async () => resp.body,
            text: async () => resp.textBody ?? JSON.stringify(resp.body ?? ''),
        } as Response
    }

    const fetchFn = Object.assign(fetchImpl, {
        preconnect: async () => {},
    }) as typeof fetch

    return { fetchFn, calls }
}

// Patch setTimeout to run immediately; returns restore fn
function patchSetTimeoutImmediate() {
    const orig = globalThis.setTimeout
    ;(globalThis as any).setTimeout = (fn: () => void, _ms: number) => orig(fn, 0)
    return () => { globalThis.setTimeout = orig }
}

const origSetTimeoutGlobal = globalThis.setTimeout
const origFetchGlobal = globalThis.fetch

afterEach(() => {
    globalThis.setTimeout = origSetTimeoutGlobal
    globalThis.fetch = origFetchGlobal
})

describe('handleAiTask', () => {
    it('immediately updates run to running status', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-1' } },
            { ok: true, body: {} },
            { ok: true, body: { executing: false } },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload(), ctx)
        } finally {
            restoreTimeout()
        }

        const statusCalls = poolObj.getUpdateRunStatusCalls()
        expect(statusCalls.length).toBeGreaterThanOrEqual(1)
        // params: [status, startedAt, id]
        expect(statusCalls[0]?.params[0]).toBe('running')
        expect(statusCalls[0]?.params[2]).toBe('run-1')
    })

    it('happy path: find-or-create → send → poll → succeeded', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn, calls: fetchCalls } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-happy' } },
            { ok: true, body: {} },
            { ok: true, body: { executing: false } },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload(), ctx)
        } finally {
            restoreTimeout()
        }

        const resultCalls = poolObj.getUpdateRunResultCalls()
        expect(resultCalls).toHaveLength(1)
        // params: [status, finishedAt, subsessionId, error, id]
        expect(resultCalls[0]?.params[0]).toBe('succeeded')
        expect(resultCalls[0]?.params[2]).toBe('sess-happy')
        expect(resultCalls[0]?.params[3]).toBeNull()

        const sendCall = fetchCalls.find(c => c.url.includes('/session/send'))
        expect(sendCall).toBeDefined()
        expect(sendCall!.body).toEqual({
            sessionId: 'sess-happy',
            message: 'say hello',
            localId: 'worker-ai-task:run-1:prompt',
        })
    })

    it('claude agent sends correct modelMode in find-or-create body', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn, calls: fetchCalls } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-claude' } },
            { ok: true, body: {} },
            { ok: true, body: { executing: false } },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload({ agent: 'claude', mode: 'sonnet' }), ctx)
        } finally {
            restoreTimeout()
        }

        const findOrCreate = fetchCalls.find(c => c.url.includes('find-or-create'))
        expect(findOrCreate).toBeDefined()
        const body = findOrCreate!.body as Record<string, unknown>
        expect(body.agent).toBe('claude')
        expect(body.modelMode).toBe('sonnet')
        expect(body.codexModel).toBeUndefined()
        expect(body.permissionMode).toBeUndefined()
    })

    it('codex agent sends correct codexModel and permissionMode in find-or-create body', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn, calls: fetchCalls } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-codex' } },
            { ok: true, body: {} },
            { ok: true, body: { executing: false } },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload({ agent: 'codex', mode: 'gpt-5.4-mini' }), ctx)
        } finally {
            restoreTimeout()
        }

        const findOrCreate = fetchCalls.find(c => c.url.includes('find-or-create'))
        expect(findOrCreate).toBeDefined()
        const body = findOrCreate!.body as Record<string, unknown>
        expect(body.agent).toBe('codex')
        expect(body.codexModel).toBe('gpt-5.4-mini')
        expect(body.permissionMode).toBe('safe-yolo')
        expect(body.modelMode).toBeUndefined()
    })

    it('polls 3 times with executing=true then records succeeded on idle', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn, calls: fetchCalls } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-poll' } },
            { ok: true, body: {} },
            { ok: true, body: { executing: true } },
            { ok: true, body: { executing: true } },
            { ok: true, body: { executing: false } },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload(), ctx)
        } finally {
            restoreTimeout()
        }

        const statusPolls = fetchCalls.filter(c => c.url.includes('/status'))
        expect(statusPolls).toHaveLength(3)

        const resultCalls = poolObj.getUpdateRunResultCalls()
        expect(resultCalls).toHaveLength(1)
        expect(resultCalls[0]?.params[0]).toBe('succeeded')
    })

    it('timeout: calls stop and records timeout after deadline passes', async () => {
        const poolObj = makePool()
        // aiTaskTimeoutMs=-1 → deadline = startedAt - 1 → immediately past on first check
        const ctx = makeCtx(poolObj, { aiTaskTimeoutMs: -1 })
        const { fetchFn, calls: fetchCalls } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-timeout' } },
            { ok: true, body: {} },
            // deadline fires before status poll; stop is the 3rd call
            { ok: true, body: {} },
        ])

        const restoreTimeout = patchSetTimeoutImmediate()
        globalThis.fetch = fetchFn

        try {
            await handleAiTask(makePayload(), ctx)
        } finally {
            restoreTimeout()
        }

        const stopCalls = fetchCalls.filter(c => c.url.includes('/stop'))
        expect(stopCalls).toHaveLength(1)

        const resultCalls = poolObj.getUpdateRunResultCalls()
        expect(resultCalls).toHaveLength(1)
        expect(resultCalls[0]?.params[0]).toBe('timeout')
        // error message contains "timed out"
        expect(String(resultCalls[0]?.params[3])).toContain('timed out')
    })

    it('HTTP 401 on find-or-create → records failed with error message', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn } = makeFetchSequence([
            { ok: false, status: 401, textBody: 'Unauthorized' },
        ])

        globalThis.fetch = fetchFn

        await handleAiTask(makePayload(), ctx)

        const resultCalls = poolObj.getUpdateRunResultCalls()
        expect(resultCalls).toHaveLength(1)
        expect(resultCalls[0]?.params[0]).toBe('failed')
        const errMsg = String(resultCalls[0]?.params[3])
        expect(errMsg).toContain('401')
    })

    it('HTTP 503 on send → records failed', async () => {
        const poolObj = makePool()
        const ctx = makeCtx(poolObj)
        const { fetchFn } = makeFetchSequence([
            { ok: true, body: { sessionId: 'sess-503' } },
            { ok: false, status: 503, textBody: 'Service Unavailable' },
        ])

        globalThis.fetch = fetchFn

        await handleAiTask(makePayload(), ctx)

        const resultCalls = poolObj.getUpdateRunResultCalls()
        expect(resultCalls).toHaveLength(1)
        expect(resultCalls[0]?.params[0]).toBe('failed')
        const errMsg = String(resultCalls[0]?.params[3])
        expect(errMsg).toContain('503')
    })
})
