import type { Metadata } from '@/api/types';
import { getProcessStartedAtMs, isProcessAlive } from '@/utils/process';
import spawn from 'cross-spawn';
import type { TrackedSession } from './types';

const PROCESS_START_TIME_STRICT_TOLERANCE_MS = 2_000;
const DAEMON_OWNED_PROCESS_START_TIME_TOLERANCE_MS = 30_000;

type SessionProcessIdentityTrust = 'passive' | 'tracked' | 'webhook';

type NormalizeSessionProcessIdentityOptions = {
    expectedSessionId?: string;
    trust?: SessionProcessIdentityTrust;
};

export function isDaemonOwnedSession(metadata: Metadata): boolean {
    return metadata.startedFromDaemon === true || metadata.startedBy === 'daemon';
}

function getProcessCommandLine(pid: number): string | null {
    if (!Number.isFinite(pid) || pid <= 0) {
        return null;
    }

    try {
        const result = process.platform === 'win32'
            ? spawn.sync('powershell', [
                '-NoProfile',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
            ], { stdio: 'pipe' })
            : spawn.sync('ps', ['-p', pid.toString(), '-o', 'args='], { stdio: 'pipe' });

        if (result.error || result.status !== 0) {
            return null;
        }

        const raw = result.stdout?.toString().trim();
        return raw || null;
    } catch {
        return null;
    }
}

function commandLineHasFlagValue(commandLine: string, flag: string, expectedValue: string): boolean {
    return commandLine.includes(`${flag} ${expectedValue}`) || commandLine.includes(`${flag}=${expectedValue}`);
}

function isDaemonOwnedProcessFingerprintMatch(pid: number, expectedSessionId?: string): boolean {
    const commandLine = getProcessCommandLine(pid);
    if (!commandLine || !commandLine.includes('--started-by daemon')) {
        return false;
    }

    if (!expectedSessionId) {
        return true;
    }

    const hasExplicitSessionId = commandLine.includes('--yoho-remote-session-id')
        || commandLine.includes('--yoho-remote-resume-session-id');
    if (!hasExplicitSessionId) {
        return true;
    }

    return commandLineHasFlagValue(commandLine, '--yoho-remote-session-id', expectedSessionId)
        || commandLineHasFlagValue(commandLine, '--yoho-remote-resume-session-id', expectedSessionId);
}

export function normalizeSessionProcessIdentity(
    metadata: Metadata,
    options: NormalizeSessionProcessIdentityOptions = {},
): Metadata | null {
    const pid = metadata.hostPid;
    if (!pid) {
        return null;
    }

    if (!isProcessAlive(pid)) {
        return null;
    }

    if (typeof metadata.hostProcessStartedAt !== 'number') {
        return metadata;
    }

    const actualStartedAt = getProcessStartedAtMs(pid);
    if (actualStartedAt === null) {
        return metadata;
    }

    const startTimeDiffMs = Math.abs(actualStartedAt - metadata.hostProcessStartedAt);
    if (startTimeDiffMs <= PROCESS_START_TIME_STRICT_TOLERANCE_MS) {
        if (actualStartedAt === metadata.hostProcessStartedAt) {
            return metadata;
        }

        return {
            ...metadata,
            hostProcessStartedAt: actualStartedAt,
        };
    }

    if (!isDaemonOwnedSession(metadata) || startTimeDiffMs > DAEMON_OWNED_PROCESS_START_TIME_TOLERANCE_MS) {
        return null;
    }

    const trust = options.trust ?? 'tracked';
    if (trust !== 'webhook' && !isDaemonOwnedProcessFingerprintMatch(pid, options.expectedSessionId)) {
        return null;
    }

    // Normalize to the actual runtime value once accepted so subsequent health checks
    // don't keep failing on coarse/granular start-time differences after daemon restart.
    return {
        ...metadata,
        hostProcessStartedAt: actualStartedAt,
    };
}

export function isSessionProcessIdentityCurrent(metadata: Metadata): boolean {
    return normalizeSessionProcessIdentity(metadata, { trust: 'tracked' }) !== null;
}

export function isTrackedSessionProcessCurrent(tracked: TrackedSession): boolean {
    const metadata = tracked.yohoRemoteSessionMetadataFromLocalWebhook;
    if (!metadata) {
        return isProcessAlive(tracked.pid);
    }

    const normalizedMetadata = normalizeSessionProcessIdentity({
        ...metadata,
        hostPid: metadata.hostPid ?? tracked.pid,
    }, {
        expectedSessionId: tracked.yohoRemoteSessionId,
        trust: 'tracked',
    });
    if (!normalizedMetadata) {
        return false;
    }

    tracked.yohoRemoteSessionMetadataFromLocalWebhook = normalizedMetadata;
    return true;
}
