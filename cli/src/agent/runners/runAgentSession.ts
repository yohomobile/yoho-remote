import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { ApiClient, type StoredMessage } from '@/api/api';
import type { AgentState, Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import packageJson from '../../../package.json';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { runtimePath } from '@/projectPath';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { AgentRegistry } from '@/agent/AgentRegistry';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentBackend, HistoryMessage, PromptContent } from '@/agent/types';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startYohoRemoteServer } from '@/claude/utils/startYohoRemoteServer';
import { getYohoRemoteCliCommand } from '@/utils/spawnYohoRemoteCLI';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { readWorktreeEnv } from '@/utils/worktreeEnv';

function extractHistoryFromStoredMessages(messages: StoredMessage[]): HistoryMessage[] {
    const history: HistoryMessage[] = [];

    for (const msg of messages) {
        const content = msg.content as Record<string, unknown> | null;
        if (!content || typeof content !== 'object') continue;

        const role = content.role;
        const innerContent = content.content as Record<string, unknown> | null;
        if (!innerContent || typeof innerContent !== 'object') continue;

        if (role === 'user' && innerContent.type === 'text' && typeof innerContent.text === 'string') {
            history.push({ role: 'user', content: innerContent.text });
        } else if (role === 'agent' && innerContent.type === 'codex') {
            const data = innerContent.data as Record<string, unknown> | null;
            if (data && data.type === 'message' && typeof data.message === 'string') {
                history.push({ role: 'assistant', content: data.message });
            }
        }
    }

    return history;
}

function emitReadyIfIdle(props: {
    queueSize: () => number;
    shouldExit: boolean;
    thinking: boolean;
    sendReady: () => void;
}): void {
    if (props.shouldExit) return;
    if (props.thinking) return;
    if (props.queueSize() > 0) return;
    props.sendReady();
}

export async function runAgentSession(opts: {
    agentType: string;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    const sessionTag = randomUUID();
    const api = await ApiClient.create();
    const sessionSource = process.env.YR_SESSION_SOURCE?.trim();

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Please report this issue on ${packageJson.bugs}`);
        process.exit(1);
    }

    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let state: AgentState = {
        controlledByUser: false
    };

    const worktreeInfo = readWorktreeEnv();
    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId,
        source: sessionSource || undefined,
        homeDir: os.homedir(),
        yohoRemoteHomeDir: configuration.yohoRemoteHomeDir,
        yohoRemoteLibDir: runtimePath(),
        yohoRemoteToolsDir: resolve(runtimePath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.agentType,
        worktree: worktreeInfo ?? undefined
    };

    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    try {
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report session to daemon: ${result.error}`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report session to daemon', error);
    }

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: false
    }));

    const messageQueue = new MessageQueue2<Record<string, never>>(() => hashObject({}));

    session.onUserMessage((message) => {
        messageQueue.push(message.content.text, {});
    });

    const reportStartFailure = async (stage: string, error: unknown): Promise<void> => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[ACP] Failed to start ${opts.agentType} agent (${stage}): ${message}`);
        session.sendSessionEvent({
            type: 'message',
            message: `Failed to start ${opts.agentType} agent (${stage}): ${message}`
        });
        session.sendSessionDeath();
        await session.flush();
        session.close();
    };

    const backend: AgentBackend = AgentRegistry.create(opts.agentType);
    try {
        await backend.initialize();
    } catch (error) {
        await reportStartFailure('initialize', error);
        await backend.disconnect().catch(() => {});
        return;
    }

    const permissionAdapter = new PermissionAdapter(session, backend);

    let yohoRemoteServer: Awaited<ReturnType<typeof startYohoRemoteServer>>;
    try {
        yohoRemoteServer = await startYohoRemoteServer(session, {
            sessionSource: sessionSource || undefined,
            apiClient: api,
            machineId,
            yohoRemoteSessionId: response.id,
        });
    } catch (error) {
        await reportStartFailure('start-mcp', error);
        await backend.disconnect().catch(() => {});
        return;
    }
    const bridgeCommand = getYohoRemoteCliCommand(['mcp', '--url', yohoRemoteServer.url]);
    const mcpServers = [
        {
            name: 'yoho-remote',
            command: bridgeCommand.command,
            args: bridgeCommand.args,
            env: []
        }
    ];

    let agentSessionId: string;
    try {
        agentSessionId = await backend.newSession({
            cwd: process.cwd(),
            mcpServers
        });
    } catch (error) {
        await reportStartFailure('session', error);
        yohoRemoteServer.stop();
        await backend.disconnect().catch(() => {});
        return;
    }

    // Update runtimeModel metadata if the backend supports getModel
    if ('getModel' in backend && typeof backend.getModel === 'function') {
        const runtimeModel = backend.getModel(agentSessionId);
        if (runtimeModel) {
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                runtimeModel
            }));
            logger.debug(`[START] Set runtimeModel: ${runtimeModel}`);
        }
    }

    // Restore history messages if the backend supports it
    if (backend.restoreHistory) {
        try {
            const storedMessages = await api.getSessionMessages(response.id, { afterSeq: 0, limit: 200 });
            const history = extractHistoryFromStoredMessages(storedMessages);
            if (history.length > 0) {
                backend.restoreHistory(agentSessionId, history);
                logger.debug(`[START] Restored ${history.length} history messages from server`);
            }
        } catch (error) {
            logger.debug('[START] Failed to restore history messages', error);
        }
    }

    let thinking = false;
    let shouldExit = false;
    let waitAbortController: AbortController | null = null;

    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const handleAbort = async () => {
        logger.debug('[ACP] Abort requested');
        await backend.cancelPrompt(agentSessionId);
        await permissionAdapter.cancelAll('User aborted');
        thinking = false;
        session.keepAlive(thinking, 'remote');
        sendReady();
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    session.rpcHandlerManager.registerHandler('abort', async () => {
        await handleAbort();
    });

    const handleKillSession = async () => {
        if (shouldExit) return;
        shouldExit = true;
        await permissionAdapter.cancelAll('Session killed');
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    // Handle model mode changes from the web UI
    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as {
            modelMode?: string;
        };

        if (config.modelMode !== undefined && 'setModel' in backend && typeof backend.setModel === 'function') {
            await backend.setModel(agentSessionId, config.modelMode);
            // Update runtimeModel metadata
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                runtimeModel: config.modelMode
            }));
            logger.debug(`[ACP] Model changed to: ${config.modelMode}`);
        }

        return {
            applied: {
                modelMode: config.modelMode
            }
        };
    });

    try {
        while (!shouldExit) {
            waitAbortController = new AbortController();
            const batch = await messageQueue.waitForMessagesAndGetAsString(waitAbortController.signal);
            waitAbortController = null;
            if (!batch) {
                if (shouldExit) {
                    break;
                }
                continue;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            thinking = true;
            session.keepAlive(thinking, 'remote');

            try {
                await backend.prompt(agentSessionId, promptContent, (message) => {
                    const converted = convertAgentMessage(message);
                    if (converted) {
                        session.sendCodexMessage(converted);
                    }
                });
            } catch (error) {
                const errorMessage = error instanceof Error
                    ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
                    : String(error);
                logger.warn('[ACP] Prompt failed:', errorMessage);
                session.sendSessionEvent({
                    type: 'message',
                    message: `Agent prompt failed: ${error instanceof Error ? error.message : String(error)}`
                });
            } finally {
                thinking = false;
                session.keepAlive(thinking, 'remote');
                await permissionAdapter.cancelAll('Prompt finished');
                emitReadyIfIdle({
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    thinking,
                    sendReady
                });
            }
        }
    } finally {
        clearInterval(keepAliveInterval);
        await permissionAdapter.cancelAll('Session ended');
        session.sendSessionDeath();
        await session.flush();
        session.close();
        await backend.disconnect();
        yohoRemoteServer.stop();
    }
}
