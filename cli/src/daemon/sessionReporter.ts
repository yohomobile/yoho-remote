import type { EventEmitter } from 'node:events';

import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { notifyDaemonSessionStarted } from './controlClient';

const SESSION_REANNOUNCE_INTERVAL_MS = 30_000;

type ReportableSession = Pick<EventEmitter, 'on' | 'off'>;

export function startDaemonSessionReporter({
    session,
    sessionId,
    metadata,
    intervalMs = SESSION_REANNOUNCE_INTERVAL_MS,
}: {
    session: ReportableSession;
    sessionId: string;
    metadata: Metadata;
    intervalMs?: number;
}): { stop: () => void } {
    let stopped = false;
    let reportInFlight: Promise<void> | null = null;
    let rerunRequested = false;
    let lastError: string | null = null;
    let lastReportSucceeded = false;

    const runReport = async (reason: 'startup' | 'periodic' | 'reconnected' | 'coalesced'): Promise<void> => {
        if (stopped) {
            return;
        }

        if (reportInFlight) {
            rerunRequested = true;
            return;
        }

        reportInFlight = (async () => {
            const result = await notifyDaemonSessionStarted(sessionId, metadata);
            const errorMessage = typeof result?.error === 'string' ? result.error : null;

            if (errorMessage) {
                if (lastReportSucceeded || lastError !== errorMessage) {
                    logger.debug(`[DAEMON REPORT] Failed to report session ${sessionId} (${reason}): ${errorMessage}`);
                }
                lastReportSucceeded = false;
                lastError = errorMessage;
                return;
            }

            if (!lastReportSucceeded || reason !== 'periodic') {
                logger.debug(`[DAEMON REPORT] Reported session ${sessionId} to daemon (${reason})`);
            }
            lastReportSucceeded = true;
            lastError = null;
        })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (lastReportSucceeded || lastError !== message) {
                logger.debug(`[DAEMON REPORT] Failed to report session ${sessionId} (${reason})`, error);
            }
            lastReportSucceeded = false;
            lastError = message;
        }).finally(() => {
            reportInFlight = null;
            if (rerunRequested && !stopped) {
                rerunRequested = false;
                void runReport('coalesced');
            }
        });

        await reportInFlight;
    };

    const handleReconnect = () => {
        void runReport('reconnected');
    };

    session.on('reconnected', handleReconnect);

    const interval = setInterval(() => {
        void runReport('periodic');
    }, Math.max(1_000, intervalMs));
    interval.unref?.();

    void runReport('startup');

    return {
        stop: () => {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(interval);
            session.off('reconnected', handleReconnect);
        },
    };
}
