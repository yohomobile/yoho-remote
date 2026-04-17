import { describe, expect, it, vi } from 'vitest'
import { logger } from '@/ui/logger'
import { ApiSessionClient } from './apiSession'

describe('ApiSessionClient.keepAlive', () => {
    it('sends the first heartbeat reliably instead of volatile', () => {
        const emitted: Array<{ event: string; payload: unknown }> = []
        const volatileEmitted: Array<{ event: string; payload: unknown }> = []

        const client = Object.create(ApiSessionClient.prototype) as any

        client.sessionId = 'session-1'
        client._lastSentThinking = null
        client.socket = {
            emit: (event: string, payload: unknown) => {
                emitted.push({ event, payload })
            },
            volatile: {
                emit: (event: string, payload: unknown) => {
                    volatileEmitted.push({ event, payload })
                }
            }
        }

        client.keepAlive(false, 'remote')

        expect(emitted).toHaveLength(1)
        expect(emitted[0]?.event).toBe('session-alive')
        expect(volatileEmitted).toHaveLength(0)
        expect(client._lastSentThinking).toBe(false)
    })

    it('uses volatile heartbeats only after the state is already stable', () => {
        const emitted: Array<{ event: string; payload: unknown }> = []
        const volatileEmitted: Array<{ event: string; payload: unknown }> = []

        const client = Object.create(ApiSessionClient.prototype) as any

        client.sessionId = 'session-2'
        client._lastSentThinking = false
        client.socket = {
            emit: (event: string, payload: unknown) => {
                emitted.push({ event, payload })
            },
            volatile: {
                emit: (event: string, payload: unknown) => {
                    volatileEmitted.push({ event, payload })
                }
            }
        }

        client.keepAlive(false, 'remote')

        expect(emitted).toHaveLength(0)
        expect(volatileEmitted).toHaveLength(1)
        expect(volatileEmitted[0]?.event).toBe('session-alive')
    })
})

describe('ApiSessionClient state update failures', () => {
    it('logs and swallows rejected agent state updates', async () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
        const client = Object.create(ApiSessionClient.prototype) as any

        client.agentStateLock = {
            inLock: vi.fn(() => Promise.reject(new Error('boom')))
        }

        client.updateAgentState((state: Record<string, unknown>) => state as any)
        await Promise.resolve()

        expect(debugSpy).toHaveBeenCalledWith('[API] Failed to update agent state', expect.any(Error))
        debugSpy.mockRestore()
    })

    it('logs and swallows rejected metadata updates', async () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
        const client = Object.create(ApiSessionClient.prototype) as any

        client.metadataLock = {
            inLock: vi.fn(() => Promise.reject(new Error('boom')))
        }

        client.updateMetadata((metadata: Record<string, unknown>) => metadata as any)
        await Promise.resolve()

        expect(debugSpy).toHaveBeenCalledWith('[API] Failed to update metadata', expect.any(Error))
        debugSpy.mockRestore()
    })
})

describe('ApiSessionClient.sendClaudeSessionMessage', () => {
    it('skips internal Claude metadata messages like last-prompt', () => {
        const emit = vi.fn()
        const client = Object.create(ApiSessionClient.prototype) as any

        client.sessionId = 'session-3'
        client.socket = { emit }
        client.updateMetadata = vi.fn()

        client.sendClaudeSessionMessage({
            type: 'last-prompt',
            sessionId: 'session-3',
            lastPrompt: 'hello'
        } as any)

        expect(emit).not.toHaveBeenCalled()
    })

    it('skips internal Claude top-level events like file-history-snapshot', () => {
        const emit = vi.fn()
        const client = Object.create(ApiSessionClient.prototype) as any

        client.sessionId = 'session-3b'
        client.socket = { emit }
        client.updateMetadata = vi.fn()

        client.sendClaudeSessionMessage({
            type: 'file-history-snapshot',
            sessionId: 'session-3b',
            uuid: 'snapshot-1',
        } as any)

        expect(emit).not.toHaveBeenCalled()
    })

    it('forwards plan attachments like plan_mode instead of filtering them out', () => {
        const emit = vi.fn()
        const client = Object.create(ApiSessionClient.prototype) as any

        client.sessionId = 'session-4'
        client.socket = { emit }
        client.updateMetadata = vi.fn()

        client.sendClaudeSessionMessage({
            type: 'attachment',
            uuid: 'attachment-plan-mode',
            timestamp: '2026-04-17T00:00:00.000Z',
            attachment: {
                type: 'plan_mode',
                planFilePath: '/tmp/demo-plan.md',
                planExists: false
            }
        } as any)

        expect(emit).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledWith('message', {
            sid: 'session-4',
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: expect.objectContaining({
                        type: 'attachment',
                        attachment: expect.objectContaining({
                            type: 'plan_mode',
                            planFilePath: '/tmp/demo-plan.md'
                        })
                    })
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        })
    })
})
