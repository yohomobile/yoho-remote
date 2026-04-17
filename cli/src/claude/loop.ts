import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { runLocalRemoteLoop } from "@/agent/loopBase"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"
import type { SessionModelMode } from "@/api/types"

export type PermissionMode = 'bypassPermissions';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    fastMode?: boolean;
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    startedBy?: 'daemon' | 'terminal'
    sessionId?: string | null
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    onSessionReady?: (session: Session) => void
    hookSettingsPath: string
    executableCommand?: string
}

export async function loop(opts: LoopOptions) {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';
    const modelMode: SessionModelMode = opts.model === 'sonnet' || opts.model === 'opus' || opts.model === 'opus-4-7' || opts.model === 'glm-5.1'
        ? opts.model
        : 'default';
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.sessionId ?? null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        hookSettingsPath: opts.hookSettingsPath,
        permissionMode: opts.permissionMode ?? 'bypassPermissions',
        modelMode,
        executableCommand: opts.executableCommand
    });

    // Notify that session is ready
    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    await runLocalRemoteLoop({
        session,
        startingMode: opts.startingMode,
        logTag: 'loop',
        runLocal: claudeLocalLauncher,
        runRemote: claudeRemoteLauncher
    });
}
