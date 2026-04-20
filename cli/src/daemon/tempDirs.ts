import type { Metadata } from '@/api/types';

const DAEMON_TEMP_DIRS_ENV_KEY = 'YR_DAEMON_TEMP_DIRS';

function normalizeDaemonTempDirs(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const dirs = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return dirs.length > 0 ? dirs : undefined;
}

export function getDaemonTempDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
    const raw = env[DAEMON_TEMP_DIRS_ENV_KEY];
    if (!raw) {
        return undefined;
    }

    try {
        return normalizeDaemonTempDirs(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

export function getDaemonTempDirsFromMetadata(metadata: Metadata | null | undefined): string[] | undefined {
    return normalizeDaemonTempDirs(metadata?.daemonTempDirs);
}

export function serializeDaemonTempDirsForEnv(tempDirs: string[]): string | undefined {
    const normalized = normalizeDaemonTempDirs(tempDirs);
    if (!normalized) {
        return undefined;
    }

    return JSON.stringify(normalized);
}
