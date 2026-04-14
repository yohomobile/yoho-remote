import type { Metadata } from '@/api/types';
import { getProcessStartedAtMs, isProcessAlive } from '@/utils/process';
import type { TrackedSession } from './types';

const PROCESS_START_TIME_TOLERANCE_MS = 2_000;

export function isSessionProcessIdentityCurrent(metadata: Metadata): boolean {
    const pid = metadata.hostPid;
    if (!pid) {
        return false;
    }

    if (!isProcessAlive(pid)) {
        return false;
    }

    if (typeof metadata.hostProcessStartedAt !== 'number') {
        return true;
    }

    const actualStartedAt = getProcessStartedAtMs(pid);
    if (actualStartedAt === null) {
        return true;
    }

    return Math.abs(actualStartedAt - metadata.hostProcessStartedAt) <= PROCESS_START_TIME_TOLERANCE_MS;
}

export function isTrackedSessionProcessCurrent(tracked: TrackedSession): boolean {
    const metadata = tracked.yohoRemoteSessionMetadataFromLocalWebhook;
    if (!metadata) {
        return isProcessAlive(tracked.pid);
    }

    return isSessionProcessIdentityCurrent({
        ...metadata,
        hostPid: metadata.hostPid ?? tracked.pid,
    });
}
