import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { loop } from '@/claude/loop';
import { AgentState, Metadata, SessionModelMode, SessionModelReasoningEffort } from '@/api/types';
import packageJson from '../../package.json';
import { readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startYohoRemoteServer } from '@/claude/utils/startYohoRemoteServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile, updateHookSettingsFastMode, readHookSettingsFastMode } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { runtimePath } from '../projectPath';
import { resolve } from 'node:path';
import type { Session } from './session';
import { readWorktreeEnv } from '@/utils/worktreeEnv';
import { readModeEnv } from '@/utils/modeEnv';
import { getYohoAuxMcpServers } from '@/utils/yohoMcpServers';

const INIT_PROMPT_PREFIX = '#InitPrompt-';

function extractClaudeAgent(args?: string[]): string | null {
    if (!args || args.length === 0) {
        return null;
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--agent') {
            const next = args[i + 1];
            if (next && !next.startsWith('-')) {
                return next.trim() || null;
            }
        }
        if (arg.startsWith('--agent=')) {
            const value = arg.slice('--agent='.length).trim();
            if (value) {
                return value;
            }
        }
    }
    return null;
}

export interface StartOptions {
    model?: string
    permissionMode?: 'bypassPermissions'
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    yohoRemoteSessionId?: string
    resumeSessionId?: string
    isCodez?: boolean
}

export async function runClaude(options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();
    const startedBy = options.startedBy ?? 'terminal';
    const runtimeAgent = extractClaudeAgent(options.claudeArgs);
    const sessionSource = process.env.YR_SESSION_SOURCE?.trim();
    const mainSessionId = process.env.YR_MAIN_SESSION_ID?.trim();
    const sessionCaller = process.env.YR_CALLER?.trim();
    logger.debug(`[START] sessionSource=${sessionSource}, mainSessionId=${mainSessionId}, caller=${sessionCaller}`);

    // Log environment info at startup
    logger.debugLargeJson('[START] YR process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements
    if (startedBy === 'daemon' && options.startingMode === 'local') {
        logger.debug('Daemon spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
    }

    // Create session service
    const api = await ApiClient.create();

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    const worktreeInfo = readWorktreeEnv();
    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        source: sessionSource || undefined,
        mainSessionId: mainSessionId || undefined,
        homeDir: os.homedir(),
        yohoRemoteHomeDir: configuration.yohoRemoteHomeDir,
        yohoRemoteLibDir: runtimePath(),
        yohoRemoteToolsDir: resolve(runtimePath(), 'tools', 'unpacked'),
        startedFromDaemon: startedBy === 'daemon',
        hostPid: process.pid,
        startedBy,
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: options.isCodez ? 'codez' : 'claude',
        runtimeAgent: runtimeAgent ?? undefined,
        worktree: worktreeInfo ?? undefined,
    };
    let response: Awaited<ReturnType<typeof api.getOrCreateSession>> | null = null;
    const yohoRemoteSessionId = options.yohoRemoteSessionId?.trim() || null;
    if (yohoRemoteSessionId) {
        try {
            response = await api.getSession(yohoRemoteSessionId);
            logger.debug(`Session loaded: ${response.id}`);
        } catch (error) {
            logger.debug(`[START] Failed to load session ${yohoRemoteSessionId}, creating new one`, error);
        }
    }
    if (!response) {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
        logger.debug(`Session created: ${response.id}`);
    }

    // Always report to daemon if it exists
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

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            // Update session metadata with tools and slash commands
            api.sessionSyncClient(response).updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

    // Create realtime session
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

    // Start YR MCP server
    const yohoRemoteServer = await startYohoRemoteServer(session, {
        sessionSource: sessionSource || undefined,
        sessionCaller: sessionCaller || undefined,
        apiClient: api,
        machineId,
        yohoRemoteSessionId: response.id,
    });
    logger.debug(`[START] YR MCP server started at ${yohoRemoteServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    const currentSessionRef: { current: Session | null } = { current: null };
    let exitCode = 0;
    let archiveReason: string | undefined;

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            const currentSession = currentSessionRef.current;
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    const claudeSettingsType = process.env.YR_CLAUDE_SETTINGS_TYPE as 'litellm' | 'claude' | undefined;
    const hookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, claudeSettingsType);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath} (settingsType=${claudeSettingsType ?? 'default'})`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    const startingMode = options.startingMode ?? (startedBy === 'daemon' ? 'remote' : 'local');
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: startingMode !== 'remote'
    }));

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
        fastMode: mode.fastMode
    }));

    // Forward messages to the queue
    // Read mode settings from environment (set by daemon when resuming session)
    const modeEnv = readModeEnv();
    // Permission mode is always bypassPermissions for Claude sessions
    let currentPermissionMode: PermissionMode = 'bypassPermissions';
    let currentModelMode: SessionModelMode = modeEnv.modelMode ?? (options.model === 'sonnet' || options.model === 'opus' || options.model === 'glm-5.1' ? options.model : 'sonnet');
    // Sync currentModel with modelMode: 'opus'/'sonnet' → pass as --model
    let currentModel = currentModelMode;
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    if (modeEnv.modelMode) {
        logger.debug(`[loop] Using mode settings from environment: modelMode=${modeEnv.modelMode}, reasoningEffort=${modeEnv.modelReasoningEffort}`);
    }
    let currentFastMode = readHookSettingsFastMode(hookSettingsPath); // Restore from settings file (e.g. merged from source settings)
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = sessionSource === 'brain'
        ? [
            ...yohoRemoteServer.toolNames
                .filter(t => sessionCaller === 'feishu' ? t !== 'change_title' : true)
                .map(toolName => `mcp__yoho_remote__${toolName}`),
            'mcp__yoho-memory__recall',
            'mcp__yoho-memory__remember',
            'mcp__yoho-memory__get_playbook',
            'mcp__yoho-memory__learn_playbook',
            'mcp__yoho-credentials__list_credentials',
            'mcp__yoho-credentials__get_credential',
            'mcp__yoho-credentials__set_credential',
            'mcp__yoho-credentials__delete_credential',
        ]
        : undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = (sessionSource === 'openclaw' || sessionSource === 'brain') ? ['AskUserQuestion'] : undefined;

    const syncSessionModes = () => {
        const sessionInstance = currentSessionRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModelMode(currentModelMode);
        sessionInstance.setFastMode(currentFastMode || undefined);
        logger.debug(`[loop] Synced session modes for keepalive: permissionMode=${currentPermissionMode}, modelMode=${currentModelMode}, fastMode=${currentFastMode}`);
    };
    session.onUserMessage((message) => {
        // Permission mode is always bypassPermissions
        const messagePermissionMode: PermissionMode = 'bypassPermissions';
        const messageModel = currentModel;
        logger.debug(`[loop] User message received with permission mode: ${currentPermissionMode}, model: ${currentModelMode}`);

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools,
            fastMode: currentFastMode || undefined
        };

        const trimmedMessage = message.content.text.trimStart();
        if (trimmedMessage.startsWith(INIT_PROMPT_PREFIX)) {
            messageQueue.pushIsolate(message.content.text, enhancedMode);
            logger.debugLargeJson('[start] Init prompt pushed to queue:', message);
            return;
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        messageQueue.push(message.content.text, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');
        restoreTerminalState();

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                const reason = archiveReason ?? 'User terminated';
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: reason
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop YR MCP server
            yohoRemoteServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(exitCode);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup();
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup();
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: PermissionMode; modelMode?: SessionModelMode; modelReasoningEffort?: SessionModelReasoningEffort; fastMode?: boolean };

        // Permission mode is always bypassPermissions, ignore any changes
        if (config.permissionMode !== undefined) {
            currentPermissionMode = 'bypassPermissions';
        }

        if (config.modelMode !== undefined) {
            const validModels: SessionModelMode[] = ['sonnet', 'opus', 'glm-5.1'];
            if (!validModels.includes(config.modelMode)) {
                throw new Error('Invalid model mode');
            }
            currentModelMode = config.modelMode;
            currentModel = config.modelMode;
        }

        if (config.fastMode !== undefined) {
            currentFastMode = config.fastMode;
            updateHookSettingsFastMode(hookSettingsPath, currentFastMode);
            logger.debug(`[loop] Fast mode ${currentFastMode ? 'enabled' : 'disabled'}, settings file updated`);
        }

        syncSessionModes();
        return { applied: { permissionMode: currentPermissionMode, modelMode: currentModelMode, fastMode: currentFastMode } };
    });

    const resumeSessionId = (options.resumeSessionId ?? response.metadata?.claudeSessionId ?? null) || null;

    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: 'bypassPermissions',
        startingMode,
        sessionId: resumeSessionId,
        messageQueue,
        api,
        allowedTools: sessionSource === 'brain'
            ? [
                // Brain mode: whitelist only MCP tools, no built-in tools (Read, Write, Bash, etc.)
                // Feishu sessions: exclude change_title (title is set server-side)
                ...yohoRemoteServer.toolNames
                    .filter(t => sessionCaller === 'feishu' ? t !== 'change_title' : true)
                    .map(toolName => `mcp__yoho_remote__${toolName}`),
                'mcp__yoho-memory__recall',
                'mcp__yoho-memory__remember',
                'mcp__yoho-memory__get_playbook',
                'mcp__yoho-memory__learn_playbook',
                'mcp__yoho-credentials__list_credentials',
                'mcp__yoho-credentials__get_credential',
                'mcp__yoho-credentials__set_credential',
                'mcp__yoho-credentials__delete_credential',
            ]
            : [
                ...yohoRemoteServer.toolNames.map(toolName => `mcp__yoho_remote__${toolName}`),
                'mcp__yoho-memory__recall',
                'mcp__yoho-memory__remember',
                'mcp__yoho-memory__get_playbook',
                'mcp__yoho-memory__learn_playbook',
                'mcp__yoho-credentials__list_credentials',
                'mcp__yoho-credentials__get_credential',
                'mcp__yoho-credentials__set_credential',
                'mcp__yoho-credentials__delete_credential',
            ],
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            currentSessionRef.current = sessionInstance;
            syncSessionModes();
        },
        mcpServers: {
            'yoho_remote': {
                type: 'http' as const,
                url: yohoRemoteServer.url,
            },
            ...getYohoAuxMcpServers('claude'),
        },
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        startedBy,
        hookSettingsPath,
        executableCommand: options.isCodez ? 'codez' : 'claude'
    });

    const localFailure = currentSessionRef.current?.localLaunchFailure;
    if (localFailure?.exitReason === 'exit') {
        exitCode = 1;
        archiveReason = `Local launch failed: ${formatFailureReason(localFailure.message)}`;
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason
        }));
    }

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop YR MCP server
    yohoRemoteServer.stop();
    logger.debug('Stopped YR MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit
    process.exit(exitCode);
}
