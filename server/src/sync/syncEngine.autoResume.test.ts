import { describe, expect, test } from 'bun:test'
import { buildBrainSessionPreferences } from '../brain/brainSessionPreferences'
import { SyncEngine, type Machine, type Session } from './syncEngine'

function createSession(id: string, metadata: Record<string, unknown>): Session {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        lastMessageAt: null,
        active: false,
        activeAt: Date.now() - 1_000,
        metadata: metadata as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        activeMonitors: [],
        thinking: false,
        thinkingAt: 0,
        modelMode: 'default',
    }
}

function createMachine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: 'guang-instance',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        orgId: null,
        supportedAgents: null,
    }
}

describe('SyncEngine auto-resume', () => {
    test('only auto-resumes sessions that were last known active in DB', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const resumable = createSession('session-resumable', {
            machineId: machine.id,
            path: '/tmp/project-a',
            flavor: 'codex',
            codexSessionId: 'thread-a',
            startedFromDaemon: true,
        })
        const stale = createSession('session-stale', {
            machineId: machine.id,
            path: '/tmp/project-b',
            flavor: 'codex',
            codexSessionId: 'thread-b',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(resumable.id, resumable)
        ;(engine as any).sessions.set(stale.id, stale)
        ;(engine as any)._dbActiveSessionIds = new Set([resumable.id])

        const spawnCalls: string[] = []
        ;(engine as any).spawnSession = async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: { sessionId?: string }) => {
            if (options?.sessionId) {
                spawnCalls.push(options.sessionId)
            }
            return { type: 'success', sessionId: options?.sessionId ?? 'unknown' }
        }
        ;(engine as any).waitForAutoResumeGrace = async () => {}
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([resumable.id])
    })

    test('rolls back optimistic auto-resume when reconnect heartbeat never arrives', async () => {
        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number; namespace: string }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async (id: string, active: boolean, activeAt: number, namespace: string) => {
                setSessionActiveCalls.push({ id, active, activeAt, namespace })
                return true
            },
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-timeout', {
            machineId: machine.id,
            path: '/tmp/project-timeout',
            flavor: 'claude',
            claudeSessionId: 'claude-thread-1',
            startedFromDaemon: true,
        })
        const originalActiveAt = session.activeAt

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])
        ;(engine as any).spawnSession = async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: { sessionId?: string }) => ({
            type: 'success',
            sessionId: options?.sessionId ?? 'unknown',
        })
        ;(engine as any).waitForAutoResumeGrace = async () => {}
        ;(engine as any).waitForSessionHeartbeatAfter = async () => false

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(setSessionActiveCalls).toEqual([
            { id: session.id, active: true, activeAt: originalActiveAt, namespace: session.namespace },
            { id: session.id, active: false, activeAt: originalActiveAt, namespace: session.namespace },
        ])
        expect(session.active).toBe(false)
        expect(session.activeAt).toBe(originalActiveAt)
        expect((engine as any)._dbActiveSessionIds.has(session.id)).toBe(false)
    })

    test('preserves brain metadata when auto-resuming an existing session', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-brain-child', {
            machineId: machine.id,
            path: '/tmp/project-brain',
            flavor: 'codex',
            codexSessionId: 'thread-brain',
            startedFromDaemon: true,
            source: 'brain-child',
            caller: 'feishu',
            mainSessionId: 'brain-session-1',
            brainPreferences: buildBrainSessionPreferences({
                machineSelectionMode: 'manual',
                machineId: machine.id,
            }),
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])

        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        ;(engine as any).spawnSession = async (
            _machineId: string,
            _directory: string,
            _agent: string,
            _yolo: boolean | undefined,
            options?: Record<string, unknown>
        ) => {
            spawnCalls.push(options)
            return { type: 'success', sessionId: options?.sessionId ?? 'unknown' }
        }
        ;(engine as any).waitForAutoResumeGrace = async () => {}
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([expect.objectContaining({
            sessionId: session.id,
            resumeSessionId: 'thread-brain',
            source: 'brain-child',
            caller: 'feishu',
            mainSessionId: 'brain-session-1',
            brainPreferences: buildBrainSessionPreferences({
                machineSelectionMode: 'manual',
                machineId: machine.id,
            }),
        })])
    })

    test('waits through reconnect grace before auto-resuming replacement sessions', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-race', {
            machineId: machine.id,
            path: '/tmp/project-race',
            flavor: 'codex',
            codexSessionId: 'thread-race',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])

        let spawnCalled = false
        ;(engine as any).spawnSession = async () => {
            spawnCalled = true
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).waitForAutoResumeGrace = async () => {
            session.active = true
            session.activeAt = Date.now()
        }
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalled).toBe(false)
    })

    test('extends auto-resume grace past the base timeout when a slow reconnect still arrives', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-slow-reconnect', {
            machineId: machine.id,
            path: '/tmp/project-slow-reconnect',
            flavor: 'codex',
            codexSessionId: 'thread-slow-reconnect',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])
        ;(engine as any).autoResumeBaseGraceMs = 20
        ;(engine as any).autoResumeGraceQuietWindowMs = 20
        ;(engine as any).autoResumeMaxGraceMs = 80
        ;(engine as any).autoResumeGraceCheckIntervalMs = 5

        let spawnCalled = false
        ;(engine as any).spawnSession = async () => {
            spawnCalled = true
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        const reconnectTimer = setTimeout(() => {
            session.active = true
            session.activeAt = Date.now()
        }, 35)

        const startedAt = Date.now()
        await (engine as any).autoResumeSessions(machine.id, machine.namespace)
        clearTimeout(reconnectTimer)

        expect(spawnCalled).toBe(false)
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30)
    })

    test('settles auto-resume grace after a quiet window when no reconnect arrives', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-grace-quiet-window', {
            machineId: machine.id,
            path: '/tmp/project-grace-quiet-window',
            flavor: 'codex',
            codexSessionId: 'thread-grace-quiet-window',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])
        ;(engine as any).autoResumeBaseGraceMs = 20
        ;(engine as any).autoResumeGraceQuietWindowMs = 20
        ;(engine as any).autoResumeMaxGraceMs = 80
        ;(engine as any).autoResumeGraceCheckIntervalMs = 5

        let spawnAt: number | null = null
        ;(engine as any).spawnSession = async () => {
            spawnAt = Date.now()
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        const startedAt = Date.now()
        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnAt).not.toBeNull()
        expect((spawnAt ?? 0) - startedAt).toBeGreaterThanOrEqual(35)
    })

    test('does not auto-resume terminal-started sessions through the daemon', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1')
        const session = createSession('session-terminal', {
            machineId: machine.id,
            path: '/tmp/project-terminal',
            flavor: 'codex',
            codexSessionId: 'thread-terminal',
            startedFromDaemon: false,
            startedBy: 'terminal',
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])

        let spawnCalled = false
        ;(engine as any).spawnSession = async () => {
            spawnCalled = true
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).waitForAutoResumeGrace = async () => {}
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalled).toBe(false)
    })

    test('tracks resume trace milestones until the first user message arrives', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: () => 'socket-1',
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        engine.markSessionResumeReady('session-trace', 'auto-resume')
        engine.noteResumeClientEvent('session-trace', 'session-get')

        const traceAfterClient = (engine as any).resumeTraceBySessionId.get('session-trace')
        expect(traceAfterClient).toMatchObject({
            source: 'auto-resume',
            firstClientActivityEvent: 'session-get',
        })
        expect(typeof traceAfterClient?.firstClientActivityAt).toBe('number')

        engine.noteResumeClientEvent('session-trace', 'message-post', { sentFrom: 'webapp' })
        expect((engine as any).resumeTraceBySessionId.has('session-trace')).toBe(false)
    })
})
