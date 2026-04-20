/**
 * Codex Exec Launcher
 *
 * Replaces codexRemoteLauncher (which used the broken `mcp-server` mode) with
 * `codex exec --json` subprocess spawning.  Each user turn spawns a new process
 * and parses the JSONL event stream.  Subsequent turns resume the previous
 * session via `codex exec resume <thread_id> --json '<prompt>'`.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { getYohoRemoteCliCommand } from '@/utils/spawnYohoRemoteCLI';
import { startYohoRemoteServer } from '@/claude/utils/startYohoRemoteServer';
import { resolveFileReferences } from '@/claude/utils/fileMessage';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import { restoreTerminalState } from '@/ui/terminalState';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexStartConfig, TITLE_INSTRUCTION } from './utils/codexStartConfig';
import { buildCommandExecutionResult, getCommandExecutionPreview } from './utils/commandExecutionResult';
import { normalizeCodexToolReferences } from './utils/normalizeCodexToolReferences';
import { buildCodexExecArgs, type CodexExecStartConfig } from './utils/codexExecArgs';
import { resolveCodexBinary } from './codexBinary';
import { getYohoAuxMcpServers, VAULT_HTTP_PORT } from '@/utils/yohoMcpServers';
import {
    BRAIN_CHILD_SAFE_YOHO_REMOTE_TOOL_NAMES,
    buildCodexBrainChildRuntimeFunctionTools,
    buildCodexConfigOverrides,
    buildCodexDeveloperInstructions,
    buildCodexRuntimeFunctionTools,
} from './utils/codexDeveloperInstructions';
import type { CodexSession } from './session';
import type { EnhancedMode, PermissionMode } from './loop';

const INIT_PROMPT_PREFIX = '#InitPrompt-';

function isInitPromptMessage(message: string): boolean {
    return message.trimStart().startsWith(INIT_PROMPT_PREFIX);
}

// ---------------------------------------------------------------------------
// Codex exec --json event types
// ---------------------------------------------------------------------------

interface ExecItemBase {
    id: string;
    type: string;
    status?: string;
}

interface ExecAgentMessageItem extends ExecItemBase {
    type: 'agent_message';
    text: string;
}

interface ExecMcpToolCallItem extends ExecItemBase {
    type: 'mcp_tool_call';
    server: string;
    tool: string;
    arguments: unknown;
    result?: unknown;
    error?: { message?: string } | null;
}

interface ExecCommandExecutionItem extends ExecItemBase {
    type: 'command_execution';
    command: string;
    aggregated_output?: unknown;
    exit_code?: number | null;
    [key: string]: unknown;
}

interface ExecFileChange extends Record<string, unknown> {
    path: string;
    kind: 'add' | 'delete' | 'update';
}

interface ExecFileChangeItem extends ExecItemBase {
    type: 'file_change';
    changes: ExecFileChange[];
}

interface ExecReasoningItem extends ExecItemBase {
    type: 'reasoning';
    text: string;
}

interface ExecTodoItem {
    text: string;
    completed: boolean;
}

interface ExecTodoListItem extends ExecItemBase {
    type: 'todo_list';
    items: ExecTodoItem[];
}

interface ExecWebSearchItem extends ExecItemBase {
    type: 'web_search';
    query: string;
    action?: unknown;
}

interface ExecCollabToolCallItem extends ExecItemBase {
    type: 'collab_tool_call';
    tool: 'spawn_agent' | 'send_input' | 'wait' | 'close_agent';
    sender_thread_id: string;
    receiver_thread_ids: string[];
    prompt?: string | null;
    agents_states?: Record<string, { status: string; message?: string | null }>;
}

interface ExecErrorItem extends ExecItemBase {
    type: 'error';
    message: string;
}

type PatchArtifactResolvers = {
    resolveUnifiedDiff?: (change: ExecFileChange) => string | null;
    resolveContent?: (change: ExecFileChange) => string | null;
};

type ExecEnrichedFileChange = ExecFileChange & {
    unified_diff?: string;
    content?: string;
};

type ExecItem =
    | ExecAgentMessageItem
    | ExecMcpToolCallItem
    | ExecCommandExecutionItem
    | ExecFileChangeItem
    | ExecReasoningItem
    | ExecTodoListItem
    | ExecWebSearchItem
    | ExecCollabToolCallItem
    | ExecErrorItem
    | ExecItemBase;

type ExecEvent =
    | { type: 'thread.started'; thread_id: string }
    | { type: 'turn.started' }
    | { type: 'turn.failed'; error?: { message?: string } }
    | { type: 'item.started'; item: ExecItem }
    | { type: 'item.updated'; item: ExecItem }
    | { type: 'item.completed'; item: ExecItem }
    | { type: 'turn.completed'; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }
    | { type: 'error'; message?: string }
    | { type: string; [key: string]: unknown };

export async function codexExecLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    if (session.codexArgs && session.codexArgs.length > 0) {
        if (hasCodexCliOverrides(session.codexCliOverrides)) {
            logger.debug(`[codex-exec] CLI args include supported sandbox/approval/service-tier overrides; other args ignored in remote mode.`);
        } else {
            logger.debug(`[codex-exec] Warning: CLI args [${session.codexArgs.join(', ')}] are ignored in remote mode.`);
        }
    }

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    const messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;
    let activeChild: ChildProcess | null = null;
    let activeChildExited = false;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                logger.debug('[codex-exec]: Exiting via Ctrl-C');
                exitReason = 'exit';
                shouldExit = true;
                killActiveChild();
            },
            onSwitchToLocal: async () => {
                logger.debug('[codex-exec]: Switching to local mode');
                exitReason = 'switch';
                shouldExit = true;
                killActiveChild();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
    }

    function killActiveChild(): void {
        if (activeChild && !activeChildExited) {
            logger.debug('[codex-exec] Killing active child process');
            activeChild.kill('SIGTERM');
            const ref = activeChild;
            setTimeout(() => {
                if (!activeChildExited) {
                    logger.debug('[codex-exec] SIGTERM did not work, sending SIGKILL');
                    ref.kill('SIGKILL');
                }
            }, 3000);
        }
    }

    // ----- MCP servers setup -----
    const yohoRemoteServer = await startYohoRemoteServer(session.client, {
        apiClient: session.api,
        machineId: session.machineId ?? undefined,
        sessionSource: session.sessionSource ?? undefined,
        yohoRemoteSessionId: session.client.sessionId,
        workingDirectory: session.path,
    });
    const bridgeCommand = getYohoRemoteCliCommand(['mcp', '--url', yohoRemoteServer.url]);
    const auxServers = await getYohoAuxMcpServers('codex', {
        apiClient: session.api,
        sessionId: session.client.sessionId,
        orgId: session.client.orgId,
    });
    const mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }> = {
        yoho_remote: {
            command: bridgeCommand.command,
            args: bridgeCommand.args
        },
        ...auxServers
    };

    // Add stdio bridge for remote vault MCP server when local files are absent
    if (!auxServers.yoho_vault) {
        try {
            const host = new URL(process.env.YOHO_REMOTE_URL || '').hostname;
            if (host) {
                const vaultBridge = getYohoRemoteCliCommand(['mcp', '--url', `http://${host}:${VAULT_HTTP_PORT}/mcp`]);
                const vaultBridgeEnv: Record<string, string> = {};
                if (session.client.orgId) vaultBridgeEnv.YOHO_ORG_ID = session.client.orgId;
                mcpServers.yoho_vault = { command: vaultBridge.command, args: vaultBridge.args, env: vaultBridgeEnv };
            }
        } catch { /* invalid URL, skip */ }
    }

    logger.debug('[codex-exec] MCP servers configured', {
        servers: Object.keys(mcpServers),
        details: Object.fromEntries(
            Object.entries(mcpServers).map(([k, v]) => [k, { command: v.command, args: v.args, cwd: v.cwd }])
        )
    });

    const isBrainSession = session.sessionSource === 'brain';
    const isBrainChildSession = session.sessionSource === 'brain-child';
    const runtimeFunctionTools = isBrainSession
        ? buildCodexRuntimeFunctionTools({
            yohoRemoteToolNames: yohoRemoteServer.toolNames,
            auxServerNames: Object.keys(mcpServers),
        })
        : isBrainChildSession
            ? buildCodexBrainChildRuntimeFunctionTools({
                yohoRemoteToolNames: yohoRemoteServer.toolNames.filter((toolName) =>
                    BRAIN_CHILD_SAFE_YOHO_REMOTE_TOOL_NAMES.includes(toolName as typeof BRAIN_CHILD_SAFE_YOHO_REMOTE_TOOL_NAMES[number])
                ),
                auxServerNames: Object.keys(mcpServers),
            })
            : [];
    if (runtimeFunctionTools.length > 0) {
        session.client.updateMetadata((metadata) => ({
            ...metadata,
            tools: runtimeFunctionTools,
        }));
    }

    const developerInstructions = (isBrainSession || isBrainChildSession)
        ? buildCodexDeveloperInstructions({
            sessionSource: session.sessionSource,
            runtimeFunctionTools,
        })
        : undefined;
    const configOverrides = buildCodexConfigOverrides({
        sessionSource: session.sessionSource,
    });

    // ----- Resolve codex binary -----
    const codexBin = resolveCodexBinary();
    logger.debug(`[codex-exec] Resolved codex binary: ${codexBin.command} (version=${codexBin.version})`);

    // ----- RPC handlers -----
    session.client.rpcHandlerManager.registerHandler('abort', async () => {
        killActiveChild();
    });
    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        exitReason = 'switch';
        shouldExit = true;
        killActiveChild();
    });

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    // ----- Timeout settings -----
    const TURN_TIMEOUT_MS = parseTimeoutEnv('YR_CODEX_TURN_TIMEOUT_MS', 3 * 60 * 60 * 1000);

    // ----- State -----
    let threadId: string | null = getInitialExecThreadId(session);
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
    let first = true;
    let titleInstructionPending = true;

    const appendTitleInstructionIfNeeded = (messageText: string): string => {
        if (!titleInstructionPending) {
            return messageText;
        }
        if (isInitPromptMessage(messageText)) {
            return messageText;
        }
        titleInstructionPending = false;
        return `${messageText}\n\n${TITLE_INSTRUCTION}`;
    };

    // ----- Main loop -----
    try {
        while (!shouldExit) {
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                console.error('[YR codex-exec] Waiting for messages...');
                const batch = await session.queue.waitForMessagesAndGetAsString();
                console.error('[YR codex-exec] Got batch:', batch ? 'yes' : 'no', 'shouldExit:', shouldExit);
                if (!batch) {
                    if (!shouldExit) {
                        logger.debug('[codex-exec]: Wait returned null while idle; continuing');
                        continue;
                    }
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            // Mode change → reset thread so we start a fresh codex session
            if (threadId && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[codex-exec] Mode changed – will start new codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                threadId = null;
                currentModeHash = null;
                pending = message;
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;
            const resolvedMessage = await resolveFileReferences(message.message, session.path);
            const outgoingPrompt = normalizeCodexToolReferences(
                appendTitleInstructionIfNeeded(resolvedMessage)
            );

            console.error('[YR codex-exec] Processing message:', message.message.slice(0, 50));

            try {
                // Build codex start config to get resolved model/prompt
                const startConfig = buildCodexStartConfig({
                    message: outgoingPrompt,
                    mode: message.mode,
                    first,
                    mcpServers,
                    cliOverrides: session.codexCliOverrides,
                    developerInstructions,
                    includeTitleInstruction: false,
                    configOverrides,
                });

                // Spawn codex exec process
                const childResult = await spawnCodexExec({
                    codexBin,
                    startConfig,
                    permissionMode: message.mode.permissionMode,
                    mcpServers,
                    threadId,
                    prompt: startConfig.prompt,
                    session,
                    messageBuffer,
                    turnTimeoutMs: TURN_TIMEOUT_MS,
                    onThreadId: (id) => { threadId = id; },
                    onChildSpawned: (child) => {
                        activeChild = child;
                        activeChildExited = false;
                    },
                    shouldExit: () => shouldExit,
                });

                if (childResult.threadId) {
                    threadId = childResult.threadId;
                }

                first = false;
                sendReady();
            } catch (error) {
                logger.warn('[codex-exec] Error in exec turn', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    threadId,
                    first,
                    permissionMode: message.mode.permissionMode,
                    messagePreview: message.message.slice(0, 200),
                });
                const errorMessage = error instanceof Error ? error.message : String(error);
                const displayMessage = `Process error: ${errorMessage.slice(0, 200)}`;
                messageBuffer.addMessage(displayMessage, 'status');
                session.sendSessionEvent({ type: 'message', message: displayMessage });

                // On error, clear thread to allow fresh start
                threadId = null;
                currentModeHash = null;
            } finally {
                activeChild = null;
                activeChildExited = true;
                session.onThinkingChange(false);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit,
                    sendReady
                });
            }
        }
    } finally {
        logger.debug('[codex-exec]: cleanup start');
        killActiveChild();
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        yohoRemoteServer.stop();
        restoreTerminalState();
        if (hasTTY) {
            try { process.stdin.pause(); } catch {}
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();
        logger.debug('[codex-exec]: cleanup done');
    }

    return exitReason || 'exit';
}

// ---------------------------------------------------------------------------
// Spawn and parse a single `codex exec --json` turn
// ---------------------------------------------------------------------------

interface SpawnCodexExecOptions {
    codexBin: { command: string; version: string | null; env: NodeJS.ProcessEnv };
    startConfig: CodexExecStartConfig;
    permissionMode: PermissionMode;
    mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }>;
    threadId: string | null;
    prompt: string;
    session: CodexSession;
    messageBuffer: MessageBuffer;
    turnTimeoutMs: number;
    onThreadId: (id: string) => void;
    onChildSpawned: (child: ChildProcess) => void;
    shouldExit: () => boolean;
}

interface SpawnCodexExecResult {
    threadId: string | null;
}

async function spawnCodexExec(opts: SpawnCodexExecOptions): Promise<SpawnCodexExecResult> {
    const {
        codexBin, startConfig, mcpServers, threadId, prompt,
        session, messageBuffer, turnTimeoutMs, onThreadId, onChildSpawned,
        shouldExit, permissionMode
    } = opts;

    const skipGitRepoCheck = session.startedBy === 'daemon';
    const args = buildCodexExecArgs({
        threadId,
        permissionMode,
        startConfig,
        mcpServers,
        prompt,
        skipGitRepoCheck,
    });

    logger.debug('[codex-exec] Spawning codex exec', {
        command: codexBin.command,
        version: codexBin.version,
        args,
        cwd: session.path,
        skipGitRepoCheck,
        permissionMode,
        threadId,
        model: startConfig.model ?? '(default)',
        reasoningEffort: startConfig.model_reasoning_effort ?? '(default)',
        serviceTier: startConfig.service_tier ?? '(default)',
        codexHome: codexBin.env.CODEX_HOME ?? '(not set)',
    });

    let resultThreadId: string | null = threadId;
    let pendingReplacementThreadId: string | null = null;

    // Generate a unique prefix per turn so callIds (item_0, item_1, ...) don't
    // collide across turns in the frontend's toolBlocksById map.
    const turnPrefix = randomUUID().slice(0, 8);

    return new Promise<SpawnCodexExecResult>((resolve, reject) => {
        const child = spawn(codexBin.command, args, {
            cwd: session.path,
            env: codexBin.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        onChildSpawned(child);

        // Close stdin immediately — exec mode reads prompt from args
        child.stdin?.end();

        let stderrChunks: string[] = [];
        let turnTimedOut = false;
        let resolved = false;
        let eventCount = 0;
        const eventTypes: string[] = [];
        const announcedToolCalls = new Set<string>();
        // Captured from JSONL `error` / `turn.failed` events — the authoritative
        // failure reason (e.g. "You've hit your usage limit"), as opposed to
        // stderr which often contains only benign chatter like "Reading
        // additional input from stdin...".
        let lastEventError: string | null = null;

        const commitPendingReplacementThreadId = (): string | null => {
            if (!pendingReplacementThreadId) {
                return null;
            }

            const replacementThreadId = pendingReplacementThreadId;
            pendingReplacementThreadId = null;
            resultThreadId = replacementThreadId;
            onThreadId(replacementThreadId);
            session.onSessionFound(replacementThreadId);
            logger.warn('[codex-exec] Promoting replacement thread ID after successful resume turn', {
                previousThreadId: threadId,
                nextThreadId: replacementThreadId,
            });
            return replacementThreadId;
        };

        const turnTimer = turnTimeoutMs > 0
            ? setTimeout(() => {
                turnTimedOut = true;
                logger.warn(`[codex-exec] Turn timed out after ${turnTimeoutMs}ms — killing child`);
                child.kill('SIGTERM');
            }, turnTimeoutMs)
            : null;

        function finish(error?: Error): void {
            if (resolved) return;
            resolved = true;
            if (turnTimer) clearTimeout(turnTimer);
            if (error) {
                reject(error);
            } else {
                resolve({ threadId: resultThreadId });
            }
        }

        // Mark thinking on turn start
        session.onThinkingChange(true);

        // Stderr — accumulate for error reporting
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderrChunks.push(chunk);
            // Log last bit for debugging
            const trimmed = chunk.trim();
            if (trimmed) {
                logger.debug(`[codex-exec:stderr] ${trimmed.slice(0, 300)}`);
            }
        });

        // Stdout — JSONL event stream
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

        rl.on('line', (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            let event: ExecEvent;
            try {
                event = JSON.parse(trimmed);
            } catch {
                logger.debug(`[codex-exec] Non-JSON stdout line: ${trimmed.slice(0, 200)}`);
                return;
            }

            eventCount++;
            eventTypes.push(event.type);

            if (event.type === 'error' || event.type === 'turn.failed') {
                const raw = event as { message?: unknown; error?: { message?: unknown } };
                const msg = typeof raw.message === 'string'
                    ? raw.message
                    : typeof raw.error?.message === 'string'
                        ? raw.error.message
                        : null;
                if (msg) lastEventError = msg;
            }

            handleExecEvent(event, {
                session,
                messageBuffer,
                turnPrefix,
                announcedToolCalls,
                currentThreadId: () => resultThreadId,
                queueReplacementThreadId: (id) => {
                    pendingReplacementThreadId = id;
                },
                commitPendingReplacementThreadId,
                onThreadId: (id) => {
                    resultThreadId = id;
                    onThreadId(id);
                }
            });
        });

        child.on('error', (err) => {
            logger.warn('[codex-exec] Child process error:', err);
            finish(err);
        });

        child.on('close', (code, signal) => {
            rl.close();
            session.onThinkingChange(false);

            const stderr = stderrChunks.join('').trim();
            const summary = {
                exitCode: code,
                signal,
                eventCount,
                eventTypes,
                threadId: resultThreadId,
                stderrLength: stderr.length,
                stderr: stderr ? stderr.slice(0, 1000) : '(empty)',
                turnTimedOut,
                permissionMode,
                model: startConfig.model ?? '(default)',
            };

            if (turnTimedOut) {
                logger.warn('[codex-exec] Turn timed out', summary);
                finish(new Error('Turn timed out'));
                return;
            }

            if (code !== 0 && code !== null) {
                pendingReplacementThreadId = null;
                const msg = lastEventError
                    ? `codex exec exited with code ${code}: ${lastEventError.slice(0, 500)}`
                    : stderr
                        ? `codex exec exited with code ${code}: ${stderr.slice(0, 500)}`
                        : `codex exec exited with code ${code}`;
                logger.warn('[codex-exec] Non-zero exit', { ...summary, lastEventError });
                finish(new Error(msg));
                return;
            }

            commitPendingReplacementThreadId();
            logger.debug('[codex-exec] Process exited normally', { exitCode: code, eventCount });
            finish();
        });
    });
}

// ---------------------------------------------------------------------------
// Handle a single JSONL event from `codex exec --json`
// ---------------------------------------------------------------------------

interface EventHandlerContext {
    session: CodexSession;
    messageBuffer: MessageBuffer;
    turnPrefix: string;
    onThreadId: (id: string) => void;
    announcedToolCalls: Set<string>;
    currentThreadId?: () => string | null;
    queueReplacementThreadId?: (id: string) => void;
    commitPendingReplacementThreadId?: () => string | null;
    emittedReasoningItemIds?: Set<string>;
    lastStreamErrorMessage?: string | null;
    workspaceGitRoot?: string | null;
    patchArtifactResolvers?: PatchArtifactResolvers;
}

function getInitialExecThreadId(session: Pick<CodexSession, 'sessionId'>): string | null {
    return session.sessionId;
}

function handleThreadStartedEvent(threadId: string, ctx: EventHandlerContext): void {
    if (!threadId) {
        return;
    }

    const previousThreadId = ctx.currentThreadId?.() ?? null;
    if (previousThreadId && previousThreadId !== threadId) {
        logger.warn('[codex-exec] Thread ID changed during exec stream; deferring replacement until success', {
            previousThreadId,
            nextThreadId: threadId,
        });
        ctx.queueReplacementThreadId?.(threadId);
        return;
    }

    ctx.onThreadId(threadId);
    ctx.session.onSessionFound(threadId);
    logger.debug(`[codex-exec] Thread started: ${threadId}`);
}

function handleExecEvent(event: ExecEvent, ctx: EventHandlerContext): void {
    const { session, messageBuffer } = ctx;

    logger.debug(`[codex-exec:event] ${event.type} ${JSON.stringify(event).slice(0, 300)}`);

    switch (event.type) {
        case 'thread.started': {
            const threadId = (event as { thread_id: string }).thread_id;
            handleThreadStartedEvent(threadId, ctx);
            break;
        }

        case 'turn.started': {
            ctx.lastStreamErrorMessage = null;
            messageBuffer.addMessage('Starting task...', 'status');
            break;
        }

        case 'item.started': {
            const item = (event as { item: ExecItem }).item;
            handleItemStarted(item, ctx);
            break;
        }

        case 'item.updated': {
            const item = (event as { item: ExecItem }).item;
            handleItemUpdated(item, ctx);
            break;
        }

        case 'item.completed': {
            const item = (event as { item: ExecItem }).item;
            handleItemCompleted(item, ctx);
            break;
        }

        case 'turn.completed': {
            ctx.commitPendingReplacementThreadId?.();
            const usage = (event as { usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }).usage;
            messageBuffer.addMessage('Task completed', 'status');

            if (usage) {
                session.sendCodexMessage({
                    type: 'token_count',
                    info: {
                        input_tokens: usage.input_tokens,
                        cache_read_input_tokens: usage.cached_input_tokens,
                        output_tokens: usage.output_tokens
                    },
                    id: randomUUID()
                });
            }
            break;
        }

        case 'turn.failed': {
            const errorMessage = getExecEventErrorMessage(event);
            messageBuffer.addMessage(`Task failed${errorMessage ? `: ${errorMessage}` : ''}`, 'status');
            if (errorMessage && errorMessage !== ctx.lastStreamErrorMessage) {
                session.sendCodexMessage({
                    type: 'error',
                    message: errorMessage,
                    source: 'turn_failed',
                    id: randomUUID()
                });
            }
            break;
        }

        case 'error': {
            const errorMessage = getExecEventErrorMessage(event);
            if (!errorMessage) {
                break;
            }
            ctx.lastStreamErrorMessage = errorMessage;
            messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
            session.sendCodexMessage({
                type: 'error',
                message: errorMessage,
                source: 'stream',
                id: randomUUID()
            });
            break;
        }

        default: {
            logger.warn('[codex-exec] Unknown event type', {
                eventType: event.type,
                event
            });
            break;
        }
    }
}

function handleItemStarted(item: ExecItem, ctx: EventHandlerContext): void {
    const { session, messageBuffer, turnPrefix } = ctx;
    const callId = `${turnPrefix}-${item.id}`;

    switch (item.type) {
        case 'mcp_tool_call': {
            const mcpItem = item as ExecMcpToolCallItem;
            messageBuffer.addMessage(`Calling ${mcpItem.server}:${mcpItem.tool}...`, 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                name: `${mcpItem.server}__${mcpItem.tool}`,
                callId,
                input: mcpItem.arguments,
                id: randomUUID()
            });
            break;
        }

        case 'command_execution': {
            const cmdItem = item as ExecCommandExecutionItem;
            messageBuffer.addMessage(`Executing: ${cmdItem.command}`, 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId,
                input: { command: cmdItem.command },
                id: randomUUID()
            });
            break;
        }

        case 'file_change': {
            const changeItem = item as ExecFileChangeItem;
            const filesMsg = changeItem.changes.length === 1 ? changeItem.changes[0]?.path ?? '1 file' : `${changeItem.changes.length} files`;
            const label = changeItem.changes.length === 1 ? `Editing ${filesMsg}...` : `Editing ${filesMsg}...`;
            messageBuffer.addMessage(label, 'tool');
            ensureToolCall(session, ctx, callId, 'CodexPatch', buildCodexPatchInput(changeItem, ctx));
            break;
        }

        case 'reasoning': {
            const reasonItem = item as ExecReasoningItem;
            messageBuffer.addMessage(`[Thinking] ${reasonItem.text?.substring(0, 100) ?? ''}...`, 'system');
            break;
        }

        case 'web_search': {
            const searchItem = item as ExecWebSearchItem;
            const label = searchItem.query?.trim() ? `Searching web: ${searchItem.query}` : 'Searching web...';
            messageBuffer.addMessage(label, 'tool');
            ensureToolCall(session, ctx, callId, 'WebSearch', buildWebSearchPayload(searchItem));
            break;
        }

        case 'todo_list': {
            const todoItem = item as ExecTodoListItem;
            const planPayload = buildCodexPlanPayload(todoItem);
            if (!planPayload) {
                break;
            }
            messageBuffer.addMessage('Updating plan...', 'tool');
            ensureToolCall(session, ctx, callId, 'CodexPlan', planPayload);
            break;
        }

        case 'collab_tool_call': {
            const collabItem = item as ExecCollabToolCallItem;
            messageBuffer.addMessage(`${describeCollabTool(collabItem.tool)}...`, 'tool');
            ensureToolCall(session, ctx, callId, mapCollabToolName(collabItem.tool), buildCollabToolPayload(collabItem));
            break;
        }

        default: {
            logger.warn('[codex-exec] Unknown item type in item.started', {
                itemType: item.type,
                item
            });
            break;
        }
    }
}

function handleItemUpdated(item: ExecItem, ctx: EventHandlerContext): void {
    if (item.type !== 'todo_list') {
        return;
    }

    const { session, turnPrefix } = ctx;
    const callId = `${turnPrefix}-${item.id}`;
    const planPayload = buildCodexPlanPayload(item as ExecTodoListItem);
    if (!planPayload) {
        return;
    }

    ensureToolCall(session, ctx, callId, 'CodexPlan', planPayload);
    session.sendCodexMessage({
        type: 'tool-call-result',
        callId,
        output: planPayload,
        id: randomUUID()
    });
}

function handleItemCompleted(item: ExecItem, ctx: EventHandlerContext): void {
    const { session, messageBuffer, turnPrefix } = ctx;
    const callId = `${turnPrefix}-${item.id}`;

    switch (item.type) {
        case 'agent_message': {
            const msgItem = item as ExecAgentMessageItem;
            messageBuffer.addMessage(msgItem.text, 'assistant');
            session.sendCodexMessage({
                type: 'message',
                message: msgItem.text,
                id: randomUUID()
            });
            break;
        }

        case 'mcp_tool_call': {
            const mcpItem = item as ExecMcpToolCallItem;
            const outputPayload = mcpItem.error?.message
                ? { error: mcpItem.error.message }
                : (mcpItem.result ?? { status: mcpItem.status });
            const resultStr = typeof outputPayload === 'string'
                ? outputPayload
                : JSON.stringify(outputPayload);
            const truncated = resultStr?.substring(0, 200) ?? '';
            messageBuffer.addMessage(`Result: ${truncated}${(resultStr?.length ?? 0) > 200 ? '...' : ''}`, 'result');
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: outputPayload,
                id: randomUUID()
            });
            break;
        }

        case 'command_execution': {
            const cmdItem = item as ExecCommandExecutionItem;
            const commandResult = buildCommandExecutionResult(cmdItem);
            const output = getCommandExecutionPreview(cmdItem)
                ?? `exit code ${cmdItem.exit_code ?? '?'}`;
            const truncated = output.substring(0, 200);
            messageBuffer.addMessage(`Result: ${truncated}${output.length > 200 ? '...' : ''}`, 'result');
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: commandResult,
                id: randomUUID()
            });
            break;
        }

        case 'file_change': {
            const changeItem = item as ExecFileChangeItem;
            ensureToolCall(session, ctx, callId, 'CodexPatch', buildCodexPatchInput(changeItem, ctx));
            const firstPath = changeItem.changes[0]?.path;
            messageBuffer.addMessage(
                firstPath ? `Modified: ${firstPath}` : 'Files modified',
                'result'
            );
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: buildCodexPatchResult(changeItem, ctx),
                id: randomUUID()
            });
            break;
        }

        case 'reasoning': {
            const reasonItem = item as ExecReasoningItem;
            const emittedReasoningItemIds = ctx.emittedReasoningItemIds ??= new Set<string>();
            if (emittedReasoningItemIds.has(reasonItem.id)) {
                break;
            }
            emittedReasoningItemIds.add(reasonItem.id);
            session.sendCodexMessage({
                type: 'reasoning-delta',
                delta: reasonItem.text ?? ''
            });
            break;
        }

        case 'web_search': {
            const searchItem = item as ExecWebSearchItem;
            ensureToolCall(session, ctx, callId, 'WebSearch', buildWebSearchPayload(searchItem));
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: buildWebSearchPayload(searchItem),
                id: randomUUID()
            });
            break;
        }

        case 'todo_list': {
            const todoItem = item as ExecTodoListItem;
            const planPayload = buildCodexPlanPayload(todoItem);
            if (!planPayload) {
                break;
            }
            ensureToolCall(session, ctx, callId, 'CodexPlan', planPayload);
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: planPayload,
                id: randomUUID()
            });
            break;
        }

        case 'collab_tool_call': {
            const collabItem = item as ExecCollabToolCallItem;
            const toolName = mapCollabToolName(collabItem.tool);
            const payload = buildCollabToolPayload(collabItem);
            ensureToolCall(session, ctx, callId, toolName, payload);
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: payload,
                id: randomUUID()
            });
            break;
        }

        case 'error': {
            const errorItem = item as ExecErrorItem;
            messageBuffer.addMessage(`Notice: ${errorItem.message}`, 'status');
            session.sendCodexMessage({
                type: 'notice',
                level: 'warning',
                source: 'item',
                message: errorItem.message,
                id: randomUUID()
            });
            break;
        }

        default: {
            logger.warn('[codex-exec] Unknown item type in item.completed', {
                itemType: item.type,
                item
            });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureToolCall(
    session: CodexSession,
    ctx: EventHandlerContext,
    callId: string,
    name: string,
    input: unknown
): void {
    if (ctx.announcedToolCalls.has(callId)) {
        return;
    }

    ctx.announcedToolCalls.add(callId);
    session.sendCodexMessage({
        type: 'tool-call',
        name,
        callId,
        input,
        id: randomUUID()
    });
}

function getExecEventErrorMessage(event: ExecEvent): string | null {
    const direct = (event as { message?: unknown }).message;
    if (typeof direct === 'string' && direct.trim().length > 0) {
        return direct.trim();
    }

    const nested = (event as { error?: { message?: unknown } }).error?.message;
    if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
    }

    return null;
}

function buildCodexPlanPayload(item: ExecTodoListItem): { plan: Array<{ step: string; status: 'completed' | 'pending' }> } | null {
    if (!Array.isArray(item.items) || item.items.length === 0) {
        return null;
    }

    return {
        plan: item.items.map((todo) => ({
            step: todo.text,
            status: todo.completed ? 'completed' : 'pending',
        }))
    };
}

function buildWebSearchPayload(item: ExecWebSearchItem): Record<string, unknown> {
    return {
        id: item.id,
        query: item.query,
        action: item.action ?? null,
    };
}

function buildCodexPatchInput(
    item: ExecFileChangeItem,
    source?: EventHandlerContext | PatchArtifactResolvers
): { changes: Record<string, { kind: string; unified_diff?: string; content?: string }> } {
    const changes = buildCodexPatchChanges(item, source);

    return {
        changes: Object.fromEntries(
            changes.map((change) => [change.path, {
                kind: change.kind,
                ...(typeof change.unified_diff === 'string' ? { unified_diff: change.unified_diff } : {}),
                ...(typeof change.content === 'string' ? { content: change.content } : {}),
            }])
        )
    };
}

function buildCodexPatchResult(
    item: ExecFileChangeItem,
    source?: EventHandlerContext | PatchArtifactResolvers
): Record<string, unknown> {
    return {
        changes: buildCodexPatchChanges(item, source),
        status: item.status ?? 'completed',
    };
}

function buildCodexPatchChanges(
    item: ExecFileChangeItem,
    source?: EventHandlerContext | PatchArtifactResolvers
): ExecEnrichedFileChange[] {
    const resolvers = getPatchArtifactResolvers(source);

    return item.changes.map((change) => {
        const unifiedDiff = resolvers?.resolveUnifiedDiff?.(change) ?? undefined;
        const content = unifiedDiff
            ? undefined
            : (resolvers?.resolveContent?.(change) ?? undefined);

        return {
            ...change,
            ...(typeof unifiedDiff === 'string' && unifiedDiff.length > 0 ? { unified_diff: unifiedDiff } : {}),
            ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
        };
    });
}

function getPatchArtifactResolvers(source?: EventHandlerContext | PatchArtifactResolvers): PatchArtifactResolvers | undefined {
    if (!source) {
        return undefined;
    }

    if ('session' in source) {
        if (!source.patchArtifactResolvers) {
            source.patchArtifactResolvers = createWorkspacePatchArtifactResolvers(source);
        }
        return source.patchArtifactResolvers;
    }

    return source;
}

function createWorkspacePatchArtifactResolvers(ctx: EventHandlerContext): PatchArtifactResolvers {
    return {
        resolveUnifiedDiff: (change) => resolveWorkspaceUnifiedDiff(ctx, change),
        resolveContent: (change) => resolveWorkspaceFileContent(ctx.session.path, change),
    };
}

function resolveWorkspaceUnifiedDiff(ctx: EventHandlerContext, change: ExecFileChange): string | null {
    const absolutePath = resolveWorkspacePath(ctx.session.path, change.path);
    const gitRoot = getWorkspaceGitRoot(ctx);

    if (gitRoot) {
        const relativePath = path.relative(gitRoot, absolutePath);
        if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath)) {
            const diff = readGitDiff(gitRoot, relativePath.split(path.sep).join('/'));
            if (diff) {
                return diff;
            }
        }
    }

    if (change.kind === 'add') {
        return readNoIndexDiff(absolutePath);
    }

    return null;
}

function resolveWorkspaceFileContent(workspacePath: string, change: ExecFileChange): string | null {
    if (change.kind !== 'add') {
        return null;
    }

    try {
        const content = readFileSync(resolveWorkspacePath(workspacePath, change.path), 'utf8');
        if (!content || content.includes('\u0000')) {
            return null;
        }
        return content.length > 100_000 ? `${content.slice(0, 100_000)}\n...` : content;
    } catch {
        return null;
    }
}

function getWorkspaceGitRoot(ctx: EventHandlerContext): string | null {
    if (ctx.workspaceGitRoot !== undefined) {
        return ctx.workspaceGitRoot;
    }

    try {
        const gitRoot = execFileSync('git', ['-C', ctx.session.path, 'rev-parse', '--show-toplevel'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        ctx.workspaceGitRoot = gitRoot || null;
    } catch {
        ctx.workspaceGitRoot = null;
    }

    return ctx.workspaceGitRoot;
}

function readGitDiff(gitRoot: string, relativePath: string): string | null {
    try {
        const diff = execFileSync('git', ['-C', gitRoot, 'diff', '--no-ext-diff', '--unified=3', '--', relativePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 2_000_000,
        });
        const trimmed = diff.trimEnd();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

function readNoIndexDiff(absolutePath: string): string | null {
    try {
        const diff = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', devNull, absolutePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 2_000_000,
        });
        const trimmed = diff.trimEnd();
        return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
        const stdout = error instanceof Error && 'stdout' in error
            ? (typeof error.stdout === 'string'
                ? error.stdout
                : Buffer.isBuffer(error.stdout)
                    ? error.stdout.toString('utf8')
                    : '')
            : '';
        const trimmed = stdout.trimEnd();
        return trimmed.length > 0 ? trimmed : null;
    }
}

function resolveWorkspacePath(workspacePath: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
}

function mapCollabToolName(tool: ExecCollabToolCallItem['tool']): string {
    switch (tool) {
        case 'spawn_agent':
            return 'spawn_agent';
        case 'send_input':
            return 'send_input';
        case 'wait':
            return 'wait_agent';
        case 'close_agent':
            return 'close_agent';
    }
}

function describeCollabTool(tool: ExecCollabToolCallItem['tool']): string {
    switch (tool) {
        case 'spawn_agent':
            return 'Spawning agent';
        case 'send_input':
            return 'Sending input to agent';
        case 'wait':
            return 'Waiting for agent';
        case 'close_agent':
            return 'Closing agent';
    }
}

function buildCollabToolPayload(item: ExecCollabToolCallItem): Record<string, unknown> {
    return {
        sender_thread_id: item.sender_thread_id,
        receiver_thread_ids: item.receiver_thread_ids,
        prompt: item.prompt ?? null,
        agents_states: item.agents_states ?? {},
        status: item.status ?? null,
    };
}

function parseTimeoutEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        logger.warn(`[codex-exec] Invalid ${name}=${raw}; using ${fallback}`);
        return fallback;
    }
    return parsed;
}

export const __testOnly = {
    getInitialExecThreadId,
    handleExecEvent,
    buildCodexPlanPayload,
    buildWebSearchPayload,
    buildCodexPatchInput,
    buildCodexPatchResult,
    buildCodexPatchChanges,
    mapCollabToolName,
    buildCollabToolPayload,
    getExecEventErrorMessage,
};
