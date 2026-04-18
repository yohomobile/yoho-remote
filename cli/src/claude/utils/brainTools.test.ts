import { describe, expect, it, vi } from 'vitest'

import {
    BRAIN_SESSION_ABORT_DESCRIPTION,
    BRAIN_SESSION_INSPECT_DESCRIPTION,
    BRAIN_SESSION_LIST_DESCRIPTION,
    BRAIN_SESSION_RESUME_DESCRIPTION,
    BRAIN_SESSION_SEND_DESCRIPTION,
    BRAIN_SESSION_SET_CONFIG_DESCRIPTION,
    BRAIN_SESSION_STOP_DESCRIPTION,
    BRAIN_SESSION_STATUS_DESCRIPTION,
    BRAIN_SESSION_TAIL_DESCRIPTION,
    BRAIN_SESSION_UPDATE_DESCRIPTION,
    buildBrainCreateDescription,
    buildBrainFindOrCreateDescription,
    registerBrainTools,
} from './brainTools'

describe('brainTools descriptions', () => {
    it('emphasizes reuse-first behavior for child sessions', () => {
        const guide = 'MODEL GUIDE'
        expect(buildBrainCreateDescription(guide)).toContain('仅在确实需要真正并行或上下文隔离时使用')
        expect(buildBrainCreateDescription(guide)).toContain('第二路或更多独立调研/验证')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('这是默认入口')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('只有需要真正并行或上下文隔离时')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('默认至少组织两路独立调研/验证')
    })

    it('discourages polling and requires reusable summaries', () => {
        expect(BRAIN_SESSION_SEND_DESCRIPTION).toContain('发送后默认结束当前轮')
        expect(BRAIN_SESSION_SEND_DESCRIPTION).toContain('监督分工进度')
        expect(BRAIN_SESSION_LIST_DESCRIPTION).toContain('监督哪些 session 正在做什么')
        expect(BRAIN_SESSION_ABORT_DESCRIPTION).toContain('先用它 stop 旧任务')
        expect(BRAIN_SESSION_STOP_DESCRIPTION).toContain('不要用 session_close 代替 stop')
        expect(BRAIN_SESSION_RESUME_DESCRIPTION).toContain('新的 sessionId')
        expect(BRAIN_SESSION_STATUS_DESCRIPTION).toContain('监督子 session 是否跑偏')
        expect(BRAIN_SESSION_INSPECT_DESCRIPTION).toContain('activeMonitors')
        expect(BRAIN_SESSION_TAIL_DESCRIPTION).toContain('真实输出/事件片段')
        expect(BRAIN_SESSION_SET_CONFIG_DESCRIPTION).toContain('统一调整子 session 的运行时 steering')
        expect(BRAIN_SESSION_UPDATE_DESCRIPTION).toContain('必须写入一行 brainSummary')
    })

    it('registers stop/resume/config/inspect/tail brain MCP tools', () => {
        const toolNames: string[] = []
        const registrations: Array<{ name: string; description?: string }> = []
        const fakeMcp = {
            registerTool: (name: string, meta: { description?: string }) => {
                registrations.push({ name, description: meta.description })
            },
        }

        registerBrainTools(fakeMcp as any, toolNames, {
            apiClient: {} as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        expect(toolNames).toContain('session_stop')
        expect(toolNames).toContain('session_resume')
        expect(toolNames).toContain('session_set_config')
        expect(toolNames).toContain('session_inspect')
        expect(toolNames).toContain('session_tail')
        expect(registrations.find((item) => item.name === 'session_stop')?.description).toContain('正式使用的 stop 能力')
        expect(registrations.find((item) => item.name === 'session_resume')?.description).toContain('新的 sessionId')
        expect(registrations.find((item) => item.name === 'session_set_config')?.description).toContain('运行时 steering')
        expect(registrations.find((item) => item.name === 'session_inspect')?.description).toContain('lastMessageAt')
        expect(registrations.find((item) => item.name === 'session_tail')?.description).toContain('真实输出/事件片段')
    })

    it('returns structured delivery data from session_send while keeping natural-language text', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            getSession: vi.fn(async () => ({
                id: 'child-session',
                active: true,
                thinking: false,
                metadata: {
                    source: 'brain-child',
                    mainSessionId: 'brain-session',
                },
            })),
            patchSessionMetadata: vi.fn(async () => undefined),
            sendMessageToSession: vi.fn(async () => ({
                ok: false,
                status: 'busy',
                sessionId: 'child-session',
                retryable: true,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_send')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            sessionId: 'child-session',
            message: '修复问题',
        })

        expect(apiClient.sendMessageToSession).toHaveBeenCalledWith('child-session', '修复问题', 'brain')
        expect(result?.isError).toBeUndefined()
        expect(result).toMatchObject({
            structuredContent: {
                delivery: {
                    status: 'busy',
                    sessionId: 'child-session',
                    retryable: true,
                },
            },
            content: [{
                type: 'text',
                text: expect.stringContaining('当前消息未投递'),
            }],
        })
    })
})
