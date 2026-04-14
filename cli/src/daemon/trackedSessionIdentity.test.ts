import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import { isSessionProcessIdentityCurrent, isTrackedSessionProcessCurrent } from './trackedSessionIdentity';
import { getProcessStartedAtMs, isProcessAlive } from '@/utils/process';

vi.mock('@/utils/process', () => ({
    isProcessAlive: vi.fn(),
    getProcessStartedAtMs: vi.fn(),
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
    });

    it('accepts matching pid and process start time', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_001_000);

        expect(isSessionProcessIdentityCurrent(baseMetadata)).toBe(true);
    });

    it('rejects reused pid when process start time no longer matches', () => {
        (isProcessAlive as unknown as { mockReturnValue: (value: boolean) => void }).mockReturnValue(true);
        (getProcessStartedAtMs as unknown as { mockReturnValue: (value: number) => void }).mockReturnValue(1_010_000);

        expect(isSessionProcessIdentityCurrent(baseMetadata)).toBe(false);
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
});
