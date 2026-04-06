import { describe, expect, it, vi } from 'vitest'

import { CodexPermissionHandler } from './permissionHandler'

describe('CodexPermissionHandler', () => {
    it('auto-approves MCP tool calls in yolo mode', async () => {
        const updateAgentState = vi.fn()
        const handler = new CodexPermissionHandler({
            updateAgentState,
            rpcHandlerManager: {
                registerHandler: vi.fn()
            }
        } as any, {
            getPermissionMode: () => 'yolo'
        })

        const result = await handler.handleToolCall('req-1', 'Recall', { input: 'query' }, {
            approvalKind: 'mcp_tool_call'
        })

        expect(result).toEqual({ decision: 'approved' })
        expect(updateAgentState).not.toHaveBeenCalled()
    })
})
