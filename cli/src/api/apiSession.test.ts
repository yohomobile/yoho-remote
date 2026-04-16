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
