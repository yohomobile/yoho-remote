import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import type { IStore } from '../store'
import { configuration } from '../configuration'
import { safeCompareStrings } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import { registerCliHandlers } from './handlers/cli'
import { RpcRegistry } from './rpcRegistry'
import type { SyncEvent } from '../sync/syncEngine'
import type { SocketData, SocketServer } from './socketTypes'
import { verifyKeycloakToken, extractUserFromToken } from '../web/keycloak'

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: IStore
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null | Promise<{ active: boolean; namespace: string } | null>
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onSessionDisconnect?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number }) => void
    onMachineDisconnect?: (payload: { machineId: string; time: number }) => void
    onLicenseBlock?: (sessionId: string, reason: string) => void
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const corsOrigins = configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: {
            origin: (origin, callback) => {
                if (!origin) {
                    callback(null, true)
                    return
                }

                if (allowAllOrigins || corsOrigins.includes(origin)) {
                    callback(null, true)
                    return
                }

                callback(new Error('Origin not allowed'), false)
            },
            methods: ['GET', 'POST'],
            credentials: false
        }
    })

    const engine = new Engine({
        path: '/socket.io/',
        maxHttpBufferSize: 150 * 1024 * 1024  // 150MB to support 100MB file uploads with base64 overhead
    })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const cliNs = io.of('/cli')
    const eventsNs = io.of('/events')

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        const parsedToken = token ? parseAccessToken(token) : null
        if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = parsedToken.namespace
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket, {
        io,
        store: deps.store,
        rpcRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionEnd: deps.onSessionEnd,
        onSessionDisconnect: deps.onSessionDisconnect,
        onMachineAlive: deps.onMachineAlive,
        onMachineDisconnect: deps.onMachineDisconnect,
        onWebappEvent: deps.onWebappEvent,
        onLicenseBlock: deps.onLicenseBlock,
    }))

    eventsNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        try {
            // Verify Keycloak JWT token
            const payload = await verifyKeycloakToken(token)
            const user = extractUserFromToken(payload)
            socket.data.userId = user.sub
            socket.data.namespace = 'default'  // All Keycloak users share the same namespace
            next()
            return
        } catch {
            return next(new Error('Invalid token'))
        }
    })

    eventsNs.on('connection', (socket) => {
        const namespace = socket.data.namespace
        if (namespace) {
            socket.join(`namespace:${namespace}`)
        }
    })

    return { io, engine, rpcRegistry }
}
