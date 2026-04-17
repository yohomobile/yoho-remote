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
})
