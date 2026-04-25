import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import spawn from 'cross-spawn';
import {
    isSessionProcessIdentityCurrent,
    isTrackedSessionProcessCurrent,
    normalizeSessionProcessIdentity,
} from './trackedSessionIdentity';
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

const baseMetadata: Metadata = {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    yohoRemoteHomeDir: '/tmp/.yr',
    yohoRemoteLibDir: '/tmp/.yr/lib',
    yohoRemoteToolsDir: '/tmp/.yr/tools',
    hostPid: 123,
    hostProcessStartedAt: 1_000_000,
    startedBy: 'daemon',
};

describe('tracked session identity', () => {
    beforeEach(() => {
        (isProcessAlive as unknown as { mockReset: () => void }).mockReset();
        (getProcessStartedAtMs as unknown as { mockReset: () => void }).mockReset();
        (spawn.sync as unknown as { mockReset: () => void }).mockReset();
    });

    it('accepts matching pid and process start time', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_001_000);

        expect(isSessionProcessIdentityCurrent(baseMetadata)).toBe(true);
    });

    it('rejects reused pid when process start time no longer matches', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_040_000);

        expect(isSessionProcessIdentityCurrent(baseMetadata)).toBe(false);
    });

    it('accepts daemon-owned sessions with coarse start time drift and normalizes metadata', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote claude --started-by daemon --yoho-remote-session-id session-1',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toMatchObject({
            ...baseMetadata,
            hostProcessStartedAt: 1_025_000,
        });
    });

    it('accepts larger daemon-owned start time drift when explicit session fingerprint matches', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_120_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon --yoho-remote-session-id session-1',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toMatchObject({
            ...baseMetadata,
            hostProcessStartedAt: 1_120_000,
        });
    });

    it('keeps coarse tolerance when only daemon fingerprint matches without explicit session id', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_120_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('rejects explicit session fingerprint match when drift exceeds 24h tolerance', () => {
        const driftBeyond24h = 24 * 60 * 60 * 1000 + 60_000;
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(baseMetadata.hostProcessStartedAt! + driftBeyond24h);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon --yoho-remote-session-id session-1',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('rejects session-id fingerprint mismatch even when drift would fit within 24h tolerance', () => {
        const driftWithin24h = 60 * 60 * 1000;
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(baseMetadata.hostProcessStartedAt! + driftWithin24h);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote codex --started-by daemon --yoho-remote-session-id session-OTHER',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('returns null at coarse drift when ps fails and command line is unavailable', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 1,
            stdout: '',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('still rejects within the 2s..30s coarse window when ps fails (cmdline=null)', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_010_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 1,
            stdout: '',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('webhook trust bypasses cmdline lookup and accepts coarse drift without fingerprint check', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 1,
            stdout: '',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'webhook',
        })).toMatchObject({
            ...baseMetadata,
            hostProcessStartedAt: 1_025_000,
        });
    });

    it('rejects daemon-owned coarse drift during passive recovery when command line fingerprint mismatches', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'python worker.py',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('rejects daemon-owned coarse drift during passive recovery when explicit session id fingerprint mismatches', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote claude --started-by daemon --yoho-remote-session-id session-2',
        });

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'passive',
        })).toBeNull();
    });

    it('accepts daemon-owned coarse drift for direct webhook reports without command line fingerprint', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);

        expect(normalizeSessionProcessIdentity(baseMetadata, {
            expectedSessionId: 'session-1',
            trust: 'webhook',
        })).toMatchObject({
            ...baseMetadata,
            hostProcessStartedAt: 1_025_000,
        });
    });

    it('keeps strict start time validation for non-daemon sessions', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);

        expect(normalizeSessionProcessIdentity({
            ...baseMetadata,
            startedBy: 'terminal',
            startedFromDaemon: false,
        })).toBeNull();
    });

    it('falls back to pid liveness when no start time is available', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);

        expect(isSessionProcessIdentityCurrent({
            ...baseMetadata,
            hostProcessStartedAt: undefined,
        })).toBe(true);
    });

    it('checks tracked sessions using stored webhook metadata', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_000_500);

        const tracked: TrackedSession = {
            pid: 123,
            startedBy: 'daemon',
            yohoRemoteSessionMetadataFromLocalWebhook: baseMetadata,
        };

        expect(isTrackedSessionProcessCurrent(tracked)).toBe(true);
    });

    it('normalizes stored webhook metadata after a successful tracked-session check', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_020_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'yoho-remote claude --started-by daemon --yoho-remote-session-id session-1',
        });

        const tracked: TrackedSession = {
            pid: 123,
            startedBy: 'daemon',
            yohoRemoteSessionId: 'session-1',
            yohoRemoteSessionMetadataFromLocalWebhook: baseMetadata,
        };

        expect(isTrackedSessionProcessCurrent(tracked)).toBe(true);
        expect(tracked.yohoRemoteSessionMetadataFromLocalWebhook?.hostProcessStartedAt).toBe(1_020_000);
    });

    it('requires daemon command line fingerprint for tracked sessions when using relaxed tolerance', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_025_000);
        (spawn.sync as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
            status: 0,
            stdout: 'python worker.py',
        });

        const tracked: TrackedSession = {
            pid: 123,
            startedBy: 'daemon',
            yohoRemoteSessionId: 'session-1',
            yohoRemoteSessionMetadataFromLocalWebhook: baseMetadata,
        };

        expect(isTrackedSessionProcessCurrent(tracked)).toBe(false);
    });
});
