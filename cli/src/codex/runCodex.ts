import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState, Metadata, SessionModelMode, SessionModelReasoningEffort } from '@/api/types';
import packageJson from '../../package.json';
import { runtimePath } from '@/projectPath';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { readModeEnv } from '@/utils/modeEnv';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

export async function runCodex(opts: {
    startedBy?: 'daemon' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    yohoRemoteSessionId?: string;
    resumeSessionId?: string;
}): Promise<void> {
    // When spawned by the daemon the process starts in a safe local cwd (non-NFS) to avoid
    // Bun/Node startup touching a potentially slow project mount too early. The actual
    // project directory is passed via YR_SPAWN_DIRECTORY and becomes the session cwd.
    const workingDirectory = process.env['YR_SPAWN_DIRECTORY'] ?? process.cwd();
    if (process.cwd() !== workingDirectory) {
        process.chdir(workingDirectory);
    }
    const sessionTag = randomUUID();
    const startedBy = opts.startedBy ?? 'terminal';
    const sessionSource = process.env.YR_SESSION_SOURCE?.trim();

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    const api = await ApiClient.create();

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let state: AgentState = {
        controlledByUser: false
    };

    const metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        source: sessionSource || undefined,
        homeDir: os.homedir(),
        yohoRemoteHomeDir: configuration.yohoRemoteHomeDir,
        yohoRemoteLibDir: runtimePath(),
        yohoRemoteToolsDir: resolve(runtimePath(), 'tools', 'unpacked'),
        startedFromDaemon: startedBy === 'daemon',
        hostPid: process.pid,
        startedBy,
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex',
    };

    let response: Awaited<ReturnType<typeof api.getOrCreateSession>> | null = null;
    const yohoRemoteSessionId = opts.yohoRemoteSessionId?.trim() || null;
    if (yohoRemoteSessionId) {
        try {
            response = await api.getSession(yohoRemoteSessionId);
            logger.debug(`Session loaded: ${response.id}`);
        } catch (error) {
            logger.debug(`[codex] Failed to load session ${yohoRemoteSessionId}, creating new one`, error);
        }
    }
    if (!response) {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }
    const session = api.sessionSyncClient(response);
    if (yohoRemoteSessionId) {
        session.updateMetadata((current) => ({
            ...current,
            ...metadata,
            summary: current.summary ?? metadata.summary,
            claudeSessionId: current.claudeSessionId ?? metadata.claudeSessionId,
            codexSessionId: current.codexSessionId ?? metadata.codexSessionId
        }));
    }

    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    const startingMode: 'local' | 'remote' = startedBy === 'daemon' ? 'remote' : 'local';

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: startingMode === 'local'
    }));

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        modelReasoningEffort: mode.modelReasoningEffort
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    // Read mode settings from environment (set by daemon when resuming session)
    const modeEnv = readModeEnv();
    // Filter to valid Codex permission modes
    const envPermissionMode = (modeEnv.permissionMode === 'default' || modeEnv.permissionMode === 'read-only' || modeEnv.permissionMode === 'safe-yolo' || modeEnv.permissionMode === 'yolo')
        ? modeEnv.permissionMode
        : undefined;
    let currentPermissionMode: PermissionMode = envPermissionMode ?? opts.permissionMode ?? 'default';
    let currentModelMode: SessionModelMode | undefined = modeEnv.modelMode;
    let currentModelReasoningEffort: SessionModelReasoningEffort | undefined = modeEnv.modelReasoningEffort;
    if (envPermissionMode || modeEnv.modelMode || modeEnv.modelReasoningEffort) {
        logger.debug(`[Codex] Using mode settings from environment: permissionMode=${envPermissionMode}, modelMode=${modeEnv.modelMode}, reasoningEffort=${modeEnv.modelReasoningEffort}`);
    }

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModelMode(currentModelMode);
        sessionInstance.setModelReasoningEffort(currentModelReasoningEffort);
        logger.debug(`[Codex] Synced session mode for keepalive: permission=${currentPermissionMode}, model=${currentModelMode ?? 'unset'}, reasoning=${currentModelReasoningEffort ?? 'unset'}`);
    };

    session.onUserMessage((message) => {
        const messagePermissionMode = currentPermissionMode;
        logger.debug(`[Codex] User message received with permission mode: ${currentPermissionMode}`);

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModelMode && currentModelMode !== 'default' ? currentModelMode : undefined,
            modelReasoningEffort: currentModelReasoningEffort
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    let cleanupStarted = false;
    let exitCode = 0;
    let archiveReason = 'User terminated';

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const cleanup = async (code: number = exitCode) => {
        if (cleanupStarted) {
            return;
        }
        cleanupStarted = true;
        logger.debug('[codex] Cleanup start');
        restoreTerminalState();
        try {
            const sessionWrapper = sessionWrapperRef.current;
            if (sessionWrapper) {
                sessionWrapper.stopKeepAlive();
            }

            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason
            }));

            session.sendSessionDeath();
            await session.flush();
            await session.close();

            logger.debug('[codex] Cleanup complete, exiting');
            process.exit(code);
        } catch (error) {
            logger.debug('[codex] Error during cleanup:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGINT', () => cleanup(0));

    process.on('uncaughtException', (error) => {
        logger.debug('[codex] Uncaught exception:', error);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup(1);
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[codex] Unhandled rejection:', reason);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup(1);
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as {
            permissionMode?: PermissionMode;
            modelMode?: SessionModelMode;
            modelReasoningEffort?: SessionModelReasoningEffort;
        };

        if (config.permissionMode !== undefined) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (!validModes.includes(config.permissionMode)) {
                throw new Error('Invalid permission mode');
            }
            currentPermissionMode = config.permissionMode;
        }

        if (config.modelMode !== undefined) {
            const validModels: SessionModelMode[] = [
                'default',
                'gpt-5.4',
                'gpt-5.4-mini',
                'gpt-5.3-codex',
                'gpt-5.3-codex-spark',
                'gpt-5.2-codex',
                'gpt-5.2',
                'gpt-5.1-codex-max',
                'gpt-5.1-codex-mini'
            ];
            if (!validModels.includes(config.modelMode)) {
                throw new Error('Invalid model mode');
            }
            currentModelMode = config.modelMode;
        }

        if (config.modelReasoningEffort !== undefined) {
            const validEfforts: SessionModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
            if (!validEfforts.includes(config.modelReasoningEffort)) {
                throw new Error('Invalid reasoning level');
            }
            currentModelReasoningEffort = config.modelReasoningEffort;
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                modelMode: currentModelMode,
                modelReasoningEffort: currentModelReasoningEffort
            }
        };
    });

    const resumeSessionId = (opts.resumeSessionId ?? response.metadata?.codexSessionId ?? null) || null;

    let loopError: unknown = null;
    try {
        await loop({
            path: workingDirectory,
            startingMode,
            sessionId: resumeSessionId,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            codexCliOverrides,
            startedBy,
            machineId,
            sessionSource: sessionSource || null,
            permissionMode: currentPermissionMode,
            onModeChange: (newMode) => {
                session.sendSessionEvent({ type: 'switch', mode: newMode });
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: newMode === 'local'
                }));
            },
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        loopError = error;
        exitCode = 1;
        archiveReason = 'Session crashed';
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            exitCode = 1;
            archiveReason = `Local launch failed: ${formatFailureReason(localFailure.message)}`;
        }
        await cleanup(loopError ? 1 : exitCode);
    }
}
