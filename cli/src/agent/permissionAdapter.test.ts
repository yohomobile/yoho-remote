import { describe, expect, it, vi } from 'vitest'

import type { PermissionRequest } from './types'
import { PermissionAdapter } from './permissionAdapter'

describe('PermissionAdapter', () => {
    function createSessionStub() {
        const rpcHandlers = new Map<string, (message: unknown) => unknown>()
        const updateAgentState = vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            updater({ requests: {}, completedRequests: {} })
        })

        return {
            rpcHandlers,
            updateAgentState,
            session: {
                updateAgentState,
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: (message: unknown) => unknown) => {
                        rpcHandlers.set(method, handler)
                    })
                }
            }
        }
    }

    function createBackendStub() {
        let permissionHandler: ((request: PermissionRequest) => void) | null = null
        return {
            backend: {
                initialize: vi.fn(),
                newSession: vi.fn(),
                prompt: vi.fn(),
                cancelPrompt: vi.fn(),
                respondToPermission: vi.fn(),
                onPermissionRequest: vi.fn((handler: (request: PermissionRequest) => void) => {
                    permissionHandler = handler
                }),
                disconnect: vi.fn()
            },
            getPermissionHandler: () => permissionHandler
        }
    }

    it('replays early permission responses after the request is registered', async () => {
        const { session, rpcHandlers } = createSessionStub()
        const { backend, getPermissionHandler } = createBackendStub()

        new PermissionAdapter(session as any, backend as any)

        const rpcPermissionHandler = rpcHandlers.get('permission')
        if (!rpcPermissionHandler) {
            throw new Error('permission rpc handler not registered')
        }

        await rpcPermissionHandler({
            id: 'req-1',
            approved: false,
            decision: 'denied'
        })

        const permissionRequestHandler = getPermissionHandler()
        if (!permissionRequestHandler) {
            throw new Error('backend permission handler not registered')
        }

        permissionRequestHandler({
            id: 'req-1',
            sessionId: 'sess-1',
            toolCallId: 'tool-1',
            title: 'Edit File',
            rawInput: { path: '/tmp/a.txt' },
            options: [{
                optionId: 'reject-once',
                name: 'Reject once',
                kind: 'reject_once'
            }]
        })

        await vi.waitFor(() => {
            expect(backend.respondToPermission).toHaveBeenCalledWith(
                'sess-1',
                expect.objectContaining({ id: 'req-1' }),
                { outcome: 'selected', optionId: 'reject-once' }
            )
        })
    })
})
