import { describe, expect, it, vi } from 'vitest'

import { CodexPermissionHandler } from './permissionHandler'

describe('CodexPermissionHandler', () => {
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

    it('auto-approves MCP tool calls in yolo mode', async () => {
        const { session, updateAgentState } = createSessionStub()
        const handler = new CodexPermissionHandler(session as any, {
            getPermissionMode: () => 'yolo'
        })

        const result = await handler.handleToolCall('req-1', 'Recall', { input: 'query' }, {
            approvalKind: 'mcp_tool_call'
        })

        expect(result).toEqual({ decision: 'approved' })
        expect(updateAgentState).not.toHaveBeenCalled()
    })

    it('replays early permission responses when the pending request registers later', async () => {
        const { session, rpcHandlers } = createSessionStub()
        const handler = new CodexPermissionHandler(session as any)
        const permissionHandler = rpcHandlers.get('permission')

        if (!permissionHandler) {
            throw new Error('permission handler not registered')
        }

        permissionHandler({
            id: 'req-early',
            approved: false,
            decision: 'denied',
            reason: 'User rejected'
        })

        await expect(handler.handleToolCall('req-early', 'exec_command', {
            command: 'pwd'
        }, {
            approvalKind: 'exec_command'
        })).resolves.toEqual({
            decision: 'denied',
            reason: 'User rejected'
        })
    })
})
