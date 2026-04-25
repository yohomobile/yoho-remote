import type { ApiClient } from '@/api/api';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import type { TrackedSession } from './types';
import { getDaemonTempDirsFromMetadata } from './tempDirs';
import { isDaemonOwnedSession, normalizeSessionProcessIdentity } from './trackedSessionIdentity';

export const EXTERNAL_TRACKED_SESSION_LABEL = 'yr directly - likely by user from terminal';

export function getTrackedSessionStartedBy(metadata: Metadata): TrackedSession['startedBy'] {
    return isDaemonOwnedSession(metadata)
        ? 'daemon'
        : EXTERNAL_TRACKED_SESSION_LABEL;
}

/**
 * Ask the server to archive a session whose PID can no longer be identified on
 * this machine. Non-fatal on failure — the next recovery pass will retry.
 * Uses `lifecycleState=archiveRequested` (server-driven archival) instead of
 * `deleteSession` to keep message history intact for audit.
 */
async function requestArchiveForStaleSession(
    api: { patchSessionMetadata?: ApiClient['patchSessionMetadata'] },
    sessionId: string,
    reason: string,
): Promise<void> {
    if (!api.patchSessionMetadata) {
        logger.debug(`[DAEMON RUN] Cannot request archive for stale session ${sessionId}: patchSessionMetadata unavailable (reason=${reason})`);
        return;
    }
    try {
        await api.patchSessionMetadata(sessionId, { lifecycleState: 'archiveRequested' });
        logger.debug(`[DAEMON RUN] Requested archive for stale session ${sessionId} (reason=${reason})`);
    } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to request archive for stale session ${sessionId}`, error);
    }
}

export async function recoverTrackedSessionsFromServer({
    api,
    machineId,
    pidToTrackedSession,
}: {
    api: Pick<ApiClient, 'listSessions' | 'getSession'> & { patchSessionMetadata?: ApiClient['patchSessionMetadata'] };
    machineId: string;
    pidToTrackedSession: Map<number, TrackedSession>;
}): Promise<number> {
    const listed = await api.listSessions({ includeOffline: true });
    const candidateIds = listed.sessions
        .filter((session) => session.metadata?.machineId === machineId)
        .map((session) => session.id);

    let recovered = 0;

    for (const sessionId of candidateIds) {
        let session;
        try {
            session = await api.getSession(sessionId);
        } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to load session ${sessionId} during startup recovery`, error);
            continue;
        }

        const metadata = session.metadata;
        if (!metadata || metadata.machineId !== machineId || metadata.lifecycleState === 'archived') {
            continue;
        }

        const pid = metadata.hostPid;
        if (!pid) {
            logger.debug(`[DAEMON RUN] Skipping recovered session ${sessionId}: missing hostPid`);
            await requestArchiveForStaleSession(api, session.id, 'missing-host-pid');
            continue;
        }

        const normalizedMetadata = normalizeSessionProcessIdentity(metadata, {
            expectedSessionId: session.id,
            trust: 'passive',
        });
        if (!normalizedMetadata) {
            logger.debug(`[DAEMON RUN] Skipping recovered session ${sessionId}: process identity no longer matches PID ${pid}`);
            await requestArchiveForStaleSession(api, session.id, 'identity-mismatch');
            continue;
        }

        const existing = pidToTrackedSession.get(pid);
        if (existing) {
            existing.startedBy = existing.startedBy === 'daemon' || isDaemonOwnedSession(metadata)
                ? 'daemon'
                : EXTERNAL_TRACKED_SESSION_LABEL;
            existing.yohoRemoteSessionId = session.id;
            existing.yohoRemoteSessionMetadataFromLocalWebhook = normalizedMetadata;
            existing.tempDirs = getDaemonTempDirsFromMetadata(metadata);
            logger.debug('[DAEMON RUN] Refreshed recovered tracked session', {
                sessionId: session.id,
                pid,
                startedBy: existing.startedBy,
                tempDirCount: existing.tempDirs?.length ?? 0,
            });
            continue;
        }

        const recoveredTrackedSession: TrackedSession = {
            startedBy: getTrackedSessionStartedBy(metadata),
            yohoRemoteSessionId: session.id,
            yohoRemoteSessionMetadataFromLocalWebhook: normalizedMetadata,
            tempDirs: getDaemonTempDirsFromMetadata(metadata),
            pid
        };
        pidToTrackedSession.set(pid, recoveredTrackedSession);
        logger.debug('[DAEMON RUN] Recovered live session from server state', {
            sessionId: session.id,
            pid,
            startedBy: recoveredTrackedSession.startedBy,
            tempDirCount: recoveredTrackedSession.tempDirs?.length ?? 0,
        });
        recovered++;
    }

    return recovered;
}
