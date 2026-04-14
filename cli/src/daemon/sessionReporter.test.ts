import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { notifyDaemonSessionStarted } from './controlClient';
import { startDaemonSessionReporter } from './sessionReporter';

vi.mock('./controlClient', () => ({
    notifyDaemonSessionStarted: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

const metadata: Metadata = {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    yohoRemoteHomeDir: '/tmp/.yoho-remote',
    yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
    yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
    hostPid: 1234,
    startedBy: 'daemon',
    machineId: 'machine-1',
};

const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

const notifyDaemonSessionStartedMock = notifyDaemonSessionStarted as unknown as {
    mockReset: () => void;
    mockResolvedValue: (value: unknown) => unknown;
    mockImplementationOnce: (impl: (...args: unknown[]) => Promise<unknown>) => {
        mockResolvedValue: (value: unknown) => unknown;
    };
};

describe('startDaemonSessionReporter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        notifyDaemonSessionStartedMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports immediately, on reconnect, and on the periodic interval', async () => {
        notifyDaemonSessionStartedMock.mockResolvedValue({});
        const session = new EventEmitter();

        const reporter = startDaemonSessionReporter({
            session,
            sessionId: 'session-1',
            metadata,
            intervalMs: 30_000,
        });

        await flushMicrotasks();
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(1);

        session.emit('reconnected');
        await flushMicrotasks();
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(30_000);
        await flushMicrotasks();
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(3);

        reporter.stop();
        session.emit('reconnected');
        vi.advanceTimersByTime(30_000);
        await flushMicrotasks();
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(3);
    });

    it('coalesces overlapping triggers into a single follow-up report', async () => {
        let resolveFirstReport: (() => void) | null = null;
        notifyDaemonSessionStartedMock
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirstReport = () => resolve({});
            }))
            .mockResolvedValue({});

        const session = new EventEmitter();
        const reporter = startDaemonSessionReporter({
            session,
            sessionId: 'session-2',
            metadata,
            intervalMs: 30_000,
        });

        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(1);

        session.emit('reconnected');
        vi.advanceTimersByTime(30_000);
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(1);

        const resolvePendingReport = resolveFirstReport as (() => void) | null;
        if (!resolvePendingReport) {
            throw new Error('Expected the first daemon report to still be pending');
        }
        (resolvePendingReport as () => void)();
        await flushMicrotasks();
        expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(2);

        reporter.stop();
    });
});
