import { io, type Socket } from 'socket.io-client'
import { expect, test } from '../src/fixtures'

function connectCliSocket(
    baseUrl: string,
    token: string,
    timeoutMs = 6_000
): Promise<{ ok: true; socket: Socket } | { ok: false; error: string }> {
    return new Promise((resolve) => {
        let settled = false
        const socket = io(`${baseUrl}/cli`, {
            path: '/socket.io/',
            transports: ['websocket'],
            auth: { token },
            reconnection: false,
            timeout: 5_000,
        })

        const settle = (result: { ok: true; socket: Socket } | { ok: false; error: string }) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (!result.ok) {
                socket.close()
            }
            resolve(result)
        }

        const timer = setTimeout(() => {
            settle({ ok: false, error: `Socket.IO connection timed out after ${timeoutMs}ms` })
        }, timeoutMs)

        socket.once('connect', () => settle({ ok: true, socket }))
        socket.once('connect_error', (error) => {
            settle({ ok: false, error: error.message })
        })
        socket.once('disconnect', (reason) => {
            settle({ ok: false, error: `Socket.IO disconnected before connect: ${reason}` })
        })
    })
}

test.describe('P0 CLI Socket.IO auth smoke', () => {
    test('accepts the CLI token and rejects invalid tokens', async ({ e2eEnv }) => {
        const accepted = await connectCliSocket(e2eEnv.mockApiUrl, `${e2eEnv.cliApiToken}:default`)
        expect(accepted.ok).toBe(true)
        if (accepted.ok) {
            expect(accepted.socket.connected).toBe(true)
            accepted.socket.close()
        }

        const rejected = await connectCliSocket(e2eEnv.mockApiUrl, 'wrong-token')
        expect(rejected.ok).toBe(false)
        if (!rejected.ok) {
            expect(rejected.error).toContain('Invalid token')
        }
    })
})
