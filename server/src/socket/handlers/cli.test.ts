import { describe, expect, test } from 'bun:test'
import { RpcRegistry } from '../rpcRegistry'
import { registerCliHandlers } from './cli'

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('registerCliHandlers', () => {
    test('waits for async session room joins before forwarding session-alive', async () => {
        const joinDeferred = createDeferred<void>()
        const aliveCalls: Array<{ sid: string; time: number }> = []
        const handlers = new Map<string, (...args: any[]) => unknown>()

        const socket = {
            id: 'socket-1',
            data: { namespace: 'default' },
            handshake: { auth: { sessionId: 'session-1' } },
            join: (room: string) => {
                if (room === 'session:session-1') {
                    return joinDeferred.promise
                }
                return undefined
            },
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-1' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
            onSessionAlive: (payload) => {
                aliveCalls.push(payload)
            },
        })

        const sessionAlive = handlers.get('session-alive')
        expect(sessionAlive).toBeDefined()

        const pending = sessionAlive!({ sid: 'session-1', time: 123 }) as Promise<void>
        await Promise.resolve()
        await Promise.resolve()
        expect(aliveCalls).toHaveLength(0)

        joinDeferred.resolve()
        await pending

        expect(aliveCalls).toHaveLength(1)
        expect(aliveCalls[0]).toEqual({ sid: 'session-1', time: 123 })
    })

    test('suppresses duplicate CLI user echoes when the same webapp message was just stored', async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>()
        let addMessageCalls = 0

        const socket = {
            id: 'socket-echo',
            data: { namespace: 'default' },
            handshake: { auth: {} },
            join: () => undefined,
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-echo' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
            getMessages: async () => [{
                id: 'msg-webapp',
                sessionId: 'session-echo',
                seq: 1,
                createdAt: 100,
                localId: null,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '继续'
                    },
                    meta: {
                        sentFrom: 'webapp'
                    }
                }
            }],
            addMessage: async () => {
                addMessageCalls += 1
                throw new Error('duplicate echo should not be stored')
            },
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
        })

        const messageHandler = handlers.get('message')
        expect(messageHandler).toBeDefined()

        await messageHandler!({
            sid: 'session-echo',
            message: {
                role: 'user',
                content: {
                    type: 'text',
                    text: '继续'
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        })

        expect(addMessageCalls).toBe(0)
    })

    test('derives a stable localId from agent payloads when the client omits one', async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>()
        const addMessageCalls: Array<{ sessionId: string; localId: string | null | undefined }> = []

        const socket = {
            id: 'socket-local-id',
            data: { namespace: 'default' },
            handshake: { auth: {} },
            join: () => undefined,
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-local-id' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
            addMessage: async (sessionId: string, _content: unknown, localId?: string) => {
                addMessageCalls.push({ sessionId, localId })
                return {
                    id: 'msg-local-id',
                    sessionId,
                    seq: 1,
                    localId: localId ?? null,
                    content: {},
                    createdAt: 1
                }
            }
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
        })

        const messageHandler = handlers.get('message')
        expect(messageHandler).toBeDefined()

        await messageHandler!({
            sid: 'session-local-id',
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        uuid: 'claude-msg-uuid',
                        timestamp: '2026-04-17T00:00:00.000Z',
                        type: 'message',
                        message: 'hello'
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        })

        expect(addMessageCalls).toEqual([
            {
                sessionId: 'session-local-id',
                localId: 'claude-msg-uuid'
            }
        ])
    })

    test('normalizes stray brain linkage fields in update-metadata for non-brain sessions', async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>()
        const updateCalls: Array<{ sid: string; metadata: unknown }> = []

        const socket = {
            id: 'socket-metadata-normalize',
            data: { namespace: 'default' },
            handshake: { auth: {} },
            join: () => undefined,
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-metadata' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
            updateSessionMetadata: async (sid: string, metadata: unknown) => {
                updateCalls.push({ sid, metadata })
                return { result: 'success', version: 2, value: metadata }
            },
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
        })

        const updateMetadataHandler = handlers.get('update-metadata')
        expect(updateMetadataHandler).toBeDefined()

        let ackPayload: unknown = null
        await updateMetadataHandler!(
            {
                sid: 'session-metadata',
                expectedVersion: 1,
                metadata: {
                    source: 'MANUAL',
                    mainSessionId: 'brain-main',
                    brainPreferences: {
                        machineSelection: { mode: 'manual', machineId: 'machine-1' },
                    },
                },
            },
            (answer: unknown) => {
                ackPayload = answer
            },
        )

        expect(updateCalls).toEqual([{
            sid: 'session-metadata',
            metadata: {
                source: 'manual',
            },
        }])
        expect(ackPayload).toEqual({
            result: 'success',
            version: 2,
            metadata: {
                source: 'manual',
            },
        })
    })

    test('rejects update-metadata when brainPreferences is invalid for a brain-linked session', async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>()
        let updateCalled = false

        const socket = {
            id: 'socket-metadata-invalid-brain-preferences',
            data: { namespace: 'default' },
            handshake: { auth: {} },
            join: () => undefined,
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-metadata' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
            updateSessionMetadata: async () => {
                updateCalled = true
                return { result: 'success', version: 2, value: null }
            },
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
        })

        const updateMetadataHandler = handlers.get('update-metadata')
        expect(updateMetadataHandler).toBeDefined()

        let ackPayload: unknown = null
        await updateMetadataHandler!(
            {
                sid: 'session-metadata',
                expectedVersion: 1,
                metadata: {
                    source: 'BRAIN',
                    brainPreferences: {
                        machineSelection: { mode: 'manual' },
                    },
                },
            },
            (answer: unknown) => {
                ackPayload = answer
            },
        )

        expect(updateCalled).toBe(false)
        expect(ackPayload).toEqual({
            result: 'error',
            reason: 'Invalid brainPreferences in session metadata',
        })
    })

    test('rejects update-metadata when brain-child mainSessionId is missing', async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>()
        let updateCalled = false

        const socket = {
            id: 'socket-metadata-invalid',
            data: { namespace: 'default' },
            handshake: { auth: {} },
            join: () => undefined,
            on: (event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler)
            },
            emit: () => {},
            to: () => ({ emit: () => {} }),
            disconnect: () => {},
        }

        const store = {
            getSessionByNamespace: async (id: string, namespace: string) => (
                id === 'session-metadata' && namespace === 'default'
                    ? { id, namespace }
                    : null
            ),
            getSession: async () => null,
            getMachineByNamespace: async () => null,
            getMachine: async () => null,
            updateSessionMetadata: async () => {
                updateCalled = true
                return { result: 'success', version: 2, value: null }
            },
        }

        const io = {
            of: () => ({
                sockets: new Map<string, { disconnect: (close?: boolean) => void }>(),
            }),
        }

        registerCliHandlers(socket as any, {
            io: io as any,
            store: store as any,
            rpcRegistry: new RpcRegistry(),
        })

        const updateMetadataHandler = handlers.get('update-metadata')
        expect(updateMetadataHandler).toBeDefined()

        let ackPayload: unknown = null
        await updateMetadataHandler!(
            {
                sid: 'session-metadata',
                expectedVersion: 1,
                metadata: {
                    source: 'brain-child',
                    caller: 'feishu',
                },
            },
            (answer: unknown) => {
                ackPayload = answer
            },
        )

        expect(updateCalled).toBe(false)
        expect(ackPayload).toEqual({
            result: 'error',
            reason: 'brain-child sessions require mainSessionId',
        })
    })
})
