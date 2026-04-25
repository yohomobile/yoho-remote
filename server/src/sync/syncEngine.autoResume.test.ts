import { describe, expect, test } from 'bun:test'
import { buildBrainSessionPreferences } from '../brain/brainSessionPreferences'
import { SyncEngine, categorizeAutoResumeSpawnError, type Machine, type Session } from './syncEngine'

function createSession(id: string, metadata: Record<string, unknown>): Session {
    return {
        id,
        namespace: 'default',
        orgId: null,
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
    test('logs skip-reason histogram before returning when no candidates are resumable', async () => {
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
        const stale = createSession('session-stale', {
            machineId: machine.id,
            path: '/tmp/project-stale',
            flavor: 'codex',
            codexSessionId: 'thread-stale',
            startedFromDaemon: true,
        })
        const terminal = createSession('session-terminal', {
            machineId: machine.id,
            path: '/tmp/project-terminal',
            flavor: 'codex',
            codexSessionId: 'thread-terminal',
            startedBy: 'terminal',
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(stale.id, stale)
        ;(engine as any).sessions.set(terminal.id, terminal)
        ;(engine as any)._dbActiveSessionIds = new Set<string>()
        ;(engine as any).listDaemonLiveSessions = async () => []

        const originalLog = console.log
        const logs: string[] = []
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(' '))
        }
        try {
            await (engine as any).autoResumeSessions(machine.id, machine.namespace)
        } finally {
            console.log = originalLog
        }

        expect(logs.some(line => line.includes('[auto-resume] Skip-reason histogram'))).toBe(true)
        expect(logs.some(line => line.includes('not-in-dbActive'))).toBe(true)
        expect(logs.some(line => line.includes('not-daemon-started'))).toBe(true)
        expect(logs.some(line => line.includes('No candidates found'))).toBe(true)
    })

    test('handleMachineAlive defers auto-resume until reloadAllAsync completes', async () => {
        // Regression: a daemon that reconnects fast enough to race the constructor's
        // reloadAllAsync used to land on an empty _dbActiveSessionIds and skip every
        // candidate with `not-in-dbActive`. The hydrationDone gate inside
        // handleMachineAlive must hold the autoResumeSessions trigger until hydrate
        // has populated session/machine state.

        let resolveGetSessions!: (rows: unknown[]) => void
        const sessionsHydratePromise = new Promise<unknown[]>((resolve) => {
            resolveGetSessions = resolve
        })

        const machineRow = {
            id: 'machine-1',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: { host: 'h', platform: 'linux', yohoRemoteCliVersion: 't' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            orgId: null,
            supportedAgents: null,
        }

        const store = {
            getSessions: () => sessionsHydratePromise,
            getSession: async () => null,
            getMachines: async () => [machineRow],
            getMachine: async (id: string) => (id === 'machine-1' ? machineRow : null),
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)

        let autoResumeCalls = 0
        ;(engine as any).autoResumeSessions = async () => {
            autoResumeCalls += 1
        }

        // Fire machine-alive while reloadAllAsync is still awaiting getSessions.
        // The handler returns immediately (machine.active flips, broadcasts), but
        // the autoResume trigger is gated on hydrationDone.
        await engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

        // Drain microtasks: gate must still be holding, autoResume not invoked.
        await new Promise((r) => setTimeout(r, 0))
        expect(autoResumeCalls).toBe(0)

        // Releasing getSessions lets reloadAllAsync finish; the .then() that
        // gated the trigger then schedules autoResumeSessions on the microtask
        // queue. One macrotask drain is enough to observe it.
        resolveGetSessions([])
        await (engine as any).hydrationDone
        await new Promise((r) => setTimeout(r, 0))
        expect(autoResumeCalls).toBe(1)

        // A second machine-alive after hydrate (without going offline first) is
        // already wasActive=true and must not double-trigger.
        await engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
        await new Promise((r) => setTimeout(r, 0))
        expect(autoResumeCalls).toBe(1)

        engine.stop()
    })

    test('hydrationDone gate skips deferred trigger when machine bounced offline during hydrate', async () => {
        let resolveGetSessions!: (rows: unknown[]) => void
        const sessionsHydratePromise = new Promise<unknown[]>((resolve) => {
            resolveGetSessions = resolve
        })

        const machineRow = {
            id: 'machine-2',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: { host: 'h', platform: 'linux', yohoRemoteCliVersion: 't' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            orgId: null,
            supportedAgents: null,
        }

        const store = {
            getSessions: () => sessionsHydratePromise,
            getSession: async () => null,
            getMachines: async () => [machineRow],
            getMachine: async (id: string) => (id === 'machine-2' ? machineRow : null),
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)

        let autoResumeCalls = 0
        ;(engine as any).autoResumeSessions = async () => {
            autoResumeCalls += 1
        }

        await engine.handleMachineAlive({ machineId: 'machine-2', time: Date.now() })
        // Mark the machine offline before hydrate completes — the gated trigger
        // must observe the new state and short-circuit.
        const machine = (engine as any).machines.get('machine-2')
        machine.active = false

        resolveGetSessions([])
        await (engine as any).hydrationDone
        await new Promise((r) => setTimeout(r, 0))
        expect(autoResumeCalls).toBe(0)

        engine.stop()
    })

    test('only auto-resumes sessions that were last known active in DB', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionThinking: async () => true,
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
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([resumable.id])
    })

    test('auto-resumes running brain-child sessions together with their parent brain even when child is not in DB active set', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionThinking: async () => true,
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
        const brain = createSession('session-brain-main', {
            machineId: machine.id,
            path: '/tmp/project-brain-main',
            flavor: 'codex',
            codexSessionId: 'thread-brain-main',
            startedFromDaemon: true,
            source: 'brain',
            lifecycleState: 'running',
        })
        const child = createSession('session-brain-child-running', {
            machineId: machine.id,
            path: '/tmp/project-brain-child',
            flavor: 'codex',
            codexSessionId: 'thread-brain-child',
            startedFromDaemon: true,
            source: 'brain-child',
            mainSessionId: brain.id,
            lifecycleState: 'running',
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(brain.id, brain)
        ;(engine as any).sessions.set(child.id, child)
        ;(engine as any)._dbActiveSessionIds = new Set([brain.id])

        const spawnCalls: string[] = []
        ;(engine as any).spawnSession = async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: { sessionId?: string }) => {
            if (options?.sessionId) {
                spawnCalls.push(options.sessionId)
            }
            return { type: 'success', sessionId: options?.sessionId ?? 'unknown' }
        }
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([brain.id, child.id])
    })

    test('auto-resumes running orchestrator-child sessions together with their parent orchestrator even when child is not in DB active set', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionThinking: async () => true,
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
        const orchestrator = createSession('session-orchestrator-main', {
            machineId: machine.id,
            path: '/tmp/project-orchestrator-main',
            flavor: 'codex',
            codexSessionId: 'thread-orchestrator-main',
            startedFromDaemon: true,
            source: 'orchestrator',
            lifecycleState: 'running',
        })
        const child = createSession('session-orchestrator-child-running', {
            machineId: machine.id,
            path: '/tmp/project-orchestrator-child',
            flavor: 'codex',
            codexSessionId: 'thread-orchestrator-child',
            startedFromDaemon: true,
            source: 'orchestrator-child',
            mainSessionId: orchestrator.id,
            lifecycleState: 'running',
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(orchestrator.id, orchestrator)
        ;(engine as any).sessions.set(child.id, child)
        ;(engine as any)._dbActiveSessionIds = new Set([orchestrator.id])

        const spawnCalls: string[] = []
        ;(engine as any).spawnSession = async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: { sessionId?: string }) => {
            if (options?.sessionId) {
                spawnCalls.push(options.sessionId)
            }
            return { type: 'success', sessionId: options?.sessionId ?? 'unknown' }
        }
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([orchestrator.id, child.id])
    })

    test('does not auto-resume historical brain-child sessions when parent brain is not resumable', async () => {
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
        const brain = createSession('session-brain-main-stale', {
            machineId: machine.id,
            path: '/tmp/project-brain-main-stale',
            flavor: 'codex',
            codexSessionId: 'thread-brain-main-stale',
            startedFromDaemon: true,
            source: 'brain',
            lifecycleState: 'running',
        })
        const child = createSession('session-brain-child-stale', {
            machineId: machine.id,
            path: '/tmp/project-brain-child-stale',
            flavor: 'codex',
            codexSessionId: 'thread-brain-child-stale',
            startedFromDaemon: true,
            source: 'brain-child',
            mainSessionId: brain.id,
            lifecycleState: 'running',
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(brain.id, brain)
        ;(engine as any).sessions.set(child.id, child)
        ;(engine as any)._dbActiveSessionIds = new Set()

        const spawnCalls: string[] = []
        ;(engine as any).spawnSession = async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: { sessionId?: string }) => {
            if (options?.sessionId) {
                spawnCalls.push(options.sessionId)
            }
            return { type: 'success', sessionId: options?.sessionId ?? 'unknown' }
        }
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalls).toEqual([])
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
            // archiveSession (invoked from the rollback path) patches metadata before
            // returning. Without this stub, the call throws before _dbActiveSessionIds
            // is cleaned up and the rollback assertions silently flap.
            patchSessionMetadata: async () => true,
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
        ;(engine as any).listDaemonLiveSessions = async () => []
        let heartbeatAfterActiveAt: number | null = null
        ;(engine as any).waitForSessionHeartbeatAfter = async (_sessionId: string, afterActiveAt: number) => {
            heartbeatAfterActiveAt = afterActiveAt
            return false
        }

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(setSessionActiveCalls).toHaveLength(2)
        expect(setSessionActiveCalls[0]).toMatchObject({
            id: session.id,
            active: true,
            namespace: session.namespace,
        })
        expect(setSessionActiveCalls[0]!.activeAt).toBeGreaterThanOrEqual(originalActiveAt)
        expect(setSessionActiveCalls[1]).toEqual({
            id: session.id,
            active: false,
            activeAt: originalActiveAt,
            namespace: session.namespace,
        })
        expect(heartbeatAfterActiveAt ?? 0).toBe(setSessionActiveCalls[0]!.activeAt)
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
        ;(engine as any).listDaemonLiveSessions = async () => []
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

    test('waits briefly for live inventory RPC registration before falling back', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            getSession: async () => null,
        } as any

        let listSessionsRegistered = false
        let rpcCalls = 0
        const machine = createMachine('machine-1')
        const socket = {
            timeout: () => ({
                emitWithAck: async (_event: string, payload: { method: string }) => {
                    rpcCalls += 1
                    expect(payload.method).toBe(`${machine.id}:list-sessions`)
                    return JSON.stringify({
                        sessions: [{
                            sessionId: 'session-live',
                            pid: 4321,
                            startedBy: 'daemon',
                        }]
                    })
                }
            }),
        }

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]]),
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const rpcRegistry = {
            getSocketIdForMethod: (method: string) => {
                if (method === `${machine.id}:list-sessions` && listSessionsRegistered) {
                    return 'socket-1'
                }
                return undefined
            },
        } as any

        const engine = new SyncEngine(store, io, rpcRegistry, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        ;(engine as any).autoResumeLiveInventoryRpcWaitMs = 120
        setTimeout(() => {
            listSessionsRegistered = true
        }, 20)

        const liveSessions = await (engine as any).listDaemonLiveSessions(machine.id)

        expect(rpcCalls).toBe(1)
        expect(liveSessions).toEqual([{
            sessionId: 'session-live',
            pid: 4321,
            startedBy: 'daemon',
        }])
    })

    test('skips replacement resume when a daemon-claimed session reconnects in time', async () => {
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
        ;(engine as any).listDaemonLiveSessions = async () => [{
            sessionId: session.id,
            pid: 4242,
            startedBy: 'daemon',
        }]
        ;(engine as any).waitForSessionHeartbeatAfter = async () => {
            session.active = true
            session.activeAt = Date.now()
            return true
        }

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalled).toBe(false)
    })

    test('resumes missing sessions immediately when daemon does not claim them', async () => {
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
        const session = createSession('session-not-claimed', {
            machineId: machine.id,
            path: '/tmp/project-not-claimed',
            flavor: 'codex',
            codexSessionId: 'thread-not-claimed',
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
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        const startedAt = Date.now()
        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnCalled).toBe(true)
        expect(Date.now() - startedAt).toBeLessThan(50)
    })

    test('sends a continue recovery message for sessions that were interrupted while thinking', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionThinking: async () => true,
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
        const session = createSession('session-thinking', {
            machineId: machine.id,
            path: '/tmp/project-thinking',
            flavor: 'codex',
            codexSessionId: 'thread-thinking',
            startedFromDaemon: true,
        })
        const originalActiveAt = session.activeAt
        session.thinking = true

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])

        const sendCalls: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
        ;(engine as any).spawnSession = async () => ({
            type: 'success',
            sessionId: session.id,
        })
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true
        ;(engine as any).waitForSocketInRoom = async () => false
        ;(engine as any).sendMessage = async (sessionId: string, payload: Record<string, unknown>) => {
            sendCalls.push({ sessionId, payload })
            return { status: 'delivered' }
        }

        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(sendCalls).toEqual([{
            sessionId: session.id,
            payload: {
                text: '请继续刚才被 daemon 重启打断的任务，避免重复已完成步骤；如果任务实际上已经完成，请直接总结当前结果。',
                localId: `auto-resume-continue-${originalActiveAt}`,
                sentFrom: 'auto-resume',
            }
        }])
        expect(session.thinking).toBe(false)
    })

    test('resumes daemon-claimed sessions after a short reconnect deadline when heartbeat never arrives', async () => {
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
        const session = createSession('session-daemon-claimed-timeout', {
            machineId: machine.id,
            path: '/tmp/project-daemon-claimed-timeout',
            flavor: 'codex',
            codexSessionId: 'thread-daemon-claimed-timeout',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])
        ;(engine as any).autoResumeClaimedReconnectTimeoutMs = 20

        let spawnAt: number | null = null
        ;(engine as any).spawnSession = async () => {
            spawnAt = Date.now()
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).listDaemonLiveSessions = async () => [{
            sessionId: session.id,
            pid: 31337,
            startedBy: 'daemon',
        }]
        let waitCallCount = 0
        ;(engine as any).waitForSessionHeartbeatAfter = async (_sessionId: string, _afterActiveAt: number, timeoutMs: number) => {
            waitCallCount += 1
            if (waitCallCount === 1) {
                await new Promise(resolve => setTimeout(resolve, timeoutMs))
                return false
            }
            return true
        }

        const startedAt = Date.now()
        await (engine as any).autoResumeSessions(machine.id, machine.namespace)

        expect(spawnAt).not.toBeNull()
        expect((spawnAt ?? 0) - startedAt).toBeGreaterThanOrEqual(20)
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
        ;(engine as any).listDaemonLiveSessions = async () => []
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

    test('spawn-failed branch redacts raw daemon error: archiveReason and warn carry only the category', async () => {
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
        const session = createSession('session-leaky-fail', {
            machineId: machine.id,
            path: '/tmp/project-leaky',
            flavor: 'codex',
            codexSessionId: 'thread-leaky',
            startedFromDaemon: true,
        })

        ;(engine as any).machines.set(machine.id, machine)
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds = new Set([session.id])
        ;(engine as any).listDaemonLiveSessions = async () => []
        ;(engine as any).waitForSessionHeartbeatAfter = async () => true

        // Realistic daemon error payload. Includes:
        //  - a fake bearer token (must never reach archiveReason or logs)
        //  - an absolute filesystem path (PII / topology leak)
        //  - a stderr tail matching what runClaude.ts would emit
        //  - a token-source env hint
        const SENSITIVE_TOKEN = 'sk-ant-FAKE-SECRET-DO-NOT-LEAK-9zX7Q'
        const SENSITIVE_PATH = '/home/guang/.yoho-remote/runtime/secret-credentials.json'
        const SENSITIVE_TOKEN_SOURCE_KEY = 'YOHO_REMOTE_TOKEN_SOURCE_API_KEY=AKIA-FAKE-TS-KEY'
        const sensitiveFragments = [SENSITIVE_TOKEN, SENSITIVE_PATH, SENSITIVE_TOKEN_SOURCE_KEY, 'sk-ant-', 'AKIA-']
        const rawDaemonError =
            `Session process for PID 31337 exited before the webhook was ready (code=1, signal=null).\n` +
            `Stderr tail (last 512B):\n` +
            `Error: failed to load credentials from ${SENSITIVE_PATH}\n` +
            `  Authorization: Bearer ${SENSITIVE_TOKEN}\n` +
            `  env: ${SENSITIVE_TOKEN_SOURCE_KEY}\n`

        ;(engine as any).spawnSession = async () => ({
            type: 'error',
            message: rawDaemonError,
        })

        type ArchiveCall = { id: string; opts: any }
        const archiveCalls: ArchiveCall[] = []
        ;(engine as any).archiveSession = async (id: string, opts: any) => {
            archiveCalls.push({ id, opts })
            return true
        }

        const originalWarn = console.warn
        const originalLog = console.log
        const warnLines: string[] = []
        const logLines: string[] = []
        console.warn = (...args: unknown[]) => {
            warnLines.push(args.map(String).join(' '))
        }
        console.log = (...args: unknown[]) => {
            logLines.push(args.map(String).join(' '))
        }
        try {
            await (engine as any).autoResumeSessions(machine.id, machine.namespace)
        } finally {
            console.warn = originalWarn
            console.log = originalLog
        }

        // 1. archiveSession was called with redacted, fixed-format reason
        expect(archiveCalls).toHaveLength(1)
        const [call] = archiveCalls
        expect(call.id).toBe(session.id)
        expect(call.opts.archivedBy).toBe('auto-resume-failed')
        expect(call.opts.archiveReason).toBe('auto-resume spawn failed: process-exited-early')
        expect(call.opts.terminateSession).toBe(false)
        expect(call.opts.force).toBe(true)

        // 2. attempts increment is preserved
        expect(call.opts.extraMetadata).toEqual({ autoResumeFailureAttempts: 1 })

        // 3. neither archive options nor logs leak any sensitive fragment
        const archiveJson = JSON.stringify(call.opts)
        for (const fragment of sensitiveFragments) {
            expect(archiveJson).not.toContain(fragment)
            for (const line of warnLines) {
                expect(line).not.toContain(fragment)
            }
            for (const line of logLines) {
                expect(line).not.toContain(fragment)
            }
        }

        // 4. warn line includes the safe category (and only the short session id) so ops can still triage
        const matchingWarn = warnLines.find(line => line.includes('spawn failed') && line.includes('process-exited-early'))
        expect(matchingWarn).toBeDefined()
        expect(matchingWarn).toContain(session.id.slice(0, 8))
        expect(matchingWarn).toContain('attempt=1')
    })

    test('categorizeAutoResumeSpawnError maps daemon error strings to a fixed code without echoing input', () => {
        // Each entry mirrors a known daemon error string from cli/src/daemon/run.ts
        // (or server-side spawnSession). The categorizer must drop the raw payload.
        const cases: Array<{ input: string; category: string }> = [
            { input: 'AGENT_NOT_AVAILABLE: "claude" not found in PATH on this machine /opt/secrets', category: 'agent-not-available' },
            { input: 'Machine "host" does not support agent "codex". Supported: claude', category: 'unsupported-agent' },
            { input: 'rpc method spawn-yoho-remote-session: RPC handler not registered for /tmp/secret', category: 'rpc-handler-not-registered' },
            { input: 'Session webhook timeout for PID 31337 with token sk-ant-FAKE', category: 'webhook-timeout' },
            { input: 'Session process for PID 31337 exited before the webhook was ready (code=1)…stderr… token=sk-ant-FAKE', category: 'process-exited-early' },
            { input: 'Child process error for PID 31337: EACCES /home/guang/secrets', category: 'child-process-error' },
            { input: 'Worktree creation failed: fatal: not a git repository', category: 'worktree-failed' },
            { input: 'Worktree sessions require an existing Git repository. Directory not found: /tmp/x', category: 'directory-missing' },
            { input: 'Unable to create directory at \'/tmp/x\'. Permission denied.', category: 'directory-create-failed' },
            { input: 'Failed to spawn YR process - no PID returned', category: 'no-pid' },
            { input: 'Unexpected spawn result', category: 'rpc-error' },
            { input: 'totally novel error: leaked /home/secret', category: 'unexpected' },
            { input: '', category: 'unexpected' },
        ]

        for (const { input, category } of cases) {
            expect(categorizeAutoResumeSpawnError(input)).toBe(category)
        }

        // Sanity: the categorizer never returns the raw input
        expect(categorizeAutoResumeSpawnError('contains sk-ant-FAKE token')).not.toContain('sk-ant')
    })

    test('claimed-live reconnect timeout default covers socket reconnectionDelayMax=5s', () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
        } as any
        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        const timeout = (engine as any).autoResumeClaimedReconnectTimeoutMs
        expect(timeout).toBeGreaterThanOrEqual(8_000)
    })
})
