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

        expect(recovered).toBe(1);
        expect(tracked.get(111)).toMatchObject({
            pid: 111,
            yohoRemoteSessionId: 'session-a',
            startedBy: 'daemon',
        });
        expect(tracked.has(333)).toBe(false);
        expect(api.getSession).toHaveBeenCalledTimes(2);
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
});
