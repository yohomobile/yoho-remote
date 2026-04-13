import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteLoop } from '@/agent/loopBase';
import { CodexSession } from './session';
import { codexLocalLauncher } from './codexLocalLauncher';
import { codexExecLauncher } from './codexExecLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { CodexCliOverrides } from './utils/codexCliOverrides';

export type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

interface LoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
    sessionId?: string | null;
    machineId?: string | null;
    sessionSource?: string | null;
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<EnhancedMode>;
    session: ApiSessionClient;
    api: ApiClient;
    codexArgs?: string[];
    codexCliOverrides?: CodexCliOverrides;
    permissionMode?: PermissionMode;
    onSessionReady?: (session: CodexSession) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';
    const session = new CodexSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.sessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        machineId: opts.machineId ?? null,
        sessionSource: opts.sessionSource ?? null,
        codexArgs: opts.codexArgs,
        codexCliOverrides: opts.codexCliOverrides,
        permissionMode: opts.permissionMode ?? 'default'
    });

    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    await runLocalRemoteLoop({
        session,
        startingMode: opts.startingMode,
        logTag: 'codex-loop',
        runLocal: codexLocalLauncher,
        runRemote: codexExecLauncher
    });
}
