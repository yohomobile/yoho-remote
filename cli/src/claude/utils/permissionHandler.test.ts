import { describe, expect, it, vi } from 'vitest'

import type { EnhancedMode } from '../loop'
import { PermissionHandler } from './permissionHandler'

function createSessionStub() {
    const rpcHandlers = new Map<string, (message: unknown) => unknown>()
    let agentState: Record<string, unknown> = { requests: {}, completedRequests: {} }
    const session = {
        queue: {
            unshift: vi.fn()
        },
        client: {
            updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
                agentState = updater(agentState)
                return agentState
            }),
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: (message: unknown) => unknown) => {
                    rpcHandlers.set(method, handler)
                })
            }
        },
        setPermissionMode: vi.fn()
    }

    return {
        session,
        rpcHandlers,
        getAgentState: () => agentState
    }
}

function createAssistantToolUseMessage(options: {
    id: string
    name: string
    input: unknown
    parentToolUseId?: string
}) {
    return {
        type: 'assistant',
        parent_tool_use_id: options.parentToolUseId,
        message: {
            role: 'assistant',
            content: [{
                type: 'tool_use',
                id: options.id,
                name: options.name,
                input: options.input
            }]
        }
    }
}

function createUserToolResultMessage(options: {
    toolUseId: string
    content: unknown
    isError?: boolean
}) {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: options.toolUseId,
                content: options.content,
                is_error: options.isError ?? false
            }]
        }
    }
}

const DEFAULT_MODE: EnhancedMode = {
    permissionMode: 'bypassPermissions'
}

describe('PermissionHandler', () => {
    it('injects root-only guidance into top-level Agent prompts', async () => {
        const { session } = createSessionStub()
        const handler = new PermissionHandler(session as any)
        const input = {
            prompt: 'Inspect the repo and report back.'
        }

        setTimeout(() => {
            handler.onMessage(createAssistantToolUseMessage({
                id: 'tool-agent-top-level',
                name: 'Agent',
                input
            }) as any)
        }, 10)

        const result = await handler.handleToolCall('Agent', input, DEFAULT_MODE, {
            signal: new AbortController().signal
        })

        expect(result.behavior).toBe('allow')
        if (result.behavior !== 'allow') {
            throw new Error('expected allow result')
        }
        expect(result.updatedInput.prompt).toContain('<yoho-remote-subagent-constraints>')
        expect(result.updatedInput.prompt).toContain('Inspect the repo and report back.')
        expect(result.updatedInput.prompt).toContain('Do NOT use Agent, Task, or ExitPlanMode')
    })

    it('denies root-only ExitPlanMode inside sidechains', async () => {
        const { session } = createSessionStub()
        const handler = new PermissionHandler(session as any)
        const signal = new AbortController().signal
        const input = {
            allowedPrompts: [],
            plan: 'Do work'
        }

        const promise = handler.handleToolCall('ExitPlanMode', input, DEFAULT_MODE, { signal })

        setTimeout(() => {
            handler.onMessage(createAssistantToolUseMessage({
                id: 'tool-1',
                name: 'ExitPlanMode',
                input,
                parentToolUseId: 'parent-tool'
            }) as any)
        }, 10)

        await expect(promise).resolves.toEqual({
            behavior: 'deny',
            message: 'Tool "ExitPlanMode" is only available in the top-level session. Complete the task with the tools provided and return findings to the orchestrator.'
        })
    })

    it('denies late sidechain Agent tool calls instead of allowing them', async () => {
        const { session } = createSessionStub()
        const handler = new PermissionHandler(session as any)
        const signal = new AbortController().signal
        const input = {
            prompt: 'Inspect the repo and report back.'
        }

        const promise = handler.handleToolCall('Agent', input, DEFAULT_MODE, { signal })

        setTimeout(() => {
            handler.onMessage(createAssistantToolUseMessage({
                id: 'tool-agent-sidechain',
                name: 'Agent',
                input,
                parentToolUseId: 'parent-tool'
            }) as any)
        }, 300)

        await expect(promise).resolves.toEqual({
            behavior: 'deny',
            message: 'Tool "Agent" is only available in the top-level session. Complete the task with the tools provided and return findings to the orchestrator.'
        })
    })

    it('waits for late top-level ExitPlanMode tool calls before handling permission responses', async () => {
        const { session, rpcHandlers } = createSessionStub()
        const handler = new PermissionHandler(session as any)
        const signal = new AbortController().signal
        const input = {
            allowedPrompts: [],
            plan: 'Do work'
        }

        const promise = handler.handleToolCall('ExitPlanMode', input, DEFAULT_MODE, { signal })

        setTimeout(() => {
            handler.onMessage(createAssistantToolUseMessage({
                id: 'tool-2',
                name: 'ExitPlanMode',
                input
            }) as any)
        }, 10)

        setTimeout(() => {
            const permissionHandler = rpcHandlers.get('permission')
            if (!permissionHandler) {
                throw new Error('permission handler not registered')
            }
            permissionHandler({
                id: 'tool-2',
                approved: false,
                reason: 'Plan rejected'
            })
        }, 40)

        await expect(promise).resolves.toEqual({
            behavior: 'deny',
            message: 'Plan rejected'
        })
    })

    it('synthesizes a completed request for orphan AskUserQuestion validation errors', () => {
        const { session, getAgentState } = createSessionStub()
        const handler = new PermissionHandler(session as any)
        const input = {
            questions: '[{"question":"Pick one"}]'
        }

        handler.onMessage(createAssistantToolUseMessage({
            id: 'tool-ask-invalid',
            name: 'AskUserQuestion',
            input
        }) as any)

        handler.onMessage(createUserToolResultMessage({
            toolUseId: 'tool-ask-invalid',
            isError: true,
            content: '<tool_use_error>InputValidationError: AskUserQuestion failed because `questions` must be an array.</tool_use_error>'
        }) as any)

        expect(getAgentState()).toMatchObject({
            requests: {},
            completedRequests: {
                'tool-ask-invalid': {
                    tool: 'AskUserQuestion',
                    arguments: input,
                    status: 'canceled',
                    reason: 'InputValidationError: AskUserQuestion failed because `questions` must be an array.'
                }
            }
        })
    })
})
