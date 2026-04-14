import { describe, expect, it } from 'vitest'
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
