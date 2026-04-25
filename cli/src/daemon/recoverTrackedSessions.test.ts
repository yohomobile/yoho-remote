import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { Metadata, Session } from '@/api/types';
import spawn from 'cross-spawn';
import {
    recoverTrackedSessionsFromServer,
    EXTERNAL_TRACKED_SESSION_LABEL,
    getTrackedSessionStartedBy,
} from './recoverTrackedSessions';
import type { TrackedSession } from './types';
import { getProcessStartedAtMs, isProcessAlive } from '@/utils/process';
import { logger } from '@/ui/logger';

vi.mock('@/utils/process', () => ({
    isProcessAlive: vi.fn(),
    getProcessStartedAtMs: vi.fn(),
}));

vi.mock('cross-spawn', () => ({
    default: {
        sync: vi.fn(),
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
    },
}));

function createSession(id: string, metadata: Metadata): Session {
    return {
        id,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
    };
}

describe('recoverTrackedSessionsFromServer', () => {
    beforeEach(() => {
        (isProcessAlive as unknown as { mockReset: () => void }).mockReset();
        (getProcessStartedAtMs as unknown as { mockReset: () => void }).mockReset();
        (spawn.sync as unknown as { mockReset: () => void }).mockReset();
        (logger.warn as unknown as { mockReset: () => void }).mockReset();
        (logger.debug as unknown as { mockReset: () => void }).mockReset();
    });

    it('classifies daemon-owned metadata using startedFromDaemon as well as startedBy', () => {
        expect(getTrackedSessionStartedBy({
            path: '/tmp/daemon',
            host: 'host-daemon',
            homeDir: '/tmp',
            yohoRemoteHomeDir: '/tmp/.yr',
            yohoRemoteLibDir: '/tmp/.yr/lib',
            yohoRemoteToolsDir: '/tmp/.yr/tools',
            startedFromDaemon: true,
            startedBy: 'terminal',
        })).toBe('daemon');
    });

    it('rehydrates live sessions for the current machine only', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-a', active: true, metadata: { machineId: 'machine-1' } },
                    { id: 'session-b', active: true, metadata: { machineId: 'machine-2' } },
                    { id: 'session-c', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn()
                .mockResolvedValueOnce(createSession('session-a', {
                    path: '/tmp/a',
                    host: 'host-a',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yr',
                    yohoRemoteLibDir: '/tmp/.yr/lib',
                    yohoRemoteToolsDir: '/tmp/.yr/tools',
                    machineId: 'machine-1',
                    hostPid: 111,
                    hostProcessStartedAt: 1_000,
                    startedBy: 'daemon',
                }))
                .mockResolvedValueOnce(createSession('session-c', {
                    path: '/tmp/c',
                    host: 'host-c',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yr',
                    yohoRemoteLibDir: '/tmp/.yr/lib',
                    yohoRemoteToolsDir: '/tmp/.yr/tools',
                    machineId: 'machine-1',
                    hostPid: 333,
                    hostProcessStartedAt: 2_000,
                    startedBy: 'terminal',
                })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockImplementation: (fn: (pid: number) => boolean) => void })
            .mockImplementation((pid: number) => pid !== 333);
        (getProcessStartedAtMs as unknown as { mockImplementation: (fn: (pid: number) => number | null) => void })
            .mockImplementation((pid: number) => pid === 111 ? 1_000 : 9_999);

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(api.listSessions).toHaveBeenCalledWith({ includeOffline: true });
        expect(recovered).toBe(1);
        expect(tracked.get(111)).toMatchObject({
            pid: 111,
            yohoRemoteSessionId: 'session-a',
            startedBy: 'daemon',
        });
        expect(tracked.has(333)).toBe(false);
        expect(api.getSession).toHaveBeenCalledTimes(2);
    });

    it('rehydrates daemon-owned sessions that server marked inactive during machine disconnect', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-disconnected', active: false, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue({
                ...createSession('session-disconnected', {
                    path: '/tmp/disconnected',
                    host: 'host-disconnected',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yr',
                    yohoRemoteLibDir: '/tmp/.yr/lib',
                    yohoRemoteToolsDir: '/tmp/.yr/tools',
                    machineId: 'machine-1',
                    hostPid: 515,
                    hostProcessStartedAt: 5_000,
                    startedBy: 'daemon',
                    startedFromDaemon: true,
                }),
                active: false,
            }),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(5_000);

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(1);
        expect(tracked.get(515)).toMatchObject({
            pid: 515,
            yohoRemoteSessionId: 'session-disconnected',
            startedBy: 'daemon',
        });
    });

    it('restores daemon temp dirs from persisted metadata so a new daemon can clean them later', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-tempdirs', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-tempdirs', {
                path: '/tmp/tempdirs',
                host: 'host-tempdirs',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 222,
                hostProcessStartedAt: 2_000,
                startedBy: 'daemon',
                daemonTempDirs: ['/tmp/yr-codex-a', ' /tmp/yr-codex-b '],
            })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(2_000);

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(1);
        expect(tracked.get(222)).toMatchObject({
            pid: 222,
            tempDirs: ['/tmp/yr-codex-a', '/tmp/yr-codex-b'],
        });
    });

    it('updates an existing tracked pid instead of duplicating it', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-existing', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-existing', {
                path: '/tmp/existing',
                host: 'host-existing',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 444,
                hostProcessStartedAt: 3_000,
                startedBy: 'terminal',
            })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(3_000);

        const tracked = new Map<number, TrackedSession>([
            [444, { pid: 444, startedBy: EXTERNAL_TRACKED_SESSION_LABEL }],
        ]);

        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(0);
        expect(tracked.size).toBe(1);
        expect(tracked.get(444)).toMatchObject({
            pid: 444,
            yohoRemoteSessionId: 'session-existing',
            startedBy: EXTERNAL_TRACKED_SESSION_LABEL,
        });
    });

    it('rehydrates daemon-owned sessions with coarse start time drift and normalizes metadata', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-daemon', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-daemon', {
                path: '/tmp/daemon',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 454,
                hostProcessStartedAt: 10_000,
                startedBy: 'daemon',
            })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(28_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote claude --started-by daemon --yoho-remote-session-id session-daemon',
        });

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(1);
        expect(tracked.get(454)).toMatchObject({
            pid: 454,
            startedBy: 'daemon',
            yohoRemoteSessionId: 'session-daemon',
            yohoRemoteSessionMetadataFromLocalWebhook: {
                hostProcessStartedAt: 28_000,
            },
        });
    });

    it('does not archive a live daemon-owned session when explicit fingerprint matches despite larger start time drift', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-daemon-large-drift', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-daemon-large-drift', {
                path: '/tmp/daemon-large-drift',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 456,
                hostProcessStartedAt: 10_000,
                startedBy: 'daemon',
            })),
            deleteSession: vi.fn(),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession' | 'deleteSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(120_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon --yoho-remote-session-id session-daemon-large-drift',
        });

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(1);
        expect(api.deleteSession).not.toHaveBeenCalled();
        expect(tracked.get(456)).toMatchObject({
            pid: 456,
            startedBy: 'daemon',
            yohoRemoteSessionId: 'session-daemon-large-drift',
            yohoRemoteSessionMetadataFromLocalWebhook: {
                hostProcessStartedAt: 120_000,
            },
        });
    });

    it('archives a still-alive session when explicit fingerprint matches but drift exceeds 24h tolerance', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-daemon-overflow', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-daemon-overflow', {
                path: '/tmp/daemon-overflow',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 789,
                hostProcessStartedAt: 0,
                startedBy: 'daemon',
            })),
            deleteSession: vi.fn(),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession' | 'deleteSession'>;

        // 25h drift — beyond the 24h tolerance even with explicit session fingerprint match.
        const driftMs = 25 * 60 * 60 * 1000;
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(driftMs);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon --yoho-remote-session-id session-daemon-overflow',
        });

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(0);
        expect(tracked.size).toBe(0);
        // Server-compat payload: archivedBy is the gate string syncEngine recognizes,
        // terminateSession=false because the process is already alive (we don't kill it).
        expect(api.deleteSession).toHaveBeenCalledWith('session-daemon-overflow', {
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: alive-identity-mismatch',
            terminateSession: false,
        });
        // Structured warn fields are the operator's eyes on alive-but-archived events.
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[ALIVE_ARCHIVE]'),
            {
                sessionId: 'session-daemon-overflow',
                pid: 789,
                hostProcessStartedAt: 0,
                startedBy: 'daemon',
                startedFromDaemon: undefined,
            },
        );
    });

    it('logs alive-but-archived warn when fingerprint missing on a live pid', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-no-fingerprint', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-no-fingerprint', {
                path: '/tmp/no-fp',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 222,
                hostProcessStartedAt: 10_000,
                startedBy: 'daemon',
            })),
            deleteSession: vi.fn(),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession' | 'deleteSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(60_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'python worker.py',
        });

        const tracked = new Map<number, TrackedSession>();
        await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(api.deleteSession).toHaveBeenCalledWith('session-no-fingerprint', {
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: alive-identity-mismatch',
            terminateSession: false,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[ALIVE_ARCHIVE]'),
            {
                sessionId: 'session-no-fingerprint',
                pid: 222,
                hostProcessStartedAt: 10_000,
                startedBy: 'daemon',
                startedFromDaemon: undefined,
            },
        );
    });

    it('skips daemon-owned coarse drift during passive recovery when daemon fingerprint is missing', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-daemon', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-daemon', {
                path: '/tmp/daemon',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 454,
                hostProcessStartedAt: 10_000,
                startedBy: 'daemon',
            })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(28_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'python worker.py',
        });

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(0);
        expect(tracked.size).toBe(0);
    });

    it('skips sessions whose pid has been reused by another process', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-reused', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-reused', {
                path: '/tmp/reused',
                host: 'host-reused',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 555,
                hostProcessStartedAt: 4_000,
                startedBy: 'daemon',
            })),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(40_000);

        const tracked = new Map<number, TrackedSession>();
        const recovered = await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(recovered).toBe(0);
        expect(tracked.size).toBe(0);
    });

    it('archives a dead pid quietly without [ALIVE_ARCHIVE] warn noise', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-dead', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-dead', {
                path: '/tmp/dead',
                host: 'host-dead',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 999,
                hostProcessStartedAt: 1_000,
                startedBy: 'daemon',
            })),
            deleteSession: vi.fn(),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession' | 'deleteSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(false);

        const tracked = new Map<number, TrackedSession>();
        await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: tracked,
        });

        expect(api.deleteSession).toHaveBeenCalledWith('session-dead', {
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: dead-pid',
            terminateSession: false,
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('also covers startedFromDaemon=true sessions in ALIVE_ARCHIVE structured fields', async () => {
        const api = {
            listSessions: vi.fn().mockResolvedValue({
                sessions: [
                    { id: 'session-from-daemon', active: true, metadata: { machineId: 'machine-1' } },
                ],
            }),
            getSession: vi.fn().mockResolvedValue(createSession('session-from-daemon', {
                path: '/tmp/from-daemon',
                host: 'host-daemon',
                homeDir: '/tmp',
                yohoRemoteHomeDir: '/tmp/.yr',
                yohoRemoteLibDir: '/tmp/.yr/lib',
                yohoRemoteToolsDir: '/tmp/.yr/tools',
                machineId: 'machine-1',
                hostPid: 333,
                hostProcessStartedAt: 5_000,
                startedFromDaemon: true,
            })),
            deleteSession: vi.fn(),
        } satisfies Pick<ApiClient, 'listSessions' | 'getSession' | 'deleteSession'>;

        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(80_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'python worker.py',
        });

        await recoverTrackedSessionsFromServer({
            api,
            machineId: 'machine-1',
            pidToTrackedSession: new Map<number, TrackedSession>(),
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[ALIVE_ARCHIVE]'),
            {
                sessionId: 'session-from-daemon',
                pid: 333,
                hostProcessStartedAt: 5_000,
                startedBy: undefined,
                startedFromDaemon: true,
            },
        );
    });
});
