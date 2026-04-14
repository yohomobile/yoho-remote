import type { ApiClient } from '@/api/api';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import type { TrackedSession } from './types';
import { isSessionProcessIdentityCurrent } from './trackedSessionIdentity';

export const EXTERNAL_TRACKED_SESSION_LABEL = 'yr directly - likely by user from terminal';

function getTrackedSessionStartedBy(metadata: Metadata): TrackedSession['startedBy'] {
    return metadata.startedBy === 'daemon'
        ? 'daemon'
        : EXTERNAL_TRACKED_SESSION_LABEL;
}

export async function recoverTrackedSessionsFromServer({
    api,
    machineId,
    pidToTrackedSession,
}: {
    api: Pick<ApiClient, 'listSessions' | 'getSession'>;
    machineId: string;
    pidToTrackedSession: Map<number, TrackedSession>;
}): Promise<number> {
    const listed = await api.listSessions();
    const candidateIds = listed.sessions
        .filter((session) => session.active && session.metadata?.machineId === machineId)
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
            continue;
        }

        if (!isSessionProcessIdentityCurrent(metadata)) {
            logger.debug(`[DAEMON RUN] Skipping recovered session ${sessionId}: process identity no longer matches PID ${pid}`);
            continue;
        }

        const existing = pidToTrackedSession.get(pid);
        if (existing) {
            existing.startedBy = existing.startedBy === 'daemon' || metadata.startedBy === 'daemon'
                ? 'daemon'
                : EXTERNAL_TRACKED_SESSION_LABEL;
            existing.yohoRemoteSessionId = session.id;
            existing.yohoRemoteSessionMetadataFromLocalWebhook = metadata;
            continue;
        }

        pidToTrackedSession.set(pid, {
            startedBy: getTrackedSessionStartedBy(metadata),
            yohoRemoteSessionId: session.id,
            yohoRemoteSessionMetadataFromLocalWebhook: metadata,
            pid
        });
        recovered++;
    }

    return recovered;
}
