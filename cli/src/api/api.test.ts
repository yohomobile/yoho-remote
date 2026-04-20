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

        await client.abortSession('child-session', { mainSessionId: 'brain-main' })

        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/abort?mainSessionId=brain-main'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('passes mainSessionId to the CLI session read endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                session: {
                    id: 'child-session',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: null,
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 1,
                },
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.getSession('child-session', { mainSessionId: 'brain-main' })

        expect(result.id).toBe('child-session')
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session?mainSessionId=brain-main'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('passes mainSessionId to the CLI session messages endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                messages: [{
                    id: 'm-1',
                    seq: 1,
                    createdAt: 1,
                    localId: null,
                    content: { role: 'user', content: { type: 'text', text: 'hello' } },
                }],
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.getSessionMessages('child-session', {
            afterSeq: 3,
            limit: 10,
            mainSessionId: 'brain-main',
        })

        expect(result).toHaveLength(1)
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/messages'),
            expect.objectContaining({
                params: {
                    afterSeq: 3,
                    limit: 10,
                    mainSessionId: 'brain-main',
                },
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

        const result = await client.resumeSession('child-session', { mainSessionId: 'brain-main' })

        expect(result).toEqual({
            type: 'created',
            sessionId: 'child-session-new',
            resumedFrom: 'child-session',
            usedResume: true,
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/resume?mainSessionId=brain-main'),
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
        }, { mainSessionId: 'brain-main' })

        expect(result).toEqual({
            ok: true,
            applied: {
                model: 'gpt-5.4-mini',
                reasoningEffort: 'high',
                fastMode: false,
            },
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/config?mainSessionId=brain-main'),
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

    it('posts to the CLI send endpoint and returns the delivery verdict', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: {
                ok: true,
                status: 'queued',
                sessionId: 'child-session',
                queue: 'brain-child-init',
                queueDepth: 1,
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.sendMessageToSession('child-session', 'run task', 'brain', { mainSessionId: 'brain-main' })

        expect(result).toEqual({
            ok: true,
            status: 'queued',
            sessionId: 'child-session',
            queue: 'brain-child-init',
            queueDepth: 1,
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/messages?mainSessionId=brain-main'),
            {
                text: 'run task',
                sentFrom: 'brain',
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                    'idempotency-key': expect.any(String),
                }),
            })
        )
    })

    it('passes mainSessionId to the CLI delete endpoint', async () => {
        const deleteSpy = vi.spyOn(axios, 'delete').mockResolvedValue({
            data: { ok: true },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.deleteSession('child-session', { mainSessionId: 'brain-main' })

        expect(result).toEqual({ ok: true })
        expect(deleteSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session?mainSessionId=brain-main'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('passes mainSessionId to the CLI metadata patch endpoint', async () => {
        const patchSpy = vi.spyOn(axios, 'patch').mockResolvedValue({
            data: { ok: true },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        await client.patchSessionMetadata('child-session', {
            brainSummary: 'updated summary',
        }, { mainSessionId: 'brain-main' })

        expect(patchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/metadata?mainSessionId=brain-main'),
            { brainSummary: 'updated summary' },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('accepts queued brain-session-inbox delivery verdicts from the CLI send endpoint', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: {
                ok: true,
                status: 'queued',
                sessionId: 'brain-session',
                queue: 'brain-session-inbox',
                queueDepth: 2,
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.sendMessageToSession('brain-session', '继续处理', 'webapp')

        expect(result).toEqual({
            ok: true,
            status: 'queued',
            sessionId: 'brain-session',
            queue: 'brain-session-inbox',
            queueDepth: 2,
        })
        expect(postSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/brain-session/messages'),
            {
                text: '继续处理',
                sentFrom: 'webapp',
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                    'idempotency-key': expect.any(String),
                }),
            })
        )
    })

    it('passes mainSessionId when listing child sessions for a brain', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                sessions: [],
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.listSessions({ includeOffline: true, mainSessionId: 'brain-main' })

        expect(result).toEqual({ sessions: [] })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions?includeOffline=true&mainSessionId=brain-main'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('passes mainSessionId to the CLI status endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                active: true,
                thinking: false,
                initDone: true,
                messageCount: 2,
                lastUsage: null,
                metadata: null,
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.getSessionStatus('child-session', { mainSessionId: 'brain-main' })

        expect(result).toEqual({
            active: true,
            thinking: false,
            initDone: true,
            messageCount: 2,
            lastUsage: null,
            metadata: null,
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/status?mainSessionId=brain-main'),
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

        const result = await client.getSessionInspect('child-session', { mainSessionId: 'brain-main' })

        expect(result).toEqual({
            sessionId: 'child-session',
            status: 'idle',
            lastMessageAt: 1_700_000_000_100,
            todoProgress: { completed: 1, total: 2 },
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/inspect?mainSessionId=brain-main'),
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

        const result = await client.getSessionTail('child-session', { limit: 3, mainSessionId: 'brain-main' })

        expect(result).toEqual({
            sessionId: 'child-session',
            items: [{ seq: 10, kind: 'result', snippet: 'done' }],
            returned: 1,
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/child-session/tail?limit=3&mainSessionId=brain-main'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('gets structured session history matches from the CLI search endpoint', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {
                query: 'publisher worker',
                returned: 1,
                results: [{
                    sessionId: 'child-session',
                    score: 99,
                    match: {
                        source: 'turn-summary',
                        text: '验证 worker / publisher / session_summaries 闭环',
                        createdAt: 123,
                        seqStart: 10,
                        seqEnd: 18,
                    },
                }],
            },
        } as any)

        const client = Object.create(ApiClient.prototype) as ApiClient
        ;(client as any).token = 'test-token'

        const result = await client.searchSessions({
            query: 'publisher worker',
            limit: 3,
            mainSessionId: 'brain-main',
            flavor: 'codex',
        })

        expect(result).toEqual({
            query: 'publisher worker',
            returned: 1,
            results: [{
                sessionId: 'child-session',
                score: 99,
                match: {
                    source: 'turn-summary',
                    text: '验证 worker / publisher / session_summaries 闭环',
                    createdAt: 123,
                    seqStart: 10,
                    seqEnd: 18,
                },
            }],
        })
        expect(getSpy).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/search?query=publisher+worker&limit=3&mainSessionId=brain-main&flavor=codex'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            })
        )
    })
})
