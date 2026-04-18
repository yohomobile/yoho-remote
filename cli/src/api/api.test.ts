import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { ApiClient } from './api'

describe('ApiClient.brainSpawnSession', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('includes caller and brainPreferences in the spawn request body', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: { type: 'success', sessionId: 'child-session' },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        await client.brainSpawnSession({
            machineId: 'machine-1',
            directory: '/tmp/task',
            agent: 'codex',
            codexModel: 'gpt-5.4',
            source: 'brain-child',
            mainSessionId: 'brain-main',
            caller: 'feishu',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })

        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/brain/spawn'),
            expect.objectContaining({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                codexModel: 'gpt-5.4',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                caller: 'feishu',
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('posts to the CLI abort endpoint for session_stop/session_abort flows', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: { ok: true },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        await client.abortSession('child-session')

        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/abort'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('posts to the CLI resume endpoint and returns the resume result', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: { type: 'created', sessionId: 'child-session-new', resumedFrom: 'child-session', usedResume: true },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.resumeSession('child-session')

        expect(result).toEqual({
            type: 'created',
            sessionId: 'child-session-new',
            resumedFrom: 'child-session',
            usedResume: true,
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/resume'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('posts to the CLI config endpoint and returns the applied runtime steering', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: {
                ok: true,
                applied: {
                    model: 'gpt-5.4-mini',
                    reasoningEffort: 'high',
                    fastMode: false,
                },
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.setSessionConfig('child-session', {
            model: 'gpt-5.4-mini',
            reasoningEffort: 'high',
        })

        expect(result).toEqual({
            ok: true,
            applied: {
                model: 'gpt-5.4-mini',
                reasoningEffort: 'high',
                fastMode: false,
            },
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/config'),
            {
                model: 'gpt-5.4-mini',
                reasoningEffort: 'high',
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('gets orchestration-focused inspect data from the CLI inspect endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                sessionId: 'child-session',
                status: 'idle',
                lastMessageAt: 1_700_000_000_100,
                todoProgress: { completed: 1, total: 2 },
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.getSessionInspect('child-session')

        expect(result).toEqual({
            sessionId: 'child-session',
            status: 'idle',
            lastMessageAt: 1_700_000_000_100,
            todoProgress: { completed: 1, total: 2 },
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/inspect'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('gets recent session tail fragments from the CLI tail endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                sessionId: 'child-session',
                items: [{ seq: 10, kind: 'result', snippet: 'done' }],
                returned: 1,
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.getSessionTail('child-session', { limit: 3 })

        expect(result).toEqual({
            sessionId: 'child-session',
            items: [{ seq: 10, kind: 'result', snippet: 'done' }],
            returned: 1,
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/tail?limit=3'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })
})
