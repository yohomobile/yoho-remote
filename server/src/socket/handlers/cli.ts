import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { IStore, StoredMachine, StoredSession } from '../../store'
import { RpcRegistry } from '../rpcRegistry'
import type { SyncEvent } from '../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../sync/todos'
import type { SocketServer, SocketWithData } from '../socketTypes'
import { getLicenseService } from '../../license/licenseService'
import {
    getUnsupportedSessionSourceError,
    getSessionSourceFromMetadata,
    isSupportedSessionSource,
} from '../../sessionSourcePolicy'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
    modelMode?: 'default' | 'sonnet' | 'opus' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini' | 'gpt-5.2'
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
}

type SessionEndPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional()
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

const machineUpdateMetadataSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const machineUpdateStateSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    daemonState: z.unknown().nullable()
})

export type CliHandlersDeps = {
    io: SocketServer
    store: IStore
    rpcRegistry: RpcRegistry
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onSessionDisconnect?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onMachineDisconnect?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onLicenseBlock?: (sessionId: string, reason: string) => void
}

// Tracks which socket currently "owns" each session (sessionId → socketId).
// When a different socket sends session-alive for the same session, the old socket
// is evicted to prevent duplicate processes from both reporting heartbeats.
const sessionOwnerSocketId = new Map<string, string>()
const machineOwnerSocketId = new Map<string, string>()

type AccessErrorReason = 'namespace-missing' | 'access-denied' | 'not-found'
type AccessResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: AccessErrorReason }

export function registerCliHandlers(socket: SocketWithData, deps: CliHandlersDeps): void {
    const {
        io,
        store,
        rpcRegistry,
        onSessionAlive,
        onSessionEnd,
        onSessionDisconnect,
        onMachineAlive,
        onMachineDisconnect,
        onWebappEvent,
        onLicenseBlock,
    } = deps
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    // Cache: machineId → orgId（用于 session-alive license fallback，避免每次心跳查 DB）
    const machineOrgIdCache = new Map<string, { orgId: string | null; fetchedAt: number }>()
    const MACHINE_ORG_CACHE_TTL = 10 * 60 * 1000 // 10 分钟，与 license cache 一致

    const getMachineOrgId = async (machineId: string): Promise<string | null> => {
        const now = Date.now()
        const cached = machineOrgIdCache.get(machineId)
        if (cached && now - cached.fetchedAt < MACHINE_ORG_CACHE_TTL) {
            return cached.orgId
        }
        const machine = await store.getMachine(machineId)
        const orgId = machine?.orgId ?? null
        machineOrgIdCache.set(machineId, { orgId, fetchedAt: now })
        return orgId
    }

    const resolveSessionAccess = async (sessionId: string): Promise<AccessResult<StoredSession>> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const session = await store.getSessionByNamespace(sessionId, namespace)
        if (session) {
            return { ok: true, value: session }
        }
        if (await store.getSession(sessionId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const resolveMachineAccess = async (machineId: string): Promise<AccessResult<StoredMachine>> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const machine = await store.getMachineByNamespace(machineId, namespace)
        if (machine) {
            return { ok: true, value: machine }
        }
        if (await store.getMachine(machineId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    const joinRoom = async (room: string): Promise<boolean> => {
        try {
            await socket.join(room)
            return true
        } catch (error) {
            console.warn(`[cli-socket] Failed to join room ${room}:`, error)
            return false
        }
    }
    // Track when socket.join() is complete for the session room
    // This ensures session-alive events are only processed after the socket can receive messages
    let sessionJoinPromise: Promise<boolean> | null = null
    if (sessionId) {
        const joinStartTime = Date.now()
        sessionJoinPromise = resolveSessionAccess(sessionId).then(async (result) => {
            if (result.ok) {
                const joined = await joinRoom(`session:${sessionId}`)
                console.log(`[cli-socket] Socket joined session room ${sessionId} in ${Date.now() - joinStartTime}ms, joined=${joined}`)
                return joined
            }
            console.log(`[cli-socket] Socket failed to join session room ${sessionId}: access denied`)
            return false
        })
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId) {
        void resolveMachineAccess(machineId).then(async (result) => {
            if (result.ok) {
                await joinRoom(`machine:${machineId}`)
            }
        })
    }

    const emitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => {
        const message = reason === 'access-denied'
            ? `${scope} access denied`
            : reason === 'not-found'
                ? `${scope} not found`
                : 'Namespace missing'
        socket.emit('error', { message, code: reason, scope, id })
    }

    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.register(socket, parsed.data.method)
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.unregister(socket, parsed.data.method)
    })

    socket.on('disconnect', () => {
        rpcRegistry.unregisterAll(socket)
        const disconnectedAt = Date.now()

        for (const [sid, ownerSocketId] of sessionOwnerSocketId.entries()) {
            if (ownerSocketId === socket.id) {
                sessionOwnerSocketId.delete(sid)
                onSessionDisconnect?.({ sid, time: disconnectedAt })
            }
        }

        for (const [ownedMachineId, ownerSocketId] of machineOwnerSocketId.entries()) {
            if (ownerSocketId === socket.id) {
                machineOwnerSocketId.delete(ownedMachineId)
                onMachineDisconnect?.({ machineId: ownedMachineId, time: disconnectedAt })
            }
        }
    })

    socket.on('message', async (data: unknown) => {
        try {
            const parsed = messageSchema.safeParse(data)
            if (!parsed.success) {
                return
            }

            const { sid, localId } = parsed.data
            const raw = parsed.data.message

            const content = typeof raw === 'string'
                ? (() => {
                    try {
                        return JSON.parse(raw) as unknown
                    } catch {
                        return raw
                    }
                })()
                : raw

            const sessionAccess = await resolveSessionAccess(sid)
            if (!sessionAccess.ok) {
                emitAccessError('session', sid, sessionAccess.reason)
                return
            }
            const session = sessionAccess.value

            const msg = await store.addMessage(sid, content, localId)

            const todos = extractTodoWriteTodosFromMessageContent(content)
            if (todos) {
                const updated = await store.setSessionTodos(sid, todos, msg.createdAt, session.namespace)
                if (updated) {
                    onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
                }
            }

            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'new-message' as const,
                    sid,
                    message: {
                        id: msg.id,
                        seq: msg.seq,
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        content: msg.content
                    }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)

            onWebappEvent?.({
                type: 'message-received',
                sessionId: sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    localId: msg.localId,
                    content: msg.content,
                    createdAt: msg.createdAt
                }
            })
        } catch (err) {
            console.error('[cli-socket] Error in message handler:', err)
        }
    })

    socket.on('update-metadata', async (data: unknown, cb: (answer: unknown) => void) => {
        try {
            const parsed = updateMetadataSchema.safeParse(data)
            if (!parsed.success) {
                cb({ result: 'error' })
                return
            }

            const { sid, metadata, expectedVersion } = parsed.data
            const sessionAccess = await resolveSessionAccess(sid)
            if (!sessionAccess.ok) {
                cb({ result: 'error', reason: sessionAccess.reason })
                return
            }

            const source = getSessionSourceFromMetadata(metadata)
            if (!isSupportedSessionSource(source)) {
                cb({ result: 'error', reason: getUnsupportedSessionSourceError(source) })
                return
            }

            const result = await store.updateSessionMetadata(sid, metadata, expectedVersion, sessionAccess.value.namespace)
            if (result.result === 'success') {
                cb({ result: 'success', version: result.version, metadata: result.value })
            } else if (result.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
            } else {
                cb({ result: 'error' })
            }

            if (result.result === 'success') {
                const update = {
                    id: randomUUID(),
                    seq: Date.now(),
                    createdAt: Date.now(),
                    body: {
                        t: 'update-session' as const,
                        sid,
                        metadata: { version: result.version, value: metadata },
                        agentState: null
                    }
                }
                socket.to(`session:${sid}`).emit('update', update)
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        } catch (err) {
            console.error('[cli-socket] Error in update-metadata handler:', err)
            try { cb({ result: 'error' }) } catch {}
        }
    })

    socket.on('update-state', async (data: unknown, cb: (answer: unknown) => void) => {
        try {
            const parsed = updateStateSchema.safeParse(data)
            if (!parsed.success) {
                cb({ result: 'error' })
                return
            }

            const { sid, agentState, expectedVersion } = parsed.data

            const stateObj = (agentState && typeof agentState === 'object' ? agentState : {}) as Record<string, unknown>
            const stateRequests = (stateObj.requests && typeof stateObj.requests === 'object' ? stateObj.requests : {}) as Record<string, { tool?: string }>
            const askRequests = Object.entries(stateRequests).filter(([, r]) => r.tool === 'AskUserQuestion' || r.tool === 'ask_user_question')
            if (askRequests.length > 0) {
                console.log(`[AskUserQuestion] update-state received`, {
                    sid,
                    expectedVersion,
                    askRequestIds: askRequests.map(([id, r]) => ({ id, tool: r.tool })),
                    totalRequests: Object.keys(stateRequests).length,
                })
            }

            const sessionAccess = await resolveSessionAccess(sid)
            if (!sessionAccess.ok) {
                cb({ result: 'error', reason: sessionAccess.reason })
                return
            }

            const result = await store.updateSessionAgentState(sid, agentState, expectedVersion, sessionAccess.value.namespace)
            if (result.result === 'success') {
                cb({ result: 'success', version: result.version, agentState: result.value })
            } else if (result.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
            } else {
                cb({ result: 'error' })
            }

            if (askRequests.length > 0) {
                console.log(`[AskUserQuestion] update-state result: ${result.result}`, {
                    sid,
                    version: 'version' in result ? result.version : undefined,
                })
            }

            if (result.result === 'success') {
                const update = {
                    id: randomUUID(),
                    seq: Date.now(),
                    createdAt: Date.now(),
                    body: {
                        t: 'update-session' as const,
                        sid,
                        metadata: null,
                        agentState: { version: result.version, value: agentState }
                    }
                }
                socket.to(`session:${sid}`).emit('update', update)
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })

                if (askRequests.length > 0) {
                    console.log(`[AskUserQuestion] broadcast update to session room and webapp SSE`, {
                        sid,
                        sseEventData: { sid },
                        note: 'SSE only sends { sid } - webapp treats this as metadata-only update',
                    })
                }
            }
        } catch (err) {
            console.error('[cli-socket] Error in update-state handler:', err)
            try { cb({ result: 'error' }) } catch {}
        }
    })

    socket.on('session-alive', async (data: SessionAlivePayload) => {
        try {
            if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
                return
            }
            if (sessionJoinPromise && data.sid === sessionId) {
                console.log(`[cli-socket] session-alive received for ${data.sid}, waiting for socket.join()...`)
                const joined = await sessionJoinPromise
                console.log(`[cli-socket] session-alive for ${data.sid}: socket.join() completed, joined=${joined}`)
                if (!joined) {
                    return
                }
            }
            const sessionAccess = await resolveSessionAccess(data.sid)
            if (!sessionAccess.ok) {
                emitAccessError('session', data.sid, sessionAccess.reason)
                return
            }

            let licenseOrgId = sessionAccess.value.orgId
            if (!licenseOrgId && sessionAccess.value.machineId) {
                licenseOrgId = await getMachineOrgId(sessionAccess.value.machineId)
            }
            if (licenseOrgId) {
                try {
                    const licenseService = getLicenseService()
                    const licenseCheck = await licenseService.validateLicense(licenseOrgId)
                    if (!licenseCheck.valid) {
                        socket.emit('error', {
                            message: licenseCheck.message,
                            code: `license-${licenseCheck.code.toLowerCase().replace(/_/g, '-')}`,
                            scope: 'session',
                            id: data.sid,
                        })
                        onLicenseBlock?.(data.sid, licenseCheck.code)
                        return
                    }
                    if (licenseCheck.valid && licenseCheck.warning) {
                        socket.emit('license-warning', {
                            message: licenseCheck.warning,
                            scope: 'session',
                            id: data.sid,
                        })
                    }
                } catch {
                    // LicenseService not initialized — skip check (dev mode)
                }
            }

            const existingOwner = sessionOwnerSocketId.get(data.sid)
            if (existingOwner && existingOwner !== socket.id) {
                const cliNamespace = io.of('/cli')
                const oldSocket = cliNamespace.sockets.get(existingOwner)
                if (oldSocket) {
                    console.warn(
                        `[cli-socket] Session ${data.sid} conflict: new socket ${socket.id} replacing old socket ${existingOwner}. ` +
                        `Disconnecting old socket to prevent dual-process heartbeats.`
                    )
                    rpcRegistry.unregisterAll(oldSocket)
                    oldSocket.disconnect(true)
                }
                sessionOwnerSocketId.delete(data.sid)
            }
            sessionOwnerSocketId.set(data.sid, socket.id)

            onSessionAlive?.(data)
        } catch (err) {
            console.error('[cli-socket] Error in session-alive handler:', err)
        }
    })

    socket.on('session-end', async (data: SessionEndPayload) => {
        try {
            if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
                return
            }
            const sessionAccess = await resolveSessionAccess(data.sid)
            if (!sessionAccess.ok) {
                emitAccessError('session', data.sid, sessionAccess.reason)
                return
            }
            const endOwner = sessionOwnerSocketId.get(data.sid)
            if (endOwner === socket.id) {
                sessionOwnerSocketId.delete(data.sid)
            }
            onSessionEnd?.(data)
        } catch (err) {
            console.error('[cli-socket] Error in session-end handler:', err)
        }
    })

    socket.on('machine-alive', async (data: MachineAlivePayload) => {
        try {
            if (!data || typeof data.machineId !== 'string' || typeof data.time !== 'number') {
                return
            }
            const machineAccess = await resolveMachineAccess(data.machineId)
            if (!machineAccess.ok) {
                emitAccessError('machine', data.machineId, machineAccess.reason)
                return
            }

            const existingOwner = machineOwnerSocketId.get(data.machineId)
            if (existingOwner && existingOwner !== socket.id) {
                const cliNamespace = io.of('/cli')
                const oldSocket = cliNamespace.sockets.get(existingOwner)
                if (oldSocket) {
                    console.warn(
                        `[cli-socket] Machine ${data.machineId} conflict: new socket ${socket.id} replacing old socket ${existingOwner}. ` +
                        `Disconnecting old socket to keep daemon ownership consistent.`
                    )
                    rpcRegistry.unregisterAll(oldSocket)
                    oldSocket.disconnect(true)
                }
                machineOwnerSocketId.delete(data.machineId)
            }
            machineOwnerSocketId.set(data.machineId, socket.id)

            onMachineAlive?.(data)
        } catch (err) {
            console.error('[cli-socket] Error in machine-alive handler:', err)
        }
    })

    const handleMachineMetadataUpdate = async (data: unknown, cb: (answer: unknown) => void) => {
        try {
            const parsed = machineUpdateMetadataSchema.safeParse(data)
            if (!parsed.success) {
                cb({ result: 'error' })
                return
            }

            const { machineId: id, metadata, expectedVersion } = parsed.data
            const machineAccess = await resolveMachineAccess(id)
            if (!machineAccess.ok) {
                cb({ result: 'error', reason: machineAccess.reason })
                return
            }

            const result = await store.updateMachineMetadata(id, metadata, expectedVersion, machineAccess.value.namespace)
            if (result.result === 'success') {
                cb({ result: 'success', version: result.version, metadata: result.value })
            } else if (result.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
            } else {
                cb({ result: 'error' })
            }

            if (result.result === 'success') {
                const update = {
                    id: randomUUID(),
                    seq: Date.now(),
                    createdAt: Date.now(),
                    body: {
                        t: 'update-machine' as const,
                        machineId: id,
                        metadata: { version: result.version, value: metadata },
                        daemonState: null
                    }
                }
                socket.to(`machine:${id}`).emit('update', update)
                onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
            }
        } catch (err) {
            console.error('[cli-socket] Error in machine-update-metadata handler:', err)
            try { cb({ result: 'error' }) } catch {}
        }
    }

    const handleMachineStateUpdate = async (data: unknown, cb: (answer: unknown) => void) => {
        try {
            const parsed = machineUpdateStateSchema.safeParse(data)
            if (!parsed.success) {
                cb({ result: 'error' })
                return
            }

            const { machineId: id, daemonState, expectedVersion } = parsed.data
            const machineAccess = await resolveMachineAccess(id)
            if (!machineAccess.ok) {
                cb({ result: 'error', reason: machineAccess.reason })
                return
            }

            const result = await store.updateMachineDaemonState(id, daemonState, expectedVersion, machineAccess.value.namespace)
            if (result.result === 'success') {
                cb({ result: 'success', version: result.version, daemonState: result.value })
            } else if (result.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: result.version, daemonState: result.value })
            } else {
                cb({ result: 'error' })
            }

            if (result.result === 'success') {
                const update = {
                    id: randomUUID(),
                    seq: Date.now(),
                    createdAt: Date.now(),
                    body: {
                        t: 'update-machine' as const,
                        machineId: id,
                        metadata: null,
                        daemonState: { version: result.version, value: daemonState }
                    }
                }
                socket.to(`machine:${id}`).emit('update', update)
                onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
            }
        } catch (err) {
            console.error('[cli-socket] Error in machine-update-state handler:', err)
            try { cb({ result: 'error' }) } catch {}
        }
    }

    socket.on('machine-update-metadata', handleMachineMetadataUpdate)
    socket.on('update-machine-metadata', handleMachineMetadataUpdate)

    socket.on('machine-update-state', handleMachineStateUpdate)
    socket.on('update-machine-state', handleMachineStateUpdate)

    socket.on('ping', (callback: () => void) => {
        callback()
    })

}
